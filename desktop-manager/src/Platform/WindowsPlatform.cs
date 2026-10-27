using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace ClaudeDesktopManager
{
    public sealed class WindowsPlatform : IPlatform
    {
        const string PolicyKey = @"SOFTWARE\Policies\Claude";
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValue = "ClaudeDesktopManager";
        static readonly Regex ClaudePackage = new Regex(@"^(?:Claude|Anthropic\.Claude(?:Desktop)?)_", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        readonly Dictionary<string, bool?> subsystemCache = new Dictionary<string, bool?>(StringComparer.OrdinalIgnoreCase);
        List<TimeZoneEntry> zones;

        public bool IsDemo => false;
        public string LocalAppData => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        public string RoamingAppData => Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        public string DesktopDir => Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);

        public string DownloadsDir
        {
            get
            {
                IntPtr p = IntPtr.Zero;
                try
                {
                    if (Native.SHGetKnownFolderPath(Native.FOLDERID_Downloads, 0, IntPtr.Zero, out p) == 0 && p != IntPtr.Zero)
                    {
                        var path = Marshal.PtrToStringUni(p);
                        if (!string.IsNullOrEmpty(path)) return path;
                    }
                }
                catch (Exception) { }
                finally
                {
                    if (p != IntPtr.Zero) Marshal.FreeCoTaskMem(p);
                }
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
            }
        }

        public string NativeArch
        {
            get
            {
                try
                {
                    if (Native.IsWow64Process2(Native.GetCurrentProcess(), out _, out ushort machine))
                        return machine == Native.IMAGE_FILE_MACHINE_ARM64 ? "arm64" : machine == Native.IMAGE_FILE_MACHINE_I386 ? "x86" : "x64";
                }
                catch (EntryPointNotFoundException) { }
                return Environment.Is64BitOperatingSystem ? "x64" : "x86";
            }
        }
        public string SelfExe { get; } = Process.GetCurrentProcess().MainModule.FileName;
        public int SelfPid { get; } = Process.GetCurrentProcess().Id;
        public int SessionId { get; } = Process.GetCurrentProcess().SessionId;

        // ------------------------------------------------------------ install detection

        public List<ClaudeInstall> DetectInstalls()
        {
            var list = DetectMsix();
            var squirrel = DetectSquirrel();
            if (squirrel != null) list.Add(squirrel);
            return list;
        }

        // Get-AppxPackage takes seconds; ask it at most once per run, and only when the registry has no answer.
        static List<KeyValuePair<string, string>> appxCache;

        List<ClaudeInstall> DetectMsix()
        {
            var packages = new List<KeyValuePair<string, string>>();
            bool repositoryListed = false;
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages"))
                {
                    var names = k?.GetSubKeyNames() ?? new string[0];
                    // Every Windows 10/11 user has dozens of packages registered (Calculator, Store…), so an
                    // empty list means the key cannot be relied on.
                    repositoryListed = names.Length > 0;
                    foreach (var name in names)
                    {
                        if (!IsClaudePackage(name)) continue;
                        using (var sub = k.OpenSubKey(name))
                        {
                            if (sub?.GetValue("PackageRootFolder") is string root && Directory.Exists(root))
                                packages.Add(new KeyValuePair<string, string>(name, root));
                        }
                    }
                }
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is System.Security.SecurityException) { }

            if (packages.Count == 0 && !repositoryListed)
            {
                if (appxCache == null)
                {
                    var found = new List<KeyValuePair<string, string>>();
                    var r = RunPowerShell(
                        "Get-AppxPackage | Where-Object { $_.Name -match '^(Claude|Anthropic\\.Claude(Desktop)?)$' } | ForEach-Object { $_.PackageFullName + '|' + $_.InstallLocation }",
                        20000);
                    foreach (var line in r.Output.Split('\n'))
                    {
                        var parts = line.Trim().Split('|');
                        if (parts.Length == 2 && IsClaudePackage(parts[0]) && parts[1].Length > 0)
                            found.Add(new KeyValuePair<string, string>(parts[0], parts[1]));
                    }
                    appxCache = found;
                }
                packages.AddRange(appxCache);
            }

            // One install per package family: the newest version.
            var result = new List<ClaudeInstall>();
            foreach (var g in packages.GroupBy(p => FamilyOf(p.Key), StringComparer.OrdinalIgnoreCase))
            {
                var best = g.OrderByDescending(p => ParseVersion(VersionOf(p.Key))).First();
                var family = g.Key;
                var root = best.Value;
                var data = new List<string>
                {
                    Path.Combine(LocalAppData, "Packages", family, "LocalCache", "Roaming", "Claude"),
                    Path.Combine(RoamingAppData, "Claude"),
                };
                result.Add(new ClaudeInstall
                {
                    Kind = InstallKind.Msix,
                    PackageFullName = best.Key,
                    PackageFamilyName = family,
                    Version = VersionOf(best.Key),
                    InstallDir = root,
                    ExePath = Path.Combine(root, "app", "Claude.exe"),
                    Aumid = family + "!" + (AppIdFromManifest(root) ?? "Claude"),
                    DataDirCandidates = data,
                    // MSIX redirects %APPDATA% writes into the package's LocalCache once it exists.
                    DataDir = Directory.Exists(data[0]) ? data[0] : data[1],
                });
            }
            return result;
        }

        static bool IsClaudePackage(string fullName) =>
            ClaudePackage.IsMatch(fullName) && fullName.IndexOf("ClaudeCode", StringComparison.OrdinalIgnoreCase) < 0;

        /// <summary>Name_Version_Arch_ResourceId_PublisherId → Name_PublisherId.</summary>
        static string FamilyOf(string fullName)
        {
            var parts = fullName.Split('_');
            return parts.Length >= 5 ? parts[0] + "_" + parts[parts.Length - 1] : fullName;
        }

        static string VersionOf(string fullName)
        {
            var parts = fullName.Split('_');
            return parts.Length >= 2 ? parts[1] : "";
        }

        static Version ParseVersion(string v) => Version.TryParse(v, out var ver) ? ver : new Version(0, 0);

        static string AppIdFromManifest(string root)
        {
            try
            {
                var text = File.ReadAllText(Path.Combine(root, "AppxManifest.xml"));
                var m = Regex.Match(text, @"<Application\s[^>]*?\bId=""([^""]+)""");
                return m.Success ? m.Groups[1].Value : null;
            }
            catch (Exception) { return null; }
        }

        ClaudeInstall DetectSquirrel()
        {
            var root = Path.Combine(LocalAppData, "AnthropicClaude");
            if (!Directory.Exists(root)) return null;
            string best = null;
            Version bestVer = null;
            try
            {
                foreach (var dir in Directory.GetDirectories(root, "app-*"))
                {
                    var exe = Path.Combine(dir, "claude.exe");
                    if (!File.Exists(exe)) continue;
                    var ver = ParseVersion(Path.GetFileName(dir).Substring(4));
                    if (bestVer == null || ver > bestVer) { best = exe; bestVer = ver; }
                }
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            var stub = Path.Combine(root, "claude.exe");
            if (best == null && File.Exists(stub)) best = stub;
            if (best == null) return null;
            var data = Path.Combine(RoamingAppData, "Claude");
            return new ClaudeInstall
            {
                Kind = InstallKind.Squirrel,
                ExePath = best,
                Version = bestVer?.ToString() ?? "",
                InstallDir = root,
                DataDir = data,
                DataDirCandidates = { data },
            };
        }

        // ------------------------------------------------------------ processes

        public List<ProcInfo> Snapshot(KnownDirs dirs)
        {
            var list = new List<ProcInfo>();
            IntPtr snap = Native.CreateToolhelp32Snapshot(Native.TH32CS_SNAPPROCESS, 0);
            if (snap == Native.INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var e = new Native.PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32W)) };
                if (Native.Process32FirstW(snap, ref e))
                {
                    do
                    {
                        list.Add(new ProcInfo { Pid = (int)e.th32ProcessID, ParentPid = (int)e.th32ParentProcessID, Name = e.szExeFile ?? "" });
                    } while (Native.Process32NextW(snap, ref e));
                }
            }
            finally { Native.CloseHandle(snap); }
            foreach (var p in list) Fill(p);
            return list;
        }

        void Fill(ProcInfo p)
        {
            if (p.Pid == 0 || p.Pid == 4) return;
            if (Native.ProcessIdToSessionId((uint)p.Pid, out var session)) p.SessionId = (int)session;
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.PROCESS_VM_READ, false, p.Pid);
            if (h == IntPtr.Zero) h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, p.Pid);
            if (h == IntPtr.Zero) return;
            try
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (Native.QueryFullProcessImageNameW(h, 0, sb, ref size)) p.Path = sb.ToString(0, size);
                if (Native.GetProcessTimes(h, out long creation, out _, out _, out _)) p.CreationTime = creation;
                if (Native.GetProcessMemoryInfo(h, out var mem, (uint)Marshal.SizeOf(typeof(Native.PROCESS_MEMORY_COUNTERS_EX))))
                {
                    p.WorkingSet = (long)mem.WorkingSetSize.ToUInt64();
                    p.PrivateBytes = (long)mem.PrivateUsage.ToUInt64();
                }
                if (p.Path != null) p.IsConsole = ConsoleSubsystem(p.Path);
                if (p.SessionId == SessionId || p.SessionId < 0) p.CommandLine = ReadCommandLine(h);
            }
            finally { Native.CloseHandle(h); }
        }

        static string ReadCommandLine(IntPtr h)
        {
            int status = Native.NtQueryInformationProcess(h, Native.ProcessCommandLineInformation, IntPtr.Zero, 0, out int len);
            if (status != Native.STATUS_INFO_LENGTH_MISMATCH || len <= 0 || len > 1 << 20) return null;
            IntPtr buf = Marshal.AllocHGlobal(len);
            try
            {
                if (Native.NtQueryInformationProcess(h, Native.ProcessCommandLineInformation, buf, len, out len) != 0) return null;
                // UNICODE_STRING { USHORT Length; USHORT MaximumLength; PWSTR Buffer; } followed by the text.
                int bytes = (ushort)Marshal.ReadInt16(buf, 0);
                IntPtr text = Marshal.ReadIntPtr(buf, IntPtr.Size);
                if (text == IntPtr.Zero || bytes == 0) return "";
                return Marshal.PtrToStringUni(text, bytes / 2);
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        bool? ConsoleSubsystem(string path)
        {
            lock (subsystemCache)
            {
                if (subsystemCache.TryGetValue(path, out var cached)) return cached;
            }
            bool? result = null;
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var br = new BinaryReader(fs))
                {
                    if (fs.Length > 0x40 && br.ReadUInt16() == 0x5A4D)
                    {
                        fs.Position = 0x3C;
                        int pe = br.ReadInt32();
                        if (pe > 0 && pe < fs.Length - 0x60)
                        {
                            fs.Position = pe;
                            if (br.ReadUInt32() == 0x00004550)
                            {
                                // Optional header starts after the 4-byte signature and the 20-byte COFF header;
                                // Subsystem sits at offset 68 for PE32 and PE32+ alike.
                                fs.Position = pe + 4 + 20 + 68;
                                ushort sub = br.ReadUInt16();
                                result = sub == 3 ? true : sub == 2 ? false : (bool?)null;
                            }
                        }
                    }
                }
            }
            catch (Exception) { result = null; }
            lock (subsystemCache) subsystemCache[path] = result;
            return result;
        }

        public bool IsAlive(int pid, long creationTime)
        {
            IntPtr h = Native.OpenProcess(Native.SYNCHRONIZE | Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return false;
            try
            {
                if (Native.WaitForSingleObject(h, 0) != Native.WAIT_TIMEOUT) return false;
                if (creationTime != 0 && Native.GetProcessTimes(h, out long c, out _, out _, out _) && c != creationTime) return false;
                return true;
            }
            finally { Native.CloseHandle(h); }
        }

        public bool Terminate(ProcInfo p, out string error)
        {
            error = null;
            IntPtr h = Native.OpenProcess(Native.PROCESS_TERMINATE | Native.SYNCHRONIZE | Native.PROCESS_QUERY_LIMITED_INFORMATION, false, p.Pid);
            if (h == IntPtr.Zero)
            {
                error = Win32Message(Marshal.GetLastWin32Error());
                return false;
            }
            try
            {
                if (p.CreationTime != 0 && Native.GetProcessTimes(h, out long c, out _, out _, out _) && c != p.CreationTime)
                {
                    error = "PID 已被别的进程复用，跳过";
                    return false;
                }
                if (!Native.TerminateProcess(h, 1))
                {
                    int code = Marshal.GetLastWin32Error();
                    // Already exiting counts as success.
                    if (Native.WaitForSingleObject(h, 0) == Native.WAIT_OBJECT_0) return true;
                    error = Win32Message(code);
                    return false;
                }
                Native.WaitForSingleObject(h, 3000);
                return true;
            }
            finally { Native.CloseHandle(h); }
        }

        static string Win32Message(int code)
        {
            if (code == Native.ERROR_ACCESS_DENIED) return "拒绝访问（可能需要管理员权限）";
            if (code == 87) return "进程已不存在";
            return new Win32Exception(code).Message;
        }

        public int CloseWindows(int pid)
        {
            int count = 0;
            Native.EnumWindows((hwnd, _) =>
            {
                Native.GetWindowThreadProcessId(hwnd, out uint owner);
                if (owner == (uint)pid && Native.IsWindowVisible(hwnd) && Native.GetWindow(hwnd, Native.GW_OWNER) == IntPtr.Zero)
                {
                    if (Native.PostMessageW(hwnd, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) count++;
                }
                return true;
            }, IntPtr.Zero);
            return count;
        }

        // ------------------------------------------------------------ launching

        public LaunchResult Launch(ClaudeInstall install, LaunchSpec spec)
        {
            if (install.Kind == InstallKind.Msix)
            {
                if (install.Aumid.Length == 0) return new LaunchResult { Error = "没有找到应用标识（AUMID）" };
                uint pid = 0;
                int hr = 0;
                Exception failure = null;
                var t = new Thread(() =>
                {
                    try
                    {
                        var mgr = (Native.IApplicationActivationManager)new Native.ApplicationActivationManager();
                        hr = mgr.ActivateApplication(install.Aumid, spec.ArgString, 0, out pid);
                        Marshal.FinalReleaseComObject(mgr);
                    }
                    catch (Exception e) { failure = e; }
                });
                t.SetApartmentState(ApartmentState.STA);
                t.Start();
                if (!t.Join(60000)) return new LaunchResult { Error = "激活 MSIX 应用超时" };
                if (failure == null && hr >= 0) return new LaunchResult { Ok = true, Pid = (int)pid, Method = "MSIX 激活" };

                var why = failure != null ? failure.Message : "HRESULT 0x" + hr.ToString("X8", CultureInfo.InvariantCulture);
                if (spec.Args.Count == 0)
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + install.Aumid) { UseShellExecute = false });
                        return new LaunchResult { Ok = true, Method = "开始菜单方式（" + why + "）" };
                    }
                    catch (Exception e) { why += "；" + e.Message; }
                }
                return new LaunchResult { Error = "MSIX 激活失败：" + why };
            }

            if (!File.Exists(install.ExePath)) return new LaunchResult { Error = "找不到 " + install.ExePath };
            return StartDetached(install.ExePath, spec.ArgString, spec.Env);
        }

        /// <summary>
        /// CreateProcess outside any job object this tool runs in, when the job allows it, so that
        /// Claude does not end (or keep a waiting script waiting) along with whatever started us.
        /// </summary>
        static LaunchResult StartDetached(string exe, string args, IDictionary<string, string> envChanges)
        {
            var vars = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
                vars[(string)e.Key] = (string)e.Value;
            foreach (var kv in envChanges)
            {
                if (kv.Value.Length == 0) vars.Remove(kv.Key);
                else vars[kv.Key] = kv.Value;
            }
            var block = new StringBuilder();
            foreach (var kv in vars) block.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
            block.Append('\0');

            IntPtr env = Marshal.StringToHGlobalUni(block.ToString());
            try
            {
                uint flags = Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_DEFAULT_ERROR_MODE;
                var dir = Path.GetDirectoryName(exe);
                foreach (var extra in new[] { Native.CREATE_BREAKAWAY_FROM_JOB, 0u })
                {
                    var si = new Native.STARTUPINFOW { cb = Marshal.SizeOf(typeof(Native.STARTUPINFOW)) };
                    var cmd = new StringBuilder(CommandLine.Quote(exe) + (args.Length > 0 ? " " + args : ""), 32768);
                    if (Native.CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, flags | extra, env, dir, ref si, out var pi))
                    {
                        Native.CloseHandle(pi.hThread);
                        Native.CloseHandle(pi.hProcess);
                        return new LaunchResult { Ok = true, Pid = pi.dwProcessId, Method = "直接启动" };
                    }
                    int code = Marshal.GetLastWin32Error();
                    // ERROR_ACCESS_DENIED: the job does not allow breaking away; start inside it.
                    if (extra == 0 || code != Native.ERROR_ACCESS_DENIED)
                        return new LaunchResult { Error = new Win32Exception(code).Message };
                }
                return new LaunchResult { Error = "CreateProcess 失败" };
            }
            finally { Marshal.FreeHGlobal(env); }
        }

        // ------------------------------------------------------------ services

        public ServiceState GetServiceState(string name)
        {
            try
            {
                using (var sc = new ServiceController(name))
                {
                    switch (sc.Status)
                    {
                        case ServiceControllerStatus.Running: return ServiceState.Running;
                        case ServiceControllerStatus.Stopped: return ServiceState.Stopped;
                        case ServiceControllerStatus.StartPending: return ServiceState.StartPending;
                        case ServiceControllerStatus.StopPending: return ServiceState.StopPending;
                        default: return ServiceState.Other;
                    }
                }
            }
            catch (InvalidOperationException e) when (e.InnerException is Win32Exception w && w.NativeErrorCode == Native.ERROR_SERVICE_DOES_NOT_EXIST)
            {
                return ServiceState.NotInstalled;
            }
            catch (Exception) { return ServiceState.Unknown; }
        }

        public bool StopService(string name, int timeoutMs, out string error)
        {
            error = null;
            try
            {
                using (var sc = new ServiceController(name))
                {
                    if (sc.Status == ServiceControllerStatus.Stopped) return true;
                    if (sc.Status != ServiceControllerStatus.StopPending) sc.Stop();
                    sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromMilliseconds(timeoutMs));
                    return true;
                }
            }
            catch (InvalidOperationException e) when (e.InnerException is Win32Exception w && w.NativeErrorCode == Native.ERROR_ACCESS_DENIED)
            {
                // The service ACL normally lets any signed-in user stop it; if not, ask for elevation.
                if (RunElevated("sc.exe", "stop " + name, timeoutMs, out int code, out error) && (code == 0 || code == 1062))
                {
                    Thread.Sleep(1000);
                    return true;
                }
                error = error ?? "sc stop 返回 " + code;
                return false;
            }
            catch (System.ServiceProcess.TimeoutException) { error = "等待服务停止超时"; return false; }
            catch (Exception e) { error = e.InnerException?.Message ?? e.Message; return false; }
        }

        public bool StartService(string name, out string error)
        {
            error = null;
            try
            {
                using (var sc = new ServiceController(name))
                {
                    if (sc.Status == ServiceControllerStatus.Running || sc.Status == ServiceControllerStatus.StartPending) return true;
                    sc.Start();
                    return true;
                }
            }
            catch (Exception e) { error = e.InnerException?.Message ?? e.Message; return false; }
        }

        // ------------------------------------------------------------ time zone

        public string GetSystemTimeZoneId()
        {
            TimeZoneInfo.ClearCachedData();
            return TimeZoneInfo.Local.Id;
        }

        public List<TimeZoneEntry> ListTimeZones()
        {
            if (zones != null) return zones;
            zones = TimeZoneInfo.GetSystemTimeZones()
                .Select(z => new TimeZoneEntry { Id = z.Id, DisplayName = z.DisplayName, BaseOffset = z.BaseUtcOffset, Info = z })
                .ToList();
            return zones;
        }

        public bool SetSystemTimeZone(string id, out string error)
        {
            error = null;
            if (!ListTimeZones().Any(z => z.Id == id)) { error = "系统里没有这个时区：" + id; return false; }
            var r = Run("tzutil.exe", "/s " + CommandLine.Quote(id), 15000);
            if (r.ExitCode == 0 && GetSystemTimeZoneId() == id) return true;
            // Normally any user may change the time zone; fall back to asking for elevation.
            if (RunElevated("tzutil.exe", "/s " + CommandLine.Quote(id), 30000, out int code, out var elevErr) && code == 0 && GetSystemTimeZoneId() == id)
                return true;
            error = (r.Output.Trim().Length > 0 ? r.Output.Trim() : "tzutil 返回 " + r.ExitCode) + (elevErr != null ? "；" + elevErr : "");
            return false;
        }

        public bool? AutoTimeZoneEnabled()
        {
            try
            {
                using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (var k = hklm.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\tzautoupdate"))
                {
                    if (k?.GetValue("Start") is int start) return start != 4;
                }
            }
            catch (Exception) { }
            return null;
        }

        // ------------------------------------------------------------ policy

        public PolicySnapshot ReadPolicy()
        {
            var s = new PolicySnapshot();
            try
            {
                using (var hkcu = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64))
                    ReadValues(hkcu, s.User);
                using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                    ReadValues(hklm, s.Machine);
            }
            catch (Exception e) { s.Error = e.Message; }
            return s;
        }

        static void ReadValues(RegistryKey root, Dictionary<string, string> into)
        {
            using (var k = root.OpenSubKey(PolicyKey))
            {
                if (k == null) return;
                foreach (var name in k.GetValueNames())
                {
                    var kind = k.GetValueKind(name);
                    if (kind != RegistryValueKind.String && kind != RegistryValueKind.ExpandString && kind != RegistryValueKind.DWord) continue;
                    var v = k.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                    into[name.Length == 0 ? "(默认)" : name] = Convert.ToString(v, CultureInfo.InvariantCulture);
                }
            }
        }

        public bool WriteUserPolicy(IDictionary<string, string> values, out string error)
        {
            error = null;
            try
            {
                using (var hkcu = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64))
                    ApplyPolicy(hkcu, PolicyKey, values);
                return true;
            }
            catch (Exception e) when (e is UnauthorizedAccessException || e is System.Security.SecurityException)
            {
                // HKCU\Software\Policies is read-only for the user itself; write it through an elevated copy of
                // this exe, into this user's hive (HKU\<SID>) rather than the administrator's.
            }
            var sid = WindowsIdentity.GetCurrent().User?.Value;
            if (sid == null) { error = "取不到当前用户的 SID"; return false; }
            var payload = new JsonObject().Set("sid", sid);
            var vals = new JsonObject();
            foreach (var kv in values) vals.Set(kv.Key, kv.Value);
            payload.Set("values", vals);
            var arg = Convert.ToBase64String(Encoding.UTF8.GetBytes(Json.Serialize(payload, false)));
            if (!RunElevated(SelfExe, "--elevated-policy " + arg, 60000, out int code, out error)) return false;
            if (code != 0) { error = "管理员进程写入失败（返回 " + code + "）"; return false; }
            var check = ReadPolicy();
            foreach (var kv in values)
            {
                var now = check.UserValue(kv.Key);
                if (kv.Value == null ? now != null : now != kv.Value) { error = "写入后读回的值不对：" + kv.Key; return false; }
            }
            return true;
        }

        static readonly HashSet<string> WritablePolicyNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ProxyLogic.PolicyUrlKey, ProxyLogic.PolicyPacKey,
        };

        static void ApplyPolicy(RegistryKey root, string subKey, IDictionary<string, string> values)
        {
            bool anySet = values.Values.Any(v => v != null);
            using (var k = anySet ? root.CreateSubKey(subKey, true) : root.OpenSubKey(subKey, true))
            {
                if (k == null) return;
                foreach (var kv in values)
                {
                    if (!WritablePolicyNames.Contains(kv.Key)) continue;
                    if (kv.Value == null) k.DeleteValue(kv.Key, false);
                    else k.SetValue(kv.Key, kv.Value, RegistryValueKind.String);
                }
            }
        }

        /// <summary>Entry point of the elevated copy: writes only the proxy policy values into HKU\&lt;SID&gt;.</summary>
        public static int ElevatedPolicyMain(string base64)
        {
            try
            {
                var o = Json.ParseObject(Encoding.UTF8.GetString(Convert.FromBase64String(base64)));
                var sid = o.GetString("sid") ?? "";
                // Local and Microsoft accounts (S-1-5-21-…) and Entra ID accounts (S-1-12-1-…).
                if (!Regex.IsMatch(sid, @"^S-1-(5-21|12-1)(-\d+){4}$")) return 3;
                var values = new Dictionary<string, string>();
                foreach (var kv in o.GetObject("values") ?? new JsonObject()) values[kv.Key] = kv.Value as string;
                using (var users = RegistryKey.OpenBaseKey(RegistryHive.Users, RegistryView.Registry64))
                {
                    using (var hive = users.OpenSubKey(sid))
                        if (hive == null) return 4;
                    ApplyPolicy(users, sid + "\\" + PolicyKey, values);
                }
                return 0;
            }
            catch (Exception) { return 2; }
        }

        // ------------------------------------------------------------ system proxy

        public SystemProxyInfo GetSystemProxy()
        {
            var s = new SystemProxyInfo();
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings"))
                {
                    if (k == null) return s;
                    s.Enabled = k.GetValue("ProxyEnable") is int en && en != 0;
                    s.Server = k.GetValue("ProxyServer") as string ?? "";
                    s.Bypass = k.GetValue("ProxyOverride") as string ?? "";
                    s.AutoConfigUrl = k.GetValue("AutoConfigURL") as string ?? "";
                }
            }
            catch (Exception) { }
            return s;
        }

        // ------------------------------------------------------------ shell

        public void OpenFolder(string path)
        {
            if (File.Exists(path)) Process.Start("explorer.exe", "/select," + CommandLine.Quote(path));
            else Process.Start("explorer.exe", CommandLine.Quote(path));
        }

        public void OpenInEditor(string path) => Process.Start("notepad.exe", CommandLine.Quote(path));

        public void OpenUri(string uri) => Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });

        public bool CreateShortcut(string lnkPath, string target, string arguments, string description, out string error)
        {
            error = null;
            object link = null;
            try
            {
                link = new Native.ShellLink();
                var sl = (Native.IShellLinkW)link;
                sl.SetPath(target);
                sl.SetArguments(arguments ?? "");
                sl.SetDescription(description ?? "");
                sl.SetWorkingDirectory(Path.GetDirectoryName(target) ?? "");
                sl.SetIconLocation(target, 0);
                ((IPersistFile)link).Save(lnkPath, true);
                return true;
            }
            catch (Exception e) { error = e.Message; return false; }
            finally
            {
                if (link != null) Marshal.FinalReleaseComObject(link);
            }
        }

        public bool GetRunAtLogin()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey))
                    return k?.GetValue(RunValue) is string s && s.IndexOf(SelfExe, StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch (Exception) { return false; }
        }

        public bool SetRunAtLogin(bool enable, out string error)
        {
            error = null;
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (enable) k.SetValue(RunValue, CommandLine.Quote(SelfExe) + " --tray", RegistryValueKind.String);
                    else k.DeleteValue(RunValue, false);
                }
                return true;
            }
            catch (Exception e) { error = e.Message; return false; }
        }

        // ------------------------------------------------------------ installing Claude

        public InstallRights GetInstallRights()
        {
            try
            {
                using (var id = WindowsIdentity.GetCurrent())
                {
                    if (new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator)) return InstallRights.Elevated;
                    if (Native.GetTokenInformation(id.Token, Native.TokenElevationType, out int type, 4, out _) && type == Native.TokenElevationTypeLimited)
                        return InstallRights.Consent;
                }
            }
            catch (Exception) { return InstallRights.Consent; }
            return InstallRights.StandardUser;
        }

        public SignatureInfo CheckSignature(string file)
        {
            var info = new SignatureInfo();
            var r = RunPowerShell(PsScripts.Signature(file), 180000);
            foreach (var raw in r.Output.Split('\n'))
            {
                var line = raw.TrimEnd('\r');
                if (line.StartsWith("STATUS ", StringComparison.Ordinal)) info.Status = line.Substring(7).Trim();
                else if (line.StartsWith("SUBJECT ", StringComparison.Ordinal)) info.Subject = line.Substring(8).Trim();
                else if (line.StartsWith("MESSAGE ", StringComparison.Ordinal)) info.Message = line.Substring(8).Trim();
            }
            if (info.Status.Length == 0) info.Message = r.TimedOut ? "校验超时" : Fmt.Shorten(r.Output.Trim(), 300);
            return info;
        }

        public CommandResult InstallPackage(string file, int timeoutMs)
        {
            // Whatever ends up installed, ask Windows afresh afterwards.
            appxCache = null;
            if (!ClaudeRelease.IsPackageFile(file)) return RunInstaller(file, timeoutMs);

            // The script travels on the command line rather than in a file another process could swap.
            var log = Path.Combine(Path.GetTempPath(), "cdm-install-" + Guid.NewGuid().ToString("N") + ".log");
            var script = PsScripts.AddPackage(file, log);
            var args = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            var r = new CommandResult();
            try
            {
                string error;
                if (GetInstallRights() == InstallRights.Elevated)
                {
                    var run = Run("powershell.exe", args, timeoutMs);
                    r.ExitCode = run.ExitCode;
                    r.TimedOut = run.TimedOut;
                    error = run.Output.Trim();
                }
                else if (RunElevated("powershell.exe", args, timeoutMs, out int code, out error)) r.ExitCode = code;
                else r.TimedOut = error == "等待管理员进程超时";
                string written = "";
                try
                {
                    if (File.Exists(log)) written = File.ReadAllText(log).Trim();
                }
                catch (Exception) { }
                r.Output = written.Length > 0 ? written : error ?? "";
            }
            finally
            {
                try { File.Delete(log); } catch (Exception) { }
            }
            return r;
        }

        /// <summary>An installer exe (ClaudeSetup.exe) asks for elevation itself when it needs it.</summary>
        static CommandResult RunInstaller(string file, int timeoutMs)
        {
            var r = new CommandResult();
            try
            {
                using (var p = Process.Start(new ProcessStartInfo(file) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(file) ?? "" }))
                {
                    if (p == null)
                    {
                        r.Output = "没能启动安装程序";
                        return r;
                    }
                    if (!p.WaitForExit(timeoutMs))
                    {
                        r.TimedOut = true;
                        r.Output = "安装程序还没结束";
                        return r;
                    }
                    r.ExitCode = p.ExitCode;
                    if (r.ExitCode != 0) r.Output = "安装程序返回 " + r.ExitCode;
                }
            }
            catch (Win32Exception e) when (e.NativeErrorCode == Native.ERROR_CANCELLED) { r.Output = "已取消管理员授权"; }
            catch (Exception e) { r.Output = e.Message; }
            return r;
        }

        // ------------------------------------------------------------ helpers

        public CommandResult RunPowerShell(string script, int timeoutMs)
        {
            using (Diag.Time("PowerShell"))
                return RunPowerShellCore(script, timeoutMs);
        }

        CommandResult RunPowerShellCore(string script, int timeoutMs)
        {
            var full = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + script;
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(full));
            return Run("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded, timeoutMs);
        }

        static CommandResult Run(string file, string args, int timeoutMs)
        {
            var r = new CommandResult();
            var psi = new ProcessStartInfo(file, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            // tzutil and sc print in the console code page.
            if (!file.StartsWith("powershell", StringComparison.OrdinalIgnoreCase))
                psi.StandardOutputEncoding = psi.StandardErrorEncoding = Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage);
            var output = new StringBuilder();
            try
            {
                using (var p = new Process { StartInfo = psi })
                {
                    p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
                    p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
                    p.Start();
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    if (!p.WaitForExit(timeoutMs))
                    {
                        try { p.Kill(); } catch (Exception) { }
                        r.TimedOut = true;
                    }
                    else
                    {
                        p.WaitForExit();
                        r.ExitCode = p.ExitCode;
                    }
                }
            }
            catch (Exception e) { output.AppendLine(e.Message); }
            lock (output) r.Output = output.ToString();
            return r;
        }

        static bool RunElevated(string file, string args, int timeoutMs, out int exitCode, out string error)
        {
            exitCode = -1;
            error = null;
            try
            {
                using (var p = Process.Start(new ProcessStartInfo(file, args) { Verb = "runas", UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden }))
                {
                    if (p == null) { error = "没能启动管理员进程"; return false; }
                    if (!p.WaitForExit(timeoutMs)) { error = "等待管理员进程超时"; return false; }
                    exitCode = p.ExitCode;
                    return true;
                }
            }
            catch (Win32Exception e) when (e.NativeErrorCode == Native.ERROR_CANCELLED)
            {
                error = "已取消管理员授权";
                return false;
            }
            catch (Exception e)
            {
                error = e.Message;
                return false;
            }
        }
    }
}
