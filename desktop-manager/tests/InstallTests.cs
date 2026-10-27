using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ClaudeDesktopManager.Tests
{
    static class InstallTests
    {
        public const string GoodIdentity =
            "<Identity Name=\"Claude\" ProcessorArchitecture=\"x64\" Publisher=\"CN=&quot;Anthropic, PBC&quot;, O=&quot;Anthropic, PBC&quot;, L=San Francisco, S=California, C=US\" Version=\"3.6556.2.0\" />";

        sealed class Rig : IDisposable
        {
            public readonly TempDir Dir = new TempDir();
            public readonly DemoPlatform P = new DemoPlatform();
            public readonly Manager M;
            long now;

            public Rig(bool installed)
            {
                if (!installed)
                {
                    P.InstallList = new List<ClaudeInstall>();
                    P.Cowork = ServiceState.NotInstalled;
                }
                var store = new SettingsStore(Dir.File("settings.json"));
                store.Load();
                M = new Manager(P, store) { LaunchWaitMs = 3000 };
                M.NowMs = () => now;
                M.Sleep = ms => now += ms;
                M.RefreshInstall();
            }

            public string Package(string identity = GoodIdentity, string name = "Claude-3.6556.2-x64.msix") =>
                ReleaseTests.MakePackage(Dir, name, "AppxManifest.xml", identity);

            public void Dispose() => Dir.Dispose();
        }

        [Test]
        public static void InstallsWhenNothingIsThere()
        {
            using (var r = new Rig(installed: false))
            {
                Assert.Null(r.M.Install, "开始时没装");
                var res = r.M.InstallClaude(r.Package());
                Assert.True(res.Ok, res.Text);
                Assert.Seq(new[] { "signature Claude-3.6556.2-x64.msix", "install Claude-3.6556.2-x64.msix" }, r.P.Calls);
                Assert.NotNull(r.M.Install);
                Assert.Equal(InstallKind.Msix, r.M.Install.Kind);
                Assert.Contains("Claude Desktop 已安装：MSIX", res.Lines.Last());
                Assert.True(r.M.History.Any(e => e.Text.Contains("安装包：Claude 3.6556.2.0（x64），发布者 CN=\"Anthropic, PBC\"")), "记下了版本和发布者");
            }
        }

        [Test]
        public static void ClosesClaudeAndTheServiceFirst()
        {
            using (var r = new Rig(installed: true))
            {
                r.P.QuitOnClose = true;
                var main = r.P.SeedRunning();
                var res = r.M.InstallClaude(r.Package());
                Assert.True(res.Ok, res.Text);
                int close = r.P.Calls.IndexOf("close " + main.Pid);
                int stop = r.P.Calls.IndexOf("service stop");
                int install = r.P.Calls.IndexOf("install Claude-3.6556.2-x64.msix");
                Assert.True(close >= 0 && stop > close && install > stop, string.Join(" | ", r.P.Calls));
                Assert.False(r.P.Procs.Any(p => p.Path == r.P.AppExe), "Claude 已关闭");
            }
        }

        [Test]
        public static void RefusesWhatIsNotAnthropics()
        {
            using (var r = new Rig(installed: false))
            {
                var res = r.M.InstallClaude(r.Package("<Identity Name=\"Claude\" Publisher=\"CN=Someone Else\" Version=\"9.9.9.9\" />", "fake.msix"));
                Assert.False(res.Ok);
                Assert.Contains("不是 Anthropic 发布的", res.Text);

                r.P.Signature = new SignatureInfo { Status = "Valid", Subject = "CN=Someone Else, O=Evil" };
                res = r.M.InstallClaude(r.Package());
                Assert.False(res.Ok);
                Assert.Contains("数字签名不是 Anthropic 的", res.Text);

                r.P.Signature = new SignatureInfo { Status = "HashMismatch", Message = "文件的哈希不匹配" };
                var mine = r.Package();
                res = r.M.InstallClaude(mine);
                Assert.False(res.Ok);
                Assert.Contains("请删掉重新下载", res.Text);
                Assert.True(File.Exists(mine), "用户自己选的文件不删");
                res = r.M.InstallClaude(mine, downloaded: true);
                Assert.Contains("已删除，再试一次会重新下载", res.Text);
                Assert.False(File.Exists(mine), "下载的坏文件删掉，下次重新下载");

                var broken = r.Dir.File("broken.msix");
                File.WriteAllBytes(broken, new byte[] { 0x50, 0x4B, 3, 4, 1, 2, 3 });
                res = r.M.InstallClaude(broken, downloaded: true);
                Assert.Contains("损坏", res.Text);
                Assert.False(File.Exists(broken));

                var exe = r.Dir.File("ClaudeSetup.exe");
                File.WriteAllText(exe, "MZ");
                r.P.Signature = new SignatureInfo { Status = "NotSupportedFileFormat" };
                res = r.M.InstallClaude(exe);
                Assert.False(res.Ok, "exe 必须有有效签名");

                res = r.M.InstallClaude(r.Dir.File("readme.txt"));
                Assert.Contains("找不到安装包", res.Text);
                File.WriteAllText(r.Dir.File("readme.txt"), "hi");
                res = r.M.InstallClaude(r.Dir.File("readme.txt"));
                Assert.Contains("不认识的安装包", res.Text);

                Assert.False(r.P.Calls.Any(c => c.StartsWith("install ", StringComparison.Ordinal)), "一次也没装");
            }
        }

        [Test]
        public static void LeavesTheCheckToWindowsWhenPowerShellCannot()
        {
            using (var r = new Rig(installed: false))
            {
                r.P.Signature = new SignatureInfo { Status = "", Message = "powershell 不在" };
                var res = r.M.InstallClaude(r.Package());
                Assert.True(res.Ok, res.Text);
                Assert.True(r.M.History.Any(e => e.Level == LogLevel.Warn && e.Text.Contains("交给 Windows")), "提示了");
            }
        }

        [Test]
        public static void StandardUsersAndWrongArchitecture()
        {
            using (var r = new Rig(installed: false))
            {
                r.P.Rights = InstallRights.StandardUser;
                var res = r.M.InstallClaude(r.Package());
                Assert.False(res.Ok);
                Assert.Contains("不是管理员", res.Text);
                Assert.Contains("ClaudeSetup.exe", res.Text);

                r.P.Rights = InstallRights.Consent;
                res = r.M.InstallClaude(r.Package(GoodIdentity.Replace("x64", "arm64"), "arm.msix"));
                Assert.False(res.Ok);
                Assert.Contains("ARM64", res.Text);
                Assert.Equal(0, r.P.Calls.Count(c => c.StartsWith("install ", StringComparison.Ordinal)));
            }
        }

        [Test]
        public static void FailuresAreExplained()
        {
            using (var r = new Rig(installed: false))
            {
                r.P.InstallAnswer = new CommandResult { ExitCode = 1, Output = "ERROR 部署失败，HRESULT: 0x80073CF6，无法注册程序包。" };
                var res = r.M.InstallClaude(r.Package());
                Assert.False(res.Ok);
                Assert.Contains("重启电脑", res.Text);
                Assert.Contains("Windows 的原话：部署失败，HRESULT: 0x80073CF6", res.Text);

                r.P.InstallAnswer = new CommandResult { ExitCode = -1, Output = "已取消管理员授权" };
                res = r.M.InstallClaude(r.Package());
                Assert.Contains("安装失败：已取消管理员授权", res.Text);

                r.P.InstallAnswer = new CommandResult { ExitCode = 4, Output = "SIGNER CN=Evil" };
                res = r.M.InstallClaude(r.Package());
                Assert.Contains("签名者不是 Anthropic：CN=Evil", res.Text);
                Assert.Null(r.M.Install, "失败时不会冒出安装");
            }
        }

        [Test]
        public static void StaleCustomPathIsCleared()
        {
            using (var r = new Rig(installed: false))
            {
                r.M.S.Options.CustomExePath = r.Dir.File("gone/Claude.exe");
                var res = r.M.InstallClaude(r.Package());
                Assert.True(res.Ok, res.Text);
                Assert.Equal("", r.M.S.Options.CustomExePath);
                Assert.Equal(InstallKind.Msix, r.M.Install.Kind);
            }
        }

        [Test]
        public static void RoutesFollowTheSelectedProfile()
        {
            using (var r = new Rig(installed: true))
            {
                r.P.SysProxy = new SystemProxyInfo { Enabled = true, Server = "127.0.0.1:7890" };
                var us = new Profile { Name = "美国", Proxy = new ProxySettings { Mode = ProxyMode.Manual, Scheme = "socks5", Host = "127.0.0.1", Port = 1080 } };
                var same = new Profile { Name = "同端口", Proxy = new ProxySettings { Mode = ProxyMode.Manual, Scheme = "http", Host = "127.0.0.1", Port = 7890 } };
                var broken = new Profile { Name = "坏的", Proxy = new ProxySettings { Mode = ProxyMode.Manual, Host = "", Port = 1 } };
                r.M.S.Profiles.AddRange(new[] { us, same, broken });

                r.M.S.SelectedProfile = "美国";
                Assert.Seq(new[] { "方案「美国」的代理 socks5://127.0.0.1:1080", "方案「本机代理 7890」的代理 http://127.0.0.1:7890", "直连（不用代理）" },
                    r.M.DownloadRoutes().Select(x => x.Label));

                // The default profile follows the system proxy.
                r.M.S.SelectedProfile = r.M.S.Profiles[0].Name;
                var routes = r.M.DownloadRoutes();
                Assert.Equal("系统代理 http://127.0.0.1:7890", routes[0].Label);
                Assert.Equal(3, routes.Count);
                Assert.Null(routes.Last().Proxy);

                // Following a system proxy that is not set means going direct.
                r.P.SysProxy = new SystemProxyInfo();
                Assert.Equal("直连（不用代理）", r.M.DownloadRoutes()[0].Label);

                r.M.S.Profiles[0].Proxy.Mode = ProxyMode.Direct;
                Assert.Seq(new[] { "直连（不用代理）", "方案「本机代理 7890」的代理 http://127.0.0.1:7890", "方案「美国」的代理 socks5://127.0.0.1:1080" },
                    r.M.DownloadRoutes().Select(x => x.Label));
            }
        }

        [Test]
        public static void DownloadThenInstall()
        {
            FileServer server = null;
            using (var r = new Rig(installed: false))
            using (server = new FileServer((req, s) =>
            {
                if (req.Path == "/api/desktop/win32/x64/msix/latest/redirect")
                    FileServer.Send(s, "HTTP/1.1 307 Temporary Redirect\r\nLocation: /releases/win32/x64/3.6556.2/Claude-abc.msix\r\nContent-Length: 0\r\n\r\n");
                else
                    FileServer.ServeFile(req, s, File.ReadAllBytes(r.Package(name: "source.msix")));
            }))
            {
                r.M.ReleaseUrl = arch => server.Url("/api/desktop/win32/" + arch + "/msix/latest/redirect");
                var downloads = Path.Combine(r.Dir.Path, "Downloads");
                var progress = new List<DownloadProgress>();
                var d = r.M.DownloadLatest(null, downloads, p => progress.Add(p), CancellationToken.None);
                Assert.True(d.Ok, d.Error);
                Assert.Equal(Path.Combine(downloads, "Claude-3.6556.2-x64.msix"), d.FilePath);
                Assert.True(progress.Count > 0);
                var res = r.M.InstallClaude(d.FilePath);
                Assert.True(res.Ok, res.Text);
                Assert.NotNull(r.M.Install);

                r.P.NativeArch = "x86";
                d = r.M.DownloadLatest(null, downloads, null, CancellationToken.None);
                Assert.False(d.Ok);
                Assert.Contains("只支持 64 位", d.Error);
            }
        }

        [Test]
        public static void HintsAfterFailedDownloads()
        {
            Assert.Contains(ClaudeRelease.DownloadPage, Manager.DownloadHint(new DownloadResult { Challenge = true, Status = 403 }));
            Assert.Contains("换一条网络线路", Manager.DownloadHint(new DownloadResult { Stage = "连接代理" }));
            Assert.Contains("换一条网络线路", Manager.DownloadHint(new DownloadResult { Stage = "HTTP", Status = 403 }));
            Assert.Equal("", Manager.DownloadHint(new DownloadResult { Cancelled = true }));
        }

        [Test]
        public static void PowerShellQuoting()
        {
            Assert.Equal("'C:\\a b\\x.msix'", PsScripts.Quote("C:\\a b\\x.msix"));
            Assert.Equal("'it''s'", PsScripts.Quote("it's"));
            Assert.Equal("'John\u2019\u2019s'", PsScripts.Quote("John\u2019s"));
            var script = PsScripts.AddPackage("C:\\Users\\O'Neil\\Downloads\\Claude.msix", "C:\\Temp\\x.log");
            Assert.Contains("$f='C:\\Users\\O''Neil\\Downloads\\Claude.msix'", script);
            Assert.Contains("Add-AppxPackage -Path $f -ForceApplicationShutdown", script);
            Assert.Contains("Get-AuthenticodeSignature -LiteralPath", PsScripts.Signature("x.msix"));
        }
    
        static string FindPowerShell()
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return "powershell.exe";
            var home = Environment.GetEnvironmentVariable("HOME") ?? "";
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator).Concat(new[] { Path.Combine(home, ".dotnet", "tools") }))
            {
                var exe = Path.Combine(dir, "pwsh");
                if (dir.Length > 0 && File.Exists(exe)) return exe;
            }
            return null;
        }

        static int RunPs(string ps, string args, out string output)
        {
            var psi = new System.Diagnostics.ProcessStartInfo(ps, args)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            using (var p = System.Diagnostics.Process.Start(psi))
            {
                var err = p.StandardError.ReadToEndAsync();
                output = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(120000)) { p.Kill(); throw new TimeoutException("PowerShell 没有结束"); }
                output += err.Result;
                return p.ExitCode;
            }
        }

        /// <summary>The scripts parse, and the install script runs the way WindowsPlatform starts it (-EncodedCommand).</summary>
        [Test]
        public static void ScriptsRunInPowerShell()
        {
            var ps = FindPowerShell();
            if (ps == null)
            {
                Console.WriteLine("     （没有 PowerShell，跳过）");
                return;
            }
            bool windows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
            using (var dir = new TempDir())
            {
                // Both kinds of single quote in the path.
                var file = ReleaseTests.MakePackage(dir, "O'Neil\u2019s Claude.msix", "AppxManifest.xml", GoodIdentity);
                var log = dir.File("install.log");
                foreach (var script in new[] { PsScripts.AddPackage(file, log), PsScripts.Signature(file) })
                {
                    var ps1 = dir.File("check.ps1");
                    File.WriteAllText(ps1, script, new UTF8Encoding(true));
                    int errors = RunPs(ps, "-NoProfile -NonInteractive -Command \"$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" +
                        ps1.Replace("'", "''") + "', [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count\"", out var parseOut);
                    Assert.Equal(0, errors, "语法错误：" + parseOut);
                }

                RunPs(ps, "-NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(
                    "if (Test-Path -LiteralPath " + PsScripts.Quote(file) + ") { 'FOUND' } else { 'MISSING' }")), out var found);
                Assert.Contains("FOUND", found);

                var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(PsScripts.AddPackage(file, log)));
                int code = RunPs(ps, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded, out var output);
                var written = File.Exists(log) ? File.ReadAllText(log) : "";
                if (windows)
                {
                    // An unsigned package never gets as far as installing.
                    Assert.True(code == 3 || code == 1, "退出码 " + code + "：" + written + output);
                    Assert.True(written.StartsWith("SIGNATURE ") || written.StartsWith("ERROR "), written + output);
                }
                else
                {
                    // No Get-AuthenticodeSignature outside Windows: the catch reports it.
                    Assert.Equal(1, code, written + output);
                    Assert.Contains("ERROR ", written);
                    Assert.Contains("Get-AuthenticodeSignature", written);
                }

                if (windows)
                {
                    RunPs(ps, "-NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(PsScripts.Signature(file))), out var sigOut);
                    Assert.Contains("STATUS ", sigOut);
                }
            }
        }
    }
}
