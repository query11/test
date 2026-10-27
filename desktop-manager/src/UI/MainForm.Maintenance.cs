using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    sealed partial class MainForm
    {
        ComboBox logFileCombo;
        CheckBox chkLogProxyOnly;
        TextBox logView;
        ListView usageList;
        Button cleanButton, reregisterButton;

        Control BuildMaintenanceTab()
        {
            logFileCombo = Kit.Combo(260);
            logFileCombo.SelectedIndexChanged += (s, e) => ShowLogFile();
            chkLogProxyOnly = Kit.Check("只看代理相关的行");
            chkLogProxyOnly.CheckedChanged += (s, e) => ShowLogFile();
            logView = Kit.MultiLine(220, readOnly: true, mono: true);

            usageList = Kit.List(("目录", 300), ("大小", 100));
            usageList.Height = Kit.S(160);
            cleanButton = Kit.Button("清理缓存…", async (s, e) => await CleanCaches());
            reregisterButton = Kit.Button("重新注册 MSIX 包…", async (s, e) => await Reregister());
            actionControls.AddRange(new Control[] { cleanButton, reregisterButton });

            return Kit.Page(
                Kit.Group("文件夹",
                    Kit.Row(
                        Kit.Button("数据目录", (s, e) => OpenDir(m.Install?.DataDir)),
                        Kit.Button("日志目录", (s, e) => OpenDir(m.Install?.LogsDir)),
                        Kit.Button("配置文件", (s, e) => OpenConfig()),
                        Kit.Button("本工具的设置", (s, e) => P.OpenFolder(m.Store.FilePath)))),
                Kit.Group("Claude 的日志",
                    Kit.Row(logFileCombo, Kit.Button("刷新", (s, e) => ReloadLogFiles()), chkLogProxyOnly),
                    logView),
                Kit.Group("磁盘占用与缓存",
                    Kit.Row(Kit.Button("统计占用", async (s, e) => await MeasureUsage()), cleanButton),
                    usageList,
                    Kit.Note("“清理缓存”只删 Cache、Code Cache、GPUCache 这类可以重新生成的缓存，不会退出登录，也不碰对话、设置和 Cowork 的虚拟机文件（vm_bundles）。要先关闭 Claude。")),
                Kit.Group("修复",
                    Kit.Row(reregisterButton, Kit.Button("复制诊断信息", async (s, e) => await CopyDiagnostics())),
                    Kit.Note("Claude 提示“Relaunch to update”却一直更新不上，或者开始菜单里点了打不开时，可以先关闭 Claude，再点“重新注册 MSIX 包”：" +
                        "它会停掉 Cowork 服务、结束残留进程，然后执行 Add-AppxPackage -RegisterByFamilyName，让 Windows 装上已经下载好的新版本。")),
                Kit.Group("桌面快捷方式",
                    Kit.Row(
                        Kit.Button("用当前方案启动 Claude", (s, e) => CreateStartShortcut()),
                        Kit.Button("一键关闭 Claude", (s, e) => CreateShortcut("关闭 Claude", "stop", "关闭 Claude Desktop（先正常退出，再结束残留进程）")),
                        Kit.Button("一键强制结束全部", (s, e) => CreateShortcut("强制结束 Claude", "kill", "立即结束 Claude Desktop 的全部进程"))),
                    Kit.Note("快捷方式调用本程序的命令行，不打开窗口。也可以自己用：ClaudeDesktopManager.exe start|restart|stop|kill|status [--profile 方案名]。")));
        }

        void UpdateMaintenanceButtons()
        {
            if (reregisterButton != null) reregisterButton.Visible = m.Install?.Kind == InstallKind.Msix;
        }

        void OpenDir(string dir)
        {
            if (string.IsNullOrEmpty(dir)) { m.Log(LogLevel.Warn, "还没找到 Claude 的数据目录"); return; }
            if (!Directory.Exists(dir)) { m.Log(LogLevel.Warn, "目录不存在：" + dir); return; }
            P.OpenFolder(dir);
        }

        void CreateShortcut(string name, string command, string description)
        {
            var lnk = Path.Combine(P.DesktopDir, name + ".lnk");
            if (P.CreateShortcut(lnk, P.SelfExe, command, description, out var err)) m.Log(LogLevel.Ok, "已在桌面创建快捷方式：" + name);
            else m.Log(LogLevel.Error, "创建快捷方式失败：" + err);
        }

        void ReloadLogFiles()
        {
            if (logFileCombo == null) return;
            var files = LogTools.ListLogFiles(m.Install?.LogsDir);
            var current = logFileCombo.SelectedItem as string;
            logFileCombo.Items.Clear();
            foreach (var f in files) logFileCombo.Items.Add(Path.GetFileName(f));
            if (files.Count == 0)
            {
                logView.Text = m.Install == null ? "还没找到 Claude 的数据目录。" : "日志目录里还没有日志：" + m.Install.LogsDir;
                return;
            }
            logFileCombo.SelectedItem = current != null && logFileCombo.Items.Contains(current) ? current : logFileCombo.Items[0];
            ShowLogFile();
        }

        async void ShowLogFile()
        {
            var name = logFileCombo.SelectedItem as string;
            var dir = m.Install?.LogsDir;
            if (name == null || string.IsNullOrEmpty(dir)) return;
            bool proxyOnly = chkLogProxyOnly.Checked;
            var text = await Task.Run(() =>
            {
                var t = LogTools.Tail(Path.Combine(dir, name), proxyOnly ? 20000 : 400, proxyOnly ? 8 * 1024 * 1024 : 1024 * 1024);
                if (!proxyOnly) return t;
                var lines = LogTools.EgressLines(t);
                return lines.Count == 0 ? "（这个文件里没有代理相关的记录）" : string.Join(Environment.NewLine, lines);
            });
            logView.Text = text.Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
            logView.SelectionStart = logView.TextLength;
            logView.ScrollToCaret();
        }

        async Task MeasureUsage()
        {
            var dir = m.Install?.DataDir;
            if (string.IsNullOrEmpty(dir)) return;
            usageList.Items.Clear();
            usageList.Items.Add(new ListViewItem(new[] { "正在统计…", "" }));
            var usage = await Task.Run(() => Maintenance.MeasureDataDir(dir));
            var caches = await Task.Run(() => Maintenance.MeasureCaches(dir));
            usageList.BeginUpdate();
            usageList.Items.Clear();
            usageList.Items.Add(new ListViewItem(new[] { "合计（" + dir + "）", Fmt.Bytes(usage.Sum(kv => kv.Value)) }) { Font = Kit.Bold });
            usageList.Items.Add(new ListViewItem(new[] { "其中可清理的缓存", Fmt.Bytes(caches.Sum(kv => kv.Value)) }) { ForeColor = Kit.OkColor });
            foreach (var kv in usage) usageList.Items.Add(new ListViewItem(new[] { kv.Key, Fmt.Bytes(kv.Value) }));
            usageList.EndUpdate();
        }

        async Task CleanCaches()
        {
            var dir = m.Install?.DataDir;
            if (string.IsNullOrEmpty(dir)) return;
            if (lastView != null && (lastView.Running || lastView.Targets.Count > 0))
            {
                MessageBox.Show(this, "请先关闭 Claude（缓存文件在运行时被占用）。", AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var caches = await Task.Run(() => Maintenance.MeasureCaches(dir));
            long total = caches.Sum(kv => kv.Value);
            if (total == 0) { m.Log(LogLevel.Info, "没有可清理的缓存"); return; }
            var text = "将删除这些缓存（共 " + Fmt.Bytes(total) + "）：\n\n" + string.Join("\n", caches.Where(kv => kv.Value > 0).Select(kv => kv.Key + "  " + Fmt.Bytes(kv.Value))) +
                "\n\n不会退出登录，也不会删除对话和设置。继续吗？";
            if (MessageBox.Show(this, text, AppInfo.Name, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            var r = await Task.Run(() => Maintenance.CleanCaches(dir));
            m.Log(r.Failed.Count == 0 ? LogLevel.Ok : LogLevel.Warn, "清理了 " + r.Files + " 个缓存文件，释放 " + Fmt.Bytes(r.Freed) + (r.Failed.Count > 0 ? "；" + r.Failed.Count + " 个删不掉（可能被占用）" : ""));
            await MeasureUsage();
        }

        async Task Reregister()
        {
            var inst = m.Install;
            if (inst == null || inst.Kind != InstallKind.Msix) return;
            if (MessageBox.Show(this, "将关闭 Claude（包括 Cowork 服务），然后重新注册 MSIX 包 " + inst.PackageFamilyName + "。\n\n如果有已经下载好的新版本，会在这一步装上。继续吗？",
                AppInfo.Name, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            await RunOp("正在关闭 Claude…", () =>
            {
                var r = m.Stop(force: false);
                if (m.P.GetServiceState(Manager.CoworkService) == ServiceState.Running) m.ServiceAction(start: false);
                return r;
            });
            await RunOp("正在重新注册…", () =>
            {
                var r = new OpResult();
                m.Log(LogLevel.Info, "执行 Add-AppxPackage -RegisterByFamilyName -MainPackage " + inst.PackageFamilyName);
                var family = inst.PackageFamilyName.Replace("'", "''");
                var name = inst.PackageFullName.Split('_')[0].Replace("'", "''");
                var res = P.RunPowerShell(
                    "try { Add-AppxPackage -RegisterByFamilyName -MainPackage '" + family + "' -ErrorAction Stop } " +
                    "catch { Write-Output $_.Exception.Message; exit 1 }; " +
                    "(Get-AppxPackage -Name '" + name + "' | Select-Object -First 1).Version.ToString()", 180000);
                var output = res.Output.Trim();
                if (res.ExitCode == 0)
                {
                    m.Log(LogLevel.Ok, "重新注册完成" + (output.Length > 0 ? "，现在的版本：" + Fmt.Shorten(output.Split('\n').Last().Trim(), 60) : ""));
                    m.RefreshInstall();
                }
                else
                {
                    r.Ok = false;
                    m.Log(LogLevel.Error, "重新注册失败：" + Fmt.Shorten(output, 500));
                }
                return r;
            });
            OnInstallKnown();
        }

        async Task CopyDiagnostics()
        {
            string text;
            try { text = await Task.Run(() => m.Diagnostics()); }
            catch (Exception e) { m.Log(LogLevel.Error, "生成诊断信息失败：" + e.Message); return; }
            try
            {
                Clipboard.SetText(text);
                m.Log(LogLevel.Ok, "诊断信息已复制到剪贴板（不含密钥；进程命令行里可能有文件路径，分享前看一眼）");
            }
            catch (Exception e) { m.Log(LogLevel.Error, "复制失败：" + e.Message); }
        }
    }
}
