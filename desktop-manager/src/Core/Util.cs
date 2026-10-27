using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace ClaudeDesktopManager
{
    public static class Fmt
    {
        public static string Bytes(long b)
        {
            if (b < 1024) return b + " B";
            double v = b;
            string[] units = { "KB", "MB", "GB", "TB" };
            int i = -1;
            do { v /= 1024; i++; } while (v >= 1024 && i < units.Length - 1);
            return v.ToString(v >= 100 ? "0" : v >= 10 ? "0.0" : "0.00", CultureInfo.InvariantCulture) + " " + units[i];
        }

        public static string Duration(TimeSpan t)
        {
            if (t < TimeSpan.Zero) t = TimeSpan.Zero;
            if (t.TotalDays >= 1) return string.Format(CultureInfo.InvariantCulture, "{0} 天 {1}:{2:00}:{3:00}", (int)t.TotalDays, t.Hours, t.Minutes, t.Seconds);
            return string.Format(CultureInfo.InvariantCulture, "{0}:{1:00}:{2:00}", t.Hours, t.Minutes, t.Seconds);
        }

        public static string Shorten(string s, int max)
        {
            if (s == null) return "";
            s = s.Replace("\r", " ").Replace("\n", " ");
            return s.Length <= max ? s : s.Substring(0, max - 1) + "…";
        }

        public static string Service(ServiceState s)
        {
            switch (s)
            {
                case ServiceState.NotInstalled: return "未安装";
                case ServiceState.Stopped: return "已停止";
                case ServiceState.StartPending: return "正在启动";
                case ServiceState.StopPending: return "正在停止";
                case ServiceState.Running: return "运行中";
                case ServiceState.Other: return "暂停或其他状态";
                default: return "未知";
            }
        }

        public static string Offset(TimeSpan o) =>
            "UTC" + (o < TimeSpan.Zero ? "-" : "+") + o.Duration().ToString(@"hh\:mm", CultureInfo.InvariantCulture);
    }

    public static class LogTools
    {
        /// <summary>Last <paramref name="maxLines"/> lines of a file that may still be written to.</summary>
        public static string Tail(string path, int maxLines, int maxBytes = 1024 * 1024)
        {
            try
            {
                if (string.IsNullOrEmpty(path) || !File.Exists(path)) return "";
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    long start = Math.Max(0, fs.Length - maxBytes);
                    fs.Position = start;
                    var buf = new byte[fs.Length - start];
                    int read = 0;
                    while (read < buf.Length)
                    {
                        int n = fs.Read(buf, read, buf.Length - read);
                        if (n <= 0) break;
                        read += n;
                    }
                    var text = Encoding.UTF8.GetString(buf, 0, read);
                    var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
                    if (start > 0 && lines.Count > 0) lines.RemoveAt(0);
                    if (lines.Count > 0 && lines[lines.Count - 1].Length == 0) lines.RemoveAt(lines.Count - 1);
                    if (lines.Count > maxLines) lines = lines.GetRange(lines.Count - maxLines, maxLines);
                    return string.Join(Environment.NewLine, lines);
                }
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                return "（读取失败：" + e.Message + "）";
            }
        }

        static readonly string[] EgressMarkers =
        {
            "[egress-proxy]", "system proxy", "Skipping SOCKS", "proxy for Code sessions", "egress pinned", "PAC fetch",
        };

        /// <summary>Lines of main.log about which proxy Claude actually uses.</summary>
        public static List<string> EgressLines(string text) =>
            (text ?? "").Replace("\r\n", "\n").Split('\n')
                .Where(l => EgressMarkers.Any(m => l.IndexOf(m, StringComparison.OrdinalIgnoreCase) >= 0))
                .ToList();

        public static List<string> ListLogFiles(string logsDir)
        {
            try
            {
                if (string.IsNullOrEmpty(logsDir) || !Directory.Exists(logsDir)) return new List<string>();
                return Directory.GetFiles(logsDir, "*.log")
                    .OrderBy(f => Path.GetFileName(f).Equals("main.log", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                    .ThenByDescending(f => File.GetLastWriteTimeUtc(f))
                    .ToList();
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                return new List<string>();
            }
        }
    }

    public sealed class CleanResult
    {
        public long Freed;
        public int Files;
        public List<string> Failed = new List<string>();
    }

    public static class Maintenance
    {
        /// <summary>Chromium caches; deleting them keeps the sign-in, settings and history.</summary>
        public static readonly string[] CacheDirs =
        {
            "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
            "GrShaderCache", "ShaderCache", Path.Combine("Service Worker", "CacheStorage"),
            Path.Combine("Service Worker", "ScriptCache"), Path.Combine("Crashpad", "reports"),
        };

        public static long DirSize(string dir)
        {
            long total = 0;
            try
            {
                if (!Directory.Exists(dir)) return 0;
                var stack = new Stack<string>();
                stack.Push(dir);
                while (stack.Count > 0)
                {
                    var d = stack.Pop();
                    try
                    {
                        foreach (var f in Directory.GetFiles(d))
                        {
                            try { total += new FileInfo(f).Length; } catch (Exception) { }
                        }
                        foreach (var sub in Directory.GetDirectories(d))
                        {
                            // Junctions / symlinks could loop or point outside; count them as zero.
                            var attr = File.GetAttributes(sub);
                            if ((attr & FileAttributes.ReparsePoint) == 0) stack.Push(sub);
                        }
                    }
                    catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
                }
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            return total;
        }

        public static List<KeyValuePair<string, long>> MeasureCaches(string dataDir)
        {
            var list = new List<KeyValuePair<string, long>>();
            if (string.IsNullOrEmpty(dataDir)) return list;
            foreach (var c in CacheDirs)
            {
                var p = Path.Combine(dataDir, c);
                if (Directory.Exists(p)) list.Add(new KeyValuePair<string, long>(c, DirSize(p)));
            }
            return list;
        }

        /// <summary>Top-level folders of the data directory with their sizes, biggest first.</summary>
        public static List<KeyValuePair<string, long>> MeasureDataDir(string dataDir)
        {
            var list = new List<KeyValuePair<string, long>>();
            try
            {
                if (string.IsNullOrEmpty(dataDir) || !Directory.Exists(dataDir)) return list;
                foreach (var d in Directory.GetDirectories(dataDir))
                    list.Add(new KeyValuePair<string, long>(Path.GetFileName(d), DirSize(d)));
                long files = 0;
                foreach (var f in Directory.GetFiles(dataDir))
                {
                    try { files += new FileInfo(f).Length; } catch (Exception) { }
                }
                if (files > 0) list.Add(new KeyValuePair<string, long>("（目录下的文件）", files));
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            return list.OrderByDescending(kv => kv.Value).ToList();
        }

        public static CleanResult CleanCaches(string dataDir)
        {
            var r = new CleanResult();
            if (string.IsNullOrEmpty(dataDir)) return r;
            foreach (var c in CacheDirs)
            {
                var dir = Path.Combine(dataDir, c);
                if (!Directory.Exists(dir)) continue;
                foreach (var f in SafeFiles(dir))
                {
                    try
                    {
                        long len = new FileInfo(f).Length;
                        File.SetAttributes(f, FileAttributes.Normal);
                        File.Delete(f);
                        r.Freed += len;
                        r.Files++;
                    }
                    catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
                    {
                        if (r.Failed.Count < 20) r.Failed.Add(f + "：" + e.Message);
                    }
                }
                // Empty sub-folders go too; the cache folder itself stays.
                foreach (var sub in SafeDirs(dir).OrderByDescending(s => s.Length))
                {
                    try { Directory.Delete(sub, false); } catch (Exception) { }
                }
            }
            return r;
        }

        static IEnumerable<string> SafeFiles(string dir)
        {
            var result = new List<string>();
            var stack = new Stack<string>();
            stack.Push(dir);
            while (stack.Count > 0)
            {
                var d = stack.Pop();
                try
                {
                    result.AddRange(Directory.GetFiles(d));
                    foreach (var sub in Directory.GetDirectories(d))
                        if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) == 0) stack.Push(sub);
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            }
            return result;
        }

        static IEnumerable<string> SafeDirs(string dir)
        {
            var result = new List<string>();
            var stack = new Stack<string>();
            stack.Push(dir);
            while (stack.Count > 0)
            {
                var d = stack.Pop();
                try
                {
                    foreach (var sub in Directory.GetDirectories(d))
                        if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) == 0)
                        {
                            result.Add(sub);
                            stack.Push(sub);
                        }
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            }
            return result;
        }
    }

    public sealed class McpServer
    {
        public string Name = "";
        public bool Enabled;
        public string Kind = "";
        public string Summary = "";
        public JsonObject Raw;
    }

    /// <summary>Lists, disables and re-enables servers in claude_desktop_config.json.</summary>
    public static class McpConfig
    {
        public const string Key = "mcpServers";
        public const int KeepBackups = 10;

        public static JsonObject Load(string path, out string error)
        {
            error = null;
            if (string.IsNullOrEmpty(path)) { error = "没有找到配置文件位置"; return null; }
            if (!File.Exists(path)) return new JsonObject();
            try
            {
                var text = File.ReadAllText(path, Encoding.UTF8);
                if (text.Trim().Length == 0) return new JsonObject();
                return Json.ParseObject(text);
            }
            catch (Exception e) when (e is JsonException || e is IOException || e is UnauthorizedAccessException)
            {
                error = "配置文件读取失败：" + e.Message;
                return null;
            }
        }

        static string StashKey(string path) => KnownDirs.Normalize(path).ToLowerInvariant();

        public static JsonObject StashFor(JsonObject stash, string path, bool create)
        {
            var key = StashKey(path);
            var o = stash.GetObject(key);
            if (o == null && create)
            {
                o = new JsonObject();
                stash.Set(key, o);
            }
            return o;
        }

        public static List<McpServer> List(JsonObject root, JsonObject stash, string path)
        {
            var list = new List<McpServer>();
            var servers = root?.GetObject(Key);
            if (servers != null)
                foreach (var kv in servers)
                    list.Add(Describe(kv.Key, kv.Value as JsonObject, true));
            var stashed = StashFor(stash, path, false);
            if (stashed != null)
                foreach (var kv in stashed)
                    if (servers == null || !servers.ContainsKey(kv.Key))
                        list.Add(Describe(kv.Key, kv.Value as JsonObject, false));
            return list;
        }

        static McpServer Describe(string name, JsonObject o, bool enabled)
        {
            var s = new McpServer { Name = name, Enabled = enabled, Raw = o };
            if (o == null) { s.Kind = "?"; return s; }
            var url = o.GetString("url");
            if (url != null)
            {
                s.Kind = o.GetString("type") ?? "http";
                s.Summary = url;
                return s;
            }
            s.Kind = "stdio";
            var parts = new List<string>();
            var cmd = o.GetString("command");
            if (cmd != null) parts.Add(cmd);
            var args = o.GetArray("args");
            if (args != null) parts.AddRange(args.Select(a => a is string str ? str : Json.Serialize(a, false)));
            s.Summary = CommandLine.Join(parts);
            var env = o.GetObject("env");
            if (env != null && env.Count > 0) s.Summary += "  （环境变量：" + string.Join("、", env.Keys) + "）";
            return s;
        }

        /// <summary>Moves servers between the config file and the stash. Returns the backup path.</summary>
        public static string SetEnabled(string path, JsonObject stash, IEnumerable<string> names, bool enable, out List<string> problems)
        {
            problems = new List<string>();
            var root = Load(path, out var error);
            if (root == null) { problems.Add(error); return null; }
            var servers = root.GetObject(Key);
            var stashed = StashFor(stash, path, true);
            int changed = 0;
            foreach (var name in names)
            {
                if (enable)
                {
                    var o = stashed.GetObject(name);
                    if (o == null) continue;
                    if (servers == null) root.Set(Key, servers = new JsonObject());
                    if (servers.ContainsKey(name)) { problems.Add("配置里已经有同名的「" + name + "」，没有覆盖"); continue; }
                    servers.Set(name, o);
                    stashed.Remove(name);
                    changed++;
                }
                else
                {
                    if (servers == null || !servers.TryGet(name, out var o)) continue;
                    stashed.Set(name, o);
                    servers.Remove(name);
                    changed++;
                }
            }
            if (stashed.Count == 0) stash.Remove(StashKey(path));
            if (changed == 0) return null;
            var backup = Backup(path);
            Write(path, root);
            return backup;
        }

        public static void Write(string path, JsonObject root)
        {
            string newline = "\n";
            if (File.Exists(path))
            {
                var old = File.ReadAllText(path, Encoding.UTF8);
                if (old.Contains("\r\n")) newline = "\r\n";
            }
            var text = Json.Serialize(root).Replace("\n", newline);
            SettingsStore.AtomicWrite(path, text);
        }

        public static string Backup(string path)
        {
            if (!File.Exists(path)) return null;
            var stamp = path + ".bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture);
            var backup = stamp;
            for (int i = 1; File.Exists(backup); i++) backup = stamp + "-" + i;
            File.Copy(path, backup, false);
            try
            {
                var dir = Path.GetDirectoryName(path);
                var old = Directory.GetFiles(dir, Path.GetFileName(path) + ".bak-*").OrderByDescending(f => f, StringComparer.Ordinal).Skip(KeepBackups);
                foreach (var f in old) File.Delete(f);
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            return backup;
        }
    }
}
