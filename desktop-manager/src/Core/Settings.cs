using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace ClaudeDesktopManager
{
    public enum ProxyMode { System, Direct, Manual, Pac }

    public enum RunningPolicy { Ask, Restart, Keep }

    public sealed class ProxySettings
    {
        public ProxyMode Mode = ProxyMode.System;
        public string Scheme = "http";
        public string Host = "127.0.0.1";
        public int Port = 7890;
        public string Bypass = "";
        public string PacUrl = "";
        public bool ViaLaunchFlags = true;
        public bool ViaPolicy;
        public bool ViaEnv = true;

        public ProxySettings Clone() => (ProxySettings)MemberwiseClone();

        public JsonObject ToJson() => new JsonObject()
            .Set("mode", Mode.ToString().ToLowerInvariant())
            .Set("scheme", Scheme)
            .Set("host", Host)
            .Set("port", Port)
            .Set("bypass", Bypass)
            .Set("pacUrl", PacUrl)
            .Set("viaLaunchFlags", ViaLaunchFlags)
            .Set("viaPolicy", ViaPolicy)
            .Set("viaEnv", ViaEnv);

        public static ProxySettings FromJson(JsonObject o)
        {
            var p = new ProxySettings();
            if (o == null) return p;
            p.Mode = ParseEnum(o.GetString("mode"), ProxyMode.System);
            p.Scheme = (o.GetString("scheme") ?? "http").Trim().ToLowerInvariant();
            p.Host = (o.GetString("host") ?? "").Trim();
            p.Port = o.GetInt("port", 7890);
            p.Bypass = o.GetString("bypass") ?? "";
            p.PacUrl = (o.GetString("pacUrl") ?? "").Trim();
            p.ViaLaunchFlags = o.GetBool("viaLaunchFlags", true);
            p.ViaPolicy = o.GetBool("viaPolicy", false);
            p.ViaEnv = o.GetBool("viaEnv", true);
            return p;
        }

        internal static T ParseEnum<T>(string s, T def) where T : struct =>
            Enum.TryParse(s ?? "", true, out T v) && Enum.IsDefined(typeof(T), v) ? v : def;
    }

    /// <summary>A named set of launch settings ("方案").</summary>
    public sealed class Profile
    {
        public string Name = "默认";
        public ProxySettings Proxy = new ProxySettings();
        /// <summary>Windows time zone id (as used by tzutil), empty = leave the system time zone alone.</summary>
        public string TimeZoneId = "";
        public string Lang = "";
        public bool DisableGpu;
        public string ExtraArgs = "";
        /// <summary>NAME=VALUE per line.</summary>
        public string ExtraEnv = "";

        public Profile Clone()
        {
            var p = (Profile)MemberwiseClone();
            p.Proxy = Proxy.Clone();
            return p;
        }

        public JsonObject ToJson() => new JsonObject()
            .Set("name", Name)
            .Set("proxy", Proxy.ToJson())
            .Set("timeZoneId", TimeZoneId)
            .Set("lang", Lang)
            .Set("disableGpu", DisableGpu)
            .Set("extraArgs", ExtraArgs)
            .Set("extraEnv", ExtraEnv);

        public static Profile FromJson(JsonObject o)
        {
            var p = new Profile();
            if (o == null) return p;
            p.Name = (o.GetString("name") ?? "").Trim();
            p.Proxy = ProxySettings.FromJson(o.GetObject("proxy"));
            p.TimeZoneId = (o.GetString("timeZoneId") ?? "").Trim();
            p.Lang = (o.GetString("lang") ?? "").Trim();
            p.DisableGpu = o.GetBool("disableGpu");
            p.ExtraArgs = o.GetString("extraArgs") ?? "";
            p.ExtraEnv = o.GetString("extraEnv") ?? "";
            return p;
        }
    }

    public sealed class AppOptions
    {
        public int GracefulTimeoutSec = 3;
        public bool KillDescendants = true;
        public bool StopCoworkService = true;
        public bool RestoreTimeZoneOnExit = true;
        public bool CloseToTray = true;
        public RunningPolicy WhenRunning = RunningPolicy.Ask;
        public string CustomExePath = "";

        public JsonObject ToJson() => new JsonObject()
            .Set("gracefulTimeoutSec", GracefulTimeoutSec)
            .Set("killDescendants", KillDescendants)
            .Set("stopCoworkService", StopCoworkService)
            .Set("restoreTimeZoneOnExit", RestoreTimeZoneOnExit)
            .Set("closeToTray", CloseToTray)
            .Set("whenRunning", WhenRunning.ToString().ToLowerInvariant())
            .Set("customExePath", CustomExePath);

        public static AppOptions FromJson(JsonObject o)
        {
            var a = new AppOptions();
            if (o == null) return a;
            a.GracefulTimeoutSec = Math.Max(0, Math.Min(60, o.GetInt("gracefulTimeoutSec", 3)));
            a.KillDescendants = o.GetBool("killDescendants", true);
            a.StopCoworkService = o.GetBool("stopCoworkService", true);
            a.RestoreTimeZoneOnExit = o.GetBool("restoreTimeZoneOnExit", true);
            a.CloseToTray = o.GetBool("closeToTray", true);
            a.WhenRunning = ProxySettings.ParseEnum(o.GetString("whenRunning"), RunningPolicy.Ask);
            a.CustomExePath = (o.GetString("customExePath") ?? "").Trim();
            return a;
        }
    }

    /// <summary>The system time zone we changed and still owe the user a restore of.</summary>
    public sealed class PendingTimeZone
    {
        public string OriginalId;
        public string AppliedId;
        public DateTime SetAtUtc;

        public JsonObject ToJson() => new JsonObject()
            .Set("originalId", OriginalId)
            .Set("appliedId", AppliedId)
            .Set("setAt", SetAtUtc.ToString("o", CultureInfo.InvariantCulture));

        public static PendingTimeZone FromJson(JsonObject o)
        {
            if (o == null || string.IsNullOrEmpty(o.GetString("originalId"))) return null;
            DateTime.TryParse(o.GetString("setAt"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var at);
            return new PendingTimeZone { OriginalId = o.GetString("originalId"), AppliedId = o.GetString("appliedId") ?? "", SetAtUtc = at };
        }
    }

    public sealed class Settings
    {
        public const int CurrentVersion = 1;

        public List<Profile> Profiles = new List<Profile>();
        public string SelectedProfile = "";
        public AppOptions Options = new AppOptions();
        public PendingTimeZone PendingTz;
        /// <summary>egressProxyUrl / egressProxyPacUrl in HKCU were written by this tool, so it may remove them.</summary>
        public bool PolicyWrittenByUs;
        /// <summary>Disabled MCP servers: config path → { server name → server JSON }.</summary>
        public JsonObject McpStash = new JsonObject();

        public static Settings CreateDefault()
        {
            var s = new Settings();
            s.Profiles.Add(new Profile { Name = "默认" });
            s.Profiles.Add(new Profile
            {
                Name = "本机代理 7890",
                Proxy = new ProxySettings { Mode = ProxyMode.Manual, Scheme = "http", Host = "127.0.0.1", Port = 7890 },
            });
            s.SelectedProfile = "默认";
            return s;
        }

        public Profile FindProfile(string name) =>
            Profiles.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));

        public Profile Selected => FindProfile(SelectedProfile) ?? Profiles.FirstOrDefault();

        /// <summary>Returns a name not used by any profile, based on <paramref name="baseName"/>.</summary>
        public string UniqueName(string baseName)
        {
            baseName = string.IsNullOrWhiteSpace(baseName) ? "新方案" : baseName.Trim();
            if (FindProfile(baseName) == null) return baseName;
            for (int i = 2; ; i++)
            {
                var n = baseName + " " + i;
                if (FindProfile(n) == null) return n;
            }
        }

        public JsonObject ToJson()
        {
            var profiles = new List<object>();
            foreach (var p in Profiles) profiles.Add(p.ToJson());
            var o = new JsonObject()
                .Set("version", CurrentVersion)
                .Set("selectedProfile", SelectedProfile)
                .Set("profiles", profiles)
                .Set("options", Options.ToJson())
                .Set("policyWrittenByUs", PolicyWrittenByUs)
                .Set("mcpStash", McpStash);
            if (PendingTz != null) o.Set("pendingTimeZone", PendingTz.ToJson());
            return o;
        }

        public static Settings FromJson(JsonObject o)
        {
            var s = new Settings();
            var list = o.GetArray("profiles");
            if (list != null)
                foreach (var item in list)
                    if (item is JsonObject po)
                    {
                        var p = Profile.FromJson(po);
                        if (p.Name.Length == 0) p.Name = s.UniqueName("方案");
                        else if (s.FindProfile(p.Name) != null) p.Name = s.UniqueName(p.Name);
                        s.Profiles.Add(p);
                    }
            if (s.Profiles.Count == 0) s.Profiles.Add(new Profile { Name = "默认" });
            s.SelectedProfile = o.GetString("selectedProfile") ?? "";
            if (s.FindProfile(s.SelectedProfile) == null) s.SelectedProfile = s.Profiles[0].Name;
            s.Options = AppOptions.FromJson(o.GetObject("options"));
            s.PendingTz = PendingTimeZone.FromJson(o.GetObject("pendingTimeZone"));
            s.PolicyWrittenByUs = o.GetBool("policyWrittenByUs");
            s.McpStash = o.GetObject("mcpStash") ?? new JsonObject();
            return s;
        }
    }

    /// <summary>Loads and saves settings.json; writes go through a temp file so a crash never leaves half a file.</summary>
    public sealed class SettingsStore
    {
        public readonly string FilePath;
        public Settings Settings { get; private set; }
        /// <summary>Set when the file existed but could not be read; it was renamed aside.</summary>
        public string LoadProblem { get; private set; }

        readonly object gate = new object();

        public SettingsStore(string filePath)
        {
            FilePath = filePath;
        }

        /// <summary>
        /// settings.json next to the exe makes the tool portable; otherwise it lives in %APPDATA%.
        /// </summary>
        public static string DefaultPath(string exeDir, string roamingAppData)
        {
            var portable = Path.Combine(exeDir ?? "", "ClaudeDesktopManager.settings.json");
            if (!string.IsNullOrEmpty(exeDir) && File.Exists(portable)) return portable;
            return Path.Combine(roamingAppData ?? "", "ClaudeDesktopManager", "settings.json");
        }

        string lastStamp;

        /// <summary>Modification time and size: enough to notice another process saving the file.</summary>
        string FileTime()
        {
            var fi = new FileInfo(FilePath);
            return fi.Exists ? fi.LastWriteTimeUtc.Ticks + ":" + fi.Length : "";
        }

        /// <summary>
        /// Another copy of the tool (a desktop shortcut runs the command line) may have recorded a time zone
        /// switch or a policy write; take those over without touching the profiles being edited here.
        /// </summary>
        public bool SyncState()
        {
            lock (gate)
            {
                try
                {
                    if (Settings == null || FileTime() == lastStamp) return false;
                    var disk = Settings.FromJson(Json.ParseObject(File.ReadAllText(FilePath, Encoding.UTF8)));
                    lastStamp = FileTime();
                    Settings.PendingTz = disk.PendingTz;
                    Settings.PolicyWrittenByUs = disk.PolicyWrittenByUs;
                    return true;
                }
                catch (Exception e) when (e is JsonException || e is IOException || e is UnauthorizedAccessException)
                {
                    return false;
                }
            }
        }

        public Settings Load()
        {
            lock (gate)
            {
                LoadProblem = null;
                if (!File.Exists(FilePath))
                {
                    Settings = Settings.CreateDefault();
                    return Settings;
                }
                try
                {
                    var text = File.ReadAllText(FilePath, Encoding.UTF8);
                    Settings = Settings.FromJson(Json.ParseObject(text));
                    lastStamp = FileTime();
                }
                catch (Exception e) when (e is JsonException || e is IOException || e is UnauthorizedAccessException)
                {
                    var aside = FilePath + ".broken-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
                    try { File.Move(FilePath, aside); } catch (Exception) { aside = null; }
                    LoadProblem = "设置文件读取失败，已改用默认设置：" + e.Message + (aside != null ? "（原文件改名为 " + Path.GetFileName(aside) + "）" : "");
                    Settings = Settings.CreateDefault();
                }
                return Settings;
            }
        }

        /// <summary>Uses <paramref name="settings"/> instead of what is on disk (demo mode, tests).</summary>
        public void Replace(Settings settings)
        {
            lock (gate) Settings = settings;
        }

        public void Save()
        {
            lock (gate)
            {
                if (Settings == null) return;
                AtomicWrite(FilePath, Json.Serialize(Settings.ToJson()) + "\n");
                lastStamp = FileTime();
            }
        }

        public static void AtomicWrite(string path, string text)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }
    }
}
