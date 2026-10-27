using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace ClaudeDesktopManager
{
    /// <summary>Small helpers so the windows can be laid out in code without fixed pixel positions.</summary>
    static class Kit
    {
        public static float Scale = 1f;
        public static Font Base, Bold, Big, Mono, Small;

        public static readonly Color OkColor = Color.FromArgb(0x1E, 0x7E, 0x34);
        public static readonly Color WarnColor = Color.FromArgb(0xA0, 0x5A, 0x00);
        public static readonly Color ErrColor = Color.FromArgb(0xC0, 0x24, 0x24);
        public static readonly Color MutedColor = Color.FromArgb(0x6A, 0x6A, 0x6A);
        public static readonly Color AccentColor = Color.FromArgb(0x1F, 0x5F, 0xBF);

        public static void Init()
        {
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) Scale = Math.Max(1f, g.DpiX / 96f);
            Base = SystemFonts.MessageBoxFont ?? new Font("Microsoft YaHei UI", 9f);
            Bold = new Font(Base, FontStyle.Bold);
            Big = new Font(Base.FontFamily, Base.Size * 1.35f, FontStyle.Bold);
            Small = new Font(Base.FontFamily, Base.Size * 0.92f);
            Mono = new Font(FontFamily.GenericMonospace, Base.Size);
            try
            {
                var consolas = new Font("Consolas", Base.Size);
                if (consolas.Name == "Consolas") Mono = consolas;
            }
            catch (Exception) { }
        }

        public static int S(int px) => (int)Math.Round(px * Scale);

        public static Label Label(string text, Color? color = null, Font font = null)
        {
            var l = new Label { Text = text, AutoSize = true, Margin = new Padding(S(3), S(6), S(3), S(3)) };
            if (color.HasValue) l.ForeColor = color.Value;
            if (font != null) l.Font = font;
            return l;
        }

        public static WrapLabel Note(string text, Color? color = null)
        {
            var l = new WrapLabel
            {
                Text = text,
                ForeColor = color ?? MutedColor,
                Margin = new Padding(S(3), S(2), S(3), S(4)),
                Anchor = AnchorStyles.Left | AnchorStyles.Top,
            };
            return l;
        }

        public static Button Button(string text, EventHandler click = null)
        {
            var b = new Button
            {
                Text = text,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Padding = new Padding(S(8), S(2), S(8), S(2)),
                Margin = new Padding(S(3)),
                UseVisualStyleBackColor = true,
            };
            if (click != null) b.Click += click;
            return b;
        }

        public static CheckBox Check(string text, bool value = false)
        {
            return new CheckBox { Text = text, AutoSize = true, Checked = value, Margin = new Padding(S(3), S(3), S(3), S(3)) };
        }

        public static RadioButton Radio(string text)
        {
            return new RadioButton { Text = text, AutoSize = true, Margin = new Padding(S(3), S(2), S(3), S(2)) };
        }

        public static TextBox Text(int width, string value = "")
        {
            return new TextBox { Width = S(width), Text = value, Margin = new Padding(S(3), S(3), S(3), S(3)) };
        }

        public static TextBox MultiLine(int height, bool readOnly, bool mono = false)
        {
            var t = new TextBox
            {
                Multiline = true,
                ReadOnly = readOnly,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Height = S(height),
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top,
                Margin = new Padding(S(3)),
            };
            if (mono) t.Font = Mono;
            if (readOnly) t.BackColor = SystemColors.Window;
            return t;
        }

        public static ComboBox Combo(int width, bool editable = false)
        {
            return new ComboBox
            {
                Width = S(width),
                DropDownStyle = editable ? ComboBoxStyle.DropDown : ComboBoxStyle.DropDownList,
                Margin = new Padding(S(3), S(3), S(3), S(3)),
            };
        }

        public static NumericUpDown Number(int min, int max, int value, int width = 70)
        {
            return new NumericUpDown { Minimum = min, Maximum = max, Value = Math.Max(min, Math.Min(max, value)), Width = S(width), Margin = new Padding(S(3), S(3), S(3), S(3)) };
        }

        /// <summary>
        /// Controls side by side. No wrapping: tab pages not shown yet are first laid out at a tiny
        /// width, and a wrapped row keeps that height on Windows. Every row fits the minimum window width.
        /// </summary>
        public static FlowLayoutPanel Row(params Control[] items)
        {
            var p = new FlowLayoutPanel
            {
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                WrapContents = false,
                FlowDirection = FlowDirection.LeftToRight,
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top,
                Margin = new Padding(0),
                Padding = new Padding(0),
            };
            p.Controls.AddRange(items.Where(c => c != null).ToArray());
            return p;
        }

        /// <summary>A vertical stack whose children stretch to its width.</summary>
        public static TableLayoutPanel Stack(params Control[] items)
        {
            var t = new TableLayoutPanel
            {
                ColumnCount = 1,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Dock = DockStyle.Fill,
                Margin = new Padding(0),
                Padding = new Padding(0),
            };
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            foreach (var c in items) Add(t, c);
            return t;
        }

        /// <summary>Appends a row; controls anchored Left|Right stretch to the width, others keep their size.</summary>
        public static void Add(TableLayoutPanel t, Control c)
        {
            if (c == null) return;
            t.RowCount++;
            t.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            t.Controls.Add(c, 0, t.RowCount - 1);
        }

        public static GroupBox Group(string title, params Control[] items)
        {
            var g = new GroupBox
            {
                Text = title,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top,
                Padding = new Padding(S(8), S(4), S(8), S(6)),
                Margin = new Padding(S(4), S(4), S(4), S(6)),
            };
            // Dock=Fill inside an auto-sizing GroupBox makes the box take all the height it is offered.
            var stack = Stack(items);
            stack.Dock = DockStyle.Top;
            g.Controls.Add(stack);
            return g;
        }

        /// <summary>Scrollable tab content made of stacked groups.</summary>
        public static Control Page(params Control[] groups)
        {
            var host = new Panel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(S(6)) };
            var stack = Stack(groups);
            stack.Dock = DockStyle.Top;
            host.Controls.Add(stack);
            return host;
        }

        public static ListView List(params (string title, int width)[] columns)
        {
            var lv = new ListView
            {
                View = View.Details,
                FullRowSelect = true,
                HideSelection = false,
                GridLines = false,
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top,
                Margin = new Padding(S(3)),
            };
            foreach (var c in columns) lv.Columns.Add(c.title, S(c.width));
            return lv;
        }

        public static string Ellipsis(string s, int max) => Fmt.Shorten(s, max);
    }

    /// <summary>Label that wraps to the width of its parent.</summary>
    sealed class WrapLabel : Label
    {
        public WrapLabel()
        {
            AutoSize = true;
        }

        protected override void OnParentChanged(EventArgs e)
        {
            base.OnParentChanged(e);
            if (Parent != null)
            {
                Parent.SizeChanged -= ParentResized;
                Parent.SizeChanged += ParentResized;
                Fit();
            }
        }

        void ParentResized(object sender, EventArgs e) => Fit();

        void Fit()
        {
            if (Parent == null) return;
            int w = Parent.ClientSize.Width - Parent.Padding.Horizontal - Margin.Horizontal - Kit.S(4);
            if (w > Kit.S(80) && MaximumSize.Width != w) MaximumSize = new Size(w, 0);
        }
    }
}
