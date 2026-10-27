using System;
using System.Collections.Generic;
using System.IO;

namespace ClaudeDesktopManager
{
    public enum InstallKind { None, Msix, Squirrel, Custom }

    public sealed class ClaudeInstall
    {
        public InstallKind Kind;
        /// <summary>Claude.exe that runs (for MSIX: the one inside WindowsApps, informational only).</summary>
        public string ExePath = "";
        public string Version = "";
        public string PackageFullName = "";
        public string PackageFamilyName = "";
        public string Aumid = "";
        public string InstallDir = "";
        /// <summary>Folder with claude_desktop_config.json and logs\.</summary>
        public string DataDir = "";
        public List<string> DataDirCandidates = new List<string>();

        public string ConfigPath => DataDir.Length == 0 ? "" : Path.Combine(DataDir, "claude_desktop_config.json");

        public string LogsDir => DataDir.Length == 0 ? "" : Path.Combine(DataDir, "logs");

        /// <summary>Environment variables can only be handed over when we create the process ourselves.</summary>
        public bool SupportsEnv => Kind == InstallKind.Squirrel || Kind == InstallKind.Custom;

        public string KindName
        {
            get
            {
                switch (Kind)
                {
                    case InstallKind.Msix: return "MSIX（官方安装包）";
                    case InstallKind.Squirrel: return "旧版安装程序（Squirrel）";
                    case InstallKind.Custom: return "自定义路径";
                    default: return "未安装";
                }
            }
        }

        public string Summary => KindName + (Version.Length > 0 ? " " + Version : "");
    }

    public enum ServiceState { NotInstalled, Stopped, StartPending, StopPending, Running, Other, Unknown }

    public sealed class TimeZoneEntry
    {
        public string Id = "";
        public string DisplayName = "";
        public TimeSpan BaseOffset;
        /// <summary>Null in the demo, where the Windows ids do not exist.</summary>
        public TimeZoneInfo Info;

        public DateTime Now(DateTime utc) => Info != null ? TimeZoneInfo.ConvertTimeFromUtc(utc, Info) : utc + BaseOffset;

        public TimeSpan OffsetAt(DateTime utc) => Info != null ? Info.GetUtcOffset(utc) : BaseOffset;

        public bool IsDst(DateTime utc) => Info != null && Info.IsDaylightSavingTime(TimeZoneInfo.ConvertTimeFromUtc(utc, Info));

        public override string ToString() => DisplayName;
    }

    public sealed class PolicySnapshot
    {
        public Dictionary<string, string> User = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> Machine = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public string Error;

        /// <summary>Any machine policy makes Claude ignore the user hive entirely.</summary>
        public bool MachinePresent => Machine.Count > 0;

        public string UserValue(string name) => User.TryGetValue(name, out var v) ? v : null;

        public string MachineValue(string name) => Machine.TryGetValue(name, out var v) ? v : null;
    }

    public sealed class SystemProxyInfo
    {
        public bool Enabled;
        public string Server = "";
        public string Bypass = "";
        public string AutoConfigUrl = "";

        public string Describe()
        {
            var parts = new List<string>();
            if (Enabled && Server.Length > 0) parts.Add("代理服务器 " + Server);
            if (AutoConfigUrl.Length > 0) parts.Add("PAC " + AutoConfigUrl);
            return parts.Count == 0 ? "未设置系统代理（直连）" : string.Join("；", parts);
        }
    }

    public sealed class LaunchResult
    {
        public bool Ok;
        public int Pid;
        public string Method = "";
        public string Error = "";
    }

    public sealed class CommandResult
    {
        public int ExitCode = -1;
        public string Output = "";
        public bool TimedOut;
    }

    /// <summary>Everything that touches Windows. WindowsPlatform is the real one, DemoPlatform fakes it.</summary>
    public interface IPlatform
    {
        bool IsDemo { get; }
        string LocalAppData { get; }
        string RoamingAppData { get; }
        string DesktopDir { get; }
        /// <summary>Full path of this tool's exe.</summary>
        string SelfExe { get; }
        int SelfPid { get; }
        int SessionId { get; }

        List<ClaudeInstall> DetectInstalls();

        /// <summary>All processes; command lines are filled for paths <paramref name="dirs"/> owns.</summary>
        List<ProcInfo> Snapshot(KnownDirs dirs);
        bool IsAlive(int pid, long creationTime);
        bool Terminate(ProcInfo p, out string error);
        /// <summary>Posts WM_CLOSE to the visible top-level windows of the process; returns how many.</summary>
        int CloseWindows(int pid);
        LaunchResult Launch(ClaudeInstall install, LaunchSpec spec);

        ServiceState GetServiceState(string name);
        bool StopService(string name, int timeoutMs, out string error);
        bool StartService(string name, out string error);

        string GetSystemTimeZoneId();
        List<TimeZoneEntry> ListTimeZones();
        bool SetSystemTimeZone(string id, out string error);
        /// <summary>"Set time zone automatically" (null = unknown).</summary>
        bool? AutoTimeZoneEnabled();

        PolicySnapshot ReadPolicy();
        /// <summary>Writes HKCU\SOFTWARE\Policies\Claude values (null deletes); asks for elevation when needed.</summary>
        bool WriteUserPolicy(IDictionary<string, string> values, out string error);

        SystemProxyInfo GetSystemProxy();

        void OpenFolder(string path);
        void OpenInEditor(string path);
        void OpenUri(string uri);
        bool CreateShortcut(string lnkPath, string target, string arguments, string description, out string error);
        bool GetRunAtLogin();
        bool SetRunAtLogin(bool enable, out string error);
        CommandResult RunPowerShell(string script, int timeoutMs);
    }
}
