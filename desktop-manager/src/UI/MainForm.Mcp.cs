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
        WrapLabel mcpPathLabel, mcpNote;
        ListView mcpList;
        Button mcpDisable, mcpEnable;

        Control BuildMcpTab()
        {
            mcpPathLabel = Kit.Note("");
            mcpPathLabel.ForeColor = System.Drawing.SystemColors.ControlText;
            mcpNote = Kit.Note("", Kit.WarnColor);
            mcpList = Kit.List(("名称", 160), ("状态", 70), ("类型", 60), ("命令 / 地址", 620));
            mcpList.Height = Kit.S(250);
            mcpList.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top;
            mcpList.ShowItemToolTips = true;
            mcpDisable = Kit.Button("停用所选", (s, e) => SetMcpEnabled(false));
            mcpEnable = Kit.Button("启用所选", (s, e) => SetMcpEnabled(true));
            var restart = Kit.Button("重启 Claude 让配置生效", async (s, e) => await StartClicked(true));
            actionControls.Add(restart);

            return Kit.Page(
                Kit.Group("claude_desktop_config.json",
                    mcpPathLabel,
                    Kit.Row(
                        Kit.Button("打开配置文件", (s, e) => OpenConfig()),
                        Kit.Button("打开所在文件夹", (s, e) => { var p = m.Install?.ConfigPath; if (!string.IsNullOrEmpty(p)) P.OpenFolder(File.Exists(p) ? p : Path.GetDirectoryName(p)); }),
                        Kit.Button("刷新", (s, e) => ReloadMcp())),
                    mcpNote),
                Kit.Group("MCP 服务器",
                    mcpList,
                    Kit.Row(mcpDisable, mcpEnable, restart),
                    Kit.Note("停用 = 把这个服务器从配置文件里移出来，存到本工具的设置里；启用时原样放回去。每次修改前都会备份配置文件（同目录下 .bak-日期，保留最近 10 份）。" +
                        "Claude 只在启动时读配置，改完要重启 Claude。")));
        }

        void OpenConfig()
        {
            var path = m.Install?.ConfigPath;
            if (string.IsNullOrEmpty(path)) { m.Log(LogLevel.Warn, "还没找到 Claude 的数据目录"); return; }
            try
            {
                if (!File.Exists(path))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    File.WriteAllText(path, "{\n  \"mcpServers\": {}\n}\n");
                    m.Log(LogLevel.Info, "配置文件不存在，已创建一个空的：" + path);
                }
                P.OpenInEditor(path);
            }
            catch (Exception e) { m.Log(LogLevel.Error, "打开配置文件失败：" + e.Message); }
        }

        async void ReloadMcp()
        {
            if (mcpList == null) return;
            var inst = m.Install;
            var path = inst?.ConfigPath;
            if (string.IsNullOrEmpty(path))
            {
                mcpPathLabel.Text = "还没找到 Claude Desktop 的数据目录。";
                mcpList.Items.Clear();
                return;
            }
            JsonObject root = null;
            string error = null;
            List<McpServer> servers = null;
            string other = null;
            await Task.Run(() =>
            {
                root = McpConfig.Load(path, out error);
                if (root != null) servers = McpConfig.List(root, m.S.McpStash, path);
                // MSIX: "Edit Config" in Claude sometimes opens %APPDATA%\Claude, which the app does not read.
                if (inst.Kind == InstallKind.Msix)
                    other = inst.DataDirCandidates.Select(d => Path.Combine(d, "claude_desktop_config.json"))
                        .FirstOrDefault(f => !string.Equals(f, path, StringComparison.OrdinalIgnoreCase) && File.Exists(f));
            });
            mcpPathLabel.Text = "Claude 读取的配置文件：" + path + (File.Exists(path) ? "" : "（还不存在）");
            var notes = new List<string>();
            if (error != null) notes.Add(error + "。请先修好这个文件（可以从同目录的 .bak 备份恢复），这里才能管理 MCP 服务器。");
            if (other != null)
                notes.Add("另外还有一份 " + other + "：MSIX 版 Claude 读的是上面那份，Claude 菜单里的“编辑配置”有时会打开这一份，改它不会生效。");
            mcpNote.Text = string.Join("\n", notes);
            mcpNote.Visible = notes.Count > 0;

            mcpList.BeginUpdate();
            mcpList.Items.Clear();
            if (servers != null)
                foreach (var s in servers)
                {
                    var item = new ListViewItem(new[] { s.Name, s.Enabled ? "启用" : "已停用", s.Kind, Fmt.Shorten(s.Summary, 300) })
                    {
                        Tag = s,
                        ForeColor = s.Enabled ? System.Drawing.SystemColors.WindowText : Kit.MutedColor,
                        ToolTipText = s.Summary,
                    };
                    mcpList.Items.Add(item);
                }
            mcpList.EndUpdate();
            bool editable = error == null;
            mcpDisable.Enabled = mcpEnable.Enabled = editable;
        }

        void SetMcpEnabled(bool enable)
        {
            var path = m.Install?.ConfigPath;
            var names = mcpList.SelectedItems.Cast<ListViewItem>().Select(i => (McpServer)i.Tag).Where(s => s.Enabled != enable).Select(s => s.Name).ToList();
            if (string.IsNullOrEmpty(path) || names.Count == 0) return;
            try
            {
                var backup = McpConfig.SetEnabled(path, m.S.McpStash, names, enable, out var problems);
                m.SaveSettings();
                foreach (var p in problems) m.Log(LogLevel.Warn, p);
                if (backup != null || problems.Count == 0)
                    m.Log(LogLevel.Ok, (enable ? "已启用" : "已停用") + " MCP 服务器：" + string.Join("、", names) + "。重启 Claude 后生效"
                        + (backup != null ? "（备份：" + Path.GetFileName(backup) + "）" : ""));
                if (lastView != null && lastView.Running) m.Log(LogLevel.Info, "Claude 正在运行，可以点“重启 Claude 让配置生效”");
            }
            catch (Exception e) { m.Log(LogLevel.Error, "修改配置失败：" + e.Message); }
            ReloadMcp();
        }
    }
}
