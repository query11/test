using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ClaudeDesktopManager.Tests
{
    /// <summary>Tiny servers on 127.0.0.1 for the proxy tests.</summary>
    sealed class FakeServer : IDisposable
    {
        public enum Kind { Target, ChunkedTarget, HttpProxy, HttpProxyAuth, Socks5, Socks5Auth, Mixed, NotHttp }

        readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        readonly Kind kind;
        volatile bool stopped;
        public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;
        public int Connections;

        public FakeServer(Kind kind)
        {
            this.kind = kind;
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
                Interlocked.Increment(ref Connections);
                new Thread(() => { try { Handle(c); } catch (Exception) { } finally { c.Close(); } }) { IsBackground = true }.Start();
            }
        }

        static string ReadHead(Stream s)
        {
            var sb = new StringBuilder();
            while (!sb.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
            {
                int b = s.ReadByte();
                if (b < 0) break;
                sb.Append((char)b);
            }
            return sb.ToString();
        }

        static void Send(Stream s, string text)
        {
            var b = Encoding.ASCII.GetBytes(text);
            s.Write(b, 0, b.Length);
        }

        static byte[] Read(Stream s, int n)
        {
            var buf = new byte[n];
            int r = 0;
            while (r < n)
            {
                int k = s.Read(buf, r, n - r);
                if (k <= 0) throw new IOException("eof");
                r += k;
            }
            return buf;
        }

        static void Pipe(Stream a, string host, int port)
        {
            using (var upstream = new TcpClient(host, port))
            {
                var b = upstream.GetStream();
                var t1 = Task.Run(() => { try { a.CopyTo(b); } catch (Exception) { } });
                var t2 = Task.Run(() => { try { b.CopyTo(a); } catch (Exception) { } });
                Task.WaitAny(t1, t2);
                Thread.Sleep(50);
            }
        }

        void Handle(TcpClient c)
        {
            var s = c.GetStream();
            switch (kind)
            {
                case Kind.Target:
                    ReadHead(s);
                    Send(s, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\n127.0.0.9");
                    break;
                case Kind.ChunkedTarget:
                    ReadHead(s);
                    Send(s, "HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
                    break;
                case Kind.NotHttp:
                    Send(s, "SSH-2.0-OpenSSH_9.0\r\n");
                    Thread.Sleep(300);
                    break;
                case Kind.HttpProxy:
                case Kind.HttpProxyAuth:
                    HandleHttpProxy(s, ReadHead(s));
                    break;
                case Kind.Socks5:
                case Kind.Socks5Auth:
                    HandleSocks(s, Read(s, 1)[0]);
                    break;
                case Kind.Mixed:
                    int first = s.ReadByte();
                    if (first == 5) HandleSocks(s, 5);
                    else HandleHttpProxy(s, (char)first + ReadHead(s));
                    break;
            }
        }

        void HandleHttpProxy(Stream s, string head)
        {
            if (kind == Kind.HttpProxyAuth)
            {
                Send(s, "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            var first = head.Split(new[] { "\r\n" }, StringSplitOptions.None)[0].Split(' ');
            if (first[0] != "CONNECT") { Send(s, "HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
            var target = first[1];
            int colon = target.LastIndexOf(':');
            var host = target.Substring(0, colon).Trim('[', ']');
            var port = int.Parse(target.Substring(colon + 1));
            if (host == "claude.ai")
            {
                // The port probe only needs the answer, never the tunnel.
                Send(s, "HTTP/1.1 200 Connection established\r\n\r\n");
                return;
            }
            Send(s, "HTTP/1.1 200 Connection established\r\n\r\n");
            Pipe(s, host, port);
        }

        void HandleSocks(Stream s, byte version)
        {
            if (version != 5) return;
            int n = Read(s, 1)[0];
            Read(s, n);
            if (kind == Kind.Socks5Auth) { s.Write(new byte[] { 5, 0xFF }, 0, 2); return; }
            s.Write(new byte[] { 5, 0 }, 0, 2);
            var req = Read(s, 4);
            string host;
            if (req[3] == 3) host = Encoding.ASCII.GetString(Read(s, Read(s, 1)[0]));
            else if (req[3] == 1) host = new IPAddress(Read(s, 4)).ToString();
            else return;
            var pb = Read(s, 2);
            int port = pb[0] << 8 | pb[1];
            s.Write(new byte[] { 5, 0, 0, 1, 127, 0, 0, 1, 0, 0 }, 0, 10);
            Pipe(s, host, port);
        }

        public void Dispose()
        {
            stopped = true;
            listener.Stop();
        }
    }

    static class NetTests
    {
        static ProxyEndpoint Ep(string scheme, FakeServer s) => new ProxyEndpoint { Scheme = scheme, Host = "127.0.0.1", Port = s.Port };

        [Test]
        public static void DirectAndThroughProxies()
        {
            using (var target = new FakeServer(FakeServer.Kind.Target))
            using (var http = new FakeServer(FakeServer.Kind.HttpProxy))
            using (var socks = new FakeServer(FakeServer.Kind.Socks5))
            using (var mixed = new FakeServer(FakeServer.Kind.Mixed))
            {
                var url = "http://127.0.0.1:" + target.Port + "/ip?x=1";
                var direct = NetProbe.Fetch(null, url, 3000);
                Assert.True(direct.Ok, direct.Describe());
                Assert.Equal(200, direct.Status);
                Assert.Equal("127.0.0.9", direct.Body);

                foreach (var ep in new[] { Ep("http", http), Ep("socks5", socks), Ep("http", mixed), Ep("socks5", mixed) })
                {
                    var r = NetProbe.Fetch(ep, url, 3000);
                    Assert.True(r.Ok, ep + " " + r.Describe());
                    Assert.Equal("127.0.0.9", r.Body, ep.ToString());
                }
                Assert.True(http.Connections >= 1, "确实经过了代理");
            }
        }

        [Test]
        public static void ChunkedBody()
        {
            using (var target = new FakeServer(FakeServer.Kind.ChunkedTarget))
            {
                var r = NetProbe.Fetch(null, "http://127.0.0.1:" + target.Port + "/", 3000);
                Assert.True(r.Ok, r.Describe());
                Assert.Equal(404, r.Status);
                Assert.Equal("hello world", r.Body);
                Assert.Contains("HTTP 404", r.Describe());
            }
        }

        [Test]
        public static void ProxyErrorsAreExplained()
        {
            using (var auth = new FakeServer(FakeServer.Kind.HttpProxyAuth))
            using (var socksAuth = new FakeServer(FakeServer.Kind.Socks5Auth))
            using (var notHttp = new FakeServer(FakeServer.Kind.NotHttp))
            {
                var r = NetProbe.Fetch(Ep("http", auth), "http://example.invalid/", 3000);
                Assert.False(r.Ok);
                Assert.Equal("代理握手", r.Stage);
                Assert.Contains("407", r.Error);

                r = NetProbe.Fetch(Ep("socks5", socksAuth), "http://example.invalid/", 3000);
                Assert.False(r.Ok);
                Assert.Contains("用户名密码", r.Error);

                r = NetProbe.Fetch(Ep("http", notHttp), "http://example.invalid/", 3000);
                Assert.False(r.Ok);
                Assert.Contains("不是 HTTP", r.Error);

                int closedPort;
                using (var tmp = new FakeServer(FakeServer.Kind.Target)) closedPort = tmp.Port;
                Thread.Sleep(100);
                r = NetProbe.Fetch(new ProxyEndpoint { Scheme = "http", Host = "127.0.0.1", Port = closedPort }, "http://example.invalid/", 3000);
                Assert.False(r.Ok);
                Assert.Equal("连接代理", r.Stage);
            }
        }

        [Test]
        public static void PortProbeDetectsKinds()
        {
            using (var http = new FakeServer(FakeServer.Kind.HttpProxy))
            using (var socks = new FakeServer(FakeServer.Kind.Socks5))
            using (var mixed = new FakeServer(FakeServer.Kind.Mixed))
            using (var auth = new FakeServer(FakeServer.Kind.HttpProxyAuth))
            using (var target = new FakeServer(FakeServer.Kind.Target))
            {
                var h = NetProbe.ProbePort(http.Port);
                Assert.True(h.Http && !h.Socks5 && h.Usable, h.Describe());
                var s = NetProbe.ProbePort(socks.Port);
                Assert.True(s.Socks5 && !s.Http, s.Describe());
                var m = NetProbe.ProbePort(mixed.Port);
                Assert.True(m.Http && m.Socks5, m.Describe());
                Assert.Contains("混合端口", m.Describe());
                var a = NetProbe.ProbePort(auth.Port);
                Assert.True(a.Http && a.HttpNeedsAuth && !a.Usable, a.Describe());
                var t = NetProbe.ProbePort(target.Port);
                Assert.False(t.Http || t.Socks5, "普通 HTTP 服务不算代理：" + t.Describe());

                var found = NetProbe.ScanLocalProxies(new[] { http.Port, socks.Port, target.Port, 1 });
                Assert.Seq(new[] { http.Port, socks.Port }.OrderBy(x => x), found.Select(p => p.Port));
            }
        }
    }
}
