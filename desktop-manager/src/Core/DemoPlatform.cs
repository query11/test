using System;
using System.Collections.Generic;
using System.Linq;

namespace ClaudeDesktopManager
{
    /// <summary>
    /// A pretend Windows with Claude Desktop installed from MSIX: drives the --demo window
    /// (screenshots on any OS) and the unit tests.
    /// </summary>
    public sealed class DemoPlatform : IPlatform
    {
        public const string PackageDir = @"C:\Program Files\WindowsApps\Claude_1.52386.6.0_x64__pzs8sxrjxfjjc";
        public string AppExe => PackageDir + @"\app\Claude.exe";

        public bool IsDemo => true;
        public string LocalAppData { get; set; } = @"C:\Users\Demo\AppData\Local";
        public string RoamingAppData { get; set; } = @"C:\Users\Demo\AppData\Roaming";
        public string DesktopDir { get; set; } = @"C:\Users\Demo\Desktop";
        public string DownloadsDir { get; set; } = @"C:\Users\Demo\Downloads";
        public string NativeArch { get; set; } = "x64";
        public string SelfExe => @"C:\Tools\ClaudeDesktopManager.exe";
        public int SelfPid => 4242;
        public int SessionId => 1;

        public readonly List<ProcInfo> Procs = new List<ProcInfo>();
        public readonly List<string> Calls = new List<string>();
        public string SystemTz = "China Standard Time";
        public bool? AutoTz = true;
        public ServiceState Cowork = ServiceState.Running;
        public SystemProxyInfo SysProxy = new SystemProxyInfo { Enabled = true, Server = "127.0.0.1:7890", Bypass = "localhost;127.*;<local>" };
        public readonly Dictionary<string, string> UserPolicy = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string, string> MachinePolicy = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public List<ClaudeInstall> InstallList;
        public string DataDir;

        /// <summary>Test knobs.</summary>
        public bool QuitOnClose;
        public int RespawnsLeft;
        public bool FailTimeZone;
        public bool FailPolicy;
        public bool FailLaunch;
        public readonly HashSet<string> Unkillable = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        public bool RunAtLogin;
        public InstallRights Rights = InstallRights.Consent;
        public SignatureInfo Signature = new SignatureInfo
        {
            Status = "Valid",
            Subject = "CN=\"Anthropic, PBC\", O=\"Anthropic, PBC\", L=San Francisco, S=California, C=US",
            Message = "签名已验证。",
        };
        /// <summary>What InstallPackage answers; null installs Claude.</summary>
        public CommandResult InstallAnswer;

        int nextPid = 9000;
        long clock = DateTime.UtcNow.AddMinutes(-48).ToFileTimeUtc();

        public DemoPlatform()
        {
            DataDir = LocalAppData + @"\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude";
            Add(4, 0, "System", null, console: null, session: 0);
            Add(780, 4, "services.exe", @"C:\Windows\System32\services.exe", console: false, session: 0);
            Add(3100, 3000, "explorer.exe", @"C:\Windows\explorer.exe", console: false);
            Add(SelfPid, 3100, "ClaudeDesktopManager.exe", SelfExe, console: false);
            var wt = Add(5200, 3100, "WindowsTerminal.exe", @"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.21_x64__8wekyb3d8bbwe\WindowsTerminal.exe", console: false);
            // Claude Code in a terminal: same file name, different place; must never be touched.
            Add(5300, wt.Pid, "claude.exe", @"C:\Users\Demo\.local\bin\claude.exe", console: true, cmd: "claude", mem: 180);
            Add(2950, 780, "cowork-svc.exe", PackageDir + @"\app\resources\cowork-svc.exe", console: true, session: 0, cmd: "cowork-svc.exe", mem: 14);
        }

        public ProcInfo Add(int pid, int ppid, string name, string path, bool? console, int session = 1, string cmd = null, long mem = 20)
        {
            var p = new ProcInfo
            {
                Pid = pid, ParentPid = ppid, Name = name, Path = path, IsConsole = console, SessionId = session,
                CommandLine = cmd ?? (path != null ? "\"" + path + "\"" : null),
                CreationTime = clock += 10_000_000, PrivateBytes = mem * 1024 * 1024, WorkingSet = mem * 1024 * 1024 * 3 / 2,
            };
            Procs.Add(p);
            return p;
        }

        int NewPid() => nextPid += 4;

        /// <summary>Claude running the way the MSIX build does, with a few MCP servers and a VS Code window it opened.</summary>
        public ProcInfo SeedRunning(string args = "")
        {
            var q = "\"" + AppExe + "\"";
            var main = Add(NewPid(), 3100, "Claude.exe", AppExe, false, cmd: q + (args.Length > 0 ? " " + args : ""), mem: 210);
            Add(NewPid(), main.Pid, "Claude.exe", AppExe, false, cmd: q + " --type=gpu-process --gpu-preferences=UAAAAAAAAADgAAAEAAAAAAAAAAAAAAAAAABgAAEAAAAAAAAA", mem: 160);
            Add(NewPid(), main.Pid, "Claude.exe", AppExe, false, cmd: q + " --type=utility --utility-sub-type=network.mojom.NetworkService --lang=zh-CN", mem: 38);
            Add(NewPid(), main.Pid, "Claude.exe", AppExe, false, cmd: q + " --type=utility --utility-sub-type=storage.mojom.StorageService", mem: 16);
            Add(NewPid(), main.Pid, "Claude.exe", AppExe, false, cmd: q + " --type=crashpad-handler --monitor-self-annotation=ptype=crashpad-handler", mem: 6);
            Add(NewPid(), main.Pid, "Claude.exe", AppExe, false, cmd: q + " --type=renderer --app-path=\"" + PackageDir + "\\app\\resources\\app.asar\" --renderer-client-id=5", mem: 420);
            Add(NewPid(), main.Pid, "Claude.exe", AppExe, false, cmd: q + " --type=renderer --renderer-client-id=7", mem: 95);
            var engine = Add(NewPid(), main.Pid, "claude.exe", DataDir + @"\claude-code\2.1.170\b7f3c2a91d0e\claude.exe", true,
                cmd: "claude.exe --output-format stream-json --verbose --input-format stream-json", mem: 230);
            var node = Add(NewPid(), main.Pid, "node.exe", @"C:\Program Files\nodejs\node.exe", true,
                cmd: "node.exe C:\\Users\\Demo\\AppData\\Roaming\\npm\\node_modules\\@modelcontextprotocol\\server-filesystem\\dist\\index.js C:\\Users\\Demo\\Documents", mem: 48);
            Add(NewPid(), node.Pid, "conhost.exe", @"C:\Windows\System32\conhost.exe", true, mem: 7);
            var uvx = Add(NewPid(), main.Pid, "uvx.exe", @"C:\Users\Demo\.local\bin\uvx.exe", true, cmd: "uvx.exe mcp-server-fetch", mem: 12);
            Add(NewPid(), uvx.Pid, "python.exe", @"C:\Users\Demo\AppData\Roaming\uv\python\cpython-3.12\python.exe", true, cmd: "python.exe -m mcp_server_fetch", mem: 61);
            var bash = Add(NewPid(), engine.Pid, "bash.exe", @"C:\Program Files\Git\usr\bin\bash.exe", true, cmd: "bash.exe -c \"npm run dev\"", mem: 9);
            Add(NewPid(), bash.Pid, "node.exe", @"C:\Program Files\nodejs\node.exe", true, cmd: "node.exe node_modules/vite/bin/vite.js", mem: 140);
            Add(NewPid(), engine.Pid, "Code.exe", @"C:\Users\Demo\AppData\Local\Programs\Microsoft VS Code\Code.exe", false, cmd: "Code.exe .", mem: 310);
            return main;
        }

        public List<ClaudeInstall> DetectInstalls()
        {
            if (InstallList != null) return InstallList;
            return new List<ClaudeInstall>
            {
                new ClaudeInstall
                {
                    Kind = InstallKind.Msix,
                    ExePath = AppExe,
                    Version = "1.52386.6.0",
                    PackageFullName = "Claude_1.52386.6.0_x64__pzs8sxrjxfjjc",
                    PackageFamilyName = "Claude_pzs8sxrjxfjjc",
                    Aumid = "Claude_pzs8sxrjxfjjc!Claude",
                    InstallDir = PackageDir,
                    DataDir = DataDir,
                    DataDirCandidates = { DataDir, RoamingAppData + @"\Claude" },
                },
            };
        }

        // The window's status timer and the start/stop operations run on different threads.
        public List<ProcInfo> Snapshot(KnownDirs dirs)
        {
            lock (Procs) return Procs.Select(p => p.Clone()).ToList();
        }

        public bool IsAlive(int pid, long creationTime)
        {
            lock (Procs) return Procs.Any(p => p.Pid == pid && (creationTime == 0 || p.CreationTime == creationTime));
        }

        public bool Terminate(ProcInfo target, out string error)
        {
            lock (Procs) return TerminateLocked(target, out error);
        }

        bool TerminateLocked(ProcInfo target, out string error)
        {
            error = null;
            var p = Procs.FirstOrDefault(x => x.Pid == target.Pid && (target.CreationTime == 0 || x.CreationTime == target.CreationTime));
            if (p == null) { error = "进程已不存在"; return false; }
            if (Unkillable.Contains(p.Name)) { error = "拒绝访问"; return false; }
            Calls.Add("kill " + p.Name + " " + p.Pid);
            Remove(p);
            return true;
        }

        void Remove(ProcInfo p)
        {
            Procs.Remove(p);
            bool isMain = p.Path == AppExe && (p.CommandLine ?? "").IndexOf("--type=", StringComparison.Ordinal) < 0;
            if (!isMain) return;
            // Chromium children sit in a job object that dies with the browser process; the
            // engine and MCP servers do not and are left behind as orphans.
            foreach (var c in Procs.Where(c => c.ParentPid == p.Pid && c.Path == AppExe).ToList()) Procs.Remove(c);
            if (RespawnsLeft > 0)
            {
                RespawnsLeft--;
                SeedRunning();
            }
        }

        public int CloseWindows(int pid)
        {
            lock (Procs) return CloseWindowsLocked(pid);
        }

        int CloseWindowsLocked(int pid)
        {
            Calls.Add("close " + pid);
            var p = Procs.FirstOrDefault(x => x.Pid == pid);
            if (p == null) return 0;
            if (QuitOnClose) Remove(p);
            return 1;
        }

        public LaunchResult Launch(ClaudeInstall install, LaunchSpec spec)
        {
            Calls.Add("launch " + spec.ArgString + (spec.Env.Count > 0 ? " env:" + string.Join(",", spec.Env.Keys.OrderBy(k => k)) : ""));
            if (FailLaunch) return new LaunchResult { Ok = false, Error = "模拟失败" };
            ProcInfo main;
            lock (Procs) main = SeedRunning(spec.ArgString);
            return new LaunchResult { Ok = true, Pid = main.Pid, Method = install.Kind == InstallKind.Msix ? "MSIX 激活" : "直接启动" };
        }

        public ServiceState GetServiceState(string name) => Cowork;

        public bool StopService(string name, int timeoutMs, out string error)
        {
            error = null;
            Calls.Add("service stop");
            Cowork = ServiceState.Stopped;
            lock (Procs) Procs.RemoveAll(p => p.Name == "cowork-svc.exe");
            return true;
        }

        public bool StartService(string name, out string error)
        {
            error = null;
            Calls.Add("service start");
            Cowork = ServiceState.Running;
            return true;
        }

        public string GetSystemTimeZoneId() => SystemTz;

        public List<TimeZoneEntry> ListTimeZones() => Zones;

        public bool SetSystemTimeZone(string id, out string error)
        {
            error = null;
            Calls.Add("tz " + id);
            if (FailTimeZone) { error = "拒绝访问"; return false; }
            SystemTz = id;
            return true;
        }

        public bool? AutoTimeZoneEnabled() => AutoTz;

        public PolicySnapshot ReadPolicy()
        {
            var s = new PolicySnapshot();
            foreach (var kv in UserPolicy) s.User[kv.Key] = kv.Value;
            foreach (var kv in MachinePolicy) s.Machine[kv.Key] = kv.Value;
            return s;
        }

        public bool WriteUserPolicy(IDictionary<string, string> values, out string error)
        {
            error = null;
            Calls.Add("policy " + string.Join(",", values.OrderBy(kv => kv.Key).Select(kv => kv.Key + "=" + (kv.Value ?? "<delete>"))));
            if (FailPolicy) { error = "用户取消了管理员授权"; return false; }
            foreach (var kv in values)
            {
                if (kv.Value == null) UserPolicy.Remove(kv.Key);
                else UserPolicy[kv.Key] = kv.Value;
            }
            return true;
        }

        public SystemProxyInfo GetSystemProxy() => SysProxy;

        public void OpenFolder(string path) => Calls.Add("open folder " + path);
        public void OpenInEditor(string path) => Calls.Add("edit " + path);
        public void OpenUri(string uri) => Calls.Add("open " + uri);

        public bool CreateShortcut(string lnkPath, string target, string arguments, string description, out string error)
        {
            error = null;
            Calls.Add("shortcut " + lnkPath + " -> " + arguments);
            return true;
        }

        public bool GetRunAtLogin() => RunAtLogin;

        public bool SetRunAtLogin(bool enable, out string error)
        {
            error = null;
            RunAtLogin = enable;
            return true;
        }

        public CommandResult RunPowerShell(string script, int timeoutMs)
        {
            Calls.Add("powershell " + script);
            return new CommandResult { ExitCode = 0, Output = "（演示模式，没有真的执行）" };
        }

        public InstallRights GetInstallRights() => Rights;

        public SignatureInfo CheckSignature(string file)
        {
            Calls.Add("signature " + System.IO.Path.GetFileName(file));
            return Signature;
        }

        public CommandResult InstallPackage(string file, int timeoutMs)
        {
            Calls.Add("install " + System.IO.Path.GetFileName(file));
            if (InstallAnswer != null) return InstallAnswer;
            // Back to the default: Claude from MSIX.
            InstallList = null;
            return new CommandResult { ExitCode = 0, Output = "OK" };
        }

        public static readonly List<TimeZoneEntry> Zones = new List<TimeZoneEntry>
        {
            Zone("Hawaiian Standard Time", "(UTC-10:00) 夏威夷", -10),
            Zone("Pacific Standard Time", "(UTC-08:00) 太平洋时间(美国和加拿大)", -8),
            Zone("Mountain Standard Time", "(UTC-07:00) 山地时间(美国和加拿大)", -7),
            Zone("Central Standard Time", "(UTC-06:00) 中部时间(美国和加拿大)", -6),
            Zone("Eastern Standard Time", "(UTC-05:00) 东部时间(美国和加拿大)", -5),
            Zone("UTC", "(UTC) 协调世界时", 0),
            Zone("GMT Standard Time", "(UTC+00:00) 都柏林，爱丁堡，里斯本，伦敦", 0),
            Zone("W. Europe Standard Time", "(UTC+01:00) 阿姆斯特丹，柏林，伯尔尼，罗马，斯德哥尔摩，维也纳", 1),
            Zone("India Standard Time", "(UTC+05:30) 钦奈，加尔各答，孟买，新德里", 5.5),
            Zone("Singapore Standard Time", "(UTC+08:00) 吉隆坡，新加坡", 8),
            Zone("China Standard Time", "(UTC+08:00) 北京，重庆，香港特别行政区，乌鲁木齐", 8),
            Zone("Taipei Standard Time", "(UTC+08:00) 台北", 8),
            Zone("Tokyo Standard Time", "(UTC+09:00) 大阪，札幌，东京", 9),
            Zone("Korea Standard Time", "(UTC+09:00) 首尔", 9),
            Zone("AUS Eastern Standard Time", "(UTC+10:00) 堪培拉，墨尔本，悉尼", 10),
        };

        static TimeZoneEntry Zone(string id, string name, double hours) =>
            new TimeZoneEntry { Id = id, DisplayName = name, BaseOffset = TimeSpan.FromHours(hours) };
    }
}
