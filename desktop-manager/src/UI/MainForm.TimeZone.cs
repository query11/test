using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    sealed partial class MainForm
    {
        RadioButton rbTzKeep, rbTzSet;
        ComboBox tzCombo;
        TextBox tzFilter;
        Label tzPreview;
        WrapLabel tzSystemLabel, tzAutoLabel, tzPendingLabel;
        Button tzOpenSettings, tzRestoreNow;
        CheckBox chkTzRestore;
        List<TimeZoneEntry> allZones = new List<TimeZoneEntry>();

        static readonly string[] WeekDays = { "星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六" };

        Control BuildTimeZoneTab()
        {
            rbTzKeep = Kit.Radio("不修改，使用系统时区");
            rbTzSet = Kit.Radio("启动 Claude 时切换到：");
            rbTzKeep.CheckedChanged += (s, e) => { if (rbTzKeep.Checked) { ProfileEdited(); UpdateTimePreview(); } };
            rbTzSet.CheckedChanged += (s, e) => { if (rbTzSet.Checked) { ProfileEdited(); UpdateTimePreview(); } };
            tzCombo = Kit.Combo(460);
            tzCombo.MaxDropDownItems = 20;
            tzCombo.SelectedIndexChanged += (s, e) =>
            {
                if (!loading && tzCombo.SelectedItem != null) rbTzSet.Checked = true;
                ProfileEdited();
                UpdateTimePreview();
            };
            tzFilter = Kit.Text(150);
            tzFilter.TextChanged += (s, e) => FillZoneCombo(SelectedZoneId());
            tzPreview = Kit.Label("", Kit.AccentColor, Kit.Bold);

            tzSystemLabel = Kit.Note("");
            tzSystemLabel.ForeColor = System.Drawing.SystemColors.ControlText;
            tzAutoLabel = Kit.Note("");
            tzOpenSettings = Kit.Button("打开“日期和时间”设置", (s, e) => { try { P.OpenUri("ms-settings:dateandtime"); } catch (Exception ex) { m.Log(LogLevel.Error, ex.Message); } });
            tzPendingLabel = Kit.Note("");
            tzRestoreNow = Kit.Button("立即恢复系统时区", async (s, e) => await RunOp("正在恢复时区…", () => m.RestoreTimeZone()));
            actionControls.Add(tzRestoreNow);
            chkTzRestore = Kit.Check("Claude 退出后自动恢复原来的系统时区（推荐）", m.S.Options.RestoreTimeZoneOnExit);
            chkTzRestore.CheckedChanged += (s, e) =>
            {
                m.S.Options.RestoreTimeZoneOnExit = chkTzRestore.Checked;
                if (chkRestoreOption != null) chkRestoreOption.Checked = chkTzRestore.Checked;
                m.SaveSettings();
            };

            return Kit.Page(
                Kit.Group("Claude 看到的时区（属于当前方案）",
                    rbTzKeep,
                    Kit.Row(rbTzSet, tzCombo),
                    Kit.Row(Kit.Label("　　筛选："), tzFilter, Kit.Label("输入城市名或时区 ID，例如 东京、Pacific", Kit.MutedColor)),
                    Kit.Row(Kit.Label("Claude 会看到："), tzPreview),
                    Kit.Note("Windows 上应用程序读到的时区就是系统时区，没有只改一个程序的办法（TZ 环境变量对 Claude 的界面无效）。" +
                        "所以用这个方案启动 Claude 时，管理器会把系统时区临时切换过去，任务栏的时钟也会跟着变；Claude 退出后（管理器在托盘里运行着就行）自动换回来。" +
                        "切换前会先把原来的时区记在设置文件里，即使管理器意外退出，下次打开时也会恢复。")),
                Kit.Group("系统状态",
                    tzSystemLabel,
                    tzAutoLabel, Kit.Row(tzOpenSettings),
                    tzPendingLabel, Kit.Row(tzRestoreNow),
                    chkTzRestore));
        }

        string SelectedZoneId() => (tzCombo?.SelectedItem as TimeZoneEntry)?.Id;

        void FillZoneCombo(string selectId)
        {
            if (tzCombo == null) return;
            bool wasLoading = loading;
            loading = true;
            try
            {
                if (allZones.Count == 0)
                {
                    try { allZones = P.ListTimeZones(); }
                    catch (Exception e) { m.Log(LogLevel.Error, "读取时区列表失败：" + e.Message); }
                }
                var filter = (tzFilter?.Text ?? "").Trim();
                var items = allZones.Where(z => filter.Length == 0
                    || z.DisplayName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                    || z.Id.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                    || z.Id == selectId).ToList();
                tzCombo.BeginUpdate();
                tzCombo.Items.Clear();
                foreach (var z in items) tzCombo.Items.Add(z);
                tzCombo.EndUpdate();
                var sel = items.FirstOrDefault(z => z.Id == selectId);
                if (sel != null) tzCombo.SelectedItem = sel;
                else if (!string.IsNullOrEmpty(filter) && items.Count > 0 && items.Count < allZones.Count)
                {
                    tzCombo.SelectedIndex = 0;
                    if (!wasLoading)
                    {
                        loading = false;
                        rbTzSet.Checked = true;
                        ProfileEdited();
                    }
                }
            }
            finally { loading = wasLoading; }
            UpdateTimePreview();
        }

        void LoadTimeZone(Profile p)
        {
            FillZoneCombo(p.TimeZoneId);
            rbTzKeep.Checked = p.TimeZoneId.Length == 0;
            rbTzSet.Checked = p.TimeZoneId.Length > 0;
            if (p.TimeZoneId.Length > 0 && !allZones.Any(z => z.Id == p.TimeZoneId))
                m.Log(LogLevel.Warn, "方案「" + p.Name + "」里的时区在这台电脑上不存在：" + p.TimeZoneId);
            UpdateTimePreview();
        }

        void SaveTimeZone(Profile p)
        {
            var id = SelectedZoneId();
            p.TimeZoneId = rbTzSet.Checked && id != null ? id : (rbTzSet.Checked ? p.TimeZoneId : "");
        }

        static string FormatTime(DateTime t) =>
            t.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + WeekDays[(int)t.DayOfWeek];

        void UpdateTimePreview()
        {
            if (tzPreview == null) return;
            var utc = DateTime.UtcNow;
            TimeZoneEntry zone = rbTzSet.Checked ? tzCombo.SelectedItem as TimeZoneEntry : null;
            if (zone == null)
            {
                tzPreview.Text = FormatTime(DateTime.Now) + "（系统时区）";
                return;
            }
            tzPreview.Text = FormatTime(zone.Now(utc)) + "（" + Fmt.Offset(zone.OffsetAt(utc)) + (zone.IsDst(utc) ? "，夏令时" : "") + "）";
        }

        void UpdateTimeZoneStatus()
        {
            if (tzSystemLabel == null) return;
            string sysId;
            try { sysId = P.GetSystemTimeZoneId(); }
            catch (Exception e) { tzSystemLabel.Text = "读取系统时区失败：" + e.Message; return; }
            tzSystemLabel.Text = "当前系统时区：" + m.TzName(sysId) + "（" + sysId + "）";
            var auto = P.AutoTimeZoneEnabled();
            tzAutoLabel.Text = auto == true
                ? "Windows 的“自动设置时区”是开着的：Windows 可能会自己把临时时区改回去。用时区功能的话，建议在“日期和时间”设置里关掉它。"
                : auto == false ? "Windows 的“自动设置时区”已关闭。" : "读不到“自动设置时区”的状态。";
            tzAutoLabel.ForeColor = auto == true ? Kit.WarnColor : Kit.MutedColor;
            tzOpenSettings.Visible = auto == true;
            var pending = m.S.PendingTz;
            tzPendingLabel.Text = pending == null
                ? "没有临时切换的时区。"
                : "系统时区现在是本工具临时设置的 " + m.TzName(pending.AppliedId) + "，原来是 " + m.TzName(pending.OriginalId) + "。";
            tzPendingLabel.ForeColor = pending == null ? Kit.MutedColor : Kit.WarnColor;
            tzRestoreNow.Visible = pending != null;
        }
    }
}
