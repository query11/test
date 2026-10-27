using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace ClaudeDesktopManager
{
    public enum LogLevel { Info, Ok, Warn, Error }

    public sealed class LogEntry
    {
        public DateTime Time;
        public LogLevel Level;
        public string Text = "";

        public override string ToString() => Time.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + " " + Text;
    }

    public sealed class OpResult
    {
        public bool Ok = true;
        /// <summary>Start found Claude already running and did not restart it.</summary>
        public bool AlreadyRunning;
        public List<string> Lines = new List<string>();

        public string Text => string.Join(Environment.NewLine, Lines);
    }

    /// <summary>Start / stop / restart Claude Desktop with a profile; shared by the window, the tray and the command line.</summary>
    public sealed class Manager
    {
        public const string CoworkService = "CoworkVMService";

        public readonly IPlatform P;
        public readonly SettingsStore Store;

        /// <summary>Injectable for tests.</summary>
        public Action<int> Sleep = ms => Thread.Sleep(ms);
        public Func<long> NowMs = () => Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency;
        public Func<DateTime> UtcNow = () => DateTime.UtcNow;
        /// <summary>How long to wait for the main window process after launching.</summary>
        public int LaunchWaitMs = 20000;

        public event Action<LogEntry> Logged;

        readonly object opGate = new object();
        readonly object logGate = new object();
        readonly List<LogEntry> history = new List<LogEntry>();
        volatile bool busy;
        bool sawRunning;
        int notRunningStreak;

        public Settings S => Store.Settings;
        public bool Busy => busy;
        public ClaudeInstall Install { get; private set; }
        public List<ClaudeInstall> Installs { get; private set; } = new List<ClaudeInstall>();
        public KnownDirs Dirs { get; private set; }
        public string LogFile;

        public Manager(IPlatform platform, SettingsStore store)
        {
            P = platform;
            Store = store;
            if (store.Settings == null) store.Load();
            Dirs = KnownDirs.ForUser(P.LocalAppData, P.RoamingAppData);
        }

        public IReadOnlyList<LogEntry> History
        {
            get { lock (logGate) return history.ToList(); }
        }

        public void Log(LogLevel level, string text)
        {
            var e = new LogEntry { Time = DateTime.Now, Level = level, Text = text };
            lock (logGate)
            {
                history.Add(e);
                if (history.Count > 500) history.RemoveRange(0, history.Count - 500);
                if (!string.IsNullOrEmpty(LogFile))
                {
                    try
                    {
                        var fi = new FileInfo(LogFile);
                        if (fi.Exists && fi.Length > 1024 * 1024) File.Copy(LogFile, LogFile + ".1", true);
                        if (fi.Exists && fi.Length > 1024 * 1024) File.Delete(LogFile);
                        File.AppendAllText(LogFile, e.Time.ToString("yyyy-MM-dd ", CultureInfo.InvariantCulture) + e + Environment.NewLine, Encoding.UTF8);
                    }
                    catch (Exception) { /* logging must never break an operation */ }
                }
            }
            Logged?.Invoke(e);
        }

        void Report(OpResult r, LogLevel level, string text)
        {
            r.Lines.Add(text);
            if (level == LogLevel.Error) r.Ok = false;
            Log(level, text);
        }

        public void SaveSettings()
        {
            try { Store.Save(); }
            catch (Exception e) { Log(LogLevel.Error, "保存设置失败：" + e.Message); }
        }

        // ---------------------------------------------------------------- install

        public ClaudeInstall RefreshInstall(ProcessView running = null)
        {
            var list = new List<ClaudeInstall>();
            try
            {
                using (Diag.Time("检测安装"))
                    list = P.DetectInstalls() ?? list;
            }
            catch (Exception e) { Log(LogLevel.Warn, "检测安装位置时出错：" + e.Message); }

            var custom = (S.Options.CustomExePath ?? "").Trim();
            if (custom.Length > 0)
            {
                if (File.Exists(custom))
                {
                    var data = Path.Combine(P.RoamingAppData ?? "", "Claude");
                    list.Insert(0, new ClaudeInstall
                    {
                        Kind = InstallKind.Custom,
                        ExePath = custom,
                        InstallDir = Path.GetDirectoryName(custom) ?? "",
                        DataDir = data,
                        DataDirCandidates = { data },
                    });
                }
                else Log(LogLevel.Warn, "自定义的 Claude 路径不存在：" + custom);
            }

            ClaudeInstall pick = list.FirstOrDefault(i => i.Kind == InstallKind.Custom);
            if (pick == null && running != null)
            {
                // Two installs side by side (old Squirrel + MSIX): the one that is running wins.
                foreach (var m in running.Mains)
                {
                    pick = list.FirstOrDefault(i => i.InstallDir.Length > 0 && m.Path != null
                        && KnownDirs.Normalize(m.Path).StartsWith(KnownDirs.Normalize(i.InstallDir), StringComparison.OrdinalIgnoreCase));
                    if (pick != null) break;
                }
            }
            if (pick == null) pick = list.FirstOrDefault(i => i.Kind == InstallKind.Msix) ?? list.FirstOrDefault();

            Installs = list;
            Install = pick;
            var extra = new List<string>();
            foreach (var i in list)
            {
                if (i.Kind == InstallKind.Custom || i.Kind == InstallKind.Squirrel) extra.Add(i.InstallDir);
                extra.AddRange(i.DataDirCandidates);
            }
            Dirs = KnownDirs.ForUser(P.LocalAppData, P.RoamingAppData, extra);
            return pick;
        }

        // ---------------------------------------------------------------- scanning

        public ProcessView Scan(IDictionary<int, long> extraParents = null)
        {
            List<ProcInfo> snap;
            using (Diag.Time("扫描进程"))
                snap = P.Snapshot(Dirs);
            return ProcessPlanner.Plan(snap, Dirs, new KillOptions
            {
                KillDescendants = S.Options.KillDescendants,
                SelfPid = P.SelfPid,
                SessionId = P.SessionId,
            }, extraParents);
        }

        /// <summary>Called by the status timer; restores the time zone once Claude has been gone for a few ticks.</summary>
        public void OnTick(ProcessView view)
        {
            Store.SyncState();
            if (view.Running)
            {
                sawRunning = true;
                notRunningStreak = 0;
                return;
            }
            if (!sawRunning) return;
            if (++notRunningStreak < 3) return;
            sawRunning = false;
            if (S.PendingTz == null || !S.Options.RestoreTimeZoneOnExit) return;
            if (!Monitor.TryEnter(opGate)) return;
            try
            {
                Log(LogLevel.Info, "Claude 已退出，恢复系统时区");
                RestoreTimeZoneCore(new OpResult());
            }
            finally { Monitor.Exit(opGate); }
        }

        /// <summary>At start-up: a time zone left switched by an earlier run is restored if Claude is not running.</summary>
        public void StartupCheck(ProcessView view)
        {
            Store.SyncState();
            if (S.PendingTz == null) return;
            // Switched moments ago: a start from the command line is probably still on its way to
            // launching Claude. Leave it to OnTick, which restores once Claude has come and gone.
            bool justSwitched = UtcNow() - S.PendingTz.SetAtUtc < TimeSpan.FromSeconds(30);
            if (view.Running || justSwitched)
            {
                sawRunning = true;
                Log(LogLevel.Warn, string.Format("系统时区仍是临时设置的 {0}（原为 {1}），Claude 退出后恢复", TzName(S.PendingTz.AppliedId), TzName(S.PendingTz.OriginalId)));
                return;
            }
            if (!S.Options.RestoreTimeZoneOnExit) return;
            lock (opGate) RestoreTimeZoneCore(new OpResult());
        }

        // ---------------------------------------------------------------- start

        public LaunchSpec Preview(Profile profile)
        {
            var supportsEnv = Install?.SupportsEnv ?? true;
            return LaunchBuilder.Build(profile, supportsEnv);
        }

        public OpResult Start(string profileName, bool restartIfRunning)
        {
            var r = new OpResult();
            lock (opGate)
            {
                busy = true;
                Store.SyncState();
                try { StartCore(r, profileName, restartIfRunning); }
                catch (Exception e) { Report(r, LogLevel.Error, "启动失败：" + e.Message); }
                finally { busy = false; }
            }
            return r;
        }

        void StartCore(OpResult r, string profileName, bool restartIfRunning)
        {
            var profile = S.FindProfile(profileName) ?? S.Selected;
            var view = Scan();
            var install = RefreshInstall(view);
            if (install == null)
            {
                Report(r, LogLevel.Error, "没有找到 Claude Desktop。请先安装，或在“设置”里指定 Claude.exe 的位置。");
                return;
            }
            var spec = LaunchBuilder.Build(profile, install.SupportsEnv);
            if (spec.Errors.Count > 0)
            {
                Report(r, LogLevel.Error, "方案「" + profile.Name + "」有错误：" + string.Join("；", spec.Errors));
                return;
            }

            if (view.Running)
            {
                if (!restartIfRunning)
                {
                    r.AlreadyRunning = true;
                    Report(r, LogLevel.Info, "Claude 已经在运行，没有重新启动（要应用方案请用“重启”）");
                    return;
                }
                Report(r, LogLevel.Info, "Claude 正在运行，先关闭再用方案「" + profile.Name + "」启动");
                StopCore(r, force: false, restoreTz: false);
                if (Scan().Running)
                {
                    Report(r, LogLevel.Error, "Claude 没能完全退出，已取消启动");
                    return;
                }
            }

            foreach (var w in spec.Warnings) Report(r, LogLevel.Warn, w);
            ApplyPolicyCore(r, profile);
            ApplyTimeZoneCore(r, profile);
            EnsureServiceStartable(r);

            LaunchResult result;
            using (Diag.Time("启动进程"))
                result = P.Launch(install, spec);
            if (!result.Ok)
            {
                Report(r, LogLevel.Error, "启动 Claude 失败：" + result.Error);
                return;
            }

            ProcInfo main;
            using (Diag.Time("等待主进程"))
                main = WaitForMain(result.Pid);
            if (main == null)
            {
                Report(r, LogLevel.Warn, "已发出启动请求（" + result.Method + "），但 " + (LaunchWaitMs / 1000) + " 秒内没看到 Claude 主进程，请稍后看一下状态");
            }
            else
            {
                Report(r, LogLevel.Ok, string.Format("已用方案「{0}」启动 Claude（{1}，PID {2}）", profile.Name, result.Method, main.Pid));
                CheckFlags(r, main, spec);
            }
            sawRunning = main != null || sawRunning;
            notRunningStreak = 0;
        }

        ProcInfo WaitForMain(int pidHint)
        {
            long deadline = NowMs() + LaunchWaitMs;
            while (true)
            {
                var v = Scan();
                var m = v.Mains.FirstOrDefault(x => x.Pid == pidHint) ?? v.Mains.OrderByDescending(x => x.CreationTime).FirstOrDefault();
                if (m != null) return m;
                if (NowMs() >= deadline) return null;
                Sleep(400);
            }
        }

        void CheckFlags(OpResult r, ProcInfo main, LaunchSpec spec)
        {
            if (spec.Args.Count == 0) return;
            if (string.IsNullOrEmpty(main.CommandLine))
            {
                Report(r, LogLevel.Info, "读不到主进程的命令行，无法确认启动参数是否生效");
                return;
            }
            var missing = spec.Args.Where(a => main.CommandLine.IndexOf(a.Split('=')[0], StringComparison.OrdinalIgnoreCase) < 0).ToList();
            if (missing.Count == 0) Report(r, LogLevel.Ok, "启动参数已生效：" + spec.ArgString);
            else Report(r, LogLevel.Warn, "主进程命令行里没有这些参数：" + CommandLine.Join(missing) + "（可能是安装方式不支持传参）");
        }

        void EnsureServiceStartable(OpResult r)
        {
            // The service is started by a named-pipe trigger, but it has been seen not to come back
            // after a stop; starting it here avoids "Failed to start Claude's workspace".
            var st = P.GetServiceState(CoworkService);
            if (st != ServiceState.Stopped) return;
            if (P.StartService(CoworkService, out var err)) Log(LogLevel.Info, "已启动 Cowork 虚拟机服务");
            else Log(LogLevel.Info, "Cowork 虚拟机服务没有启动（" + err + "），Claude 需要时会自己启动它");
        }

        // ---------------------------------------------------------------- stop

        public OpResult Stop(bool force)
        {
            var r = new OpResult();
            lock (opGate)
            {
                busy = true;
                Store.SyncState();
                try { StopCore(r, force, restoreTz: true); }
                catch (Exception e) { Report(r, LogLevel.Error, "关闭失败：" + e.Message); }
                finally { busy = false; }
            }
            return r;
        }

        void StopCore(OpResult r, bool force, bool restoreTz)
        {
            var opt = S.Options;
            if (Install == null) RefreshInstall();
            var view = Scan();
            var killed = new Dictionary<int, long>();
            var failed = new Dictionary<int, string>();
            int respawned = 0;
            bool graceful = false;

            if (view.Targets.Count == 0)
            {
                Report(r, LogLevel.Info, "Claude 没有在运行");
            }
            else
            {
                if (!force && opt.GracefulTimeoutSec > 0 && view.Mains.Count > 0)
                using (Diag.Time("等待正常退出"))
                {
                    int windows = 0;
                    foreach (var m in view.Mains) windows += P.CloseWindows(m.Pid);
                    if (windows > 0)
                    {
                        long deadline = NowMs() + opt.GracefulTimeoutSec * 1000L;
                        while (view.Mains.Any(m => P.IsAlive(m.Pid, m.CreationTime)) && NowMs() < deadline) Sleep(200);
                        graceful = !view.Mains.Any(m => P.IsAlive(m.Pid, m.CreationTime));
                        if (graceful) Log(LogLevel.Info, "Claude 已正常退出，清理剩下的进程");
                    }
                }

                foreach (var t in view.Targets)
                {
                    TerminateOne(t, killed, failed);
                }

                // Killed processes get respawned (by Claude itself or its helpers); go round until it is quiet.
                int quiet = 0;
                for (int pass = 0; pass < 8 && quiet < 2; pass++)
                {
                    Sleep(pass == 0 ? 300 : 500);
                    var again = Scan(killed).Targets.Where(t => !failed.ContainsKey(t.Pid)).ToList();
                    if (again.Count == 0) { quiet++; continue; }
                    quiet = 0;
                    foreach (var t in again)
                    {
                        if (TerminateOne(t, killed, failed)) respawned++;
                    }
                }

                var left = Scan(killed);
                // Chromium's helpers die with the main process, so count what is gone, not what we killed.
                var gone = view.Targets.Where(t => !P.IsAlive(t.Pid, t.CreationTime)).ToList();
                int goneChildren = gone.Count(t => t.Role == ProcRole.Child);
                var parts = new List<string>();
                if (graceful) parts.Add("Claude 已正常退出");
                parts.Add((gone.Count == view.Targets.Count ? "Claude 的 " + gone.Count + " 个进程都已结束" : "结束了 " + gone.Count + " / " + view.Targets.Count + " 个进程")
                    + (goneChildren > 0 ? "（含 " + goneChildren + " 个 MCP / 命令行子进程）" : ""));
                if (respawned > 0) parts.Add("另有 " + respawned + " 个被结束后又自动重启，也已结束");
                Report(r, LogLevel.Ok, string.Join("，", parts));
                var keptWindows = view.Kept.Where(k => k.Role == ProcRole.Kept).Select(k => k.Name).Distinct().ToList();
                if (keptWindows.Count > 0)
                    Report(r, LogLevel.Info, "保留了 Claude 打开的窗口程序：" + string.Join("、", keptWindows));
                int keptChildren = view.Kept.Count(k => k.Role == ProcRole.Child);
                if (keptChildren > 0)
                    Report(r, LogLevel.Info, "按设置保留了 " + keptChildren + " 个命令行子进程（MCP 服务器等）");
                if (failed.Count > 0)
                    Report(r, LogLevel.Warn, "有 " + failed.Count + " 个进程没能结束：" + string.Join("；", failed.Select(f => f.Key + " " + f.Value)));
                if (left.Running) Report(r, LogLevel.Error, "Claude 主进程仍在运行（可能需要管理员权限，或被系统重新拉起）");
            }

            if (opt.StopCoworkService)
            {
                var st = P.GetServiceState(CoworkService);
                if (st == ServiceState.Running || st == ServiceState.StartPending)
                {
                    if (P.StopService(CoworkService, 15000, out var err)) Report(r, LogLevel.Ok, "已停止 Cowork 虚拟机服务（CoworkVMService）");
                    else Report(r, LogLevel.Warn, "停止 Cowork 虚拟机服务失败：" + err);
                }
            }

            if (restoreTz && S.PendingTz != null && opt.RestoreTimeZoneOnExit) RestoreTimeZoneCore(r);
            sawRunning = false;
        }

        bool TerminateOne(ProcInfo t, Dictionary<int, long> killed, Dictionary<int, string> failed)
        {
            if (!P.IsAlive(t.Pid, t.CreationTime))
            {
                killed[t.Pid] = t.CreationTime;
                return false;
            }
            if (P.Terminate(t, out var err))
            {
                killed[t.Pid] = t.CreationTime;
                return true;
            }
            failed[t.Pid] = t.Name + "：" + err;
            return false;
        }

        /// <summary>Ends the given processes (from the process list); no tree logic.</summary>
        public OpResult KillPids(IEnumerable<ProcInfo> procs)
        {
            var r = new OpResult();
            lock (opGate)
            {
                busy = true;
                try
                {
                    int n = 0;
                    foreach (var p in procs)
                    {
                        if (p.Pid == P.SelfPid) continue;
                        if (!P.IsAlive(p.Pid, p.CreationTime)) continue;
                        if (P.Terminate(p, out var err)) n++;
                        else Report(r, LogLevel.Warn, "无法结束 " + p.Name + "（" + p.Pid + "）：" + err);
                    }
                    Report(r, LogLevel.Ok, "已结束 " + n + " 个进程");
                }
                finally { busy = false; }
            }
            return r;
        }

        public OpResult ServiceAction(bool start)
        {
            var r = new OpResult();
            lock (opGate)
            {
                string err;
                bool ok = start ? P.StartService(CoworkService, out err) : P.StopService(CoworkService, 15000, out err);
                if (ok) Report(r, LogLevel.Ok, start ? "已启动 Cowork 虚拟机服务" : "已停止 Cowork 虚拟机服务");
                else Report(r, LogLevel.Error, (start ? "启动" : "停止") + " Cowork 虚拟机服务失败：" + err);
            }
            return r;
        }

        // ---------------------------------------------------------------- time zone

        public string TzName(string id)
        {
            if (string.IsNullOrEmpty(id)) return "（未知）";
            try
            {
                var e = P.ListTimeZones().FirstOrDefault(z => string.Equals(z.Id, id, StringComparison.OrdinalIgnoreCase));
                return e != null ? e.DisplayName : id;
            }
            catch (Exception) { return id; }
        }

        void ApplyTimeZoneCore(OpResult r, Profile profile)
        {
            var want = (profile.TimeZoneId ?? "").Trim();
            if (want.Length == 0)
            {
                if (S.PendingTz != null) RestoreTimeZoneCore(r);
                return;
            }
            var current = P.GetSystemTimeZoneId();
            var pending = S.PendingTz;
            if (pending != null && !string.Equals(current, pending.AppliedId, StringComparison.OrdinalIgnoreCase))
            {
                // Someone changed the time zone after our switch: that is the user's zone now.
                pending.OriginalId = current;
            }
            if (string.Equals(current, want, StringComparison.OrdinalIgnoreCase))
            {
                if (pending != null) pending.AppliedId = want;
                SaveSettings();
                Report(r, LogLevel.Info, "系统时区已经是 " + TzName(want) + "，不用切换");
                return;
            }

            bool created = pending == null;
            if (created) S.PendingTz = pending = new PendingTimeZone { OriginalId = current };
            pending.AppliedId = want;
            pending.SetAtUtc = UtcNow();
            // Saved before the switch, so the original zone is never lost even if we crash right after.
            SaveSettings();

            if (!P.SetSystemTimeZone(want, out var err))
            {
                if (created && string.Equals(P.GetSystemTimeZoneId(), current, StringComparison.OrdinalIgnoreCase))
                {
                    S.PendingTz = null;
                    SaveSettings();
                }
                Report(r, LogLevel.Warn, "切换系统时区失败：" + err + "。Claude 会按当前时区启动");
                return;
            }
            Report(r, LogLevel.Ok, string.Format("已把系统时区临时切换为 {0}（原为 {1}）", TzName(want), TzName(pending.OriginalId)));
            if (P.AutoTimeZoneEnabled() == true)
                Report(r, LogLevel.Warn, "Windows 开着“自动设置时区”，可能会把时区改回去；可以在“时区”页打开系统设置关掉它");
        }

        public OpResult RestoreTimeZone()
        {
            var r = new OpResult();
            lock (opGate)
            {
                Store.SyncState();
                if (S.PendingTz == null) Report(r, LogLevel.Info, "没有需要恢复的时区");
                else RestoreTimeZoneCore(r);
            }
            return r;
        }

        void RestoreTimeZoneCore(OpResult r)
        {
            var pending = S.PendingTz;
            if (pending == null) return;
            var current = P.GetSystemTimeZoneId();
            if (string.Equals(current, pending.OriginalId, StringComparison.OrdinalIgnoreCase))
            {
                S.PendingTz = null;
                SaveSettings();
                return;
            }
            if (!string.Equals(current, pending.AppliedId, StringComparison.OrdinalIgnoreCase))
            {
                S.PendingTz = null;
                SaveSettings();
                Report(r, LogLevel.Info, "系统时区已被改成 " + TzName(current) + "（不是本工具设置的），不再自动恢复");
                return;
            }
            if (P.SetSystemTimeZone(pending.OriginalId, out var err))
            {
                S.PendingTz = null;
                SaveSettings();
                Report(r, LogLevel.Ok, "已恢复系统时区：" + TzName(pending.OriginalId));
            }
            else Report(r, LogLevel.Error, "恢复系统时区失败：" + err + "。可以在“时区”页再试，或用 tzutil /s \"" + pending.OriginalId + "\" 手动恢复");
        }

        // ---------------------------------------------------------------- policy

        public OpResult ApplyPolicy(Profile profile)
        {
            var r = new OpResult();
            lock (opGate)
            {
                Store.SyncState();
                ApplyPolicyCore(r, profile);
            }
            return r;
        }

        void ApplyPolicyCore(OpResult r, Profile profile)
        {
            var desired = ProxyLogic.DesiredPolicy(profile.Proxy, S.PolicyWrittenByUs);
            var snap = P.ReadPolicy();
            if (snap.Error != null) Log(LogLevel.Warn, "读取 Claude 策略失败：" + snap.Error);
            var currentUrl = snap.UserValue(ProxyLogic.PolicyUrlKey);
            var currentPac = snap.UserValue(ProxyLogic.PolicyPacKey);

            if (snap.MachineValue(ProxyLogic.PolicyUrlKey) != null || snap.MachineValue(ProxyLogic.PolicyPacKey) != null)
                Report(r, LogLevel.Warn, "机器级策略（HKLM）里设置了 egressProxy，Claude 会优先用它：" + (snap.MachineValue(ProxyLogic.PolicyUrlKey) ?? snap.MachineValue(ProxyLogic.PolicyPacKey)));

            if (desired == null)
            {
                if (currentUrl != null || currentPac != null)
                    Report(r, LogLevel.Warn, "用户策略里已有 egressProxy 设置（" + (currentUrl ?? currentPac) + "），Claude 会用它而不是本方案的代理；可以在“网络代理”页清除");
                return;
            }
            if (!S.PolicyWrittenByUs && (currentUrl != null || currentPac != null)
                && (desired[ProxyLogic.PolicyUrlKey] != currentUrl || desired[ProxyLogic.PolicyPacKey] != currentPac))
            {
                Report(r, LogLevel.Warn, "已有不是本工具写入的 egressProxy 策略（" + (currentUrl ?? currentPac) + "），为免覆盖没有修改；确需修改请先在“网络代理”页清除");
                return;
            }
            if (snap.MachinePresent && desired.Values.Any(v => v != null))
                Report(r, LogLevel.Warn, "HKLM\\SOFTWARE\\Policies\\Claude 下有机器级策略，Claude 会忽略用户级策略，写入的代理可能不生效");

            var changes = new Dictionary<string, string>();
            foreach (var kv in desired)
            {
                var cur = snap.UserValue(kv.Key);
                if (kv.Value == null ? cur != null : cur != kv.Value) changes[kv.Key] = kv.Value;
            }
            if (changes.Count == 0) return;
            if (!P.WriteUserPolicy(changes, out var err))
            {
                Report(r, LogLevel.Warn, "写入官方代理策略失败：" + err);
                return;
            }
            S.PolicyWrittenByUs = desired.Values.Any(v => v != null);
            SaveSettings();
            var set = desired.Where(kv => kv.Value != null).Select(kv => kv.Key + " = " + kv.Value).ToList();
            Report(r, LogLevel.Ok, set.Count > 0 ? "已写入官方代理策略：" + string.Join("，", set) : "已清除本工具写入的官方代理策略");
        }

        /// <summary>Removes egressProxyUrl / egressProxyPacUrl from the user policy, whoever wrote them.</summary>
        public OpResult ClearPolicy()
        {
            var r = new OpResult();
            lock (opGate)
            {
                Store.SyncState();
                var snap = P.ReadPolicy();
                if (snap.UserValue(ProxyLogic.PolicyUrlKey) == null && snap.UserValue(ProxyLogic.PolicyPacKey) == null)
                {
                    S.PolicyWrittenByUs = false;
                    SaveSettings();
                    Report(r, LogLevel.Info, "用户策略里没有 egressProxy 设置");
                    return r;
                }
                var changes = new Dictionary<string, string> { [ProxyLogic.PolicyUrlKey] = null, [ProxyLogic.PolicyPacKey] = null };
                if (P.WriteUserPolicy(changes, out var err))
                {
                    S.PolicyWrittenByUs = false;
                    SaveSettings();
                    Report(r, LogLevel.Ok, "已清除 egressProxy 策略，Claude 下次启动时按方案或系统设置走");
                }
                else Report(r, LogLevel.Error, "清除策略失败：" + err);
            }
            return r;
        }

        // ---------------------------------------------------------------- diagnostics

        public string Diagnostics()
        {
            var sb = new StringBuilder();
            sb.AppendLine("Claude Desktop 管理器 " + AppInfo.Version + " 诊断信息 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
            sb.AppendLine();
            var view = Scan();
            RefreshInstall(view);
            if (Install == null) sb.AppendLine("安装：未找到");
            foreach (var i in Installs)
            {
                sb.AppendLine("安装：" + i.Summary + (i == Install ? "（使用中）" : ""));
                if (i.Aumid.Length > 0) sb.AppendLine("  AUMID：" + i.Aumid);
                sb.AppendLine("  程序：" + i.ExePath);
                sb.AppendLine("  数据目录：" + i.DataDir);
            }
            sb.AppendLine();
            sb.AppendLine("运行中：" + (view.Running ? "是" : "否") + "，进程 " + view.Targets.Count + " 个，内存 " + Fmt.Bytes(view.PrivateBytes));
            foreach (var p in view.All)
                sb.AppendLine(string.Format("  {0,6} {1,-10} {2,-24} {3,9}  {4}", p.Pid, ProcessPlanner.RoleName(p.Role), p.Name, Fmt.Bytes(p.PrivateBytes),
                    Fmt.Shorten(p.CommandLine ?? p.Path ?? "", 160)));
            sb.AppendLine("Cowork 服务：" + Fmt.Service(P.GetServiceState(CoworkService)));
            sb.AppendLine();
            sb.AppendLine("系统时区：" + TzName(P.GetSystemTimeZoneId()));
            if (S.PendingTz != null) sb.AppendLine("临时时区：" + S.PendingTz.AppliedId + "，原为 " + S.PendingTz.OriginalId);
            var auto = P.AutoTimeZoneEnabled();
            sb.AppendLine("自动设置时区：" + (auto == null ? "未知" : auto.Value ? "开" : "关"));
            sb.AppendLine("系统代理：" + P.GetSystemProxy().Describe());
            var pol = P.ReadPolicy();
            sb.AppendLine("用户策略：" + (pol.User.Count == 0 ? "无" : string.Join("，", pol.User.Select(kv => kv.Key + "=" + Redact(kv.Key, kv.Value)))));
            sb.AppendLine("机器策略：" + (pol.Machine.Count == 0 ? "无" : string.Join("，", pol.Machine.Select(kv => kv.Key + "=" + Redact(kv.Key, kv.Value)))));
            sb.AppendLine();
            var prof = S.Selected;
            if (prof != null)
            {
                var spec = Preview(prof);
                sb.AppendLine("当前方案：" + prof.Name + "，代理 " + ProxyLogic.Describe(prof.Proxy) + "，时区 " + (prof.TimeZoneId.Length > 0 ? prof.TimeZoneId : "不修改"));
                sb.AppendLine("启动参数：" + spec.ArgString);
            }
            if (Install != null && Install.LogsDir.Length > 0)
            {
                var lines = LogTools.EgressLines(LogTools.Tail(Path.Combine(Install.LogsDir, "main.log"), 4000));
                if (lines.Count > 0)
                {
                    sb.AppendLine();
                    sb.AppendLine("main.log 里和代理有关的最近几行：");
                    foreach (var l in lines.Skip(Math.Max(0, lines.Count - 8))) sb.AppendLine("  " + Fmt.Shorten(l, 300));
                }
            }
            return sb.ToString();
        }

        static string Redact(string key, string value)
        {
            var k = key.ToLowerInvariant();
            if (k.Contains("key") || k.Contains("token") || k.Contains("secret") || k.Contains("password")) return "***";
            return value;
        }
    }

    public static class AppInfo
    {
        public const string Version = "1.0.0";
        public const string Name = "Claude Desktop 管理器";
    }
}
