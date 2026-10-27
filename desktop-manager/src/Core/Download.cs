using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace ClaudeDesktopManager
{
    public sealed class DownloadProgress
    {
        /// <summary>Bytes in the file so far, including a part kept from an earlier try.</summary>
        public long Received;
        /// <summary>-1 while unknown.</summary>
        public long Total = -1;
        public double BytesPerSecond;

        /// <summary>-1 while the size is unknown.</summary>
        public int Percent => Total > 0 ? (int)Math.Min(100, Received * 100 / Total) : -1;

        public string Describe()
        {
            var parts = new List<string> { "已下载 " + Fmt.Bytes(Received) + (Total > 0 ? " / " + Fmt.Bytes(Total) : "") };
            if (BytesPerSecond >= 1) parts.Add(Fmt.Bytes((long)BytesPerSecond) + "/s");
            if (Total > 0 && BytesPerSecond >= 1 && Received < Total) parts.Add("还剩 " + Remaining((Total - Received) / BytesPerSecond));
            return string.Join(" · ", parts);
        }

        static string Remaining(double seconds)
        {
            var s = (long)Math.Ceiling(seconds);
            if (s < 60) return s + " 秒";
            if (s < 3600) return (s / 60) + " 分 " + (s % 60) + " 秒";
            return (s / 3600) + " 小时 " + (s % 3600 / 60) + " 分";
        }
    }

    public sealed class DownloadResult
    {
        public bool Ok;
        public bool Cancelled;
        /// <summary>A browser check (Cloudflare) is in the way; only a real browser gets past it.</summary>
        public bool Challenge;
        public string FilePath = "";
        public string FinalUrl = "";
        public int Status;
        public long Bytes;
        /// <summary>Carried on from a part file an earlier try left behind.</summary>
        public bool Resumed;
        /// <summary>The same file was already there in full; nothing was downloaded.</summary>
        public bool Reused;
        public int Attempts;
        public string Stage = "";
        public string Error = "";
    }

    /// <summary>
    /// Downloads one file over HTTP(S), directly or through a proxy: follows redirects, carries on from a part
    /// file an earlier try left behind, tries again when the connection drops half-way, reports progress and
    /// can be cancelled from another thread.
    /// </summary>
    public sealed class Downloader
    {
        public ProxyEndpoint Proxy;
        /// <summary>For connecting and for each read: a connection quiet for this long counts as dropped.</summary>
        public int TimeoutMs = 30000;
        public int MaxRedirects = 10;
        /// <summary>More tries after the connection dropped part-way through the file.</summary>
        public int Retries = 3;
        public int RetryDelayMs = 1000;
        public Action<DownloadProgress> Progress;
        public int ProgressIntervalMs = 250;
        public CancellationToken Cancel = CancellationToken.None;

        enum Outcome { Done, Failed, Dropped }

        sealed class LocalFileException : Exception
        {
            public LocalFileException(Exception inner) : base(inner.Message, inner) { }
        }

        /// <summary>
        /// Saves what <paramref name="url"/> leads to in <paramref name="dir"/>, named by <paramref name="nameFor"/> from
        /// each address on the way. The data goes to name.part first, which is renamed once it is complete.
        /// </summary>
        public DownloadResult Download(string url, string dir, Func<Uri, string> nameFor)
        {
            var r = new DownloadResult();
            if (!Uri.TryCreate(url, UriKind.Absolute, out var start) || (start.Scheme != Uri.UriSchemeHttps && start.Scheme != Uri.UriSchemeHttp))
            {
                r.Error = "下载地址不对：" + url;
                return r;
            }
            for (int attempt = 0; ; attempt++)
            {
                r.Attempts = attempt + 1;
                var outcome = Attempt(start, dir, nameFor, r);
                if (outcome != Outcome.Dropped) return r;
                if (attempt >= Retries)
                {
                    r.Error += "。已经下载的部分保留着，再试一次会接着下载";
                    return r;
                }
                if (Cancel.WaitHandle.WaitOne(RetryDelayMs * (attempt + 1)))
                {
                    Cancelled(r);
                    return r;
                }
            }
        }

        Outcome Attempt(Uri uri, string dir, Func<Uri, string> nameFor, DownloadResult r)
        {
            bool fromHttps = uri.Scheme == Uri.UriSchemeHttps;
            bool noRange = false;
            int hops = 0;
            while (true)
            {
                if (Cancel.IsCancellationRequested) return Cancelled(r);
                var target = Path.Combine(dir, SafeFileName(nameFor(uri)));
                var part = target + ".part";
                long have = 0;
                if (!noRange)
                {
                    try { have = File.Exists(part) ? new FileInfo(part).Length : 0; }
                    catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
                }
                long got = 0;
                bool complete = false;
                long total = -1;
                var c = new NetProbe.HttpConnection(Proxy, TimeoutMs);
                try
                {
                    using (c)
                    using (Cancel.Register(c.Abort))
                    {
                        c.Open(uri);
                        var head = have > 0 ? c.Get(uri, "Range: bytes=" + have.ToString(CultureInfo.InvariantCulture) + "-") : c.Get(uri);
                        int status = head.Status;
                        r.Status = status;
                        r.FinalUrl = uri.AbsoluteUri;
                        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308)
                        {
                            var location = head.Header("Location");
                            if (string.IsNullOrEmpty(location) || !Uri.TryCreate(uri, location, out var next))
                                return Fail(r, "HTTP", "服务器要求跳转（HTTP " + status + "），却没给出有效的地址");
                            if (next.Scheme != Uri.UriSchemeHttps && (fromHttps || next.Scheme != Uri.UriSchemeHttp))
                                return Fail(r, "HTTP", "拒绝跳转到不安全的地址：" + next.GetLeftPart(UriPartial.Path));
                            if (++hops > MaxRedirects) return Fail(r, "HTTP", "跳转次数太多");
                            uri = next;
                            continue;
                        }
                        if (status == 416 && have > 0)
                        {
                            // The part file does not fit what the server has now: start over.
                            noRange = true;
                            TryDelete(part);
                            continue;
                        }
                        if (status != 200 && status != 206)
                        {
                            var body = c.ReadText(head, 32 * 1024);
                            r.Challenge = LooksLikeChallenge(status, head, body);
                            return Fail(r, "HTTP", Explain(status, r.Challenge, body));
                        }

                        long offset = 0;
                        total = head.ContentLength;
                        if (status == 206)
                        {
                            if (!ParseContentRange(head.Header("Content-Range"), out long from, out long size) || from != have)
                            {
                                noRange = true;
                                TryDelete(part);
                                continue;
                            }
                            offset = have;
                            total = size;
                        }
                        if (total >= 0 && SameSize(target, total))
                        {
                            TryDelete(part);
                            r.Reused = true;
                            return Done(r, target, total);
                        }
                        if (total >= 0 && !EnoughSpace(dir, total - offset, out var spaceError)) return Fail(r, "保存", spaceError);
                        r.Resumed |= offset > 0;

                        var meter = new Meter(offset, total, Progress, ProgressIntervalMs);
                        using (var fs = OpenPart(dir, part, offset))
                        {
                            complete = c.CopyBody(head, (b, n) =>
                            {
                                try { fs.Write(b, 0, n); }
                                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { throw new LocalFileException(e); }
                                got += n;
                                meter.Add(n);
                            });
                        }
                        meter.Report();
                    }
                }
                catch (Exception e)
                {
                    if (Cancel.IsCancellationRequested) return Cancelled(r);
                    if (e is LocalFileException) return Fail(r, "保存", "写入文件失败：" + e.Message);
                    if (got > 0) return Dropped(r, NetProbe.Explain(e));
                    return Fail(r, e is NetProbe.StageException se ? se.Stage : c.Stage, NetProbe.Explain(e));
                }

                long length;
                try { length = new FileInfo(part).Length; }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { return Fail(r, "保存", e.Message); }
                r.Bytes = length;
                if (!complete || (total >= 0 && length < total))
                {
                    var msg = "连接在下载完成前断开了（已下载 " + Fmt.Bytes(length) + (total > 0 ? " / " + Fmt.Bytes(total) : "") + "）";
                    return got > 0 ? Dropped(r, msg) : Fail(r, "下载", msg);
                }
                if (total >= 0 && length > total)
                {
                    TryDelete(part);
                    return Fail(r, "保存", "下载的文件比服务器说的大，已删除，请重新下载");
                }
                try
                {
                    if (File.Exists(target)) File.Delete(target);
                    File.Move(part, target);
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
                {
                    return Fail(r, "保存", "下载好了，但没法改名为 " + Path.GetFileName(target) + "：" + e.Message);
                }
                return Done(r, target, length);
            }
        }

        static Outcome Done(DownloadResult r, string path, long bytes)
        {
            r.Ok = true;
            r.FilePath = path;
            r.Bytes = bytes;
            r.Stage = r.Error = "";
            return Outcome.Done;
        }

        static Outcome Fail(DownloadResult r, string stage, string error)
        {
            r.Stage = stage;
            r.Error = error;
            return Outcome.Failed;
        }

        static Outcome Dropped(DownloadResult r, string error)
        {
            r.Stage = "下载";
            r.Error = error;
            return Outcome.Dropped;
        }

        static Outcome Cancelled(DownloadResult r)
        {
            r.Cancelled = true;
            r.Stage = "下载";
            r.Error = "已取消";
            return Outcome.Failed;
        }

        static FileStream OpenPart(string dir, string part, long offset)
        {
            try
            {
                Directory.CreateDirectory(dir);
                return new FileStream(part, offset > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read);
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { throw new LocalFileException(e); }
        }

        static bool SameSize(string path, long size)
        {
            try { return File.Exists(path) && new FileInfo(path).Length == size; }
            catch (Exception) { return false; }
        }

        static void TryDelete(string path)
        {
            try { File.Delete(path); } catch (Exception) { }
        }

        static bool EnoughSpace(string dir, long needed, out string error)
        {
            error = null;
            try
            {
                var root = Path.GetPathRoot(Path.GetFullPath(dir));
                if (string.IsNullOrEmpty(root) || root.StartsWith(@"\\", StringComparison.Ordinal)) return true;
                long free = new DriveInfo(root).AvailableFreeSpace;
                if (free >= needed + 16L * 1024 * 1024) return true;
                error = "磁盘空间不够：还要 " + Fmt.Bytes(needed) + "，" + root + " 只剩 " + Fmt.Bytes(free);
                return false;
            }
            catch (Exception) { return true; }
        }

        static string SafeFileName(string name)
        {
            var bad = Path.GetInvalidFileNameChars();
            var s = new string((name ?? "").Select(ch => bad.Contains(ch) ? '_' : ch).ToArray()).Trim(' ', '.');
            return s.Length > 0 ? s : "download.bin";
        }

        /// <summary>"bytes 100-999/1000": where the part starts and the full size (-1 for "*").</summary>
        internal static bool ParseContentRange(string value, out long from, out long total)
        {
            from = total = -1;
            var m = Regex.Match(value ?? "", @"^\s*bytes\s+(\d+)-\d+/(\d+|\*)\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (!m.Success || !long.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out from)) return false;
            if (m.Groups[2].Value != "*" && !long.TryParse(m.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out total)) return false;
            return true;
        }

        internal static bool LooksLikeChallenge(int status, NetProbe.HttpHead head, string body)
        {
            if (string.Equals(head.Header("cf-mitigated"), "challenge", StringComparison.OrdinalIgnoreCase)) return true;
            if (status != 403 && status != 429 && status != 503) return false;
            foreach (var marker in new[] { "Just a moment", "cf-chl", "cf_chl", "challenge-platform" })
                if (body.IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        static string Explain(int status, bool challenge, string body)
        {
            if (challenge) return "网站要求先通过浏览器验证（Cloudflare，HTTP " + status + "），本工具没法自动完成";
            switch (status)
            {
                case 403: return "服务器拒绝了下载（HTTP 403），可能是不对这条线路（所在地区或 IP）开放";
                case 404: return "服务器上没有这个文件（HTTP 404），下载地址可能变了";
                case 407: return "代理要求用户名密码（HTTP 407）";
                case 429: return "请求太频繁（HTTP 429），过几分钟再试";
            }
            if (status >= 500) return "服务器暂时出错（HTTP " + status + "），稍后再试";
            var text = Regex.Replace(Regex.Replace(body ?? "", "<[^>]*>", " "), @"\s+", " ").Trim();
            return "服务器返回 HTTP " + status + (text.Length > 0 ? "：" + Fmt.Shorten(text, 120) : "");
        }

        /// <summary>Progress reports at most every few hundred milliseconds, with the speed over the last seconds.</summary>
        sealed class Meter
        {
            readonly long total;
            readonly Action<DownloadProgress> sink;
            readonly int intervalMs;
            readonly Stopwatch sw = Stopwatch.StartNew();
            readonly Queue<KeyValuePair<long, long>> samples = new Queue<KeyValuePair<long, long>>();
            long received, lastReport;

            public Meter(long start, long total, Action<DownloadProgress> sink, int intervalMs)
            {
                received = start;
                this.total = total;
                this.sink = sink;
                this.intervalMs = intervalMs;
                Report();
            }

            public void Add(int n)
            {
                received += n;
                if (sw.ElapsedMilliseconds - lastReport >= intervalMs) Report();
            }

            public void Report()
            {
                long now = sw.ElapsedMilliseconds;
                lastReport = now;
                samples.Enqueue(new KeyValuePair<long, long>(now, received));
                while (samples.Count > 2 && now - samples.Peek().Key > 3000) samples.Dequeue();
                var first = samples.Peek();
                double speed = now > first.Key ? (received - first.Value) * 1000.0 / (now - first.Key) : 0;
                sink?.Invoke(new DownloadProgress { Received = received, Total = total, BytesPerSecond = speed });
            }
        }
    }
}
