using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    static class Program
    {
        const string MutexName = @"Local\ClaudeDesktopManager";
        const string ShowEventName = @"Local\ClaudeDesktopManager.Show";

        public static bool IsWindows => Environment.OSVersion.Platform == PlatformID.Win32NT;

        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length >= 2 && args[0] == "--elevated-policy") return WindowsPlatform.ElevatedPolicyMain(args[1]);

            bool demo = args.Contains("--demo");
            var command = args.FirstOrDefault(a => !a.StartsWith("-", StringComparison.Ordinal) && !IsOptionValue(args, a));
            if (!demo && !IsWindows)
            {
                Console.Error.WriteLine("这个程序只能在 Windows 上运行（其他系统上可以用 --demo 看界面）。");
                return 2;
            }

            IPlatform platform;
            string settingsPath;
            if (demo) platform = DemoSetup.Create(out settingsPath);
            else
            {
                platform = new WindowsPlatform();
                settingsPath = SettingsStore.DefaultPath(Path.GetDirectoryName(Application.ExecutablePath), platform.RoamingAppData);
            }
            var store = new SettingsStore(settingsPath);
            store.Load();
            var manager = new Manager(platform, store);
            if (!demo) manager.LogFile = Path.Combine(Path.GetDirectoryName(settingsPath) ?? "", "manager.log");

            if (command != null) return Cli.Run(manager, command.ToLowerInvariant(), args);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Kit.Init();
            int tab = 0;
            int.TryParse(ArgAfter(args, "--tab") ?? "0", NumberStyles.Integer, CultureInfo.InvariantCulture, out tab);

            if (demo)
            {
                var form = new MainForm(manager, false, tab);
                var size = (ArgAfter(args, "--size") ?? "").Split('x');
                if (size.Length == 2 && int.TryParse(size[0], out var w) && int.TryParse(size[1], out var h))
                {
                    form.StartPosition = FormStartPosition.Manual;
                    form.Location = new System.Drawing.Point(0, 0);
                    form.Size = new System.Drawing.Size(w, h);
                }
                var shots = ArgAfter(args, "--screenshot");
                if (shots != null)
                {
                    var t = new System.Windows.Forms.Timer { Interval = 2500 };
                    t.Tick += (s, e) =>
                    {
                        t.Stop();
                        form.SaveScreenshots(shots);
                        Application.Exit();
                    };
                    form.Shown += (s, e) => t.Start();
                }
                Application.Run(form);
                return 0;
            }

            using (var mutex = new Mutex(true, MutexName, out bool first))
            {
                if (!first)
                {
                    // Already running (probably in the tray): bring that window up instead.
                    try
                    {
                        if (EventWaitHandle.TryOpenExisting(ShowEventName, out var ev))
                            using (ev) ev.Set();
                    }
                    catch (Exception) { }
                    return 0;
                }
                Native.SetCurrentProcessExplicitAppUserModelID("ClaudeDesktopManager");
                var form = new MainForm(manager, args.Contains("--tray"), tab);
                using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName))
                {
                    var waiter = new Thread(() =>
                    {
                        try
                        {
                            while (show.WaitOne())
                                form.BeginInvoke(new Action(form.ShowFromTray));
                        }
                        catch (Exception) { /* exiting */ }
                    }) { IsBackground = true };
                    waiter.Start();
                    Application.Run(form);
                }
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        public static bool GuiRunning()
        {
            try
            {
                if (Mutex.TryOpenExisting(MutexName, out var m))
                {
                    m.Dispose();
                    return true;
                }
            }
            catch (Exception) { }
            return false;
        }

        static readonly string[] OptionsWithValue = { "--profile", "--tab", "--screenshot", "--out", "--size" };

        static bool IsOptionValue(string[] args, string a)
        {
            int i = Array.IndexOf(args, a);
            return i > 0 && OptionsWithValue.Contains(args[i - 1]);
        }

        public static string ArgAfter(string[] args, string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }
    }

    /// <summary>Command-line mode, used by the desktop shortcuts.</summary>
    static class Cli
    {
        public static int Run(Manager m, string command, string[] args)
        {
            bool console = Program.IsWindows && Native.AttachConsole(Native.ATTACH_PARENT_PROCESS);
            var outFile = Program.ArgAfter(args, "--out");
            var output = new StringBuilder();
            Action<string> print = line =>
            {
                output.AppendLine(line);
                if (console || !Program.IsWindows) Console.WriteLine(line);
            };
            if (console) Console.WriteLine();

            int code;
            try { code = Execute(m, command, args, print); }
            catch (Exception e)
            {
                print("出错：" + e.Message);
                code = 1;
            }

            if (outFile != null)
            {
                try { File.WriteAllText(outFile, output.ToString(), new UTF8Encoding(false)); } catch (Exception) { }
            }
            else if (code != 0 && !console && Program.IsWindows && !m.P.IsDemo)
            {
                // Started from a shortcut: nobody sees stdout.
                MessageBox.Show(output.ToString(), AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            return code;
        }

        static int Execute(Manager m, string command, string[] args, Action<string> print)
        {
            var profile = Program.ArgAfter(args, "--profile");
            if (profile != null && m.S.FindProfile(profile) == null)
            {
                print("没有叫「" + profile + "」的方案。现有方案：" + string.Join("、", m.S.Profiles.Select(p => p.Name)));
                return 2;
            }
            var name = profile ?? m.S.SelectedProfile;
            OpResult r;
            switch (command)
            {
                case "start":
                case "restart":
                    m.RefreshInstall();
                    r = m.Start(name, restartIfRunning: command == "restart");
                    // Someone has to put the time zone back once Claude quits: leave the manager in the tray.
                    if (r.Ok && m.S.PendingTz != null && !m.P.IsDemo && !Program.GuiRunning())
                    {
                        try { System.Diagnostics.Process.Start(m.P.SelfExe, "--tray"); } catch (Exception) { }
                    }
                    break;
                case "stop":
                    m.RefreshInstall();
                    r = m.Stop(force: false);
                    break;
                case "kill":
                    m.RefreshInstall();
                    r = m.Stop(force: true);
                    break;
                case "restore-tz":
                    r = m.RestoreTimeZone();
                    break;
                case "status":
                    return Status(m, print);
                case "selftest":
                    return SelfTest.Run(m, print);
                case "help":
                case "/?":
                    Usage(print);
                    return 0;
                default:
                    print("不认识的命令：" + command);
                    Usage(print);
                    return 2;
            }
            foreach (var line in r.Lines) print(line);
            return r.Ok ? 0 : 1;
        }

        static int Status(Manager m, Action<string> print)
        {
            var view = m.Scan();
            m.RefreshInstall(view);
            print("安装：" + (m.Install == null ? "未找到" : m.Install.Summary + "  " + m.Install.ExePath));
            if (view.Running)
            {
                var main = view.Mains.First();
                print("状态：正在运行，主进程 PID " + main.Pid + "，共 " + view.Targets.Count + " 个进程，内存 " + Fmt.Bytes(view.PrivateBytes));
                print("命令行：" + (main.CommandLine ?? "（读不到）"));
            }
            else print("状态：未运行" + (view.Targets.Count > 0 ? "（有 " + view.Targets.Count + " 个残留进程）" : ""));
            print("Cowork 服务：" + Fmt.Service(m.P.GetServiceState(Manager.CoworkService)));
            print("系统时区：" + m.P.GetSystemTimeZoneId() + (m.S.PendingTz != null ? "（临时，原为 " + m.S.PendingTz.OriginalId + "）" : ""));
            print("当前方案：" + m.S.SelectedProfile);
            return 0;
        }

        static void Usage(Action<string> print)
        {
            print(AppInfo.Name + " " + AppInfo.Version);
            print("用法：ClaudeDesktopManager.exe [命令] [--profile 方案名]");
            print("  （不带命令）   打开管理窗口；加 --tray 只在托盘运行");
            print("  start          用方案启动 Claude（已在运行则不动）");
            print("  restart        关闭后用方案重新启动");
            print("  stop           关闭 Claude：先正常退出，再结束残留进程");
            print("  kill           立即结束 Claude 的全部进程");
            print("  status         显示状态");
            print("  restore-tz     恢复被临时切换的系统时区");
        }
    }

    /// <summary>Fake data for --demo (screenshots on any OS).</summary>
    static class DemoSetup
    {
        public static IPlatform Create(out string settingsPath)
        {
            var dir = Path.Combine(Path.GetTempPath(), "cdm-demo");
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            var data = Path.Combine(dir, "Claude");
            Directory.CreateDirectory(Path.Combine(data, "logs"));
            Directory.CreateDirectory(Path.Combine(data, "Cache", "Cache_Data"));
            File.WriteAllBytes(Path.Combine(data, "Cache", "Cache_Data", "data_1"), new byte[3 * 1024 * 1024]);
            Directory.CreateDirectory(Path.Combine(data, "GPUCache"));
            File.WriteAllBytes(Path.Combine(data, "GPUCache", "data_0"), new byte[512 * 1024]);
            File.WriteAllText(Path.Combine(data, "claude_desktop_config.json"),
                "{\n  \"mcpServers\": {\n    \"filesystem\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"C:\\\\Users\\\\Demo\\\\Documents\"]\n    },\n" +
                "    \"fetch\": {\n      \"command\": \"uvx\",\n      \"args\": [\"mcp-server-fetch\"],\n      \"env\": { \"HTTPS_PROXY\": \"http://127.0.0.1:7890\" }\n    },\n" +
                "    \"github\": {\n      \"type\": \"http\",\n      \"url\": \"https://api.githubcopilot.com/mcp/\"\n    }\n  },\n  \"preferences\": {\n    \"menuBarEnabled\": false\n  }\n}\n");
            var now = DateTime.Now;
            File.WriteAllText(Path.Combine(data, "logs", "main.log"), string.Join("\n", new[]
            {
                now.AddMinutes(-12).ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " [info] Starting app { version: '1.52386.6', isPackaged: true }",
                now.AddMinutes(-12).ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " [info] [egress-proxy] pinned to fixed proxy at 127.0.0.1:7890; OS proxy settings ignored",
                now.AddMinutes(-11).ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " [info] Resolved system proxy for Code sessions: http://127.0.0.1:7890",
                now.AddMinutes(-11).ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " [info] MCP server filesystem: connected",
                now.AddMinutes(-3).ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " [info] Window focused",
            }) + "\n");
            File.WriteAllText(Path.Combine(data, "logs", "mcp.log"), "[filesystem] Server started and connected successfully\n");

            var d = new DemoPlatform();
            d.InstallList = new List<ClaudeInstall>
            {
                new ClaudeInstall
                {
                    Kind = InstallKind.Msix,
                    ExePath = d.AppExe,
                    Version = "1.52386.6.0",
                    PackageFullName = "Claude_1.52386.6.0_x64__pzs8sxrjxfjjc",
                    PackageFamilyName = "Claude_pzs8sxrjxfjjc",
                    Aumid = "Claude_pzs8sxrjxfjjc!Claude",
                    InstallDir = DemoPlatform.PackageDir,
                    DataDir = data,
                    DataDirCandidates = { data },
                },
            };
            d.SeedRunning("--proxy-server=http://127.0.0.1:7890 --proxy-bypass-list=<local> --lang=en-US");
            d.SystemTz = "Pacific Standard Time";
            d.UserPolicy[ProxyLogic.PolicyUrlKey] = "http://127.0.0.1:7890";

            settingsPath = Path.Combine(dir, "settings.json");
            var s = Settings.CreateDefault();
            s.Profiles.Add(new Profile
            {
                Name = "美国西部 · 代理",
                Proxy = new ProxySettings { Mode = ProxyMode.Manual, Scheme = "http", Host = "127.0.0.1", Port = 7890, ViaPolicy = true },
                TimeZoneId = "Pacific Standard Time",
                Lang = "en-US",
            });
            s.SelectedProfile = "美国西部 · 代理";
            s.PendingTz = new PendingTimeZone { OriginalId = "China Standard Time", AppliedId = "Pacific Standard Time", SetAtUtc = DateTime.UtcNow.AddMinutes(-12) };
            s.PolicyWrittenByUs = true;
            s.McpStash.Set(KnownDirs.Normalize(Path.Combine(data, "claude_desktop_config.json")).ToLowerInvariant(),
                new JsonObject().Set("sqlite", new JsonObject().Set("command", "uvx").Set("args", new List<object> { "mcp-server-sqlite", "--db-path", "C:\\data\\app.db" })));
            var store = new SettingsStore(settingsPath);
            store.Replace(s);
            store.Save();
            return d;
        }
    }
}
