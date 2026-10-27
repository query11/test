using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    sealed partial class MainForm : Form
    {
        readonly Manager m;
        readonly IPlatform P;
        readonly bool startHidden;
        readonly int initialTab;

        bool loading;
        bool refreshing;
        bool busy;
        bool reallyExit;
        bool trayHintShown;
        ProcessView lastView;
        DateTime lastViewAt;

        readonly Timer statusTimer = new Timer { Interval = 2000 };
        readonly Timer saveTimer = new Timer { Interval = 600 };
        readonly Timer clockTimer = new Timer { Interval = 1000 };

        Label statusDot, statusText, statusDetail, installLabel, tzBanner;
        Button tzRestoreButton;
        ComboBox profileCombo;
        Button manageButton, startButton, restartButton, stopButton, killButton;
        TabControl tabs;
        RichTextBox logBox;
        NotifyIcon tray;
        ContextMenuStrip trayMenu;
        readonly List<Control> actionControls = new List<Control>();

        Profile Current => m.S.Selected;

        public MainForm(Manager manager, bool startHidden, int initialTab)
        {
            m = manager;
            P = manager.P;
            this.startHidden = startHidden;
            this.initialTab = initialTab;

            Text = AppInfo.Name + (P.IsDemo ? "（演示模式）" : "");
            Font = Kit.Base;
            AutoScaleMode = AutoScaleMode.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(Kit.S(960), Kit.S(720));
            MinimumSize = new Size(Kit.S(760), Kit.S(560));
            Padding = new Padding(Kit.S(8), Kit.S(6), Kit.S(8), Kit.S(8));
            Icon = AppIcon();

            BuildHeader();
            BuildLog();
            BuildTabs();
            BuildTray();
            LoadProfiles();

            statusTimer.Tick += (s, e) => RefreshStatus();
            saveTimer.Tick += (s, e) => { saveTimer.Stop(); m.SaveSettings(); };
            clockTimer.Tick += (s, e) => TickClock();

            foreach (var e in m.History) AppendLog(e);
            m.Logged += e =>
            {
                try
                {
                    if (IsHandleCreated && !IsDisposed) BeginInvoke(new Action(() => AppendLog(e)));
                }
                catch (InvalidOperationException) { /* window is closing */ }
            };
            if (m.Store.LoadProblem != null) m.Log(LogLevel.Warn, m.Store.LoadProblem);

            HandleCreated += (s, e) => BeginInvoke(new Action(StartUp));
        }

        public static Icon AppIcon()
        {
            try
            {
                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico"))
                    if (s != null) return new Icon(s);
            }
            catch (Exception) { }
            return SystemIcons.Application;
        }

        protected override void SetVisibleCore(bool value)
        {
            if (startHidden && !IsHandleCreated)
            {
                CreateHandle();
                value = false;
            }
            base.SetVisibleCore(value);
        }

        async void StartUp()
        {
            if (initialTab > 0 && initialTab < tabs.TabCount) tabs.SelectedIndex = initialTab;
            statusText.Text = "正在检测…";
            try
            {
                var view = await Task.Run(() =>
                {
                    m.RefreshInstall();
                    var v = m.Scan();
                    m.RefreshInstall(v);
                    m.StartupCheck(v);
                    return v;
                });
                ShowView(view);
                if (m.Install == null) m.Log(LogLevel.Warn, "没有找到 Claude Desktop 的安装位置；可以在“设置”里手动指定 Claude.exe");
                else m.Log(LogLevel.Info, "检测到 Claude Desktop：" + m.Install.Summary);
            }
            catch (Exception e)
            {
                m.Log(LogLevel.Error, "初始化失败：" + e.Message);
            }
            OnInstallKnown();
            statusTimer.Start();
            clockTimer.Start();
        }

        // ------------------------------------------------------------ header

        void BuildHeader()
        {
            statusDot = Kit.Label("●", Kit.MutedColor, Kit.Big);
            statusDot.Margin = new Padding(Kit.S(2), Kit.S(2), 0, 0);
            statusText = Kit.Label("", null, Kit.Big);
            statusText.Margin = new Padding(0, Kit.S(2), Kit.S(8), 0);
            statusDetail = Kit.Label("", Kit.MutedColor);
            statusDetail.Margin = new Padding(Kit.S(3), Kit.S(8), Kit.S(3), 0);

            installLabel = Kit.Label("", Kit.MutedColor);
            tzBanner = Kit.Label("", Kit.WarnColor);
            tzRestoreButton = Kit.Button("恢复", async (s, e) => await RunOp("正在恢复时区…", () => m.RestoreTimeZone()));
            tzRestoreButton.Margin = new Padding(Kit.S(3), 0, Kit.S(3), 0);
            tzRestoreButton.Visible = false;

            profileCombo = Kit.Combo(200);
            profileCombo.SelectedIndexChanged += (s, e) => OnProfileSelected();
            manageButton = Kit.Button("方案管理 ▾");
            manageButton.Click += (s, e) => ShowProfileMenu();

            startButton = Kit.Button("启动", async (s, e) => await StartClicked(false));
            startButton.Font = Kit.Bold;
            restartButton = Kit.Button("重启", async (s, e) => await StartClicked(true));
            stopButton = Kit.Button("关闭 Claude", async (s, e) => await RunOp("正在关闭 Claude…", () => m.Stop(force: false)));
            killButton = Kit.Button("强制结束全部进程", async (s, e) => await RunOp("正在结束全部进程…", () => m.Stop(force: true)));
            killButton.ForeColor = Kit.ErrColor;
            actionControls.AddRange(new Control[] { startButton, restartButton, stopButton, killButton, tzRestoreButton });

            var spacer = new Label { AutoSize = false, Width = Kit.S(16), Height = 1 };
            // Fixed height whether or not the time zone banner is shown, so the buttons never move.
            var infoRow = Kit.Row(installLabel, tzBanner, tzRestoreButton);
            infoRow.WrapContents = false;
            infoRow.MinimumSize = new Size(0, tzRestoreButton.PreferredSize.Height + Kit.S(6));
            var header = Kit.Stack(
                Kit.Row(statusDot, statusText, statusDetail),
                infoRow,
                Kit.Row(Kit.Label("方案："), profileCombo, manageButton, spacer, startButton, restartButton, stopButton, killButton));
            header.Dock = DockStyle.Top;
            Controls.Add(header);
        }

        void ShowView(ProcessView v)
        {
            lastView = v;
            lastViewAt = DateTime.Now;
            if (v.Running)
            {
                statusDot.ForeColor = Kit.OkColor;
                statusText.Text = "Claude 正在运行";
                var main = v.Mains.OrderBy(p => p.CreationTime).First();
                var parts = new List<string> { "PID " + main.Pid, v.Targets.Count + " 个进程", "内存 " + Fmt.Bytes(v.PrivateBytes) };
                if (main.StartedLocal.HasValue) parts.Add("已运行 " + Fmt.Duration(DateTime.Now - main.StartedLocal.Value));
                if (v.Services.Count > 0) parts.Add("Cowork 服务 " + Fmt.Bytes(v.Services.Sum(p => p.PrivateBytes)));
                statusDetail.Text = string.Join(" · ", parts);
            }
            else
            {
                statusDot.ForeColor = Kit.MutedColor;
                statusText.Text = "Claude 未运行";
                var leftovers = v.Targets.Count;
                statusDetail.Text = leftovers > 0 ? "但还有 " + leftovers + " 个残留进程（可以点“强制结束全部进程”清理）" : (v.Services.Count > 0 ? "Cowork 虚拟机服务仍在运行" : "");
                statusDetail.ForeColor = leftovers > 0 ? Kit.WarnColor : Kit.MutedColor;
            }
            if (v.Running) statusDetail.ForeColor = Kit.MutedColor;
            if (busy) statusDot.ForeColor = Kit.WarnColor;

            var inst = m.Install;
            installLabel.Text = inst == null ? "未找到 Claude Desktop 安装" : "安装：" + inst.Summary;
            UpdateTzBanner();
            UpdateTray(v);
            UpdateProcessList(v);
        }

        void UpdateTzBanner()
        {
            var pending = m.S.PendingTz;
            if (pending == null)
            {
                tzBanner.Text = "";
                tzRestoreButton.Visible = false;
            }
            else
            {
                tzBanner.Text = "时区临时为 " + ShortTz(pending.AppliedId, true) + "（原为 " + ShortTz(pending.OriginalId, true) + "）";
                tzRestoreButton.Visible = true;
            }
            UpdateTimeZoneStatus();
        }

        /// <summary>"(UTC+08:00) 北京，重庆，…" → "北京，重庆，…", or just "北京" when <paramref name="first"/>.</summary>
        string ShortTz(string id, bool first = false)
        {
            var name = m.TzName(id);
            int i = name.IndexOf(')');
            if (i > 0 && i < name.Length - 1) name = name.Substring(i + 1).Trim();
            if (first)
            {
                int cut = name.IndexOfAny(new[] { '，', ',', '(', '（' });
                if (cut > 0) name = name.Substring(0, cut).Trim();
            }
            return name;
        }

        async void RefreshStatus()
        {
            if (refreshing || IsDisposed) return;
            refreshing = true;
            try
            {
                var v = await Task.Run(() =>
                {
                    var view = m.Scan();
                    if (!m.Busy) m.OnTick(view);
                    return view;
                });
                if (!IsDisposed) ShowView(v);
            }
            catch (Exception e)
            {
                statusDetail.Text = "读取进程信息失败：" + e.Message;
            }
            finally { refreshing = false; }
        }

        void TickClock()
        {
            UpdateTimePreview();
            if (lastView != null && lastView.Running && (DateTime.Now - lastViewAt).TotalSeconds < 5)
            {
                var main = lastView.Mains.FirstOrDefault();
                if (main?.StartedLocal != null)
                {
                    var text = statusDetail.Text;
                    int i = text.IndexOf("已运行 ", StringComparison.Ordinal);
                    if (i >= 0)
                    {
                        int end = text.IndexOf(" · ", i, StringComparison.Ordinal);
                        statusDetail.Text = text.Substring(0, i) + "已运行 " + Fmt.Duration(DateTime.Now - main.StartedLocal.Value) + (end >= 0 ? text.Substring(end) : "");
                    }
                }
            }
        }

        // ------------------------------------------------------------ operations

        async Task StartClicked(bool restart)
        {
            var profile = Current;
            if (profile == null) return;
            FlushEdits();
            var spec = m.Preview(profile);
            if (spec.Errors.Count > 0)
            {
                MessageBox.Show(this, "方案「" + profile.Name + "」有错误，请先改正：\n\n" + string.Join("\n", spec.Errors), AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            bool doRestart = restart;
            if (!restart && lastView != null && lastView.Running)
            {
                switch (m.S.Options.WhenRunning)
                {
                    case RunningPolicy.Restart:
                        doRestart = true;
                        break;
                    case RunningPolicy.Ask:
                        var ans = MessageBox.Show(this, "Claude 正在运行。要关闭它，再用方案「" + profile.Name + "」重新启动吗？\n\n方案里的代理、时区等设置只在启动时生效。",
                            AppInfo.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                        if (ans != DialogResult.Yes) return;
                        doRestart = true;
                        break;
                }
            }
            if (profile.Proxy.ViaPolicy && !P.IsDemo)
                m.Log(LogLevel.Info, "如果需要修改官方代理策略，Windows 会弹出管理员确认");
            await RunOp(doRestart ? "正在重启 Claude…" : "正在启动 Claude…", () => m.Start(profile.Name, doRestart));
        }

        async Task RunOp(string busyText, Func<OpResult> op)
        {
            if (busy) return;
            SetBusy(true, busyText);
            OpResult r = null;
            try { r = await Task.Run(op); }
            catch (Exception e) { m.Log(LogLevel.Error, "操作失败：" + e.Message); }
            finally
            {
                SetBusy(false, null);
                RefreshStatus();
            }
            if (r != null && !r.Ok && !Visible && tray != null)
                tray.ShowBalloonTip(5000, AppInfo.Name, Fmt.Shorten(r.Lines.LastOrDefault() ?? "操作失败", 200), ToolTipIcon.Warning);
        }

        void SetBusy(bool on, string text)
        {
            busy = on;
            foreach (var c in actionControls) c.Enabled = !on;
            foreach (ToolStripItem i in trayMenu.Items) if (i.Tag as string == "op") i.Enabled = !on;
            UseWaitCursor = on;
            if (on)
            {
                statusDot.ForeColor = Kit.WarnColor;
                statusText.Text = text;
            }
        }

        // ------------------------------------------------------------ log

        void BuildLog()
        {
            logBox = new RichTextBox
            {
                Dock = DockStyle.Fill,
                ReadOnly = true,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = SystemColors.Window,
                Font = Kit.Small,
                DetectUrls = false,
                WordWrap = true,
                ScrollBars = RichTextBoxScrollBars.Vertical,
            };
            var title = Kit.Label("操作记录", Kit.MutedColor);
            title.Dock = DockStyle.Top;
            var panel = new Panel { Dock = DockStyle.Bottom, Height = Kit.S(128), Padding = new Padding(0, Kit.S(4), 0, 0) };
            panel.Controls.Add(logBox);
            panel.Controls.Add(title);
            logBox.BringToFront();
            Controls.Add(panel);
        }

        void AppendLog(LogEntry e)
        {
            if (logBox == null || logBox.IsDisposed) return;
            Color color;
            switch (e.Level)
            {
                case LogLevel.Ok: color = Kit.OkColor; break;
                case LogLevel.Warn: color = Kit.WarnColor; break;
                case LogLevel.Error: color = Kit.ErrColor; break;
                default: color = SystemColors.WindowText; break;
            }
            if (logBox.Lines.Length > 400)
            {
                logBox.Select(0, logBox.GetFirstCharIndexFromLine(100));
                logBox.ReadOnly = false;
                logBox.SelectedText = "";
                logBox.ReadOnly = true;
            }
            logBox.SelectionStart = logBox.TextLength;
            logBox.SelectionLength = 0;
            logBox.SelectionColor = color;
            logBox.AppendText((logBox.TextLength > 0 ? "\n" : "") + e);
            logBox.SelectionColor = logBox.ForeColor;
            logBox.ScrollToCaret();
        }

        // ------------------------------------------------------------ tabs

        void BuildTabs()
        {
            tabs = new TabControl { Dock = DockStyle.Fill, Padding = new Point(Kit.S(10), Kit.S(4)) };
            tabs.TabPages.Add(Tab("进程", BuildProcessTab()));
            tabs.TabPages.Add(Tab("网络代理", BuildNetworkTab()));
            tabs.TabPages.Add(Tab("时区", BuildTimeZoneTab()));
            tabs.TabPages.Add(Tab("启动选项", BuildLaunchTab()));
            tabs.TabPages.Add(Tab("MCP 服务器", BuildMcpTab()));
            tabs.TabPages.Add(Tab("维护", BuildMaintenanceTab()));
            tabs.TabPages.Add(Tab("设置", BuildSettingsTab()));
            tabs.SelectedIndexChanged += (s, e) => OnTabChanged();
            Controls.Add(tabs);
            tabs.BringToFront();
        }

        static TabPage Tab(string title, Control content)
        {
            var page = new TabPage(title) { UseVisualStyleBackColor = true };
            page.Controls.Add(content);
            return page;
        }

        void OnTabChanged()
        {
            var title = tabs.SelectedTab?.Text;
            if (title == "进程" && lastView != null) UpdateProcessList(lastView);
            if (title == "MCP 服务器") ReloadMcp();
            if (title == "网络代理") UpdateNetworkStatus();
            if (title == "维护") ReloadLogFiles();
        }

        void OnInstallKnown()
        {
            UpdateLaunchPreview();
            UpdateNetworkValidation();
            UpdateNetworkStatus();
            ReloadMcp();
            ReloadLogFiles();
            UpdateMaintenanceButtons();
        }

        // ------------------------------------------------------------ profiles

        void LoadProfiles()
        {
            loading = true;
            profileCombo.Items.Clear();
            foreach (var p in m.S.Profiles) profileCombo.Items.Add(p.Name);
            profileCombo.SelectedItem = Current?.Name;
            loading = false;
            LoadProfileIntoTabs();
            RebuildTrayProfiles();
        }

        void OnProfileSelected()
        {
            if (loading || profileCombo.SelectedItem == null) return;
            FlushEdits();
            m.S.SelectedProfile = (string)profileCombo.SelectedItem;
            m.SaveSettings();
            LoadProfileIntoTabs();
            RebuildTrayProfiles();
            if (lastView != null) UpdateTray(lastView);
        }

        void LoadProfileIntoTabs()
        {
            var p = Current;
            if (p == null) return;
            loading = true;
            try
            {
                LoadNetwork(p);
                LoadTimeZone(p);
                LoadLaunch(p);
            }
            finally { loading = false; }
            UpdateLaunchPreview();
            UpdateNetworkStatus();
        }

        /// <summary>A control on a profile tab changed: copy it into the profile and save shortly after.</summary>
        void ProfileEdited()
        {
            if (loading || Current == null) return;
            SaveNetwork(Current);
            SaveTimeZone(Current);
            SaveLaunch(Current);
            saveTimer.Stop();
            saveTimer.Start();
            UpdateLaunchPreview();
            UpdateNetworkValidation();
        }

        void FlushEdits()
        {
            if (saveTimer.Enabled)
            {
                saveTimer.Stop();
                m.SaveSettings();
            }
        }

        void ShowProfileMenu()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("新建方案…", null, (s, e) => NewProfile(false));
            menu.Items.Add("复制当前方案…", null, (s, e) => NewProfile(true));
            menu.Items.Add("重命名…", null, (s, e) => RenameProfile());
            var del = menu.Items.Add("删除当前方案", null, (s, e) => DeleteProfile());
            del.Enabled = m.S.Profiles.Count > 1;
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("在桌面创建“用此方案启动”的快捷方式", null, (s, e) => CreateStartShortcut());
            menu.Show(manageButton, new Point(0, manageButton.Height));
        }

        void NewProfile(bool copy)
        {
            var name = Prompt.Ask(this, copy ? "复制方案" : "新建方案", "方案名称：", m.S.UniqueName(copy ? Current.Name + " 副本" : "新方案"));
            if (name == null) return;
            name = name.Trim();
            if (name.Length == 0) return;
            if (m.S.FindProfile(name) != null) { MessageBox.Show(this, "已经有叫「" + name + "」的方案了", AppInfo.Name); return; }
            FlushEdits();
            var p = copy ? Current.Clone() : new Profile();
            p.Name = name;
            m.S.Profiles.Add(p);
            m.S.SelectedProfile = name;
            m.SaveSettings();
            LoadProfiles();
            m.Log(LogLevel.Info, (copy ? "复制" : "新建") + "了方案「" + name + "」");
        }

        void RenameProfile()
        {
            var p = Current;
            var name = Prompt.Ask(this, "重命名方案", "新名称：", p.Name);
            if (name == null) return;
            name = name.Trim();
            if (name.Length == 0 || name == p.Name) return;
            var other = m.S.FindProfile(name);
            if (other != null && other != p) { MessageBox.Show(this, "已经有叫「" + name + "」的方案了", AppInfo.Name); return; }
            p.Name = name;
            m.S.SelectedProfile = name;
            m.SaveSettings();
            LoadProfiles();
        }

        void DeleteProfile()
        {
            var p = Current;
            if (m.S.Profiles.Count <= 1) return;
            if (MessageBox.Show(this, "删除方案「" + p.Name + "」？", AppInfo.Name, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            m.S.Profiles.Remove(p);
            m.S.SelectedProfile = m.S.Profiles[0].Name;
            m.SaveSettings();
            LoadProfiles();
            m.Log(LogLevel.Info, "删除了方案「" + p.Name + "」");
        }

        void CreateStartShortcut()
        {
            var p = Current;
            var lnk = Path.Combine(P.DesktopDir, SafeFileName("Claude（" + p.Name + "）") + ".lnk");
            if (P.CreateShortcut(lnk, P.SelfExe, "start --profile " + CommandLine.Quote(p.Name), "用方案「" + p.Name + "」启动 Claude Desktop", out var err))
                m.Log(LogLevel.Ok, "已在桌面创建快捷方式：" + Path.GetFileName(lnk));
            else m.Log(LogLevel.Error, "创建快捷方式失败：" + err);
        }

        static string SafeFileName(string s) => new string(s.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c).ToArray());

        // ------------------------------------------------------------ tray

        void BuildTray()
        {
            trayMenu = new ContextMenuStrip();
            try
            {
                tray = new NotifyIcon { Icon = Icon, Text = AppInfo.Name, ContextMenuStrip = trayMenu, Visible = true };
                tray.DoubleClick += (s, e) => ShowFromTray();
            }
            catch (Exception)
            {
                tray = null;
            }
            RebuildTrayProfiles();
        }

        void RebuildTrayProfiles()
        {
            if (trayMenu == null) return;
            trayMenu.Items.Clear();
            var status = new ToolStripMenuItem("Claude 状态未知") { Enabled = false, Name = "status" };
            trayMenu.Items.Add(status);
            trayMenu.Items.Add(new ToolStripSeparator());
            var start = new ToolStripMenuItem("用方案启动 / 重启") { Tag = "op" };
            foreach (var p in m.S.Profiles)
            {
                var name = p.Name;
                var item = new ToolStripMenuItem(name, null, async (s, e) => await RunOp("正在启动…", () => m.Start(name, restartIfRunning: true)))
                {
                    Checked = name == m.S.SelectedProfile,
                };
                start.DropDownItems.Add(item);
            }
            trayMenu.Items.Add(start);
            trayMenu.Items.Add(new ToolStripMenuItem("关闭 Claude", null, async (s, e) => await RunOp("正在关闭…", () => m.Stop(false))) { Tag = "op" });
            trayMenu.Items.Add(new ToolStripMenuItem("强制结束全部进程", null, async (s, e) => await RunOp("正在结束…", () => m.Stop(true))) { Tag = "op" });
            trayMenu.Items.Add(new ToolStripMenuItem("恢复系统时区", null, async (s, e) => await RunOp("正在恢复时区…", () => m.RestoreTimeZone())) { Tag = "op", Name = "tz", Visible = false });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("打开管理器", null, (s, e) => ShowFromTray());
            trayMenu.Items.Add("退出管理器", null, (s, e) => ExitApp());
        }

        void UpdateTray(ProcessView v)
        {
            if (trayMenu == null) return;
            var status = trayMenu.Items["status"];
            var text = v.Running ? "Claude 正在运行 · " + v.Targets.Count + " 个进程 · " + Fmt.Bytes(v.PrivateBytes) : "Claude 未运行";
            if (status != null) status.Text = text;
            var tz = trayMenu.Items["tz"];
            if (tz != null) tz.Visible = m.S.PendingTz != null;
            if (tray != null) tray.Text = Fmt.Shorten(AppInfo.Name + "\n" + text, 63);
        }

        public void ShowFromTray()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            RefreshStatus();
        }

        void ExitApp()
        {
            if (m.S.PendingTz != null && lastView != null && lastView.Running)
            {
                var ans = MessageBox.Show(this,
                    "系统时区还是临时设置的 " + ShortTz(m.S.PendingTz.AppliedId) + "，Claude 仍在运行。\n\n" +
                    "是：现在恢复成 " + ShortTz(m.S.PendingTz.OriginalId) + "（Claude 会立刻看到变化）\n" +
                    "否：先不恢复，下次打开管理器、Claude 已退出时再恢复\n取消：不退出",
                    AppInfo.Name, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (ans == DialogResult.Cancel) return;
                if (ans == DialogResult.Yes) m.RestoreTimeZone();
            }
            reallyExit = true;
            Close();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!reallyExit && e.CloseReason == CloseReason.UserClosing && m.S.Options.CloseToTray && tray != null)
            {
                e.Cancel = true;
                Hide();
                if (!trayHintShown)
                {
                    trayHintShown = true;
                    tray.ShowBalloonTip(4000, AppInfo.Name, "管理器还在托盘里运行（Claude 退出后要恢复时区等）。右键托盘图标可以退出。", ToolTipIcon.Info);
                }
                return;
            }
            if (!reallyExit && e.CloseReason == CloseReason.UserClosing && m.S.PendingTz != null && lastView != null && lastView.Running)
            {
                e.Cancel = true;
                ExitApp();
                return;
            }
            FlushEdits();
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            statusTimer.Stop();
            clockTimer.Stop();
            if (tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
            }
            base.OnFormClosed(e);
        }

        /// <summary>Demo / CI: render every tab to PNG files and quit.</summary>
        public void SaveScreenshots(string dir)
        {
            Directory.CreateDirectory(dir);
            for (int i = 0; i < tabs.TabCount; i++)
            {
                tabs.SelectedIndex = i;
                Application.DoEvents();
                using (var bmp = new Bitmap(Width, Height))
                {
                    DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
                    bmp.Save(Path.Combine(dir, "tab" + i + ".png"), System.Drawing.Imaging.ImageFormat.Png);
                }
            }
        }
    }

    /// <summary>A one-line input dialog.</summary>
    static class Prompt
    {
        public static string Ask(IWin32Window owner, string title, string label, string value)
        {
            using (var f = new Form
            {
                Text = title,
                Font = Kit.Base,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                StartPosition = FormStartPosition.CenterParent,
                MinimizeBox = false,
                MaximizeBox = false,
                ShowInTaskbar = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Padding = new Padding(Kit.S(10)),
            })
            {
                var box = Kit.Text(300, value);
                var ok = Kit.Button("确定");
                ok.DialogResult = DialogResult.OK;
                var cancel = Kit.Button("取消");
                cancel.DialogResult = DialogResult.Cancel;
                var stack = Kit.Stack(Kit.Label(label), box, Kit.Row(ok, cancel));
                stack.Dock = DockStyle.None;
                f.Controls.Add(stack);
                f.AcceptButton = ok;
                f.CancelButton = cancel;
                box.SelectAll();
                return f.ShowDialog(owner) == DialogResult.OK ? box.Text : null;
            }
        }
    }
}
