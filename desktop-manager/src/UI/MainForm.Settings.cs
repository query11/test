using System;
using System.IO;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    sealed partial class MainForm
    {
        NumericUpDown gracefulBox;
        CheckBox chkKillChildren, chkStopService, chkRestoreOption, chkTray, chkLogin;
        RadioButton rbAsk, rbAutoRestart, rbKeep;
        TextBox exePathBox;

        Control BuildSettingsTab()
        {
            var o = m.S.Options;
            gracefulBox = Kit.Number(0, 60, o.GracefulTimeoutSec, 60);
            gracefulBox.ValueChanged += (s, e) => { o.GracefulTimeoutSec = (int)gracefulBox.Value; m.SaveSettings(); };
            chkKillChildren = Kit.Check("同时结束 Claude 启动的命令行子进程（MCP 服务器、终端命令等；它打开的窗口程序不受影响）", o.KillDescendants);
            chkKillChildren.CheckedChanged += (s, e) => { o.KillDescendants = chkKillChildren.Checked; m.SaveSettings(); };
            chkStopService = Kit.Check("同时停止 Cowork 虚拟机服务 CoworkVMService（释放虚拟机占用的内存，下次启动 Claude 时会自动再开）", o.StopCoworkService);
            chkStopService.CheckedChanged += (s, e) => { o.StopCoworkService = chkStopService.Checked; m.SaveSettings(); };

            rbAsk = Kit.Radio("每次询问");
            rbAutoRestart = Kit.Radio("自动关闭后重新启动（应用方案）");
            rbKeep = Kit.Radio("保持运行，不重启");
            rbAsk.Checked = o.WhenRunning == RunningPolicy.Ask;
            rbAutoRestart.Checked = o.WhenRunning == RunningPolicy.Restart;
            rbKeep.Checked = o.WhenRunning == RunningPolicy.Keep;
            EventHandler running = (s, e) =>
            {
                if (!((RadioButton)s).Checked) return;
                o.WhenRunning = rbAutoRestart.Checked ? RunningPolicy.Restart : rbKeep.Checked ? RunningPolicy.Keep : RunningPolicy.Ask;
                m.SaveSettings();
            };
            rbAsk.CheckedChanged += running;
            rbAutoRestart.CheckedChanged += running;
            rbKeep.CheckedChanged += running;

            chkRestoreOption = Kit.Check("Claude 退出后自动恢复系统时区", o.RestoreTimeZoneOnExit);
            chkRestoreOption.CheckedChanged += (s, e) =>
            {
                o.RestoreTimeZoneOnExit = chkRestoreOption.Checked;
                if (chkTzRestore != null) chkTzRestore.Checked = chkRestoreOption.Checked;
                m.SaveSettings();
            };

            chkTray = Kit.Check("关闭窗口时最小化到托盘（右键托盘图标可以退出）", o.CloseToTray);
            chkTray.CheckedChanged += (s, e) => { o.CloseToTray = chkTray.Checked; m.SaveSettings(); };
            chkLogin = Kit.Check("开机时自动启动管理器（只在托盘里运行）", P.GetRunAtLogin());
            chkLogin.CheckedChanged += (s, e) =>
            {
                if (loading) return;
                if (!P.SetRunAtLogin(chkLogin.Checked, out var err))
                {
                    m.Log(LogLevel.Error, "设置开机启动失败：" + err);
                    loading = true;
                    chkLogin.Checked = !chkLogin.Checked;
                    loading = false;
                }
                else m.Log(LogLevel.Ok, chkLogin.Checked ? "已设置开机启动" : "已取消开机启动");
            };

            exePathBox = Kit.Text(420, o.CustomExePath);
            exePathBox.Leave += (s, e) => ApplyExePath();
            var browse = Kit.Button("浏览…", (s, e) =>
            {
                using (var dlg = new OpenFileDialog { Filter = "Claude.exe|claude.exe|程序|*.exe", Title = "选择 Claude.exe" })
                {
                    if (dlg.ShowDialog(this) == DialogResult.OK)
                    {
                        exePathBox.Text = dlg.FileName;
                        ApplyExePath();
                    }
                }
            });

            return Kit.Page(
                Kit.Group("关闭 Claude 时",
                    Kit.Row(Kit.Label("先请 Claude 正常退出，最多等"), gracefulBox, Kit.Label("秒，之后强制结束（0 = 直接强制结束）")),
                    chkKillChildren, chkStopService),
                Kit.Group("启动方案时 Claude 已经在运行",
                    Kit.Row(rbAsk, rbAutoRestart, rbKeep),
                    Kit.Note("方案里的代理、时区、启动参数都只在 Claude 启动时生效，所以换方案需要重启 Claude。")),
                Kit.Group("时区", chkRestoreOption),
                Kit.Group("本工具",
                    chkTray, chkLogin,
                    Kit.Label("Claude.exe 的位置（留空自动检测 MSIX 和旧版安装）："),
                    Kit.Row(exePathBox, browse),
                    Kit.Note("设置文件：" + m.Store.FilePath + "（把 ClaudeDesktopManager.settings.json 放在程序旁边，就会改用那个文件，方便放 U 盘带着走）")),
                Kit.Group("关于",
                    Kit.Note(AppInfo.Name + " " + AppInfo.Version + "。非官方工具，与 Anthropic 无关；只调用 Windows 和 Claude Desktop 已有的功能（官方代理策略见 Claude 的部署文档），不修改 Claude 的程序文件。"),
                    Kit.Note("命令行：ClaudeDesktopManager.exe start [--profile 方案名] | restart | stop | kill | status | restore-tz")));
        }

        void ApplyExePath()
        {
            var path = exePathBox.Text.Trim().Trim('"');
            if (path == m.S.Options.CustomExePath) return;
            if (path.Length > 0 && !File.Exists(path))
            {
                m.Log(LogLevel.Warn, "文件不存在：" + path);
                return;
            }
            m.S.Options.CustomExePath = path;
            m.SaveSettings();
            m.RefreshInstall(lastView);
            m.Log(LogLevel.Info, m.Install == null ? "没有找到 Claude Desktop" : "现在使用：" + m.Install.Summary + " " + m.Install.ExePath);
            OnInstallKnown();
            RefreshStatus();
        }
    }
}
