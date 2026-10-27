using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace ClaudeDesktopManager.Tests
{
    static class JsonTests
    {
        [Test]
        public static void RoundTripKeepsOrderAndFormatting()
        {
            var text = "{\n  \"mcpServers\": {\n    \"b\": {\n      \"command\": \"npx\",\n      \"args\": [\n        \"-y\",\n        \"x\"\n      ]\n    },\n    \"a\": {}\n  },\n  \"preferences\": {\n    \"n\": 1.50,\n    \"big\": 12345678901234567890,\n    \"t\": true,\n    \"z\": null,\n    \"empty\": []\n  }\n}";
            var o = Json.ParseObject(text);
            Assert.Seq(new[] { "mcpServers", "preferences" }, o.Keys);
            Assert.Seq(new[] { "b", "a" }, o.GetObject("mcpServers").Keys);
            Assert.Equal(text, Json.Serialize(o));
        }

        [Test]
        public static void StringsAndEscapes()
        {
            var o = Json.ParseObject("{\"s\":\"中文 \\\"q\\\" \\\\ \\/ \\n \\t \\u00e9 \\ud83d\\ude00\"}");
            Assert.Equal("中文 \"q\" \\ / \n \t é 😀", o.GetString("s"));
            var back = Json.Serialize(o, false);
            Assert.Equal("{\"s\":\"中文 \\\"q\\\" \\\\ / \\n \\t é 😀\"}", back);
            Assert.Equal(o.GetString("s"), Json.ParseObject(back).GetString("s"));
        }

        [Test]
        public static void ErrorsHaveLineAndColumn()
        {
            var e = Assert.Throws<JsonException>(() => Json.Parse("{\n  \"a\": 1,\n  \"b\" 2\n}"));
            Assert.Equal(3, e.Line);
            Assert.Throws<JsonException>(() => Json.Parse("{\"a\": 1,}"));
            Assert.Throws<JsonException>(() => Json.Parse("[1, 2"));
            Assert.Throws<JsonException>(() => Json.Parse("{} x"));
            Assert.Throws<JsonException>(() => Json.Parse("01"));
            Assert.Throws<JsonException>(() => Json.Parse("\"a\nb\""));
        }

        [Test]
        public static void BomAndDuplicates()
        {
            var o = Json.ParseObject("\uFEFF{\"a\":1,\"b\":2,\"a\":3}");
            Assert.Seq(new[] { "a", "b" }, o.Keys);
            Assert.Equal(3, o.GetInt("a"));
        }

        [Test]
        public static void TypedGettersAndSet()
        {
            var o = new JsonObject().Set("i", 5).Set("s", "x").Set("b", true);
            o.Set("i", 6);
            Assert.Seq(new[] { "i", "s", "b" }, o.Keys);
            Assert.Equal(6, Json.ParseObject(Json.Serialize(o)).GetInt("i"));
            Assert.Equal("x", o.GetString("s"));
            Assert.True(o.GetBool("b"));
            Assert.Equal(7, o.GetInt("missing", 7));
            Assert.True(o.Remove("s"));
            Assert.False(o.Remove("s"));
            Assert.Equal("{}", Json.Serialize(new JsonObject()));
        }
    }

    static class SettingsTests
    {
        [Test]
        public static void DefaultsAndRoundTrip()
        {
            using (var t = new TempDir())
            {
                var store = new SettingsStore(t.File("s.json"));
                var s = store.Load();
                Assert.Equal(2, s.Profiles.Count);
                Assert.Equal("默认", s.Selected.Name);
                s.Profiles[1].TimeZoneId = "Pacific Standard Time";
                s.Profiles[1].Proxy.ViaPolicy = true;
                s.Options.GracefulTimeoutSec = 5;
                s.Options.WhenRunning = RunningPolicy.Restart;
                s.PendingTz = new PendingTimeZone { OriginalId = "China Standard Time", AppliedId = "Pacific Standard Time", SetAtUtc = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) };
                store.Save();
                var again = new SettingsStore(t.File("s.json")).Load();
                Assert.Equal("Pacific Standard Time", again.Profiles[1].TimeZoneId);
                Assert.True(again.Profiles[1].Proxy.ViaPolicy);
                Assert.Equal(ProxyMode.Manual, again.Profiles[1].Proxy.Mode);
                Assert.Equal(7890, again.Profiles[1].Proxy.Port);
                Assert.Equal(5, again.Options.GracefulTimeoutSec);
                Assert.Equal(RunningPolicy.Restart, again.Options.WhenRunning);
                Assert.Equal("China Standard Time", again.PendingTz.OriginalId);
                Assert.Equal(new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc), again.PendingTz.SetAtUtc.ToUniversalTime());
                Assert.False(File.Exists(t.File("s.json.tmp")), "临时文件已清理");
            }
        }

        [Test]
        public static void BrokenFileIsSetAside()
        {
            using (var t = new TempDir())
            {
                File.WriteAllText(t.File("s.json"), "{ not json");
                var store = new SettingsStore(t.File("s.json"));
                var s = store.Load();
                Assert.NotNull(store.LoadProblem);
                Assert.Equal("默认", s.Selected.Name);
                Assert.True(Directory.GetFiles(t.Path, "s.json.broken-*").Length == 1, "坏文件改名保留");
            }
        }

        [Test]
        public static void DuplicateAndEmptyNamesAreFixed()
        {
            var s = Settings.FromJson(Json.ParseObject("{\"profiles\":[{\"name\":\"A\"},{\"name\":\"a\"},{\"name\":\"\"}],\"selectedProfile\":\"zzz\",\"options\":{\"gracefulTimeoutSec\":999}}"));
            Assert.Seq(new[] { "A", "a 2", "方案" }, s.Profiles.Select(p => p.Name));
            Assert.Equal("A", s.SelectedProfile);
            Assert.Equal(60, s.Options.GracefulTimeoutSec);
        }

        [Test]
        public static void PortableWhenFileNextToExe()
        {
            using (var t = new TempDir())
            {
                var roaming = Path.Combine(t.Path, "roaming");
                Assert.Equal(Path.Combine(roaming, "ClaudeDesktopManager", "settings.json"), SettingsStore.DefaultPath(t.Path, roaming));
                File.WriteAllText(t.File("ClaudeDesktopManager.settings.json"), "{}");
                Assert.Equal(t.File("ClaudeDesktopManager.settings.json"), SettingsStore.DefaultPath(t.Path, roaming));
            }
        }
    }

    static class LaunchTests
    {
        static ProxySettings Manual(string scheme = "http", string host = "127.0.0.1", int port = 7890) =>
            new ProxySettings { Mode = ProxyMode.Manual, Scheme = scheme, Host = host, Port = port };

        [Test]
        public static void ChromiumArgsPerMode()
        {
            Assert.Seq(new string[0], ProxyLogic.ChromiumArgs(new ProxySettings()));
            Assert.Seq(new[] { "--no-proxy-server" }, ProxyLogic.ChromiumArgs(new ProxySettings { Mode = ProxyMode.Direct }));
            var m = Manual();
            m.Bypass = "*.corp.example.com; intranet ,*.corp.example.com";
            Assert.Seq(new[] { "--proxy-server=http://127.0.0.1:7890", "--proxy-bypass-list=<local>;*.corp.example.com;intranet" }, ProxyLogic.ChromiumArgs(m));
            Assert.Seq(new[] { "--proxy-server=socks5://[::1]:1080", "--proxy-bypass-list=<local>" }, ProxyLogic.ChromiumArgs(Manual("socks5", "::1", 1080)));
            Assert.Seq(new[] { "--proxy-pac-url=https://wpad.example.com/proxy.pac" },
                ProxyLogic.ChromiumArgs(new ProxySettings { Mode = ProxyMode.Pac, PacUrl = " https://wpad.example.com/proxy.pac " }));
            var off = Manual();
            off.ViaLaunchFlags = false;
            Assert.Seq(new string[0], ProxyLogic.ChromiumArgs(off));
        }

        [Test]
        public static void Validation()
        {
            Assert.Equal(0, ProxyLogic.Validate(Manual()).Count);
            Assert.Contains("http://", ProxyLogic.Validate(Manual(host: "http://127.0.0.1"))[0]);
            Assert.Contains("用户名密码", ProxyLogic.Validate(Manual(host: "u:p@host"))[0]);
            Assert.Contains("端口", ProxyLogic.Validate(Manual(port: 70000))[0]);
            Assert.Contains("地址", ProxyLogic.Validate(Manual(host: " "))[0]);
            Assert.Contains("协议", ProxyLogic.Validate(Manual(scheme: "ftp"))[0]);
            Assert.Contains("PAC", ProxyLogic.Validate(new ProxySettings { Mode = ProxyMode.Pac, PacUrl = "file:///c:/x.pac" })[0]);
            Assert.Equal(0, ProxyLogic.Validate(new ProxySettings { Mode = ProxyMode.System, Host = "" }).Count);
        }

        [Test]
        public static void EnvVars()
        {
            var env = ProxyLogic.EnvVars(Manual());
            Assert.Equal("http://127.0.0.1:7890", env["HTTPS_PROXY"]);
            Assert.Equal("http://127.0.0.1:7890", env["HTTP_PROXY"]);
            Assert.Equal("localhost,127.0.0.1,::1", env["NO_PROXY"]);
            var socks = ProxyLogic.EnvVars(Manual("socks5"));
            Assert.Equal("socks5://127.0.0.1:7890", socks["ALL_PROXY"]);
            Assert.False(socks.ContainsKey("HTTPS_PROXY"), "SOCKS 不写 HTTPS_PROXY");
            var direct = ProxyLogic.EnvVars(new ProxySettings { Mode = ProxyMode.Direct });
            Assert.Equal("", direct["HTTPS_PROXY"]);
            Assert.Equal(0, ProxyLogic.EnvVars(new ProxySettings()).Count);
        }

        [Test]
        public static void DesiredPolicy()
        {
            var http = Manual();
            Assert.Null(ProxyLogic.DesiredPolicy(http, false), "没勾选策略且不归我们管");
            http.ViaPolicy = true;
            var d = ProxyLogic.DesiredPolicy(http, false);
            Assert.Equal("http://127.0.0.1:7890", d[ProxyLogic.PolicyUrlKey]);
            Assert.Null(d[ProxyLogic.PolicyPacKey]);
            var pac = new ProxySettings { Mode = ProxyMode.Pac, PacUrl = "http://x/p.pac", ViaPolicy = true };
            d = ProxyLogic.DesiredPolicy(pac, false);
            Assert.Null(d[ProxyLogic.PolicyUrlKey]);
            Assert.Equal("http://x/p.pac", d[ProxyLogic.PolicyPacKey]);
            var socks = Manual("socks5");
            socks.ViaPolicy = true;
            Assert.Null(ProxyLogic.DesiredPolicy(socks, false), "SOCKS 不能写策略");
            d = ProxyLogic.DesiredPolicy(new ProxySettings(), true);
            Assert.True(d.ContainsKey(ProxyLogic.PolicyUrlKey) && d[ProxyLogic.PolicyUrlKey] == null, "我们写过的要删掉");
        }

        [Test]
        public static void BuildSpec()
        {
            var p = new Profile { Proxy = Manual(), Lang = "en-US", DisableGpu = true, ExtraArgs = "--foo \"a b\"", ExtraEnv = "# 注释\nNODE_EXTRA_CA_CERTS = C:\\ca.pem\n\nTZ=Asia/Tokyo" };
            var spec = LaunchBuilder.Build(p, supportsEnv: true);
            Assert.Equal(0, spec.Errors.Count);
            Assert.Seq(new[] { "--proxy-server=http://127.0.0.1:7890", "--proxy-bypass-list=<local>", "--lang=en-US", "--disable-gpu", "--foo", "a b" }, spec.Args);
            Assert.Equal("C:\\ca.pem", spec.Env["NODE_EXTRA_CA_CERTS"]);
            Assert.Equal("Asia/Tokyo", spec.Env["TZ"]);
            Assert.Equal("http://127.0.0.1:7890", spec.Env["HTTPS_PROXY"]);

            var msix = LaunchBuilder.Build(p, supportsEnv: false);
            Assert.Equal(0, msix.Env.Count);
            Assert.True(msix.Warnings.Any(w => w.Contains("MSIX")), "MSIX 提示环境变量无效");

            var bad = LaunchBuilder.Build(new Profile { ExtraArgs = "\"unclosed", ExtraEnv = "NOEQUALS\n=x", Lang = "en US" }, true);
            Assert.Equal(4, bad.Errors.Count);
        }

        [Test]
        public static void QuoteSplitRoundTrip()
        {
            var cases = new[]
            {
                new[] { "plain", "with space", "" },
                new[] { "a\"b", "c\\d", "trailing\\", "both \\\"x\\\"", "\\\\server\\share\\" },
                new[] { "--proxy-bypass-list=<local>;*.x", "--lang=zh-CN" },
            };
            foreach (var c in cases)
            {
                var joined = CommandLine.Join(c);
                Assert.Seq(c, CommandLine.Split(joined), joined);
            }
            var rnd = new Random(42);
            const string alphabet = "ab \\\"\t=;<>中";
            for (int i = 0; i < 2000; i++)
            {
                var args = Enumerable.Range(0, rnd.Next(1, 4))
                    .Select(_ => new string(Enumerable.Range(0, rnd.Next(0, 8)).Select(__ => alphabet[rnd.Next(alphabet.Length)]).ToArray()))
                    .ToArray();
                var joined = CommandLine.Join(args);
                Assert.Seq(args, CommandLine.Split(joined), joined);
            }
            Assert.Seq(new[] { "a", "b c", "d\"e" }, CommandLine.Split("  a \"b c\"  d\\\"e "));
        }
    }

    static class LogTests
    {
        [Test]
        public static void TailAndEgressLines()
        {
            using (var t = new TempDir())
            {
                var path = t.File("main.log");
                var sb = new StringBuilder();
                for (int i = 0; i < 100; i++) sb.Append("line " + i + "\r\n");
                sb.Append("2026-10-27 10:00:00 [info] [egress-proxy] pinned to fixed proxy at 127.0.0.1:7890; OS proxy settings ignored\n");
                sb.Append("2026-10-27 10:00:01 [info] Resolved system proxy for Code sessions: http://127.0.0.1:7890\n");
                File.WriteAllText(path, sb.ToString());
                var tail = LogTools.Tail(path, 3);
                Assert.Equal(3, tail.Split(new[] { Environment.NewLine }, StringSplitOptions.None).Length);
                Assert.Contains("line 99", tail);
                var lines = LogTools.EgressLines(File.ReadAllText(path));
                Assert.Equal(2, lines.Count);
                Assert.Equal("", LogTools.Tail(t.File("missing.log"), 10));
                // Only the end of a big file is read; the first, partial line is dropped.
                var small = LogTools.Tail(path, 1000, 40);
                Assert.False(small.StartsWith("line 0", StringComparison.Ordinal), "只读文件末尾");
            }
        }
    }

    static class MaintenanceTests
    {
        [Test]
        public static void CleanCachesOnlyTouchesCaches()
        {
            using (var t = new TempDir())
            {
                Directory.CreateDirectory(Path.Combine(t.Path, "Cache", "Cache_Data"));
                File.WriteAllBytes(Path.Combine(t.Path, "Cache", "Cache_Data", "f_000001"), new byte[1000]);
                Directory.CreateDirectory(Path.Combine(t.Path, "GPUCache"));
                File.WriteAllBytes(Path.Combine(t.Path, "GPUCache", "data_0"), new byte[500]);
                Directory.CreateDirectory(Path.Combine(t.Path, "Local Storage", "leveldb"));
                File.WriteAllBytes(Path.Combine(t.Path, "Local Storage", "leveldb", "000003.log"), new byte[300]);
                File.WriteAllText(Path.Combine(t.Path, "claude_desktop_config.json"), "{}");

                var caches = Maintenance.MeasureCaches(t.Path);
                Assert.Equal(1500L, caches.Sum(kv => kv.Value));
                var usage = Maintenance.MeasureDataDir(t.Path);
                Assert.Equal("Cache", usage[0].Key);

                var r = Maintenance.CleanCaches(t.Path);
                Assert.Equal(1500L, r.Freed);
                Assert.Equal(2, r.Files);
                Assert.True(Directory.Exists(Path.Combine(t.Path, "Cache")), "缓存目录本身保留");
                Assert.False(Directory.Exists(Path.Combine(t.Path, "Cache", "Cache_Data")), "空的子目录删掉");
                Assert.True(File.Exists(Path.Combine(t.Path, "Local Storage", "leveldb", "000003.log")), "登录数据不动");
                Assert.True(File.Exists(Path.Combine(t.Path, "claude_desktop_config.json")), "配置不动");
            }
        }
    }

    static class McpTests
    {
        const string Config = "{\r\n  \"mcpServers\": {\r\n    \"filesystem\": {\r\n      \"command\": \"npx\",\r\n      \"args\": [\r\n        \"-y\",\r\n        \"@modelcontextprotocol/server-filesystem\",\r\n        \"C:\\\\Users\\\\me\\\\Documents\"\r\n      ]\r\n    },\r\n    \"fetch\": {\r\n      \"command\": \"uvx\",\r\n      \"args\": [\r\n        \"mcp-server-fetch\"\r\n      ],\r\n      \"env\": {\r\n        \"HTTPS_PROXY\": \"http://127.0.0.1:7890\"\r\n      }\r\n    },\r\n    \"remote\": {\r\n      \"type\": \"http\",\r\n      \"url\": \"https://mcp.example.com/mcp\"\r\n    }\r\n  },\r\n  \"preferences\": {\r\n    \"menuBarEnabled\": false\r\n  }\r\n}";

        [Test]
        public static void DisableEnableRoundTrip()
        {
            using (var t = new TempDir())
            {
                var path = t.File("claude_desktop_config.json");
                File.WriteAllText(path, Config);
                var stash = new JsonObject();
                var list = McpConfig.List(McpConfig.Load(path, out var err), stash, path);
                Assert.Null(err);
                Assert.Seq(new[] { "filesystem", "fetch", "remote" }, list.Select(s => s.Name));
                Assert.Equal("stdio", list[0].Kind);
                Assert.Contains("@modelcontextprotocol/server-filesystem", list[0].Summary);
                Assert.Contains("HTTPS_PROXY", list[1].Summary);
                Assert.Equal("https://mcp.example.com/mcp", list[2].Summary);

                var backup = McpConfig.SetEnabled(path, stash, new[] { "fetch" }, false, out var problems);
                Assert.Equal(0, problems.Count);
                Assert.Equal(Config, File.ReadAllText(backup));
                var text = File.ReadAllText(path);
                Assert.NotContains("mcp-server-fetch", text);
                Assert.Contains("\r\n", text);
                list = McpConfig.List(McpConfig.Load(path, out err), stash, path);
                Assert.Seq(new[] { "filesystem:True", "remote:True", "fetch:False" }, list.Select(s => s.Name + ":" + s.Enabled));

                McpConfig.SetEnabled(path, stash, new[] { "fetch" }, true, out problems);
                Assert.Equal(0, problems.Count);
                Assert.Equal(0, stash.Count);
                var back = McpConfig.Load(path, out err);
                var original = Json.ParseObject(Config);
                Assert.Seq(new[] { "filesystem", "remote", "fetch" }, back.GetObject("mcpServers").Keys);
                Assert.Equal(Json.Serialize(original.GetObject("mcpServers").GetObject("fetch")), Json.Serialize(back.GetObject("mcpServers").GetObject("fetch")));
                Assert.Equal("menuBarEnabled", back.GetObject("preferences").Keys.Single());
            }
        }

        [Test]
        public static void EnableDoesNotOverwriteAndBackupsArePruned()
        {
            using (var t = new TempDir())
            {
                var path = t.File("claude_desktop_config.json");
                File.WriteAllText(path, Config);
                var stash = new JsonObject();
                McpConfig.SetEnabled(path, stash, new[] { "remote" }, false, out _);
                // The user re-added a server with the same name meanwhile.
                var root = McpConfig.Load(path, out _);
                root.GetObject("mcpServers").Set("remote", new JsonObject().Set("url", "https://other"));
                McpConfig.Write(path, root);
                McpConfig.SetEnabled(path, stash, new[] { "remote" }, true, out var problems);
                Assert.Equal(1, problems.Count);
                Assert.Equal("https://other", McpConfig.Load(path, out _).GetObject("mcpServers").GetObject("remote").GetString("url"));

                for (int i = 0; i < 15; i++) McpConfig.Backup(path);
                Assert.Equal(McpConfig.KeepBackups, Directory.GetFiles(t.Path, "claude_desktop_config.json.bak-*").Length);
            }
        }

        [Test]
        public static void MissingAndBrokenFiles()
        {
            using (var t = new TempDir())
            {
                var path = t.File("claude_desktop_config.json");
                Assert.Equal(0, McpConfig.Load(path, out var err).Count);
                Assert.Null(err);
                File.WriteAllText(path, "{\"mcpServers\": {");
                Assert.Null(McpConfig.Load(path, out err));
                Assert.Contains("读取失败", err);
                McpConfig.SetEnabled(path, new JsonObject(), new[] { "x" }, false, out var problems);
                Assert.Equal(1, problems.Count);
                Assert.Equal("{\"mcpServers\": {", File.ReadAllText(path));
            }
        }
    }
}
