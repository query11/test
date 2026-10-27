using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    /// <summary>Downloads the latest official MSIX, checks and installs it, then starts Claude if asked to.</summary>
    sealed class InstallDialog : Form
    {
        readonly Manager m;
        readonly ComboBox routeCombo;
        readonly TextBox folderBox;
        readonly Button folderButton, goButton, cancelButton, closeButton;
        readonly CheckBox startAfter;
        readonly ProgressBar bar;
        readonly WrapLabel status;
        CancellationTokenSource cts;
        bool working, installing, closeWhenDone;

        /// <summary>Something was installed: the main window should look again.</summary>
        public bool Installed { get; private set; }

        public InstallDialog(Manager manager)
        {
            m = manager;
            Text = "下载安装 Claude Desktop";
            Font = Kit.Base;
            Icon = MainForm.AppIcon();
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            Padding = new Padding(Kit.S(12), Kit.S(10), Kit.S(12), Kit.S(10));
            ClientSize = new Size(Kit.S(640), Kit.S(330));

            var arch = m.P.NativeArch;
            var intro = Kit.Note("从 claude.ai 下载最新的官方安装包（MSIX，Windows " + arch + "），校验 Anthropic 的数字签名后安装。" +
                "安装要管理员确认（安装包里有 Cowork 虚拟机服务）。已经装了的会升级到最新版，登录状态和设置都保留。", SystemColors.ControlText);
            WrapLabel rights = null;
            if (m.P.GetInstallRights() == InstallRights.StandardUser) rights = Kit.Note(Manager.StandardUserNote, Kit.ErrColor);

            routeCombo = Kit.Combo(440);
            foreach (var r in m.DownloadRoutes()) routeCombo.Items.Add(r);
            routeCombo.SelectedIndex = 0;
            folderBox = Kit.Text(400, m.P.DownloadsDir);
            folderBox.ReadOnly = true;
            folderButton = Kit.Button("更改…", (s, e) => PickFolder());
            var profile = m.S.SelectedProfile;
            startAfter = Kit.Check("装好后用方案「" + profile + "」启动 Claude", true);

            bar = new ProgressBar
            {
                Height = Kit.S(18),
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top,
                Margin = new Padding(Kit.S(3), Kit.S(10), Kit.S(3), Kit.S(3)),
                Maximum = 1000,
            };
            status = Kit.Note("", Kit.MutedColor);
            status.MinimumSize = new Size(0, Kit.S(40));

            goButton = Kit.Button("下载并安装", async (s, e) => await Go());
            goButton.Font = Kit.Bold;
            cancelButton = Kit.Button("取消下载", (s, e) => cts?.Cancel());
            cancelButton.Enabled = false;
            var pageButton = Kit.Button("打开官网下载页", (s, e) => m.P.OpenUri(ClaudeRelease.DownloadPage));
            closeButton = Kit.Button("关闭", (s, e) => Close());
            var gap = new Label { AutoSize = false, Width = Kit.S(24), Height = 1 };

            var label1 = Kit.Label("网络线路：");
            var label2 = Kit.Label("保存到：");
            label1.MinimumSize = label2.MinimumSize = new Size(Math.Max(label1.PreferredWidth, label2.PreferredWidth), 0);
            var stack = Kit.Stack(
                intro,
                rights,
                Kit.Row(label1, routeCombo),
                Kit.Row(label2, folderBox, folderButton),
                startAfter,
                bar,
                status,
                Kit.Row(goButton, cancelButton, gap, pageButton, closeButton));
            Controls.Add(stack);
            AcceptButton = goButton;
            CancelButton = closeButton;
            if (rights != null) ClientSize = new Size(ClientSize.Width, ClientSize.Height + Kit.S(60));
        }

        void PickFolder()
        {
            using (var d = new FolderBrowserDialog { Description = "安装包保存到哪个文件夹", SelectedPath = folderBox.Text, ShowNewFolderButton = true })
            {
                if (d.ShowDialog(this) == DialogResult.OK) folderBox.Text = d.SelectedPath;
            }
        }

        void SetStatus(string text, Color color)
        {
            status.ForeColor = color;
            status.Text = text;
        }

        void SetWorking(bool on)
        {
            working = on;
            goButton.Enabled = routeCombo.Enabled = folderButton.Enabled = startAfter.Enabled = !on;
            cancelButton.Enabled = false;
            UseWaitCursor = on && installing;
        }

        void ShowProgress(DownloadProgress p)
        {
            if (IsDisposed || installing) return;
            if (p.Percent >= 0)
            {
                bar.Style = ProgressBarStyle.Continuous;
                bar.Value = Math.Max(0, Math.Min(bar.Maximum, (int)(p.Received * bar.Maximum / Math.Max(1, p.Total))));
            }
            else bar.Style = ProgressBarStyle.Marquee;
            SetStatus(p.Describe(), Kit.MutedColor);
        }

        /// <summary>For the screenshots: how the dialog looks while downloading.</summary>
        public void ShowSampleProgress()
        {
            SetWorking(true);
            cancelButton.Enabled = true;
            ShowProgress(new DownloadProgress { Received = 87L * 1024 * 1024 + 300 * 1024, Total = 214L * 1024 * 1024, BytesPerSecond = 6.4 * 1024 * 1024 });
        }

        async Task Go()
        {
            if (working) return;
            if (m.P.GetInstallRights() == InstallRights.StandardUser)
            {
                if (MessageBox.Show(this, Manager.StandardUserNote + "\n\n要打开官网下载页吗？", AppInfo.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                    m.P.OpenUri(ClaudeRelease.DownloadPage);
                return;
            }
            var route = (DownloadRoute)routeCombo.SelectedItem;
            var dir = folderBox.Text;
            installing = false;
            SetWorking(true);
            cancelButton.Enabled = true;
            bar.Style = ProgressBarStyle.Continuous;
            bar.Value = 0;
            SetStatus("正在连接 claude.ai（" + route.Label + "）…", Kit.MutedColor);
            cts = new CancellationTokenSource();
            DownloadResult d;
            try
            {
                d = await Task.Run(() => m.DownloadLatest(route.Proxy, dir, p =>
                {
                    try
                    {
                        if (!IsDisposed && IsHandleCreated) BeginInvoke(new Action(() => ShowProgress(p)));
                    }
                    catch (InvalidOperationException) { /* closing */ }
                }, cts.Token));
            }
            catch (Exception e)
            {
                d = new DownloadResult { Error = e.Message };
            }
            if (!d.Ok)
            {
                SetWorking(false);
                if (d.Cancelled) SetStatus("已取消。下载了的部分保留着，再点“下载并安装”会接着下载。", Kit.MutedColor);
                else SetStatus("下载失败：" + d.Error + Manager.DownloadHint(d), Kit.ErrColor);
                goButton.Text = d.Cancelled ? "继续下载" : "重试";
                if (closeWhenDone) Close();
                return;
            }

            bar.Value = bar.Maximum;
            if (closeWhenDone)
            {
                SetWorking(false);
                Close();
                return;
            }
            if (await Task.Run(() => m.Scan().Targets.Count > 0) &&
                MessageBox.Show(this, "下载好了。安装前要先关闭正在运行的 Claude，现在关闭并安装吗？", AppInfo.Name,
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK)
            {
                SetWorking(false);
                SetStatus("安装包已经下载到 " + d.FilePath + "。要装的时候再点“安装”（不会重新下载），或者在“维护”页用“从本地安装包安装…”。", Kit.MutedColor);
                goButton.Text = "安装";
                return;
            }

            installing = true;
            SetWorking(true);
            SetStatus((d.Reused ? "这个版本之前已经下载好了。" : "下载完成。") + "正在校验并安装" +
                (m.P.GetInstallRights() == InstallRights.Elevated ? "…" : "，Windows 会弹出管理员确认，请点“是”…"), Kit.MutedColor);
            var r = await Task.Run(() => m.InstallClaude(d.FilePath, downloaded: true));
            if (!r.Ok)
            {
                installing = false;
                SetWorking(false);
                SetStatus(r.Lines.LastOrDefault() ?? "安装失败", Kit.ErrColor);
                goButton.Text = "重试";
                return;
            }
            Installed = true;
            var summary = r.Lines.LastOrDefault() ?? "安装完成";
            if (startAfter.Checked)
            {
                SetStatus(summary + "。正在启动 Claude…", Kit.OkColor);
                var profile = m.S.SelectedProfile;
                var s = await Task.Run(() => m.Start(profile, restartIfRunning: false));
                SetStatus(summary + (s.Ok ? "。Claude 已启动。" : "。但启动没成功：" + s.Lines.LastOrDefault()), s.Ok ? Kit.OkColor : Kit.WarnColor);
            }
            else SetStatus(summary + "。", Kit.OkColor);
            installing = false;
            SetWorking(false);
            goButton.Visible = cancelButton.Visible = false;
            closeButton.Font = Kit.Bold;
            closeButton.Focus();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (working)
            {
                e.Cancel = true;
                if (installing)
                {
                    MessageBox.Show(this, "正在安装，请稍等。", AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                if (MessageBox.Show(this, "正在下载。要取消下载并关闭吗？\n\n已经下载的部分会保留，下次接着下载。", AppInfo.Name,
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                {
                    closeWhenDone = true;
                    cts?.Cancel();
                }
                return;
            }
            base.OnFormClosing(e);
        }
    }
}
