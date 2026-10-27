using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace ClaudeDesktopManager.Tests
{
    static class PlannerTests
    {
        static KillOptions Opt(DemoPlatform d, bool children = true) =>
            new KillOptions { KillDescendants = children, SelfPid = d.SelfPid, SessionId = d.SessionId };

        static KnownDirs Dirs(DemoPlatform d) =>
            KnownDirs.ForUser(d.LocalAppData, d.RoamingAppData, d.DetectInstalls().SelectMany(i => i.DataDirCandidates));

        [Test]
        public static void ClassifiesARunningClaude()
        {
            var d = new DemoPlatform();
            var main = d.SeedRunning("--proxy-server=http://127.0.0.1:7890");
            var v = ProcessPlanner.Plan(d.Snapshot(null), Dirs(d), Opt(d));
            Assert.True(v.Running);
            Assert.Equal(main.Pid, v.Mains.Single().Pid);
            Assert.Equal(main.Pid, v.Targets[0].Pid, "主进程排第一");
            var roles = v.Targets.GroupBy(p => p.Role).ToDictionary(g => g.Key, g => g.Count());
            Assert.Equal(2, roles[ProcRole.Renderer]);
            Assert.Equal(1, roles[ProcRole.Gpu]);
            Assert.Equal(2, roles[ProcRole.Utility]);
            Assert.Equal(1, roles[ProcRole.Crashpad]);
            Assert.Equal(1, roles[ProcRole.Engine]);
            Assert.Equal(5, roles[ProcRole.Child]);
            Assert.Equal("网络服务", v.Targets.Single(p => p.Role == ProcRole.Utility && p.CommandLine.Contains("network")).Detail);
            Assert.Seq(new[] { "Code.exe" }, v.Kept.Select(p => p.Name));
            Assert.Seq(new[] { "cowork-svc.exe" }, v.Services.Select(p => p.Name));
            var names = v.All.Select(p => p.Path ?? "").ToList();
            Assert.False(names.Contains(@"C:\Users\Demo\.local\bin\claude.exe"), "终端里的 Claude Code 不算");
            Assert.False(v.All.Any(p => p.Name == "conhost.exe"), "conhost 不动");
            Assert.False(v.All.Any(p => p.Pid == d.SelfPid), "不含自己");
            Assert.True(v.PrivateBytes > 1000L * 1024 * 1024, "内存合计");
        }

        [Test]
        public static void ReusedParentPidIsNotAChild()
        {
            var d = new DemoPlatform();
            var main = d.SeedRunning();
            // Started before Claude, but its (long dead) parent had the PID Claude has now.
            var old = d.Add(7000, main.Pid, "node.exe", @"C:\Program Files\nodejs\node.exe", true);
            old.CreationTime = main.CreationTime - 1;
            var v = ProcessPlanner.Plan(d.Snapshot(null), Dirs(d), Opt(d));
            Assert.False(v.Targets.Any(p => p.Pid == 7000), "PID 复用");
        }

        [Test]
        public static void OtherSessionsAndKeepChildrenOption()
        {
            var d = new DemoPlatform();
            d.SeedRunning();
            d.Add(8000, 3100, "Claude.exe", d.AppExe, false, session: 2);
            var v = ProcessPlanner.Plan(d.Snapshot(null), Dirs(d), Opt(d, children: false));
            Assert.Seq(new[] { 8000 }, v.OtherSessions.Select(p => p.Pid));
            Assert.Equal(1, v.Mains.Count);
            Assert.False(v.Targets.Any(p => p.Role == ProcRole.Child), "不结束子进程");
            Assert.True(v.Kept.Count(p => p.Role == ProcRole.Child) == 5, "子进程列为保留");
        }

        [Test]
        public static void UnknownSubsystemIsKept()
        {
            var d = new DemoPlatform();
            var main = d.SeedRunning();
            d.Add(7100, main.Pid, "mystery.exe", null, null);
            var v = ProcessPlanner.Plan(d.Snapshot(null), Dirs(d), Opt(d));
            Assert.True(v.Kept.Any(p => p.Pid == 7100), "看不出类型的保留");
        }

        [Test]
        public static void KnownDirsMatching()
        {
            var dirs = KnownDirs.ForUser(@"C:\Users\A\AppData\Local", @"C:\Users\A\AppData\Roaming");
            Assert.True(dirs.IsOwned(@"C:\Program Files\WindowsApps\Claude_1.2.3.0_x64__pzs8sxrjxfjjc\app\Claude.exe"));
            Assert.True(dirs.IsOwned(@"D:\WindowsApps\Claude_1.2.3.0_arm64__pzs8sxrjxfjjc\app\Claude.exe"), "应用装在别的盘");
            Assert.True(dirs.IsOwned(@"c:\users\a\appdata\local\packages\claude_pzs8sxrjxfjjc\localcache\roaming\claude\claude-code\2.1\x\claude.exe"));
            Assert.True(dirs.IsOwned(@"C:\Users\A\AppData\Local\AnthropicClaude\app-0.14.10\claude.exe"));
            Assert.True(dirs.IsOwned(@"C:\Users\A\AppData\Roaming\Claude\claude-code\2.1.170\abc\claude.exe"));
            Assert.True(dirs.IsOwned(@"C:\Program Files\WindowsApps\Anthropic.ClaudeDesktop_1.0.0.0_x64__h6f0761\app\Claude.exe"));
            Assert.False(dirs.IsOwned(@"C:\Users\A\.local\bin\claude.exe"), "Claude Code CLI");
            Assert.False(dirs.IsOwned(@"C:\Program Files\WindowsApps\Anthropic.ClaudeCode_2.1.0.0_x64__abc\claude.exe"), "WinGet 的 Claude Code");
            Assert.False(dirs.IsOwned(@"C:\Program Files\WindowsApps\ClaudeCode_1.0_x64__abc\claude.exe"));
            Assert.False(dirs.IsOwned(@"C:\Users\A\AppData\Roaming\Claude Code\x.exe"), "目录名要完全一致");
            Assert.False(dirs.IsOwned(@"C:\Users\A\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js"));
            Assert.False(dirs.IsOwned(null));
            Assert.True(KnownDirs.IsEnginePath(@"C:\x\Claude\claude-code\2.1\b\claude.exe"));
            var tooBroad = new KnownDirs(new[] { @"C:\", @"C:\Program Files" });
            Assert.Equal(0, tooBroad.Prefixes.Count);
        }

        [Test]
        public static void ArgValueParsing()
        {
            Assert.Equal("renderer", ProcessPlanner.ArgValue("\"C:\\a b\\Claude.exe\" --type=renderer --x", "type"));
            Assert.Equal("utility", ProcessPlanner.ArgValue("x \"--type=utility\"", "type"));
            Assert.Null(ProcessPlanner.ArgValue("x --no-type=renderer", "type"));
            Assert.Null(ProcessPlanner.ArgValue(null, "type"));
        }
    }

    static class ManagerTests
    {
        sealed class Rig : IDisposable
        {
            public readonly TempDir Dir = new TempDir();
            public readonly DemoPlatform P = new DemoPlatform();
            public readonly Manager M;
            long now;

            public Rig()
            {
                var store = new SettingsStore(Dir.File("settings.json"));
                store.Load();
                M = new Manager(P, store) { LaunchWaitMs = 3000 };
                M.NowMs = () => now;
                M.Sleep = ms => now += ms;
                M.RefreshInstall();
            }

            public Profile Profile(string name, Action<Profile> edit)
            {
                var p = new Profile { Name = name };
                edit(p);
                M.S.Profiles.Add(p);
                return p;
            }

            public bool ClaudeLeft => P.Procs.Any(p => M.Dirs.IsOwned(p.Path) && p.Name != "cowork-svc.exe");

            public void Dispose() => Dir.Dispose();
        }

        [Test]
        public static void StartWithProxyAndTimeZone()
        {
            using (var r = new Rig())
            {
                r.Profile("美国", p =>
                {
                    p.Proxy = new ProxySettings { Mode = ProxyMode.Manual, Host = "127.0.0.1", Port = 7890 };
                    p.TimeZoneId = "Pacific Standard Time";
                });
                r.P.Cowork = ServiceState.Stopped;
                var res = r.M.Start("美国", restartIfRunning: false);
                Assert.True(res.Ok, res.Text);
                Assert.Equal("Pacific Standard Time", r.P.SystemTz);
                Assert.Equal("China Standard Time", r.M.S.PendingTz.OriginalId);
                Assert.Contains("launch --proxy-server=http://127.0.0.1:7890 --proxy-bypass-list=<local>", string.Join("\n", r.P.Calls));
                Assert.Contains("启动参数已生效", res.Text);
                Assert.Contains("自动设置时区", res.Text);
                Assert.Equal(ServiceState.Running, r.P.Cowork);
                var saved = new SettingsStore(r.Dir.File("settings.json")).Load();
                Assert.Equal("China Standard Time", saved.PendingTz.OriginalId);
                Assert.False(r.P.Calls.Any(c => c.StartsWith("policy", StringComparison.Ordinal)), "没勾选策略就不碰注册表");
            }
        }

        [Test]
        public static void StopKillsEverythingButWindowsAndRestoresTimeZone()
        {
            using (var r = new Rig())
            {
                r.Profile("东京", p => p.TimeZoneId = "Tokyo Standard Time");
                r.M.Start("东京", false);
                Assert.Equal("Tokyo Standard Time", r.P.SystemTz);
                var res = r.M.Stop(force: true);
                Assert.True(res.Ok, res.Text);
                Assert.False(r.ClaudeLeft, "Claude 的进程都结束了");
                Assert.False(r.P.Procs.Any(p => p.Name == "python.exe" || p.Name == "uvx.exe" || p.Name == "bash.exe"), "孤儿 MCP 进程也结束了");
                Assert.True(r.P.Procs.Any(p => p.Name == "Code.exe"), "VS Code 保留");
                Assert.True(r.P.Procs.Any(p => p.Path == @"C:\Users\Demo\.local\bin\claude.exe"), "终端里的 Claude Code 保留");
                Assert.Equal(ServiceState.Stopped, r.P.Cowork);
                Assert.Equal("China Standard Time", r.P.SystemTz);
                Assert.Null(r.M.S.PendingTz);
                Assert.Contains("保留了 Claude 打开的窗口程序：Code.exe", res.Text);
                Assert.False(r.P.Calls.Any(c => c.StartsWith("close", StringComparison.Ordinal)), "强制结束不发关闭消息");
            }
        }

        [Test]
        public static void GracefulCloseThenCleanup()
        {
            using (var r = new Rig())
            {
                r.P.SeedRunning();
                r.P.QuitOnClose = true;
                var res = r.M.Stop(force: false);
                Assert.True(res.Ok, res.Text);
                Assert.True(r.P.Calls.Any(c => c.StartsWith("close", StringComparison.Ordinal)), "先发关闭消息");
                Assert.Contains("正常退出", res.Text);
                Assert.False(r.ClaudeLeft);
                Assert.False(r.P.Procs.Any(p => p.Name == "python.exe"), "正常退出后留下的子进程也清理");
            }
        }

        [Test]
        public static void GracefulTimeoutFallsBackToForce()
        {
            using (var r = new Rig())
            {
                r.P.SeedRunning();
                r.M.S.Options.GracefulTimeoutSec = 2;
                var res = r.M.Stop(force: false);
                Assert.False(r.ClaudeLeft, res.Text);
                Assert.NotContains("正常退出", res.Text);
            }
        }

        [Test]
        public static void RespawnedProcessesAreKilledToo()
        {
            using (var r = new Rig())
            {
                r.P.SeedRunning();
                r.P.RespawnsLeft = 2;
                var res = r.M.Stop(force: true);
                Assert.False(r.ClaudeLeft, res.Text);
                Assert.Contains("自动重启", res.Text);
            }
        }

        [Test]
        public static void UnkillableIsReported()
        {
            using (var r = new Rig())
            {
                r.P.SeedRunning();
                r.P.Unkillable.Add("python.exe");
                var res = r.M.Stop(force: true);
                Assert.Contains("没能结束", res.Text);
                Assert.Contains("python.exe", res.Text);
            }
        }

        [Test]
        public static void StartWhenRunning()
        {
            using (var r = new Rig())
            {
                r.Profile("东京", p => p.TimeZoneId = "Tokyo Standard Time");
                r.Profile("东京2", p => { p.TimeZoneId = "Tokyo Standard Time"; p.DisableGpu = true; });
                r.M.Start("东京", false);
                var again = r.M.Start("东京", false);
                Assert.True(again.AlreadyRunning);
                Assert.Equal(1, r.P.Calls.Count(c => c.StartsWith("launch", StringComparison.Ordinal)));

                r.P.Calls.Clear();
                var restart = r.M.Start("东京2", restartIfRunning: true);
                Assert.True(restart.Ok, restart.Text);
                Assert.False(r.P.Calls.Any(c => c.StartsWith("tz ", StringComparison.Ordinal)), "重启时同一时区不来回切：" + string.Join(" | ", r.P.Calls));
                Assert.Contains("launch --disable-gpu", string.Join("\n", r.P.Calls));
                Assert.Equal("China Standard Time", r.M.S.PendingTz.OriginalId);
                Assert.Equal(1, r.M.Scan().Mains.Count);
            }
        }

        [Test]
        public static void SwitchingToProfileWithoutTimeZoneRestores()
        {
            using (var r = new Rig())
            {
                r.Profile("东京", p => p.TimeZoneId = "Tokyo Standard Time");
                r.M.Start("东京", false);
                r.M.Start("默认", restartIfRunning: true);
                Assert.Equal("China Standard Time", r.P.SystemTz);
                Assert.Null(r.M.S.PendingTz);
            }
        }

        [Test]
        public static void UserChangedTimeZoneIsRespected()
        {
            using (var r = new Rig())
            {
                r.Profile("东京", p => p.TimeZoneId = "Tokyo Standard Time");
                r.M.Start("东京", false);
                r.P.SystemTz = "Singapore Standard Time";
                var res = r.M.Stop(true);
                Assert.Equal("Singapore Standard Time", r.P.SystemTz);
                Assert.Null(r.M.S.PendingTz);
                Assert.Contains("不再自动恢复", res.Text);

                // A new switch remembers the zone the user picked as the original.
                r.M.Start("东京", false);
                Assert.Equal("Singapore Standard Time", r.M.S.PendingTz.OriginalId);
            }
        }

        [Test]
        public static void ChangedWhileRunningBecomesTheOriginal()
        {
            using (var r = new Rig())
            {
                r.Profile("东京", p => p.TimeZoneId = "Tokyo Standard Time");
                r.Profile("纽约", p => p.TimeZoneId = "Eastern Standard Time");
                r.M.Start("东京", false);
                r.P.SystemTz = "Singapore Standard Time";
                r.M.Start("纽约", true);
                Assert.Equal("Singapore Standard Time", r.M.S.PendingTz.OriginalId);
                r.M.Stop(true);
                Assert.Equal("Singapore Standard Time", r.P.SystemTz);
            }
        }

        [Test]
        public static void FailedTimeZoneSwitchLeavesNothingPending()
        {
            using (var r = new Rig())
            {
                r.Profile("东京", p => p.TimeZoneId = "Tokyo Standard Time");
                r.P.FailTimeZone = true;
                var res = r.M.Start("东京", false);
                Assert.Null(r.M.S.PendingTz);
                Assert.Contains("切换系统时区失败", res.Text);
                Assert.True(r.M.Scan().Running, "时区失败也照样启动");
            }
        }

        [Test]
        public static void TickRestoresAfterClaudeExits()
        {
            using (var r = new Rig())
            {
                r.Profile("东京", p => p.TimeZoneId = "Tokyo Standard Time");
                r.M.Start("东京", false);
                r.M.OnTick(r.M.Scan());
                // Claude quits on its own (window closed, tray Quit…).
                r.P.Procs.RemoveAll(p => r.M.Dirs.IsOwned(p.Path) && p.Name != "cowork-svc.exe");
                r.M.OnTick(r.M.Scan());
                r.M.OnTick(r.M.Scan());
                Assert.Equal("Tokyo Standard Time", r.P.SystemTz, "两次还不算");
                r.M.OnTick(r.M.Scan());
                Assert.Equal("China Standard Time", r.P.SystemTz);
                Assert.Null(r.M.S.PendingTz);
            }
        }

        [Test]
        public static void TrayInstancePicksUpSwitchMadeFromShortcut()
        {
            using (var r = new Rig())
            {
                r.Profile("东京", p => p.TimeZoneId = "Tokyo Standard Time");
                r.M.SaveSettings();
                // The desktop shortcut runs a second copy on the same settings file.
                var cliStore = new SettingsStore(r.Dir.File("settings.json"));
                cliStore.Load();
                long t = 0;
                var cli = new Manager(r.P, cliStore) { LaunchWaitMs = 3000, NowMs = () => t, Sleep = ms => t += ms };
                cli.RefreshInstall();
                cli.Start("东京", false);
                Assert.Equal("Tokyo Standard Time", r.P.SystemTz);
                Assert.Null(r.M.S.PendingTz, "托盘里的实例还不知道");

                r.M.OnTick(r.M.Scan());
                Assert.Equal("China Standard Time", r.M.S.PendingTz?.OriginalId, "下一次刷新就同步过来");
                r.P.Procs.RemoveAll(p => r.M.Dirs.IsOwned(p.Path) && p.Name != "cowork-svc.exe");
                for (int i = 0; i < 3; i++) r.M.OnTick(r.M.Scan());
                Assert.Equal("China Standard Time", r.P.SystemTz);
                Assert.Null(new SettingsStore(r.Dir.File("settings.json")).Load().PendingTz, "文件里也清掉了");
            }
        }

        [Test]
        public static void StartupRestoresLeftoverSwitch()
        {
            using (var r = new Rig())
            {
                r.M.S.PendingTz = new PendingTimeZone { OriginalId = "China Standard Time", AppliedId = "Tokyo Standard Time" };
                r.P.SystemTz = "Tokyo Standard Time";
                r.M.StartupCheck(r.M.Scan());
                Assert.Equal("China Standard Time", r.P.SystemTz);

                r.M.S.PendingTz = new PendingTimeZone { OriginalId = "China Standard Time", AppliedId = "Tokyo Standard Time" };
                r.P.SystemTz = "Tokyo Standard Time";
                r.P.SeedRunning();
                r.M.StartupCheck(r.M.Scan());
                Assert.Equal("Tokyo Standard Time", r.P.SystemTz, "Claude 还在运行时不恢复");
            }
        }

        [Test]
        public static void PolicyIsWrittenAndCleanedUp()
        {
            using (var r = new Rig())
            {
                r.Profile("策略", p => p.Proxy = new ProxySettings { Mode = ProxyMode.Manual, Host = "127.0.0.1", Port = 7890, ViaPolicy = true });
                r.M.Start("策略", false);
                Assert.Equal("http://127.0.0.1:7890", r.P.UserPolicy[ProxyLogic.PolicyUrlKey]);
                Assert.True(r.M.S.PolicyWrittenByUs);

                r.P.Calls.Clear();
                r.M.Start("策略", true);
                Assert.False(r.P.Calls.Any(c => c.StartsWith("policy", StringComparison.Ordinal)), "没变化不再写（不弹管理员确认）");

                r.M.Start("默认", true);
                Assert.Equal(0, r.P.UserPolicy.Count);
                Assert.False(r.M.S.PolicyWrittenByUs);
            }
        }

        [Test]
        public static void ForeignPolicyIsNotOverwritten()
        {
            using (var r = new Rig())
            {
                r.P.UserPolicy[ProxyLogic.PolicyUrlKey] = "http://corp-proxy:8080";
                r.Profile("策略", p => p.Proxy = new ProxySettings { Mode = ProxyMode.Manual, Host = "127.0.0.1", Port = 7890, ViaPolicy = true });
                var res = r.M.Start("策略", false);
                Assert.Equal("http://corp-proxy:8080", r.P.UserPolicy[ProxyLogic.PolicyUrlKey]);
                Assert.Contains("不是本工具写入", res.Text);

                var def = r.M.Start("默认", true);
                Assert.Contains("已有 egressProxy 设置", def.Text);
                Assert.Equal("http://corp-proxy:8080", r.P.UserPolicy[ProxyLogic.PolicyUrlKey]);

                r.M.ClearPolicy();
                Assert.Equal(0, r.P.UserPolicy.Count);
            }
        }

        [Test]
        public static void PolicyFailureStillLaunches()
        {
            using (var r = new Rig())
            {
                r.P.FailPolicy = true;
                r.Profile("策略", p => p.Proxy = new ProxySettings { Mode = ProxyMode.Manual, Host = "127.0.0.1", Port = 7890, ViaPolicy = true });
                var res = r.M.Start("策略", false);
                Assert.Contains("写入官方代理策略失败", res.Text);
                Assert.True(r.M.Scan().Running);
                Assert.False(r.M.S.PolicyWrittenByUs);
            }
        }

        [Test]
        public static void InvalidProfileDoesNotLaunch()
        {
            using (var r = new Rig())
            {
                r.Profile("坏", p => p.Proxy = new ProxySettings { Mode = ProxyMode.Manual, Host = "", Port = 0 });
                var res = r.M.Start("坏", false);
                Assert.False(res.Ok);
                Assert.False(r.P.Calls.Any(c => c.StartsWith("launch", StringComparison.Ordinal)));
            }
        }

        [Test]
        public static void NoInstall()
        {
            using (var r = new Rig())
            {
                r.P.InstallList = new List<ClaudeInstall>();
                var res = r.M.Start("默认", false);
                Assert.False(res.Ok);
                Assert.Contains("没有找到 Claude Desktop", res.Text);
            }
        }

        [Test]
        public static void SquirrelInstallGetsEnvironment()
        {
            using (var r = new Rig())
            {
                r.P.InstallList = new List<ClaudeInstall>
                {
                    new ClaudeInstall { Kind = InstallKind.Squirrel, ExePath = @"C:\Users\Demo\AppData\Local\AnthropicClaude\app-0.14.10\claude.exe", InstallDir = @"C:\Users\Demo\AppData\Local\AnthropicClaude", DataDir = @"C:\Users\Demo\AppData\Roaming\Claude" },
                };
                r.Profile("代理", p => p.Proxy = new ProxySettings { Mode = ProxyMode.Manual, Host = "127.0.0.1", Port = 7890 });
                r.M.Start("代理", false);
                Assert.Contains("env:HTTP_PROXY,HTTPS_PROXY,NO_PROXY", string.Join("\n", r.P.Calls));
            }
        }

        [Test]
        public static void DiagnosticsMentionsTheEssentials()
        {
            using (var r = new Rig())
            {
                r.P.SeedRunning();
                var text = r.M.Diagnostics();
                Assert.Contains("MSIX", text);
                Assert.Contains("Claude_pzs8sxrjxfjjc!Claude", text);
                Assert.Contains("运行中：是", text);
                Assert.Contains("系统代理：代理服务器 127.0.0.1:7890", text);
            }
        }
    }
}
