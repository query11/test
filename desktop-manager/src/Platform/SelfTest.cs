using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;

namespace ClaudeDesktopManager
{
    /// <summary>`ClaudeDesktopManager.exe selftest`: checks the Windows calls on a real machine (used by CI).</summary>
    static class SelfTest
    {
        public static int Run(Manager m, Action<string> print)
        {
            var P = m.P;
            int failures = 0;
            void Check(string name, bool ok, string detail = null)
            {
                print((ok ? "ok   " : "FAIL ") + name + (string.IsNullOrEmpty(detail) ? "" : " — " + detail));
                if (!ok) failures++;
            }

            var snap = P.Snapshot(m.Dirs);
            var self = snap.FirstOrDefault(p => p.Pid == P.SelfPid);
            Check("进程快照", snap.Count > 10, snap.Count + " 个进程");
            Check("找到自己", self != null);
            if (self != null)
            {
                Check("自己的路径", string.Equals(self.Path, P.SelfExe, StringComparison.OrdinalIgnoreCase), self.Path);
                Check("自己的命令行", (self.CommandLine ?? "").Contains("selftest"), self.CommandLine);
                Check("创建时间", self.CreationTime > 0 && self.StartedLocal.Value > DateTime.Now.AddMinutes(-10), self.StartedLocal?.ToString());
                Check("内存", self.PrivateBytes > 0 && self.WorkingSet > 0, Fmt.Bytes(self.PrivateBytes));
                Check("识别为窗口程序", self.IsConsole == false);
                Check("会话", self.SessionId == P.SessionId, self.SessionId.ToString());
            }
            // Services run in session 0, and that has to be known even where the process cannot be opened.
            var services = snap.Where(p => p.Name.Equals("services.exe", StringComparison.OrdinalIgnoreCase)).ToList();
            Check("系统进程的会话", services.Count > 0 && services.All(p => p.SessionId == 0), string.Join(",", services.Select(p => p.SessionId)));

            using (var ping = Process.Start(new ProcessStartInfo("ping.exe", "-n 120 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true }))
            {
                Thread.Sleep(800);
                var child = P.Snapshot(m.Dirs).FirstOrDefault(p => p.Pid == ping.Id);
                Check("子进程", child != null);
                if (child != null)
                {
                    Check("父进程 PID", child.ParentPid == P.SelfPid, child.ParentPid.ToString());
                    Check("识别为命令行程序", child.IsConsole == true);
                    Check("子进程命令行", (child.CommandLine ?? "").Contains("127.0.0.1"), child.CommandLine);
                    Check("IsAlive", P.IsAlive(child.Pid, child.CreationTime));
                    Check("创建时间不符时不算", !P.IsAlive(child.Pid, child.CreationTime + 1));
                    var wrong = child.Clone();
                    wrong.CreationTime += 1;
                    Check("PID 复用保护", !P.Terminate(wrong, out var reuse) && P.IsAlive(child.Pid, 0), reuse);
                    Check("结束进程", P.Terminate(child, out var err), err);
                    Check("已结束", !P.IsAlive(child.Pid, 0));
                }
            }

            try
            {
                using (var note = Process.Start("notepad.exe"))
                {
                    int windows = 0;
                    for (int i = 0; i < 30 && windows == 0; i++)
                    {
                        Thread.Sleep(200);
                        windows = P.CloseWindows(note.Id);
                    }
                    if (windows == 0)
                    {
                        print("跳过 关闭窗口（没有可见的桌面会话）");
                        if (!note.HasExited) note.Kill();
                    }
                    else Check("关闭窗口（WM_CLOSE）", note.WaitForExit(5000), windows + " 个窗口");
                }
            }
            catch (Exception e) { print("跳过 关闭窗口：" + e.Message); }

            var zones = P.ListTimeZones();
            Check("时区列表", zones.Count > 100, zones.Count + " 个");
            var tz = P.GetSystemTimeZoneId();
            Check("系统时区", zones.Any(z => z.Id == tz), tz + " " + m.TzName(tz));
            print("     自动设置时区：" + (P.AutoTimeZoneEnabled()?.ToString() ?? "未知"));

            var pol = P.ReadPolicy();
            Check("读取策略", pol.Error == null, pol.Error ?? ("用户 " + pol.User.Count + " 项，机器 " + pol.Machine.Count + " 项"));
            print("     系统代理：" + P.GetSystemProxy().Describe());
            Check("服务状态", P.GetServiceState("EventLog") == ServiceState.Running);
            Check("不存在的服务", P.GetServiceState("NoSuchService_cdm_selftest") == ServiceState.NotInstalled);
            print("     CoworkVMService：" + Fmt.Service(P.GetServiceState(Manager.CoworkService)));

            foreach (var i in P.DetectInstalls())
                print("     安装：" + i.Summary + "  " + i.ExePath + "  数据：" + i.DataDir + (i.Aumid.Length > 0 ? "  " + i.Aumid : ""));

            var lnk = Path.Combine(Path.GetTempPath(), "cdm-selftest-快捷方式.lnk");
            Check("创建快捷方式", P.CreateShortcut(lnk, P.SelfExe, "status", "self test", out var lnkErr) && File.Exists(lnk), lnkErr);
            try { File.Delete(lnk); } catch (Exception) { }

            print(failures == 0 ? "全部通过" : failures + " 项失败");
            return failures == 0 ? 0 : 1;
        }
    }
}
