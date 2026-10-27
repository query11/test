using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    sealed partial class MainForm
    {
        ListView procList;
        Label serviceLabel;
        Button serviceStopButton, serviceStartButton, killSelectedButton;

        Control BuildProcessTab()
        {
            procList = Kit.List(("PID", 64), ("类型", 84), ("说明", 150), ("名称", 130), ("内存", 80), ("启动时间", 120), ("命令行 / 路径", 700));
            procList.Dock = DockStyle.Fill;
            procList.ShowItemToolTips = true;
            procList.SelectedIndexChanged += (s, e) => killSelectedButton.Enabled = !busy && procList.SelectedItems.Count > 0;

            killSelectedButton = Kit.Button("结束所选进程", async (s, e) => await KillSelected());
            killSelectedButton.Enabled = false;
            serviceLabel = Kit.Label("Cowork 虚拟机服务：…");
            serviceLabel.Margin = new Padding(Kit.S(18), Kit.S(8), Kit.S(3), Kit.S(3));
            serviceStopButton = Kit.Button("停止服务", async (s, e) => await RunOp("正在停止服务…", () => m.ServiceAction(start: false)));
            serviceStartButton = Kit.Button("启动服务", async (s, e) => await RunOp("正在启动服务…", () => m.ServiceAction(start: true)));
            actionControls.AddRange(new Control[] { killSelectedButton, serviceStopButton, serviceStartButton });

            var toolbar = Kit.Row(
                Kit.Button("刷新", (s, e) => RefreshStatus()),
                killSelectedButton,
                Kit.Button("复制列表", (s, e) => CopyProcessList()),
                serviceLabel, serviceStopButton, serviceStartButton);

            var note = Kit.Note("只列出 Claude Desktop 自己的进程（按安装目录识别，终端里的 Claude Code 不算）和它启动的子进程。" +
                "“强制结束全部进程”会结束黑色的这些；灰色的保留不动：Claude 打开的窗口程序（例如 VS Code、记事本）、其他用户会话里的 Claude。蓝色的是 Cowork 虚拟机服务。");

            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(Kit.S(6)) };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.Controls.Add(toolbar, 0, 0);
            grid.Controls.Add(procList, 0, 1);
            grid.Controls.Add(note, 0, 2);
            return grid;
        }

        void UpdateProcessList(ProcessView v)
        {
            UpdateServiceRow(v);
            if (tabs == null || tabs.SelectedIndex != 0 || procList == null) return;
            var selected = new HashSet<int>(procList.SelectedItems.Cast<ListViewItem>().Select(i => ((ProcInfo)i.Tag).Pid));
            int top = procList.TopItem?.Index ?? 0;
            procList.BeginUpdate();
            try
            {
                procList.Items.Clear();
                foreach (var p in v.Targets) procList.Items.Add(Item(p, SystemColors.WindowText, null));
                foreach (var p in v.Services) procList.Items.Add(Item(p, Kit.AccentColor, "服务由系统管理，用上面的“停止服务”"));
                foreach (var p in v.Kept) procList.Items.Add(Item(p, Kit.MutedColor, null));
                foreach (var p in v.OtherSessions) procList.Items.Add(Item(p, Kit.MutedColor, "其他用户会话"));
                foreach (ListViewItem i in procList.Items)
                    if (selected.Contains(((ProcInfo)i.Tag).Pid)) i.Selected = true;
                if (top > 0 && top < procList.Items.Count) procList.TopItem = procList.Items[top];
            }
            catch (Exception) { /* TopItem can throw while the list is not visible */ }
            finally { procList.EndUpdate(); }
        }

        static ListViewItem Item(ProcInfo p, Color color, string detailOverride)
        {
            var started = p.StartedLocal.HasValue
                ? p.StartedLocal.Value.ToString(p.StartedLocal.Value.Date == DateTime.Today ? "HH:mm:ss" : "MM-dd HH:mm", CultureInfo.InvariantCulture)
                : "";
            var cmd = p.CommandLine;
            if (string.IsNullOrEmpty(cmd)) cmd = p.Path ?? "";
            var item = new ListViewItem(new[]
            {
                p.Pid.ToString(CultureInfo.InvariantCulture),
                ProcessPlanner.RoleName(p.Role),
                detailOverride ?? p.Detail,
                p.Name,
                p.PrivateBytes > 0 ? Fmt.Bytes(p.PrivateBytes) : "",
                started,
                Fmt.Shorten(cmd, 400),
            })
            {
                ForeColor = color,
                Tag = p,
                ToolTipText = Fmt.Shorten(cmd, 1000),
            };
            return item;
        }

        void UpdateServiceRow(ProcessView v)
        {
            if (serviceLabel == null) return;
            var state = v.Services.Count > 0 ? ServiceState.Running : ServiceState.Unknown;
            // Querying the service manager every two seconds is cheap enough, but only needed when the
            // process list does not already show the service.
            if (state != ServiceState.Running) state = P.GetServiceState(Manager.CoworkService);
            serviceLabel.Text = "Cowork 虚拟机服务：" + Fmt.Service(state);
            serviceStopButton.Visible = state == ServiceState.Running || state == ServiceState.StartPending;
            serviceStartButton.Visible = state == ServiceState.Stopped;
        }

        async System.Threading.Tasks.Task KillSelected()
        {
            var procs = procList.SelectedItems.Cast<ListViewItem>().Select(i => (ProcInfo)i.Tag)
                .Where(p => p.Role != ProcRole.Service).ToList();
            if (procs.Count == 0) return;
            var text = "结束这 " + procs.Count + " 个进程？\n\n" + string.Join("\n", procs.Take(12).Select(p => p.Pid + "  " + p.Name + "  " + p.Detail))
                + (procs.Count > 12 ? "\n…" : "");
            if (MessageBox.Show(this, text, AppInfo.Name, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            await RunOp("正在结束所选进程…", () => m.KillPids(procs));
        }

        void CopyProcessList()
        {
            if (lastView == null) return;
            var sb = new StringBuilder();
            foreach (var p in lastView.All)
                sb.AppendLine(string.Join("\t", p.Pid, ProcessPlanner.RoleName(p.Role), p.Detail, p.Name, Fmt.Bytes(p.PrivateBytes), p.CommandLine ?? p.Path ?? ""));
            try
            {
                Clipboard.SetText(sb.Length > 0 ? sb.ToString() : "（没有 Claude 进程）");
                m.Log(LogLevel.Info, "进程列表已复制到剪贴板");
            }
            catch (Exception e) { m.Log(LogLevel.Error, "复制失败：" + e.Message); }
        }
    }
}
