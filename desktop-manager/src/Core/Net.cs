using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;

namespace ClaudeDesktopManager
{
    public sealed class ProxyEndpoint
    {
        public string Scheme = "http";
        public string Host = "";
        public int Port;

        public static ProxyEndpoint From(ProxySettings p) =>
            p != null && p.Mode == ProxyMode.Manual ? new ProxyEndpoint { Scheme = p.Scheme, Host = p.Host.Trim(), Port = p.Port } : null;

        /// <summary>The proxy Windows is set to use for HTTPS; null when there is none (or only a PAC script).</summary>
        public static ProxyEndpoint FromSystem(SystemProxyInfo sys)
        {
            if (sys == null || !sys.Enabled || sys.Server.Length == 0) return null;
            var entries = sys.Server.Split(';').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            string pick = null, scheme = "http";
            foreach (var pref in new[] { "https=", "http=", "socks=" })
            {
                var e = entries.FirstOrDefault(x => x.StartsWith(pref, StringComparison.OrdinalIgnoreCase));
                if (e != null)
                {
                    pick = e.Substring(pref.Length);
                    if (pref == "socks=") scheme = "socks4";
                    break;
                }
            }
            if (pick == null) pick = entries.FirstOrDefault(x => !x.Contains("="));
            if (pick == null) return null;
            if (pick.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) pick = pick.Substring(7);
            int colon = pick.LastIndexOf(':');
            if (colon <= 0 || !int.TryParse(pick.Substring(colon + 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out var port)) return null;
            return new ProxyEndpoint { Scheme = scheme, Host = pick.Substring(0, colon).Trim('[', ']'), Port = port };
        }

        /// <summary>"http://127.0.0.1:7890", "socks5://127.0.0.1:1080"; a bare host:port means HTTP.</summary>
        public static ProxyEndpoint Parse(string text, out string error)
        {
            error = null;
            var t = (text ?? "").Trim();
            if (!t.Contains("://")) t = "http://" + t;
            var m = System.Text.RegularExpressions.Regex.Match(t, @"^(?<scheme>[A-Za-z0-9]+)://(?<host>\[[0-9A-Fa-f:.]+\]|[^:/@\s\[\]]+):(?<port>\d{1,5})/?$");
            if (!m.Success || !int.TryParse(m.Groups["port"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int port) || port < 1 || port > 65535)
            {
                error = "代理地址应该像 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080";
                return null;
            }
            var scheme = m.Groups["scheme"].Value.ToLowerInvariant();
            if (!ProxyLogic.Schemes.Contains(scheme))
            {
                error = "不支持的代理协议：" + scheme;
                return null;
            }
            return new ProxyEndpoint { Scheme = scheme, Host = m.Groups["host"].Value.Trim('[', ']'), Port = port };
        }

        public override string ToString() => Scheme + "://" + ProxyLogic.UrlHost(Host) + ":" + Port.ToString(CultureInfo.InvariantCulture);

        public override bool Equals(object obj) =>
            obj is ProxyEndpoint o && o.Scheme == Scheme && string.Equals(o.Host, Host, StringComparison.OrdinalIgnoreCase) && o.Port == Port;

        public override int GetHashCode() => ToString().ToLowerInvariant().GetHashCode();
    }

    public sealed class FetchResult
    {
        public string Url = "";
        /// <summary>An HTTP response came back (any status code).</summary>
        public bool Ok;
        public int Status;
        public string StatusLine = "";
        public long ConnectMs, TunnelMs, TlsMs, TotalMs;
        public string Body = "";
        public string Stage = "";
        public string Error = "";

        public string Describe()
        {
            if (!Ok) return "失败（" + Stage + "）：" + Error;
            var t = new List<string> { "连接 " + ConnectMs + " ms" };
            if (TunnelMs > 0) t.Add("代理握手 " + TunnelMs + " ms");
            if (TlsMs > 0) t.Add("TLS " + TlsMs + " ms");
            t.Add("共 " + TotalMs + " ms");
            return "HTTP " + Status + "（" + string.Join("，", t) + "）";
        }
    }

    public sealed class PortProbe
    {
        public int Port;
        public bool Http;
        public bool HttpNeedsAuth;
        public bool Socks5;
        public bool Socks5NeedsAuth;

        public bool Usable => (Http && !HttpNeedsAuth) || (Socks5 && !Socks5NeedsAuth);

        public string Describe()
        {
            var kinds = new List<string>();
            if (Http) kinds.Add(HttpNeedsAuth ? "HTTP（要密码）" : "HTTP");
            if (Socks5) kinds.Add(Socks5NeedsAuth ? "SOCKS5（要密码）" : "SOCKS5");
            return "127.0.0.1:" + Port + "  " + string.Join(" + ", kinds) + (Http && Socks5 ? "（混合端口）" : "");
        }
    }

    public static class NetProbe
    {
        public static readonly int[] CommonProxyPorts =
        {
            7890, 7891, 7897, 7898, 7899, 1080, 1081, 1086, 1087, 10808, 10809, 10810, 10811,
            2080, 2081, 20170, 20171, 20172, 8080, 8118, 8888, 8889, 3128, 9050, 9150, 6152, 6153, 12334, 33210, 33211,
        };

        internal const string UserAgent = "ClaudeDesktopManager/" + AppInfo.Version;

        internal sealed class StageException : Exception
        {
            public readonly string Stage;

            public StageException(string stage, string message) : base(message) { Stage = stage; }
        }

        public static FetchResult Fetch(ProxyEndpoint proxy, string url, int timeoutMs = 8000, int maxBody = 64 * 1024)
        {
            var r = new FetchResult { Url = url };
            var sw = Stopwatch.StartNew();
            var c = new HttpConnection(proxy, timeoutMs);
            try
            {
                using (c)
                {
                    var uri = new Uri(url);
                    c.Open(uri);
                    var head = c.Get(uri);
                    r.StatusLine = head.StatusLine;
                    r.Status = head.Status;
                    r.Body = c.ReadText(head, maxBody);
                    r.Ok = true;
                }
            }
            catch (Exception e)
            {
                r.Stage = e is StageException se ? se.Stage : c.Stage;
                r.Error = Explain(e);
            }
            r.ConnectMs = c.ConnectMs;
            r.TunnelMs = c.TunnelMs;
            r.TlsMs = c.TlsMs;
            r.TotalMs = sw.ElapsedMilliseconds;
            return r;
        }

        internal static string Explain(Exception e)
        {
            if (e is AggregateException ae && ae.InnerException != null) e = ae.InnerException;
            if (e is System.Security.Authentication.AuthenticationException)
                return "证书验证失败（" + e.Message + "）。如果代理在做 HTTPS 解密，需要信任它的根证书";
            if (e is SocketException se)
            {
                switch (se.SocketErrorCode)
                {
                    case SocketError.ConnectionRefused: return "连接被拒绝（端口上没有程序在监听）";
                    case SocketError.TimedOut: return "连接超时";
                    case SocketError.HostNotFound: case SocketError.NoData: return "域名解析失败";
                    case SocketError.NetworkUnreachable: case SocketError.HostUnreachable: return "网络不可达";
                    case SocketError.ConnectionReset: return "连接被重置";
                }
                return se.Message;
            }
            if (e is IOException io && io.InnerException is SocketException inner)
            {
                if (inner.SocketErrorCode == SocketError.TimedOut) return "等待响应超时";
                return Explain(inner);
            }
            if (e is TimeoutException) return e.Message.Length > 0 ? e.Message : "超时";
            return e.Message;
        }

        static void Connect(TcpClient client, string host, int port, int timeoutMs)
        {
            var task = client.ConnectAsync(host, port);
            bool done;
            try { done = task.Wait(timeoutMs); }
            catch (AggregateException ae) { throw ae.InnerException ?? ae; }
            if (!done)
            {
                // Observe the eventual failure so it does not surface as an unobserved task exception.
                task.ContinueWith(t => { var _ = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                throw new TimeoutException("连接 " + host + ":" + port + " 超时");
            }
        }

        static Stream OpenTunnel(Stream s, ProxyEndpoint proxy, string host, int port)
        {
            switch (proxy.Scheme)
            {
                case "https":
                    var ssl = new SslStream(s, false);
                    ssl.AuthenticateAsClient(proxy.Host);
                    HttpConnect(ssl, host, port);
                    return ssl;
                case "http":
                    HttpConnect(s, host, port);
                    return s;
                case "socks5":
                    Socks5(s, host, port);
                    return s;
                case "socks4":
                    Socks4a(s, host, port);
                    return s;
                default:
                    throw new StageException("代理握手", "不支持的代理协议 " + proxy.Scheme);
            }
        }

        static void HttpConnect(Stream s, string host, int port)
        {
            var target = ProxyLogic.UrlHost(host) + ":" + port.ToString(CultureInfo.InvariantCulture);
            var req = "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\nUser-Agent: " + UserAgent + "\r\nProxy-Connection: keep-alive\r\n\r\n";
            var bytes = Encoding.ASCII.GetBytes(req);
            s.Write(bytes, 0, bytes.Length);
            s.Flush();
            // Byte by byte: nothing after the blank line may be consumed, it belongs to TLS.
            var head = new HttpReader(s, byteByByte: true).ReadHead();
            var line = head.Count > 0 ? head[0] : "";
            int status = ParseStatus(line);
            if (status == 407) throw new StageException("代理握手", "代理要求用户名密码（HTTP 407），Claude Desktop 不支持代理登录");
            if (status < 200 || status > 299)
                throw new StageException("代理握手", status == 0 ? "代理的回应不是 HTTP：" + Fmt.Shorten(line, 80) : "代理拒绝了连接：" + line);
        }

        static void Socks5(Stream s, string host, int port)
        {
            s.Write(new byte[] { 5, 1, 0 }, 0, 3);
            var hello = ReadExactly(s, 2);
            if (hello[0] != 5) throw new StageException("代理握手", "不是 SOCKS5 代理");
            if (hello[1] == 0xFF) throw new StageException("代理握手", "SOCKS5 代理要求用户名密码，Claude Desktop 不支持");
            if (hello[1] != 0) throw new StageException("代理握手", "SOCKS5 代理要求不支持的认证方式 " + hello[1]);
            var hostBytes = Encoding.ASCII.GetBytes(host);
            if (hostBytes.Length > 255) throw new StageException("代理握手", "域名太长");
            var req = new List<byte> { 5, 1, 0, 3, (byte)hostBytes.Length };
            req.AddRange(hostBytes);
            req.Add((byte)(port >> 8));
            req.Add((byte)(port & 0xFF));
            s.Write(req.ToArray(), 0, req.Count);
            var head = ReadExactly(s, 4);
            if (head[1] != 0) throw new StageException("代理握手", "SOCKS5 连接失败：" + Socks5Error(head[1]));
            int skip;
            switch (head[3])
            {
                case 1: skip = 4; break;
                case 4: skip = 16; break;
                case 3: skip = ReadExactly(s, 1)[0]; break;
                default: throw new StageException("代理握手", "SOCKS5 回应格式不对");
            }
            ReadExactly(s, skip + 2);
        }

        static string Socks5Error(byte code)
        {
            switch (code)
            {
                case 1: return "代理服务器内部错误";
                case 2: return "规则不允许";
                case 3: return "网络不可达";
                case 4: return "主机不可达";
                case 5: return "目标拒绝连接";
                case 6: return "超时";
                case 7: return "不支持的命令";
                case 8: return "不支持的地址类型";
                default: return "错误码 " + code;
            }
        }

        static void Socks4a(Stream s, string host, int port)
        {
            var req = new List<byte> { 4, 1, (byte)(port >> 8), (byte)(port & 0xFF), 0, 0, 0, 1, 0 };
            req.AddRange(Encoding.ASCII.GetBytes(host));
            req.Add(0);
            s.Write(req.ToArray(), 0, req.Count);
            var reply = ReadExactly(s, 8);
            if (reply[1] != 0x5A) throw new StageException("代理握手", "SOCKS4 连接失败（" + reply[1] + "）");
        }

        static byte[] ReadExactly(Stream s, int n)
        {
            var buf = new byte[n];
            int read = 0;
            while (read < n)
            {
                int k = s.Read(buf, read, n - read);
                if (k <= 0) throw new StageException("代理握手", "代理提前断开了连接");
                read += k;
            }
            return buf;
        }

        static int ParseStatus(string line)
        {
            if (line == null || !line.StartsWith("HTTP/", StringComparison.Ordinal)) return 0;
            var parts = line.Split(' ');
            return parts.Length >= 2 && int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var st) ? st : 0;
        }

        /// <summary>Public IP seen by the internet through the proxy (or directly).</summary>
        public static string ExitIp(ProxyEndpoint proxy, out FetchResult result, int timeoutMs = 8000)
        {
            result = Fetch(proxy, "https://api.ipify.org/", timeoutMs, 256);
            if (!result.Ok || result.Status != 200) return null;
            var ip = result.Body.Trim();
            return IPAddress.TryParse(ip, out _) ? ip : null;
        }

        public static List<PortProbe> ScanLocalProxies(IEnumerable<int> ports, int connectTimeoutMs = 400)
        {
            var tasks = ports.Distinct().Select(port => Task.Run(() => ProbePort(port, connectTimeoutMs))).ToArray();
            Task.WaitAll(tasks);
            return tasks.Select(t => t.Result).Where(p => p != null && (p.Http || p.Socks5)).OrderBy(p => p.Port).ToList();
        }

        public static PortProbe ProbePort(int port, int connectTimeoutMs = 400, string host = "127.0.0.1")
        {
            var probe = new PortProbe { Port = port };
            try
            {
                using (var c = new TcpClient())
                {
                    Connect(c, host, port, connectTimeoutMs);
                }
            }
            catch (Exception) { return null; }

            try
            {
                using (var c = new TcpClient())
                {
                    Connect(c, host, port, connectTimeoutMs);
                    var s = c.GetStream();
                    s.ReadTimeout = s.WriteTimeout = 800;
                    s.Write(new byte[] { 5, 1, 0 }, 0, 3);
                    var b = new byte[2];
                    int n = s.Read(b, 0, 2);
                    if (n >= 1 && b[0] == 5)
                    {
                        probe.Socks5 = true;
                        probe.Socks5NeedsAuth = n == 2 && b[1] == 0xFF;
                    }
                }
            }
            catch (Exception) { }

            try
            {
                using (var c = new TcpClient())
                {
                    Connect(c, host, port, connectTimeoutMs);
                    var s = c.GetStream();
                    s.ReadTimeout = s.WriteTimeout = 2000;
                    var bytes = Encoding.ASCII.GetBytes("CONNECT claude.ai:443 HTTP/1.1\r\nHost: claude.ai:443\r\nUser-Agent: " + UserAgent + "\r\n\r\n");
                    s.Write(bytes, 0, bytes.Length);
                    var head = new HttpReader(s, byteByByte: true).ReadHead();
                    int status = head.Count > 0 ? ParseStatus(head[0]) : 0;
                    // A tunnel answer has no body; a web server that answers 200 to anything sends one.
                    bool hasBody = head.Skip(1).Any(h =>
                        h.StartsWith("Transfer-Encoding:", StringComparison.OrdinalIgnoreCase)
                        || (h.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase) && h.Substring(15).Trim() != "0"));
                    if (status >= 200 && status <= 299 && !hasBody) probe.Http = true;
                    else if (status == 407) { probe.Http = true; probe.HttpNeedsAuth = true; }
                }
            }
            catch (Exception) { }
            return probe;
        }

        /// <summary>One request over a fresh connection: TCP, then the proxy tunnel, then TLS.</summary>
        internal sealed class HttpConnection : IDisposable
        {
            readonly ProxyEndpoint proxy;
            readonly int timeoutMs;
            readonly Stopwatch sw = Stopwatch.StartNew();
            readonly TcpClient client = new TcpClient();
            Stream stream;
            HttpReader reader;

            /// <summary>What was going on when something failed.</summary>
            public string Stage;
            public long ConnectMs, TunnelMs, TlsMs;

            public HttpConnection(ProxyEndpoint proxy, int timeoutMs)
            {
                this.proxy = proxy;
                this.timeoutMs = timeoutMs;
                Stage = proxy != null ? "连接代理" : "连接";
            }

            public void Open(Uri uri)
            {
                string host = uri.IdnHost;
                int port = uri.Port;
                Connect(client, proxy != null ? proxy.Host : host, proxy != null ? proxy.Port : port, timeoutMs);
                ConnectMs = sw.ElapsedMilliseconds;
                stream = client.GetStream();
                stream.ReadTimeout = stream.WriteTimeout = timeoutMs;
                if (proxy != null)
                {
                    Stage = "代理握手";
                    stream = OpenTunnel(stream, proxy, host, port);
                    TunnelMs = sw.ElapsedMilliseconds - ConnectMs;
                }
                if (uri.Scheme == Uri.UriSchemeHttps)
                {
                    Stage = "TLS";
                    long before = sw.ElapsedMilliseconds;
                    var ssl = new SslStream(stream, false);
                    ssl.AuthenticateAsClient(host);
                    stream = ssl;
                    TlsMs = sw.ElapsedMilliseconds - before;
                }
                Stage = "HTTP";
            }

            /// <summary>Sends a GET and reads the status line and headers.</summary>
            public HttpHead Get(Uri uri, params string[] headers)
            {
                string hostHeader = uri.IsDefaultPort ? uri.Host : uri.Host + ":" + uri.Port.ToString(CultureInfo.InvariantCulture);
                var req = new StringBuilder("GET " + uri.PathAndQuery + " HTTP/1.1\r\nHost: " + hostHeader + "\r\nUser-Agent: " + UserAgent + "\r\nAccept: */*\r\n");
                foreach (var h in headers) req.Append(h).Append("\r\n");
                req.Append("Connection: close\r\n\r\n");
                var bytes = Encoding.ASCII.GetBytes(req.ToString());
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
                reader = new HttpReader(stream);
                var head = new HttpHead(reader.ReadHead());
                if (head.Status == 0) throw new StageException("HTTP", "响应不是 HTTP：" + Fmt.Shorten(head.StatusLine, 80));
                return head;
            }

            public string ReadText(HttpHead head, int max) => reader.ReadBody(head, max);

            /// <summary>Hands the body to <paramref name="sink"/> piece by piece; false when the connection ended before all of it came.</summary>
            public bool CopyBody(HttpHead head, Action<byte[], int> sink) => reader.CopyBody(head, sink);

            /// <summary>Makes a read blocked on this connection fail at once (cancelling from another thread).</summary>
            public void Abort()
            {
                try { client.Close(); } catch (Exception) { }
            }

            public void Dispose()
            {
                try { stream?.Dispose(); } catch (Exception) { }
                client.Close();
            }
        }

        /// <summary>Status line and headers of a response.</summary>
        internal sealed class HttpHead
        {
            public readonly List<string> Lines;

            public HttpHead(List<string> lines) { Lines = lines; }

            public string StatusLine => Lines.Count > 0 ? Lines[0] : "";

            public int Status => ParseStatus(StatusLine);

            public string Header(string name)
            {
                foreach (var h in Lines.Skip(1))
                {
                    int i = h.IndexOf(':');
                    if (i > 0 && h.Substring(0, i).Trim().Equals(name, StringComparison.OrdinalIgnoreCase)) return h.Substring(i + 1).Trim();
                }
                return null;
            }

            /// <summary>-1 when not given.</summary>
            public long ContentLength =>
                long.TryParse(Header("Content-Length"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) && n >= 0 ? n : -1;

            public bool Chunked => (Header("Transfer-Encoding") ?? "").IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>Minimal HTTP/1.1 response reader (status line, headers, Content-Length or chunked body).</summary>
        sealed class HttpReader
        {
            readonly Stream s;
            readonly bool byteByByte;
            readonly byte[] buf = new byte[8192];
            int pos, len;

            public HttpReader(Stream stream, bool byteByByte = false)
            {
                s = stream;
                this.byteByByte = byteByByte;
            }

            int ReadByte()
            {
                if (pos >= len)
                {
                    len = s.Read(buf, 0, byteByByte ? 1 : buf.Length);
                    pos = 0;
                    if (len <= 0) return -1;
                }
                return buf[pos++];
            }

            /// <summary>Whatever is already buffered first, then straight from the stream.</summary>
            int Read(byte[] dst, int count)
            {
                if (pos < len)
                {
                    int n = Math.Min(count, len - pos);
                    Buffer.BlockCopy(buf, pos, dst, 0, n);
                    pos += n;
                    return n;
                }
                return s.Read(dst, 0, count);
            }

            string ReadLine(bool allowEof)
            {
                var sb = new StringBuilder();
                while (true)
                {
                    int b = ReadByte();
                    if (b < 0)
                    {
                        if (allowEof) return sb.Length > 0 ? sb.ToString() : null;
                        throw new StageException("HTTP", "连接在响应完成前断开了");
                    }
                    if (b == '\n') break;
                    if (b != '\r') sb.Append((char)b);
                    if (sb.Length > 16 * 1024) throw new StageException("HTTP", "响应头太长");
                }
                return sb.ToString();
            }

            /// <summary>Status line and headers; stops after the first line when it is not HTTP at all.</summary>
            public List<string> ReadHead()
            {
                var lines = new List<string>();
                while (true)
                {
                    var line = ReadLine(lines.Count == 0);
                    if (line == null) throw new StageException("HTTP", "没有收到任何响应");
                    if (line.Length == 0) break;
                    lines.Add(line);
                    if (lines.Count == 1 && !line.StartsWith("HTTP/", StringComparison.Ordinal)) break;
                    if (lines.Count > 200) throw new StageException("HTTP", "响应头太多");
                }
                return lines;
            }

            /// <summary>The body as text, cut at <paramref name="max"/> bytes; a connection that breaks off just ends it.</summary>
            public string ReadBody(HttpHead head, int max)
            {
                var body = new MemoryStream();
                try
                {
                    CopyBody(head, (b, n) =>
                    {
                        body.Write(b, 0, (int)Math.Min(n, max - body.Length));
                        if (body.Length >= max) throw new EnoughException();
                    });
                }
                catch (EnoughException) { }
                // Whatever arrived is still worth showing.
                catch (IOException) { }
                catch (StageException) { }
                return Encoding.UTF8.GetString(body.ToArray());
            }

            sealed class EnoughException : Exception { }

            public bool CopyBody(HttpHead head, Action<byte[], int> sink)
            {
                var chunk = new byte[64 * 1024];
                if (head.Chunked)
                {
                    while (true)
                    {
                        var sizeLine = ReadLine(true);
                        if (sizeLine == null) return false;
                        var hex = sizeLine.Split(';')[0].Trim();
                        if (!long.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out long size) || size < 0)
                            throw new StageException("HTTP", "分块编码格式不对：" + Fmt.Shorten(sizeLine, 40));
                        if (size == 0) return true;
                        if (!CopyExactly(size, chunk, sink)) return false;
                        ReadLine(true);
                    }
                }
                long length = head.ContentLength;
                if (length >= 0) return CopyExactly(length, chunk, sink);
                // Neither: the body runs until the server closes the connection.
                while (true)
                {
                    int n = Read(chunk, chunk.Length);
                    if (n <= 0) return true;
                    sink(chunk, n);
                }
            }

            bool CopyExactly(long count, byte[] chunk, Action<byte[], int> sink)
            {
                while (count > 0)
                {
                    int n = Read(chunk, (int)Math.Min(chunk.Length, count));
                    if (n <= 0) return false;
                    count -= n;
                    sink(chunk, n);
                }
                return true;
            }
        }
    }
}
