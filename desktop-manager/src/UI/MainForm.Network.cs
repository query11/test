using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    sealed partial class MainForm
    {
        RadioButton rbSystem, rbDirect, rbManual, rbPac;
        ComboBox schemeCombo;
        TextBox hostBox, bypassBox, pacBox, testResult;
        NumericUpDown portBox;
        CheckBox chkFlags, chkPolicy, chkEnv;
        WrapLabel netValidation, sysProxyLabel, policyLabel, egressLabel;
        Button scanButton, testButton, testDirectButton, clearPolicyButton;

        Control BuildNetworkTab()
        {
            rbSystem = Kit.Radio("跟随系统代理设置（Windows“设置 → 网络和 Internet → 代理”，默认）");
            rbDirect = Kit.Radio("不使用代理（直连）");
            rbManual = Kit.Radio("指定代理服务器");
            rbPac = Kit.Radio("使用 PAC 自动配置脚本");
            foreach (var rb in new[] { rbSystem, rbDirect, rbManual, rbPac }) rb.CheckedChanged += (s, e) => { if (((RadioButton)s).Checked) ProfileEdited(); };

            schemeCombo = Kit.Combo(90);
            schemeCombo.Items.AddRange(ProxyLogic.Schemes);
            schemeCombo.SelectedIndexChanged += (s, e) => ProfileEdited();
            hostBox = Kit.Text(170);
            hostBox.TextChanged += (s, e) => ProfileEdited();
            portBox = Kit.Number(1, 65535, 7890, 80);
            portBox.ValueChanged += (s, e) => ProfileEdited();
            scanButton = Kit.Button("检测本机代理端口…", async (s, e) => await ScanPorts());
            bypassBox = Kit.Text(420);
            bypassBox.TextChanged += (s, e) => ProfileEdited();
            pacBox = Kit.Text(420);
            pacBox.TextChanged += (s, e) => ProfileEdited();

            chkFlags = Kit.Check("启动参数 --proxy-server（Claude 窗口本身的请求；不需要管理员权限）");
            chkPolicy = Kit.Check("官方托管策略 egressProxyUrl（窗口 + Claude Code 引擎 + Cowork；要管理员确认）");
            chkEnv = Kit.Check("环境变量 HTTP(S)_PROXY（给 MCP 服务器等子进程；仅旧版安装）");
            foreach (var c in new[] { chkFlags, chkPolicy, chkEnv }) c.CheckedChanged += (s, e) => ProfileEdited();
            netValidation = Kit.Note("", Kit.WarnColor);

            sysProxyLabel = Kit.Note("");
            sysProxyLabel.ForeColor = SystemColors.ControlText;
            policyLabel = Kit.Note("");
            policyLabel.ForeColor = SystemColors.ControlText;
            egressLabel = Kit.Note("");
            clearPolicyButton = Kit.Button("清除 egressProxy 策略", async (s, e) =>
            {
                if (MessageBox.Show(this, "从 HKCU\\SOFTWARE\\Policies\\Claude 删除 egressProxyUrl 和 egressProxyPacUrl？\n（需要管理员确认，Claude 下次启动时生效）",
                    AppInfo.Name, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
                await RunOp("正在清除策略…", () => m.ClearPolicy());
                UpdateNetworkStatus();
            });
            actionControls.Add(clearPolicyButton);

            testButton = Kit.Button("按当前方案测试连接", async (s, e) => await TestNetwork(false));
            testDirectButton = Kit.Button("测试直连", async (s, e) => await TestNetwork(true));
            testResult = Kit.MultiLine(150, readOnly: true, mono: true);

            return Kit.Page(
                Kit.Group("代理方式（属于当前方案）", rbSystem, rbDirect, rbManual, rbPac),
                Kit.Group("代理服务器",
                    Kit.Row(Kit.Label("协议"), schemeCombo, Kit.Label("地址"), hostBox, Kit.Label("端口"), portBox, scanButton),
                    Kit.Row(Kit.Label("不走代理的地址"), bypassBox),
                    Kit.Note("多个用 ; 分隔，例如 *.corp.example.com;10.*。本机地址（localhost、127.0.0.1）总是直连。"),
                    Kit.Row(Kit.Label("PAC 地址"), pacBox)),
                Kit.Group("怎么让 Claude 用上这个代理",
                    chkFlags, chkPolicy, chkEnv,
                    Kit.Note("只勾“启动参数”就够大多数情况用了。想让 Claude Code / Cowork 的请求也一定走代理，再勾“官方托管策略”：" +
                        "它写在 HKCU\\SOFTWARE\\Policies\\Claude，只支持 HTTP 代理，需要 Claude Desktop 1.44121.1 以上，切回别的方案时本工具会把它删掉。" +
                        "代理软件开了 TUN / 虚拟网卡模式的话，所有程序都已经走代理，这里选“跟随系统”即可。"),
                    netValidation),
                Kit.Group("现在的情况",
                    sysProxyLabel, policyLabel, Kit.Row(clearPolicyButton), egressLabel),
                Kit.Group("连通性测试",
                    Kit.Row(testButton, testDirectButton),
                    Kit.Note("会连接 claude.ai、api.anthropic.com，并通过 api.ipify.org 查看出口 IP。收到任何 HTTP 状态码都说明网络是通的。"),
                    testResult));
        }

        void LoadNetwork(Profile p)
        {
            var x = p.Proxy;
            rbSystem.Checked = x.Mode == ProxyMode.System;
            rbDirect.Checked = x.Mode == ProxyMode.Direct;
            rbManual.Checked = x.Mode == ProxyMode.Manual;
            rbPac.Checked = x.Mode == ProxyMode.Pac;
            schemeCombo.SelectedItem = ProxyLogic.Schemes.Contains(x.Scheme) ? x.Scheme : "http";
            hostBox.Text = x.Host;
            portBox.Value = Math.Max(1, Math.Min(65535, x.Port));
            bypassBox.Text = x.Bypass;
            pacBox.Text = x.PacUrl;
            chkFlags.Checked = x.ViaLaunchFlags;
            chkPolicy.Checked = x.ViaPolicy;
            chkEnv.Checked = x.ViaEnv;
            UpdateNetworkValidation();
        }

        void SaveNetwork(Profile p)
        {
            var x = p.Proxy;
            x.Mode = rbDirect.Checked ? ProxyMode.Direct : rbManual.Checked ? ProxyMode.Manual : rbPac.Checked ? ProxyMode.Pac : ProxyMode.System;
            x.Scheme = (schemeCombo.SelectedItem as string) ?? "http";
            x.Host = hostBox.Text.Trim();
            x.Port = (int)portBox.Value;
            x.Bypass = bypassBox.Text;
            x.PacUrl = pacBox.Text.Trim();
            x.ViaLaunchFlags = chkFlags.Checked;
            x.ViaPolicy = chkPolicy.Checked;
            x.ViaEnv = chkEnv.Checked;
        }

        void UpdateNetworkValidation()
        {
            if (netValidation == null || Current == null) return;
            var x = Current.Proxy;
            bool manual = x.Mode == ProxyMode.Manual, pac = x.Mode == ProxyMode.Pac;
            schemeCombo.Enabled = hostBox.Enabled = portBox.Enabled = bypassBox.Enabled = manual;
            pacBox.Enabled = pac;
            chkFlags.Enabled = chkPolicy.Enabled = x.Mode != ProxyMode.System;
            chkEnv.Enabled = x.Mode != ProxyMode.System && (m.Install?.SupportsEnv ?? true);
            var lines = new List<string>();
            var errors = ProxyLogic.Validate(x);
            lines.AddRange(errors.Select(e => "✗ " + e));
            lines.AddRange(ProxyLogic.Warnings(x, m.Install?.SupportsEnv ?? true).Select(w => "! " + w));
            netValidation.Text = string.Join("\n", lines);
            netValidation.ForeColor = errors.Count > 0 ? Kit.ErrColor : Kit.WarnColor;
            netValidation.Visible = lines.Count > 0;
        }

        async void UpdateNetworkStatus()
        {
            if (sysProxyLabel == null) return;
            var logsDir = m.Install?.LogsDir;
            SystemProxyInfo sys = null;
            PolicySnapshot pol = null;
            List<string> egress = null;
            try
            {
                await Task.Run(() =>
                {
                    sys = P.GetSystemProxy();
                    pol = P.ReadPolicy();
                    egress = string.IsNullOrEmpty(logsDir) ? new List<string>() : LogTools.EgressLines(LogTools.Tail(Path.Combine(logsDir, "main.log"), 3000));
                });
            }
            catch (Exception e)
            {
                sysProxyLabel.Text = "读取失败：" + e.Message;
                return;
            }
            sysProxyLabel.Text = "系统代理：" + sys.Describe() + (sys.Bypass.Length > 0 && sys.Enabled ? "（例外：" + Fmt.Shorten(sys.Bypass, 80) + "）" : "");

            var parts = new List<string>();
            foreach (var key in new[] { ProxyLogic.PolicyUrlKey, ProxyLogic.PolicyPacKey })
            {
                var u = pol.UserValue(key);
                var mach = pol.MachineValue(key);
                if (u != null) parts.Add("HKCU " + key + " = " + u + (m.S.PolicyWrittenByUs ? "（本工具写入）" : "（不是本工具写入的）"));
                if (mach != null) parts.Add("HKLM " + key + " = " + mach + "（机器级，优先）");
            }
            if (pol.MachinePresent && parts.All(s => !s.StartsWith("HKLM", StringComparison.Ordinal)))
                parts.Add("HKLM 下有其他 Claude 策略，用户级（HKCU）策略会被 Claude 忽略");
            policyLabel.Text = "官方代理策略：" + (parts.Count == 0 ? "没有设置" : string.Join("；", parts));
            clearPolicyButton.Visible = pol.UserValue(ProxyLogic.PolicyUrlKey) != null || pol.UserValue(ProxyLogic.PolicyPacKey) != null;
            egressLabel.Text = egress.Count == 0
                ? "main.log 里还没有代理相关的记录（Claude 启动、开始 Code / Cowork 会话后才会写）"
                : "main.log 最近的代理记录：\n" + string.Join("\n", egress.Skip(Math.Max(0, egress.Count - 4)).Select(l => Fmt.Shorten(l, 220)));
        }

        static ProxyEndpoint FromSystem(SystemProxyInfo sys)
        {
            if (sys == null || !sys.Enabled || sys.Server.Length == 0) return null;
            var entries = sys.Server.Split(';').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            string pick = null, scheme = "http";
            foreach (var pref in new[] { "https=", "http=", "socks=" })
            {
                var e = entries.FirstOrDefault(x => x.StartsWith(pref, StringComparison.OrdinalIgnoreCase));
                if (e != null)
                {
                    pick = e.Substring(pref.Length);
                    if (pref == "socks=") scheme = "socks4";
                    break;
                }
            }
            if (pick == null) pick = entries.FirstOrDefault(x => !x.Contains("="));
            if (pick == null) return null;
            if (pick.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) pick = pick.Substring(7);
            int colon = pick.LastIndexOf(':');
            if (colon <= 0 || !int.TryParse(pick.Substring(colon + 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out var port)) return null;
            return new ProxyEndpoint { Scheme = scheme, Host = pick.Substring(0, colon).Trim('[', ']'), Port = port };
        }

        async Task TestNetwork(bool direct)
        {
            FlushEdits();
            var x = Current.Proxy.Clone();
            ProxyEndpoint ep = null;
            string label;
            if (direct || x.Mode == ProxyMode.Direct) label = "直连";
            else if (x.Mode == ProxyMode.Manual)
            {
                var errors = ProxyLogic.Validate(x);
                if (errors.Count > 0) { testResult.Text = string.Join(Environment.NewLine, errors); return; }
                ep = ProxyEndpoint.From(x);
                label = "代理 " + ep;
            }
            else if (x.Mode == ProxyMode.Pac) label = "直连（PAC 脚本要由 Claude 自己解析，这里没法模拟）";
            else
            {
                ep = FromSystem(P.GetSystemProxy());
                label = ep == null ? "直连（没有设置系统代理）" : "系统代理 " + ep;
            }
            testButton.Enabled = testDirectButton.Enabled = false;
            testResult.Text = "正在测试：" + label + " …";
            try
            {
                var targets = new[] { "https://claude.ai/", "https://api.anthropic.com/" };
                var fetches = targets.Select(u => Task.Run(() => NetProbe.Fetch(ep, u))).ToList();
                var ipTask = Task.Run(() => { var ip = NetProbe.ExitIp(ep, out var fr); return Tuple.Create(ip, fr); });
                await Task.WhenAll(fetches.Cast<Task>().Concat(new Task[] { ipTask }));
                var sb = new StringBuilder();
                sb.AppendLine("测试方式：" + label + "   " + DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture));
                for (int i = 0; i < targets.Length; i++)
                    sb.AppendLine(new Uri(targets[i]).Host.PadRight(20) + fetches[i].Result.Describe());
                var ipResult = ipTask.Result;
                sb.AppendLine("出口 IP".PadRight(17) + (ipResult.Item1 ?? "获取失败：" + (ipResult.Item2.Ok ? "HTTP " + ipResult.Item2.Status : ipResult.Item2.Error)));
                if (fetches.All(f => !f.Result.Ok) && ep != null)
                    sb.AppendLine("全部失败：检查代理软件是否在运行、端口是否正确，或者点“检测本机代理端口”。");
                testResult.Text = sb.ToString();
            }
            catch (Exception e) { testResult.Text = "测试出错：" + e.Message; }
            finally { testButton.Enabled = testDirectButton.Enabled = true; }
        }

        async Task ScanPorts()
        {
            scanButton.Enabled = false;
            var old = scanButton.Text;
            scanButton.Text = "正在检测…";
            List<PortProbe> found;
            try { found = await Task.Run(() => NetProbe.ScanLocalProxies(NetProbe.CommonProxyPorts)); }
            catch (Exception e) { m.Log(LogLevel.Error, "检测端口失败：" + e.Message); return; }
            finally
            {
                scanButton.Text = old;
                scanButton.Enabled = true;
            }
            if (found.Count == 0)
            {
                MessageBox.Show(this, "在常用端口（" + string.Join("、", NetProbe.CommonProxyPorts.Take(8)) + " 等）上没有发现本机代理。\n请确认代理软件已启动，并在它的设置里查看端口号。", AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var menu = new ContextMenuStrip();
            menu.Items.Add(new ToolStripMenuItem("点一项填入：") { Enabled = false });
            foreach (var p in found)
            {
                var probe = p;
                var item = menu.Items.Add(probe.Describe(), null, (s, e) =>
                {
                    rbManual.Checked = true;
                    schemeCombo.SelectedItem = probe.Http && !probe.HttpNeedsAuth ? "http" : "socks5";
                    hostBox.Text = "127.0.0.1";
                    portBox.Value = probe.Port;
                    ProfileEdited();
                });
                item.Enabled = probe.Usable;
            }
            menu.Show(scanButton, new Point(0, scanButton.Height));
        }
    }
}
