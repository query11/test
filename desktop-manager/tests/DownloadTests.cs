using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace ClaudeDesktopManager.Tests
{
    /// <summary>An HTTP server on 127.0.0.1 that answers each request with whatever the test's handler writes.</summary>
    sealed class FileServer : IDisposable
    {
        public sealed class Request
        {
            public string Path = "";
            public readonly Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            public string Header(string name) => Headers.TryGetValue(name, out var v) ? v : null;
        }

        readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        readonly Action<Request, Stream> handler;
        readonly List<Request> requests = new List<Request>();
        volatile bool stopped;

        public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;
        public string Url(string path) => "http://127.0.0.1:" + Port + path;

        public List<Request> Requests
        {
            get { lock (requests) return requests.ToList(); }
        }

        public FileServer(Action<Request, Stream> handler)
        {
            this.handler = handler;
            listener.Start();
            new Thread(Loop) { IsBackground = true }.Start();
        }

        void Loop()
        {
            while (!stopped)
            {
                TcpClient c;
                try { c = listener.AcceptTcpClient(); }
                catch (Exception) { return; }
                new Thread(() =>
                {
                    try
                    {
                        var s = c.GetStream();
                        var req = Parse(s);
                        if (req == null) return;
                        lock (requests) requests.Add(req);
                        handler(req, s);
                        s.Flush();
                    }
                    catch (Exception) { }
                    finally { c.Close(); }
                }) { IsBackground = true }.Start();
            }
        }

        static Request Parse(Stream s)
        {
            var sb = new StringBuilder();
            while (!sb.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
            {
                int b = s.ReadByte();
                if (b < 0) return null;
                sb.Append((char)b);
            }
            var lines = sb.ToString().Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries);
            var req = new Request { Path = lines[0].Split(' ')[1] };
            foreach (var l in lines.Skip(1))
            {
                int i = l.IndexOf(':');
                if (i > 0) req.Headers[l.Substring(0, i).Trim()] = l.Substring(i + 1).Trim();
            }
            return req;
        }

        public static void Send(Stream s, string text)
        {
            var b = Encoding.ASCII.GetBytes(text);
            s.Write(b, 0, b.Length);
        }

        /// <summary>
        /// The file with Range support; <paramref name="cutAfter"/> drops the connection after that many body
        /// bytes, <paramref name="delayMs"/> waits between 16 KB pieces.
        /// </summary>
        public static void ServeFile(Request req, Stream s, byte[] data, long cutAfter = -1, bool chunked = false, int delayMs = 0, bool ignoreRange = false)
        {
            long start = 0;
            var m = Regex.Match(req.Header("Range") ?? "", @"^bytes=(\d+)-$");
            if (m.Success && !ignoreRange)
            {
                start = long.Parse(m.Groups[1].Value);
                if (start >= data.Length)
                {
                    Send(s, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + data.Length + "\r\nContent-Length: 0\r\n\r\n");
                    return;
                }
                Send(s, "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + start + "-" + (data.Length - 1) + "/" + data.Length +
                    "\r\nContent-Length: " + (data.Length - start) + "\r\n\r\n");
            }
            else if (chunked) Send(s, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
            else Send(s, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " + data.Length + "\r\n\r\n");

            long sent = 0;
            for (long pos = start; pos < data.Length; pos += 16 * 1024)
            {
                int n = (int)Math.Min(16 * 1024, data.Length - pos);
                if (cutAfter >= 0 && sent + n > cutAfter) n = (int)(cutAfter - sent);
                if (n > 0)
                {
                    if (chunked) Send(s, n.ToString("x") + "\r\n");
                    s.Write(data, (int)pos, n);
                    if (chunked) Send(s, "\r\n");
                    sent += n;
                }
                if (cutAfter >= 0 && sent >= cutAfter) return;
                if (delayMs > 0) Thread.Sleep(delayMs);
            }
            if (chunked) Send(s, "0\r\n\r\n");
        }

        public void Dispose()
        {
            stopped = true;
            listener.Stop();
        }
    }

    static class DownloadTests
    {
        const string Release = "/releases/win32/x64/3.6556.2/Claude-20c019a1e61fa5b687616af57d31f97bb3181723.msix";

        static byte[] Data(int size, int seed = 7)
        {
            var b = new byte[size];
            new Random(seed).NextBytes(b);
            return b;
        }

        static Downloader Fast(List<DownloadProgress> progress = null) => new Downloader
        {
            TimeoutMs = 5000,
            RetryDelayMs = 10,
            ProgressIntervalMs = 0,
            Progress = p => { if (progress != null) lock (progress) progress.Add(p); },
        };

        static Func<Uri, string> Names => u => ClaudeRelease.FileNameFor(u, "x64");

        /// <summary>The redirect endpoint and the release file, the way claude.ai serves them.</summary>
        static Action<FileServer.Request, Stream> Site(Func<int> port, byte[] data, Action<FileServer.Request, Stream> file = null) => (req, s) =>
        {
            if (req.Path == "/download")
                FileServer.Send(s, "HTTP/1.1 302 Found\r\nLocation: /api/desktop/win32/x64/msix/latest/redirect\r\nContent-Length: 0\r\n\r\n");
            else if (req.Path == "/api/desktop/win32/x64/msix/latest/redirect")
                FileServer.Send(s, "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:" + port() + Release + "\r\nContent-Length: 0\r\n\r\n");
            else if (req.Path == Release)
            {
                if (file != null) file(req, s);
                else FileServer.ServeFile(req, s, data);
            }
            else FileServer.Send(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        };

        [Test]
        public static void FollowsRedirectsAndNamesTheFile()
        {
            var data = Data(300 * 1024 + 17);
            FileServer server = null;
            using (var dir = new TempDir())
            using (server = new FileServer(Site(() => server.Port, data)))
            {
                var progress = new List<DownloadProgress>();
                var r = Fast(progress).Download(server.Url("/download"), dir.Path, Names);
                Assert.True(r.Ok, r.Stage + " " + r.Error);
                Assert.Equal(Path.Combine(dir.Path, "Claude-3.6556.2-x64.msix"), r.FilePath);
                Assert.Equal(server.Url(Release), r.FinalUrl);
                Assert.Seq(data, File.ReadAllBytes(r.FilePath));
                Assert.Equal((long)data.Length, r.Bytes);
                Assert.False(r.Resumed || r.Reused, "全新下载");
                Assert.False(File.Exists(r.FilePath + ".part"), "临时文件已改名");
                Assert.Seq(new[] { "/download", "/api/desktop/win32/x64/msix/latest/redirect", Release }, server.Requests.Select(q => q.Path));
                Assert.True(progress.Count >= 2, "有进度回报");
                Assert.Equal((long)data.Length, progress.Last().Received);
                Assert.Equal((long)data.Length, progress.Last().Total);
                Assert.Equal(100, progress.Last().Percent);
                Assert.Equal("ClaudeDesktopManager/" + AppInfo.Version, server.Requests[0].Header("User-Agent"));
            }
        }

        [Test]
        public static void ResumesAfterTheConnectionDrops()
        {
            var data = Data(500 * 1024);
            int fileRequests = 0;
            FileServer server = null;
            using (var dir = new TempDir())
            using (server = new FileServer(Site(() => server.Port, data, (req, s) =>
            {
                // The first try breaks off after 100 KB.
                if (Interlocked.Increment(ref fileRequests) == 1) FileServer.ServeFile(req, s, data, cutAfter: 100 * 1024);
                else FileServer.ServeFile(req, s, data);
            })))
            {
                var r = Fast().Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                Assert.True(r.Ok, r.Error);
                Assert.True(r.Resumed, "接着下载");
                Assert.Equal(2, r.Attempts);
                Assert.Seq(data, File.ReadAllBytes(r.FilePath));
                var ranges = server.Requests.Where(q => q.Path == Release).Select(q => q.Header("Range")).ToList();
                Assert.Seq(new[] { null, "bytes=" + (100 * 1024) + "-" }, ranges);
            }
        }

        [Test]
        public static void KeepsThePartAndCarriesOnNextTime()
        {
            var data = Data(200 * 1024);
            bool broken = true;
            FileServer server = null;
            using (var dir = new TempDir())
            using (server = new FileServer(Site(() => server.Port, data, (req, s) =>
                FileServer.ServeFile(req, s, data, cutAfter: broken ? 64 * 1024 : -1))))
            {
                var d = Fast();
                d.Retries = 0;
                var r = d.Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                Assert.False(r.Ok);
                Assert.Equal("下载", r.Stage);
                Assert.Contains("接着下载", r.Error);
                var part = Path.Combine(dir.Path, "Claude-3.6556.2-x64.msix.part");
                Assert.Equal(64L * 1024, new FileInfo(part).Length);

                broken = false;
                r = Fast().Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                Assert.True(r.Ok, r.Error);
                Assert.True(r.Resumed);
                Assert.Seq(data, File.ReadAllBytes(r.FilePath));
                Assert.False(File.Exists(part));
            }
        }

        [Test]
        public static void StartsOverWhenThePartDoesNotFit()
        {
            var data = Data(80 * 1024);
            using (var dir = new TempDir())
            {
                var part = Path.Combine(dir.Path, "Claude-3.6556.2-x64.msix.part");

                // The server ignores Range and sends everything: the part is replaced, not appended to.
                File.WriteAllBytes(part, Data(1000, seed: 1));
                FileServer server = null;
                using (server = new FileServer(Site(() => server.Port, data, (req, s) => FileServer.ServeFile(req, s, data, ignoreRange: true))))
                {
                    var r = Fast().Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                    Assert.True(r.Ok, r.Error);
                    Assert.False(r.Resumed);
                    Assert.Seq(data, File.ReadAllBytes(r.FilePath));
                }

                // A part longer than the file gets 416: start over without Range.
                File.Delete(Path.Combine(dir.Path, "Claude-3.6556.2-x64.msix"));
                File.WriteAllBytes(part, Data(90 * 1024, seed: 2));
                using (server = new FileServer(Site(() => server.Port, data)))
                {
                    var r = Fast().Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                    Assert.True(r.Ok, r.Error);
                    Assert.Seq(data, File.ReadAllBytes(r.FilePath));
                    var ranges = server.Requests.Where(q => q.Path == Release).Select(q => q.Header("Range")).ToList();
                    Assert.Seq(new[] { "bytes=" + (90 * 1024) + "-", null }, ranges);
                }
            }
        }

        [Test]
        public static void ReusesAFileThatIsAlreadyComplete()
        {
            var data = Data(50 * 1024);
            FileServer server = null;
            using (var dir = new TempDir())
            using (server = new FileServer(Site(() => server.Port, data)))
            {
                var target = Path.Combine(dir.Path, "Claude-3.6556.2-x64.msix");
                File.WriteAllBytes(target, data);
                var r = Fast().Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                Assert.True(r.Ok, r.Error);
                Assert.True(r.Reused, "直接用已有的文件");
                Assert.Equal(target, r.FilePath);
                Assert.Seq(data, File.ReadAllBytes(target));
            }
        }

        [Test]
        public static void ChunkedFileWithoutLength()
        {
            var data = Data(70 * 1024 + 5);
            FileServer server = null;
            using (var dir = new TempDir())
            using (server = new FileServer(Site(() => server.Port, data, (req, s) => FileServer.ServeFile(req, s, data, chunked: true))))
            {
                var progress = new List<DownloadProgress>();
                var r = Fast(progress).Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                Assert.True(r.Ok, r.Error);
                Assert.Seq(data, File.ReadAllBytes(r.FilePath));
                Assert.Equal(-1L, progress.Last().Total);
                Assert.Equal(-1, progress.Last().Percent);
                Assert.Contains("已下载 70.0 KB", progress.Last().Describe());
            }
        }

        [Test]
        public static void ChunkedFileThatBreaksOffIsNotComplete()
        {
            var data = Data(70 * 1024);
            FileServer server = null;
            using (var dir = new TempDir())
            using (server = new FileServer(Site(() => server.Port, data, (req, s) => FileServer.ServeFile(req, s, data, chunked: true, cutAfter: 40 * 1024, ignoreRange: true))))
            {
                var d = Fast();
                d.Retries = 1;
                var r = d.Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                Assert.False(r.Ok, "没收到结尾的 0 长度块就不算完整");
                Assert.Equal(2, r.Attempts);
                Assert.False(File.Exists(Path.Combine(dir.Path, "Claude-3.6556.2-x64.msix")));
            }
        }

        [Test]
        public static void BrowserChallengeAndRefusals()
        {
            using (var dir = new TempDir())
            using (var server = new FileServer((req, s) =>
            {
                if (req.Path == "/challenge")
                {
                    var html = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>";
                    FileServer.Send(s, "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\ncf-mitigated: challenge\r\nContent-Length: " + html.Length + "\r\n\r\n" + html);
                }
                else if (req.Path == "/forbidden")
                    FileServer.Send(s, "HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nForbidden");
                else if (req.Path == "/teapot")
                    FileServer.Send(s, "HTTP/1.1 418 I'm a teapot\r\nContent-Length: 27\r\n\r\n<h1>short and   stout</h1>\n");
                else if (req.Path == "/loop")
                    FileServer.Send(s, "HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\n\r\n");
                else
                    FileServer.Send(s, "HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n");
            }))
            {
                var r = Fast().Download(server.Url("/challenge"), dir.Path, Names);
                Assert.False(r.Ok);
                Assert.True(r.Challenge, "认出 Cloudflare 的浏览器验证");
                Assert.Equal(403, r.Status);
                Assert.Contains("浏览器验证", r.Error);

                r = Fast().Download(server.Url("/forbidden"), dir.Path, Names);
                Assert.False(r.Ok || r.Challenge);
                Assert.Contains("HTTP 403", r.Error);

                r = Fast().Download(server.Url("/teapot"), dir.Path, Names);
                Assert.Contains("HTTP 418：short and stout", r.Error);

                r = Fast().Download(server.Url("/loop"), dir.Path, Names);
                Assert.Contains("跳转次数太多", r.Error);

                r = Fast().Download(server.Url("/nowhere"), dir.Path, Names);
                Assert.Contains("没给出有效的地址", r.Error);

                Assert.Equal(0, Directory.GetFiles(dir.Path).Length);
            }
        }

        [Test]
        public static void CancelStopsAtOnceAndKeepsThePart()
        {
            var data = Data(4 * 1024 * 1024);
            FileServer server = null;
            using (var dir = new TempDir())
            using (server = new FileServer(Site(() => server.Port, data, (req, s) => FileServer.ServeFile(req, s, data, delayMs: 30))))
            using (var cts = new CancellationTokenSource())
            {
                var d = Fast();
                d.Cancel = cts.Token;
                d.Progress = p => { if (p.Received > 64 * 1024) cts.Cancel(); };
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var task = Task.Run(() => d.Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names));
                Assert.True(task.Wait(5000), "取消后很快结束");
                var r = task.Result;
                Assert.False(r.Ok);
                Assert.True(r.Cancelled);
                Assert.Equal(1, r.Attempts);
                Assert.True(sw.ElapsedMilliseconds < 4000, "没有等到下载完");
                var part = Path.Combine(dir.Path, "Claude-3.6556.2-x64.msix.part");
                Assert.True(File.Exists(part) && new FileInfo(part).Length > 0, "保留已下载的部分");
            }
        }

        [Test]
        public static void ThroughHttpAndSocksProxies()
        {
            var data = Data(120 * 1024);
            FileServer server = null;
            using (var http = new FakeServer(FakeServer.Kind.HttpProxy))
            using (var socks = new FakeServer(FakeServer.Kind.Socks5))
            using (server = new FileServer(Site(() => server.Port, data)))
            {
                foreach (var proxy in new[]
                {
                    new ProxyEndpoint { Scheme = "http", Host = "127.0.0.1", Port = http.Port },
                    new ProxyEndpoint { Scheme = "socks5", Host = "127.0.0.1", Port = socks.Port },
                })
                using (var dir = new TempDir())
                {
                    var d = Fast();
                    d.Proxy = proxy;
                    var r = d.Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                    Assert.True(r.Ok, proxy + " " + r.Error);
                    Assert.Seq(data, File.ReadAllBytes(r.FilePath));
                }
                Assert.True(http.Connections >= 2 && socks.Connections >= 2, "两次请求都经过了代理");

                using (var dir = new TempDir())
                {
                    int closed;
                    using (var tmp = new FakeServer(FakeServer.Kind.Target)) closed = tmp.Port;
                    var d = Fast();
                    d.Proxy = new ProxyEndpoint { Scheme = "http", Host = "127.0.0.1", Port = closed };
                    var r = d.Download(server.Url("/api/desktop/win32/x64/msix/latest/redirect"), dir.Path, Names);
                    Assert.False(r.Ok);
                    Assert.Equal("连接代理", r.Stage);
                    Assert.Equal(1, r.Attempts);
                }
            }
        }

        [Test]
        public static void ProgressText()
        {
            Assert.Equal("已下载 1.00 MB / 4.00 MB · 512 KB/s · 还剩 6 秒",
                new DownloadProgress { Received = 1024 * 1024, Total = 4 * 1024 * 1024, BytesPerSecond = 512 * 1024 }.Describe());
            Assert.Equal("已下载 10.0 MB / 200 MB · 100 KB/s · 还剩 32 分 26 秒",
                new DownloadProgress { Received = 10L * 1024 * 1024, Total = 200L * 1024 * 1024, BytesPerSecond = 100 * 1024 }.Describe());
            Assert.Equal("已下载 300 KB", new DownloadProgress { Received = 300 * 1024 }.Describe());
            Assert.Equal(25, new DownloadProgress { Received = 1, Total = 4 }.Percent);
        }

        [Test]
        public static void ContentRangeParsing()
        {
            Assert.True(Downloader.ParseContentRange("bytes 100-999/1000", out var from, out var total));
            Assert.Equal(100L, from);
            Assert.Equal(1000L, total);
            Assert.True(Downloader.ParseContentRange("bytes 0-0/*", out from, out total));
            Assert.Equal(-1L, total);
            Assert.False(Downloader.ParseContentRange("bytes */1000", out _, out _));
            Assert.False(Downloader.ParseContentRange(null, out _, out _));
        }
    }

    static class ReleaseTests
    {
        [Test]
        public static void ReleaseUrlsAndFileNames()
        {
            Assert.Equal("https://claude.ai/api/desktop/win32/arm64/msix/latest/redirect", ClaudeRelease.MsixUrl("arm64"));
            var rel = new Uri("https://downloads.claude.ai/releases/win32/x64/3.6556.2/Claude-20c019a1e61fa5b687616af57d31f97bb3181723.msix");
            Assert.Equal("3.6556.2", ClaudeRelease.VersionOf(rel));
            Assert.Equal("Claude-3.6556.2-x64.msix", ClaudeRelease.FileNameFor(rel, "x64"));
            Assert.Equal("Claude-3.6556.2-arm64.msix", ClaudeRelease.FileNameFor(new Uri("https://downloads.claude.ai/releases/win32/ARM64/3.6556.2/x.msix"), "x64"));
            Assert.Null(ClaudeRelease.VersionOf(new Uri(ClaudeRelease.MsixUrl("x64"))));
            Assert.Equal("Claude-x64.msix", ClaudeRelease.FileNameFor(new Uri(ClaudeRelease.MsixUrl("x64")), "x64"));
            Assert.Equal("ClaudeSetup.exe", ClaudeRelease.FileNameFor(new Uri("https://downloads.claude.ai/releases/win32/x64/ClaudeSetup.exe?x=1"), "x64"));
            Assert.Equal("Claude Setup.msix", ClaudeRelease.FileNameFor(new Uri("https://example.com/a/Claude%20Setup.msix"), "x64"));
            Assert.True(ClaudeRelease.IsPackageFile(@"C:\x\Claude.MSIX"));
            Assert.True(ClaudeRelease.IsPackageFile("a.msixbundle"));
            Assert.False(ClaudeRelease.IsPackageFile("ClaudeSetup.exe"));
        }

        [Test]
        public static void PublisherIdsAndSubjects()
        {
            // The well-known id of Microsoft's own packages (Microsoft.WindowsTerminal_8wekyb3d8bbwe and so on).
            Assert.Equal("8wekyb3d8bbwe", ClaudeRelease.PublisherIdOf("CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"));
            Assert.True(ClaudeRelease.IsAnthropicSubject("CN=\"Anthropic, PBC\", O=\"Anthropic, PBC\", L=San Francisco, S=California, C=US"));
            Assert.True(ClaudeRelease.IsAnthropicSubject("CN=Anthropic, PBC, O=Anthropic, PBC, C=US"));
            Assert.True(ClaudeRelease.IsAnthropicSubject("SERIALNUMBER=123, O=\"Anthropic, PBC\""));
            Assert.False(ClaudeRelease.IsAnthropicSubject("CN=\"Anthropic, PBC Fake\", O=Evil Inc, C=US"));
            Assert.False(ClaudeRelease.IsAnthropicSubject("CN=Evil, O=\"Not Anthropic, PBC\""));
            Assert.False(ClaudeRelease.IsAnthropicSubject("OU=\"Anthropic, PBC\", O=Evil"));
            Assert.False(ClaudeRelease.IsAnthropicSubject(null));
        }

        [Test]
        public static void InstallErrorsAreExplained()
        {
            Assert.Contains("重启电脑", ClaudeRelease.ExplainInstallError("ERROR 部署失败，HRESULT: 0x80073CF6，无法注册程序包。"));
            Assert.Contains("管理员权限", ClaudeRelease.ExplainInstallError("Deployment failed with HRESULT: 0x80073d28"));
            Assert.Contains("更新的版本", ClaudeRelease.ExplainInstallError("0x80073D06"));
            Assert.Null(ClaudeRelease.ExplainInstallError("HRESULT: 0x80001234"));
            Assert.Null(ClaudeRelease.ExplainInstallError("没有错误码"));
        }

        internal static string MakePackage(TempDir dir, string name, string manifestPath, string identity)
        {
            var path = dir.File(name);
            using (var fs = File.Create(path))
            using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
            {
                using (var w = new StreamWriter(zip.CreateEntry("app/Claude.exe").Open())) w.Write("MZ");
                if (manifestPath != null)
                    using (var w = new StreamWriter(zip.CreateEntry(manifestPath).Open(), new UTF8Encoding(true)))
                        w.Write("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<Package xmlns=\"http://schemas.microsoft.com/appx/manifest/foundation/windows10\">\n  " +
                            identity + "\n  <Properties><DisplayName>Claude</DisplayName></Properties>\n</Package>\n");
            }
            return path;
        }

        [Test]
        public static void ReadsThePackageIdentity()
        {
            using (var dir = new TempDir())
            {
                var good = MakePackage(dir, "good.msix", "AppxManifest.xml",
                    "<Identity Name=\"Claude\" ProcessorArchitecture=\"x64\" Publisher=\"CN=&quot;Anthropic, PBC&quot;, O=&quot;Anthropic, PBC&quot;, L=San Francisco, S=California, C=US\" Version=\"3.6556.2.0\" />");
                var id = PackageIdentity.Read(good, out var err);
                Assert.NotNull(id, err);
                Assert.Equal("Claude", id.Name);
                Assert.Equal("3.6556.2.0", id.Version);
                Assert.Equal("x64", id.Architecture);
                Assert.Equal("CN=\"Anthropic, PBC\", O=\"Anthropic, PBC\", L=San Francisco, S=California, C=US", id.Publisher);
                Assert.True(id.IsClaude);
                Assert.False(id.Bundle);

                var other = PackageIdentity.Read(MakePackage(dir, "other.msix", "AppxManifest.xml",
                    "<Identity Name='Claude' Publisher='CN=Someone Else' Version='9.0.0.0'/>"), out err);
                Assert.Equal("CN=Someone Else", other.Publisher);
                Assert.False(other.IsClaude, "别人发布的不算");

                var notClaude = PackageIdentity.Read(MakePackage(dir, "nc.msix", "AppxManifest.xml",
                    "<Identity Name=\"Anthropic.Other\" Publisher=\"CN=Anthropic, PBC, O=Anthropic, PBC\" Version=\"1.0.0.0\"/>"), out err);
                Assert.False(notClaude.IsClaude, "Anthropic 的其他应用不算");

                var bundle = PackageIdentity.Read(MakePackage(dir, "b.msixbundle", "AppxMetadata/AppxBundleManifest.xml",
                    "<Identity Name=\"Claude\" Publisher=\"O=Anthropic, PBC\" Version=\"1.2.3.0\" />"), out err);
                Assert.True(bundle.Bundle && bundle.IsClaude, "bundle");

                Assert.Null(PackageIdentity.Read(MakePackage(dir, "empty.msix", null, null), out err));
                Assert.Contains("没有 AppxManifest.xml", err);

                var broken = dir.File("broken.msix");
                File.WriteAllBytes(broken, File.ReadAllBytes(good).Take(200).ToArray());
                Assert.Null(PackageIdentity.Read(broken, out err));
                Assert.Contains("损坏", err);

                Assert.Null(PackageIdentity.Read(dir.File("missing.msix"), out err));
                Assert.Contains("读取安装包失败", err);
            }
        }

        [Test]
        public static void ProxyAddresses()
        {
            var p = ProxyEndpoint.Parse("socks5://127.0.0.1:1080", out var err);
            Assert.Equal("socks5://127.0.0.1:1080", p.ToString());
            Assert.Equal("http://127.0.0.1:7890", ProxyEndpoint.Parse(" 127.0.0.1:7890 ", out err).ToString());
            Assert.Equal("http://[::1]:8080", ProxyEndpoint.Parse("HTTP://[::1]:8080/", out err).ToString());
            Assert.Null(ProxyEndpoint.Parse("http://127.0.0.1", out err));
            Assert.Null(ProxyEndpoint.Parse("http://user:pw@127.0.0.1:80", out err));
            Assert.Null(ProxyEndpoint.Parse("ftp://127.0.0.1:21", out err));
            Assert.Contains("不支持", err);
            Assert.Null(ProxyEndpoint.Parse("http://127.0.0.1:70000", out err));

            Assert.Equal("http://127.0.0.1:7890", ProxyEndpoint.FromSystem(new SystemProxyInfo { Enabled = true, Server = "127.0.0.1:7890" }).ToString());
            Assert.Equal("http://10.0.0.2:3128", ProxyEndpoint.FromSystem(new SystemProxyInfo { Enabled = true, Server = "ftp=1.1.1.1:21;https=10.0.0.2:3128;http=10.0.0.3:80" }).ToString());
            Assert.Equal("socks4://127.0.0.1:1080", ProxyEndpoint.FromSystem(new SystemProxyInfo { Enabled = true, Server = "socks=127.0.0.1:1080" }).ToString());
            Assert.Null(ProxyEndpoint.FromSystem(new SystemProxyInfo { Enabled = false, Server = "127.0.0.1:7890" }));
            Assert.Null(ProxyEndpoint.FromSystem(new SystemProxyInfo { Enabled = true, AutoConfigUrl = "http://x/pac" }));
            Assert.True(new ProxyEndpoint { Host = "LOCALHOST", Port = 1 }.Equals(new ProxyEndpoint { Host = "localhost", Port = 1 }));
        }
    }
}
