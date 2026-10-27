using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    sealed partial class MainForm
    {
        ComboBox langCombo;
        CheckBox chkGpu;
        TextBox extraArgsBox, extraEnvBox, previewBox;
        WrapLabel launchValidation;

        const string NoLang = "（不指定，跟随系统）";

        Control BuildLaunchTab()
        {
            langCombo = Kit.Combo(200, editable: true);
            langCombo.Items.AddRange(new object[] { NoLang, "en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "fr-FR", "de-DE", "es-ES", "pt-BR" });
            langCombo.TextChanged += (s, e) => ProfileEdited();
            chkGpu = Kit.Check("禁用 GPU 硬件加速（--disable-gpu；窗口黑屏、白屏、花屏或闪烁时可以试试）");
            chkGpu.CheckedChanged += (s, e) => ProfileEdited();
            extraArgsBox = Kit.Text(520);
            extraArgsBox.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top;
            extraArgsBox.TextChanged += (s, e) => ProfileEdited();
            extraEnvBox = Kit.MultiLine(90, readOnly: false, mono: true);
            extraEnvBox.TextChanged += (s, e) => ProfileEdited();
            previewBox = Kit.MultiLine(130, readOnly: true, mono: true);
            launchValidation = Kit.Note("", Kit.WarnColor);

            return Kit.Page(
                Kit.Group("启动参数（属于当前方案）",
                    Kit.Row(Kit.Label("界面语言 --lang"), langCombo),
                    Kit.Note("影响 Claude 窗口里的菜单语言和网页看到的浏览器语言（Accept-Language）。"),
                    chkGpu,
                    Kit.Label("额外启动参数（原样传给 Claude，例如 --force-device-scale-factor=1.25）："),
                    extraArgsBox),
                Kit.Group("额外环境变量（每行一个 名称=值，# 开头的是注释）",
                    extraEnvBox,
                    Kit.Note("只对旧版安装（Squirrel）和自定义路径有效。MSIX 版 Claude 由 Windows 激活启动，带不进环境变量；需要给 MCP 服务器设置环境变量时，可以写在 claude_desktop_config.json 里该服务器的 env 中。")),
                Kit.Group("启动时会做什么（预览）", previewBox, launchValidation));
        }

        void LoadLaunch(Profile p)
        {
            langCombo.Text = p.Lang.Length == 0 ? NoLang : p.Lang;
            chkGpu.Checked = p.DisableGpu;
            extraArgsBox.Text = p.ExtraArgs;
            extraEnvBox.Text = (p.ExtraEnv ?? "").Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
        }

        void SaveLaunch(Profile p)
        {
            var lang = (langCombo.Text ?? "").Trim();
            p.Lang = lang == NoLang ? "" : lang;
            p.DisableGpu = chkGpu.Checked;
            p.ExtraArgs = extraArgsBox.Text;
            p.ExtraEnv = extraEnvBox.Text.Replace("\r\n", "\n");
        }

        void UpdateLaunchPreview()
        {
            if (previewBox == null || Current == null) return;
            var p = Current;
            var inst = m.Install;
            var spec = m.Preview(p);
            var sb = new StringBuilder();
            if (inst == null) sb.AppendLine("启动方式：（还没找到 Claude Desktop）");
            else if (inst.Kind == InstallKind.Msix) sb.AppendLine("启动方式：MSIX 激活 " + inst.Aumid);
            else sb.AppendLine("启动方式：直接运行 " + inst.ExePath);
            sb.AppendLine("启动参数：" + (spec.Args.Count == 0 ? "（无）" : spec.ArgString));
            if (spec.Env.Count > 0) sb.AppendLine("环境变量：" + string.Join("  ", spec.Env.Select(kv => kv.Key + "=" + (kv.Value.Length == 0 ? "（清除）" : kv.Value))));
            sb.AppendLine("系统时区：" + (p.TimeZoneId.Length == 0 ? "不修改" : "临时切换为 " + m.TzName(p.TimeZoneId)));
            var desired = ProxyLogic.DesiredPolicy(p.Proxy, m.S.PolicyWrittenByUs);
            if (desired == null) sb.AppendLine("官方代理策略：不修改");
            else
            {
                var set = desired.Where(kv => kv.Value != null).Select(kv => kv.Key + " = " + kv.Value).ToList();
                sb.AppendLine("官方代理策略：" + (set.Count > 0 ? "写入 " + string.Join("，", set) : "删除本工具之前写入的 egressProxy 策略"));
            }
            previewBox.Text = sb.ToString().TrimEnd();
            var lines = spec.Errors.Select(e => "✗ " + e).Concat(spec.Warnings.Select(w => "! " + w)).ToList();
            launchValidation.Text = string.Join("\n", lines);
            launchValidation.ForeColor = spec.Errors.Count > 0 ? Kit.ErrColor : Kit.WarnColor;
            launchValidation.Visible = lines.Count > 0;
        }
    }
}
