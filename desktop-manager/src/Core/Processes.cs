using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace ClaudeDesktopManager
{
    public enum ProcRole
    {
        Other,
        /// <summary>Main Claude.exe (browser process).</summary>
        App,
        Renderer,
        Gpu,
        Utility,
        Crashpad,
        /// <summary>Node child of the main process (ELECTRON_RUN_AS_NODE extensions and the like).</summary>
        NodeChild,
        /// <summary>The Claude Code engine (claude.exe under …\claude-code\…).</summary>
        Engine,
        NativeHost,
        Updater,
        /// <summary>cowork-svc.exe, the CoworkVMService service.</summary>
        Service,
        OwnedOther,
        /// <summary>Command-line process started (directly or not) by Claude: MCP servers, shells, git…</summary>
        Child,
        /// <summary>Windowed program started by Claude (VS Code, Notepad…), never killed.</summary>
        Kept,
    }

    public sealed class ProcInfo
    {
        public int Pid, ParentPid;
        public int SessionId = -1;
        public string Name = "";
        public string Path;
        /// <summary>FILETIME (UTC, 100 ns since 1601), 0 when unknown.</summary>
        public long CreationTime;
        public long WorkingSet, PrivateBytes;
        public string CommandLine;
        /// <summary>PE subsystem is console (true), GUI (false) or could not be read (null).</summary>
        public bool? IsConsole;

        public ProcRole Role;
        public string Detail = "";

        public ProcInfo Clone() => (ProcInfo)MemberwiseClone();

        public DateTime? StartedLocal =>
            CreationTime > 0 ? DateTime.FromFileTimeUtc(CreationTime).ToLocalTime() : (DateTime?)null;

        public override string ToString() => Name + " (" + Pid + ")";
    }

    /// <summary>Recognises paths that belong to Claude Desktop (app, data, engine, updater).</summary>
    public sealed class KnownDirs
    {
        static readonly Regex PackagePath = new Regex(
            @"\\(?:WindowsApps|Packages)\\(?:Claude|Anthropic\.Claude(?:Desktop)?)_[^\\]*\\",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        readonly List<string> prefixes = new List<string>();

        public IReadOnlyList<string> Prefixes => prefixes;

        public KnownDirs(IEnumerable<string> dirs)
        {
            foreach (var d in dirs) Add(d);
        }

        public static KnownDirs ForUser(string localAppData, string roamingAppData, IEnumerable<string> extra = null)
        {
            var dirs = new List<string>();
            if (!string.IsNullOrEmpty(localAppData))
            {
                dirs.Add(Combine(localAppData, "AnthropicClaude"));
                dirs.Add(Combine(localAppData, "Claude-3p"));
            }
            if (!string.IsNullOrEmpty(roamingAppData))
            {
                dirs.Add(Combine(roamingAppData, "Claude"));
                dirs.Add(Combine(roamingAppData, "Claude-3p"));
            }
            if (extra != null) dirs.AddRange(extra);
            return new KnownDirs(dirs);
        }

        // Path.Combine would use '/' when the tests run on Linux; these are always Windows paths.
        static string Combine(string a, string b) => a.TrimEnd('\\', '/') + "\\" + b;

        public void Add(string dir)
        {
            if (string.IsNullOrWhiteSpace(dir)) return;
            var d = Normalize(dir);
            if (!d.EndsWith("\\", StringComparison.Ordinal)) d += "\\";
            // A drive root or something as broad as C:\Program Files\ would match half the machine.
            if (d.Length < 8 || d.Count(c => c == '\\') < 3) return;
            if (!prefixes.Contains(d, StringComparer.OrdinalIgnoreCase)) prefixes.Add(d);
        }

        public static string Normalize(string path) => (path ?? "").Replace('/', '\\').Trim();

        public bool IsOwned(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            var p = Normalize(path);
            if (PackagePath.IsMatch(p)) return true;
            foreach (var pre in prefixes)
                if (p.StartsWith(pre, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public static bool IsEnginePath(string path)
        {
            var p = Normalize(path).ToLowerInvariant();
            return p.Contains("\\claude-code\\") || p.Contains("\\claude-code-vm\\");
        }

        /// <summary>Same folder; unknown paths count as the same.</summary>
        public static bool IsSameDir(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return true;
            return string.Equals(DirOf(a), DirOf(b), StringComparison.OrdinalIgnoreCase);
        }

        static string DirOf(string path)
        {
            var p = Normalize(path);
            int i = p.LastIndexOf('\\');
            return i >= 0 ? p.Substring(0, i) : "";
        }
    }

    public sealed class KillOptions
    {
        public bool KillDescendants = true;
        public int SelfPid;
        /// <summary>Session of the current user; -1 = do not filter by session.</summary>
        public int SessionId = -1;
    }

    public sealed class ProcessView
    {
        /// <summary>Main Claude.exe processes in this session.</summary>
        public List<ProcInfo> Mains = new List<ProcInfo>();
        /// <summary>Everything to terminate, in order: main processes first, command-line children last.</summary>
        public List<ProcInfo> Targets = new List<ProcInfo>();
        public List<ProcInfo> Kept = new List<ProcInfo>();
        public List<ProcInfo> Services = new List<ProcInfo>();
        public List<ProcInfo> OtherSessions = new List<ProcInfo>();

        public bool Running => Mains.Count > 0;

        /// <summary>Everything worth listing in the UI.</summary>
        public IEnumerable<ProcInfo> All => Targets.Concat(Services).Concat(Kept).Concat(OtherSessions);

        public long PrivateBytes => Targets.Sum(p => p.PrivateBytes);
        public long WorkingSet => Targets.Sum(p => p.WorkingSet);
    }

    public static class ProcessPlanner
    {
        /// <summary>Never terminated even when they show up as Claude's children.</summary>
        static readonly HashSet<string> Protected = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "explorer.exe", "svchost.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe",
            "lsass.exe", "smss.exe", "dwm.exe", "sihost.exe", "taskhostw.exe", "runtimebroker.exe",
            "dllhost.exe", "werfault.exe", "wermgr.exe", "searchhost.exe", "startmenuexperiencehost.exe",
            "shellexperiencehost.exe", "textinputhost.exe", "ctfmon.exe", "fontdrvhost.exe", "audiodg.exe",
            "conhost.exe", "openconsole.exe", "consent.exe", "msedgewebview2.exe",
        };

        static readonly Dictionary<string, string> UtilityNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["network.mojom.NetworkService"] = "网络服务",
            ["storage.mojom.StorageService"] = "存储服务",
            ["audio.mojom.AudioService"] = "音频服务",
            ["video_capture.mojom.VideoCaptureService"] = "视频采集",
            ["node.mojom.NodeService"] = "Node 服务",
            ["data_decoder.mojom.DataDecoderService"] = "数据解码",
            ["proxy_resolver.mojom.ProxyResolverFactory"] = "PAC 解析",
            ["on_device_model.mojom.OnDeviceModelService"] = "本地模型",
        };

        public static string ArgValue(string commandLine, string name)
        {
            if (string.IsNullOrEmpty(commandLine)) return null;
            var m = Regex.Match(commandLine, "(?:^|\\s)\"?--" + Regex.Escape(name) + "=(\"[^\"]*\"|[^\\s\"]+)", RegexOptions.CultureInvariant);
            if (!m.Success) return null;
            return m.Groups[1].Value.Trim('"');
        }

        static bool IsAppExe(ProcInfo p) =>
            p.Name.Equals("claude.exe", StringComparison.OrdinalIgnoreCase) && !KnownDirs.IsEnginePath(p.Path);

        /// <summary>Role of a process whose path is Claude's.</summary>
        public static void ClassifyOwned(ProcInfo p, Func<int, ProcInfo> parentOf)
        {
            var name = p.Name ?? "";
            if (name.Equals("cowork-svc.exe", StringComparison.OrdinalIgnoreCase)) { p.Role = ProcRole.Service; p.Detail = "Cowork 虚拟机服务"; return; }
            if (name.Equals("update.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("squirrel.exe", StringComparison.OrdinalIgnoreCase))
            { p.Role = ProcRole.Updater; p.Detail = "更新程序"; return; }
            if (name.IndexOf("native-host", StringComparison.OrdinalIgnoreCase) >= 0) { p.Role = ProcRole.NativeHost; p.Detail = "浏览器扩展连接"; return; }
            if (KnownDirs.IsEnginePath(p.Path)) { p.Role = ProcRole.Engine; p.Detail = "Claude Code 引擎"; return; }
            if (!IsAppExe(p)) { p.Role = ProcRole.OwnedOther; p.Detail = "Claude 组件"; return; }

            var type = ArgValue(p.CommandLine, "type");
            if (type == null)
            {
                var parent = parentOf(p.ParentPid);
                bool parentIsApp = parent != null && IsAppExe(parent) && parent.Name.Equals(p.Name, StringComparison.OrdinalIgnoreCase)
                    && KnownDirs.IsSameDir(parent.Path, p.Path);
                if (parentIsApp) { p.Role = ProcRole.NodeChild; p.Detail = "Node 子进程（扩展等）"; }
                else { p.Role = ProcRole.App; p.Detail = "主进程"; }
                return;
            }
            switch (type)
            {
                case "renderer": p.Role = ProcRole.Renderer; p.Detail = "渲染进程"; break;
                case "gpu-process": p.Role = ProcRole.Gpu; p.Detail = "GPU 进程"; break;
                case "crashpad-handler": p.Role = ProcRole.Crashpad; p.Detail = "崩溃报告"; break;
                default:
                    p.Role = ProcRole.Utility;
                    var sub = ArgValue(p.CommandLine, "utility-sub-type");
                    p.Detail = sub != null && UtilityNames.TryGetValue(sub, out var n) ? n : "工具进程";
                    break;
            }
        }

        /// <summary>A child must have started after its parent, or the parent PID was reused.</summary>
        static bool IsChildOf(ProcInfo child, ProcInfo parent) =>
            child.ParentPid == parent.Pid && child.Pid != parent.Pid
            && (child.CreationTime == 0 || parent.CreationTime == 0 || child.CreationTime >= parent.CreationTime);

        public static ProcessView Plan(IList<ProcInfo> snapshot, KnownDirs dirs, KillOptions opt,
            IDictionary<int, long> extraParents = null)
        {
            var view = new ProcessView();
            var byPid = new Dictionary<int, ProcInfo>();
            foreach (var p in snapshot) byPid[p.Pid] = p;
            ProcInfo ParentOf(int pid) => byPid.TryGetValue(pid, out var q) ? q : null;

            var owned = new List<ProcInfo>();
            foreach (var p in snapshot)
            {
                p.Role = ProcRole.Other;
                p.Detail = "";
                if (p.Pid == opt.SelfPid || p.Pid == 0 || p.Pid == 4) continue;
                if (!dirs.IsOwned(p.Path)) continue;
                ClassifyOwned(p, ParentOf);
                if (p.Role == ProcRole.Service) { view.Services.Add(p); continue; }
                if (opt.SessionId >= 0 && p.SessionId >= 0 && p.SessionId != opt.SessionId)
                {
                    view.OtherSessions.Add(p);
                    continue;
                }
                owned.Add(p);
            }

            var children = new Dictionary<int, List<ProcInfo>>();
            foreach (var p in snapshot)
            {
                if (!children.TryGetValue(p.ParentPid, out var list)) children[p.ParentPid] = list = new List<ProcInfo>();
                list.Add(p);
            }

            var taken = new HashSet<int>(owned.Select(p => p.Pid));
            var descendants = new List<ProcInfo>();
            var queue = new Queue<ProcInfo>(owned);
            // Processes we already killed in an earlier pass count as parents too, so a child
            // orphaned by that kill is still recognised as Claude's.
            if (extraParents != null)
                foreach (var kv in extraParents)
                    if (!byPid.ContainsKey(kv.Key))
                        queue.Enqueue(new ProcInfo { Pid = kv.Key, CreationTime = kv.Value, Name = "(已结束)" });

            while (queue.Count > 0)
            {
                var parent = queue.Dequeue();
                if (!children.TryGetValue(parent.Pid, out var kids)) continue;
                foreach (var c in kids)
                {
                    if (taken.Contains(c.Pid) || !IsChildOf(c, parent)) continue;
                    if (c.Pid == opt.SelfPid || Protected.Contains(c.Name ?? "")) continue;
                    if (opt.SessionId >= 0 && c.SessionId >= 0 && c.SessionId != opt.SessionId) continue;
                    taken.Add(c.Pid);
                    if (c.IsConsole == true)
                    {
                        c.Role = ProcRole.Child;
                        c.Detail = ChildDetail(c);
                        if (opt.KillDescendants) descendants.Add(c);
                        else
                        {
                            c.Detail += "（设置为不结束子进程）";
                            view.Kept.Add(c);
                        }
                        queue.Enqueue(c);
                    }
                    else
                    {
                        c.Role = ProcRole.Kept;
                        c.Detail = c.IsConsole == false ? "窗口程序，保留" : "无法判断类型，保留";
                        view.Kept.Add(c);
                    }
                }
            }

            view.Mains.AddRange(owned.Where(p => p.Role == ProcRole.App).OrderBy(p => p.CreationTime));
            view.Targets.AddRange(view.Mains);
            view.Targets.AddRange(owned.Where(p => p.Role == ProcRole.Engine));
            view.Targets.AddRange(owned.Where(p => p.Role != ProcRole.App && p.Role != ProcRole.Engine).OrderBy(p => p.Role));
            view.Targets.AddRange(descendants);
            return view;
        }

        static string ChildDetail(ProcInfo c)
        {
            var n = (c.Name ?? "").ToLowerInvariant();
            if (n == "node.exe" || n == "npx.exe" || n == "uv.exe" || n == "uvx.exe" || n.StartsWith("python", StringComparison.Ordinal)
                || n == "docker.exe" || n == "bun.exe" || n == "deno.exe")
                return "MCP 服务器 / 脚本";
            if (n == "cmd.exe" || n == "powershell.exe" || n == "pwsh.exe" || n == "bash.exe" || n == "sh.exe" || n == "wsl.exe")
                return "命令行 / Shell";
            if (n == "git.exe") return "git";
            return "命令行子进程";
        }

        public static string RoleName(ProcRole r)
        {
            switch (r)
            {
                case ProcRole.App: return "主进程";
                case ProcRole.Renderer: return "渲染";
                case ProcRole.Gpu: return "GPU";
                case ProcRole.Utility: return "工具";
                case ProcRole.Crashpad: return "崩溃报告";
                case ProcRole.NodeChild: return "Node";
                case ProcRole.Engine: return "Claude Code";
                case ProcRole.NativeHost: return "扩展连接";
                case ProcRole.Updater: return "更新";
                case ProcRole.Service: return "服务";
                case ProcRole.OwnedOther: return "组件";
                case ProcRole.Child: return "子进程";
                case ProcRole.Kept: return "保留";
                default: return "其他";
            }
        }
    }
}
