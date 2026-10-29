using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace Zhiyu.Terminal {
    public sealed class TerminalView : FrameworkElement {
        public readonly Screen Screen = new Screen(100, 30);
        public Action<string> Send;
        public Action<int, int> Resized;
        public int RenderCount;
        double fontSize = 14, cellWidth, cellHeight;
        int selectionStart = -1, selectionEnd = -1;
        public readonly HistoryViewport Viewport = new HistoryViewport();
        public Action ViewportChanged;
        bool draggingScroll, cursorBlink = true, cursorPhase = true, autoFollow = true;
        string cursorStyle = "bar";
        Color background = Color.FromRgb(32, 32, 30);
        long cursorAt;
        public bool PaintEnabled = true;
        int offset { get { return Viewport.Offset; } }
        readonly Dictionary<string, FormattedText> glyphs = new Dictionary<string, FormattedText>();
        Typeface normal = new Typeface(new FontFamily("Cascadia Mono, Consolas"), FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);
        Typeface heavy = new Typeface(new FontFamily("Cascadia Mono, Consolas"), FontStyles.Normal, FontWeights.Bold, FontStretches.Normal);
        string[] palette = { "#242933", "#E98989", "#A6C69F", "#DBCA96", "#91B6E3", "#C4A9D8", "#8AC3C8", "#D7DDE7", "#697383", "#F5ABAB", "#B8DBAE", "#EFDEAE", "#ACCDF3", "#DAC1E9", "#A5DFDE", "#F4F6FA" };
        public void Appearance(string family, double size, string[] colors) {
            fontSize = System.Math.Max(11, System.Math.Min(22, size)); palette = colors;
            normal = new Typeface(new FontFamily(family), FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);
            heavy = new Typeface(new FontFamily(family), FontStyles.Normal, FontWeights.Bold, FontStretches.Normal);
            glyphs.Clear(); imeCaret = new Point(double.NaN, double.NaN); MeasureCells();
        }
        public void Surface(Color color) { background = color; InvalidateVisual(); }
        public void Behavior(bool blink, bool follow, int historyLimit, string style) {
            cursorBlink = blink; cursorPhase = true; cursorStyle = style == "block" || style == "underline" ? style : "bar";
            Screen.History.SetLimit(historyLimit); Viewport.Scroll(offset, Screen.History.Count);
            if (autoFollow != follow) { autoFollow = follow; Viewport.Lock(!follow); }
            NotifyViewport(); InvalidateVisual();
        }
        void NotifyViewport() { if (ViewportChanged != null) ViewportChanged(); }
        public void ScrollHistory(int lines) { if (Screen.Alternate) return; Viewport.Scroll(offset + lines, Screen.History.Count); selectionStart = selectionEnd = -1; NotifyViewport(); InvalidateVisual(); }
        public void ToggleScrollLock() { Viewport.Lock(!Viewport.Locked); NotifyViewport(); InvalidateVisual(); }
        public void Latest() { Viewport.Latest(); selectionStart = selectionEnd = -1; NotifyViewport(); InvalidateVisual(); }
        public void TickCursor() {
            if (!cursorBlink || !PaintEnabled || !IsKeyboardFocusWithin) return;
            long now = System.Diagnostics.Stopwatch.GetTimestamp();
            if (now - cursorAt < System.Diagnostics.Stopwatch.Frequency * 53 / 100) return;
            cursorAt = now; cursorPhase = !cursorPhase; InvalidateVisual();
        }
        public TerminalView() {
            Focusable = true; ClipToBounds = true; Cursor = Cursors.IBeam;
            // WPF 自绘控件没有文本存储，默认 TSF 上下文会把输入法候选框放到屏幕左上角；改由 IMM32 跟随光标定位。
            InputMethod.SetIsInputMethodSuspended(this, true);
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            Screen.Reply = s => { if (Send != null) Send(s); };
            SizeChanged += (s, e) => MeasureCells();
            TextInput += (s, e) => { if (!string.IsNullOrEmpty(e.Text)) { Input(e.Text); e.Handled = true; } };
            PreviewKeyDown += OnKey;
            GotKeyboardFocus += (s, e) => { cursorPhase = true; cursorAt = System.Diagnostics.Stopwatch.GetTimestamp(); ImeAttach(); InvalidateVisual(); };
            LostKeyboardFocus += (s, e) => { cursorPhase = true; ImeDetach(); InvalidateVisual(); };
            MouseLeftButtonDown += (s, e) => {
                Focus(); var point = e.GetPosition(this);
                draggingScroll = !Screen.Alternate && Screen.History.Count > 0 && point.X >= ActualWidth - 16;
                if (draggingScroll) DragScroll(point.Y); else selectionStart = selectionEnd = Index(point);
                CaptureMouse(); InvalidateVisual();
            };
            MouseMove += (s, e) => { if (IsMouseCaptured) { if (draggingScroll) DragScroll(e.GetPosition(this).Y); else { selectionEnd = Index(e.GetPosition(this)); if (selectionStart != selectionEnd) { Viewport.Lock(true); NotifyViewport(); } } InvalidateVisual(); } };
            MouseLeftButtonUp += (s, e) => { draggingScroll = false; ReleaseMouseCapture(); };
            MouseRightButtonUp += (s, e) => { if (selectionStart != selectionEnd) Copy(); else Paste(); };
            MouseWheel += (s, e) => { if ((Keyboard.Modifiers & ModifierKeys.Control) != 0) Zoom(e.Delta > 0 ? 1 : -1); else ScrollHistory(e.Delta > 0 ? 3 : -3); e.Handled = true; };
            MeasureCells();
        }
        public void Feed(string text) { long before = Screen.History.TotalAdded; Screen.Feed(text); if (Screen.Alternate) Viewport.Latest(); else Viewport.Output(Screen.History.TotalAdded - before, Screen.History.Count); NotifyViewport(); if (PaintEnabled) InvalidateVisual(); }
        public void Zoom(int delta) { fontSize = System.Math.Max(10, System.Math.Min(28, fontSize + delta)); glyphs.Clear(); MeasureCells(); }
        void MeasureCells() {
            var f = new FormattedText("M", CultureInfo.InvariantCulture, FlowDirection.LeftToRight, normal, fontSize, Brushes.White, VisualTreeHelper.GetDpi(this).PixelsPerDip);
            cellWidth = f.WidthIncludingTrailingWhitespace; cellHeight = System.Math.Ceiling(fontSize * 1.5);
            int cols = System.Math.Max(20, (int)((ActualWidth - 48) / cellWidth));
            int rows = System.Math.Max(4, (int)((ActualHeight - 24) / cellHeight));
            if (cols != Screen.Columns || rows != Screen.Rows) { long before = Screen.History.TotalAdded; Screen.Resize(cols, rows); selectionStart = selectionEnd = -1; int shifted = (int)(Screen.History.TotalAdded - before); Viewport.Scroll(offset > 0 || Viewport.Locked ? offset + shifted : offset, Screen.History.Count); if (Resized != null) Resized(Screen.Columns, Screen.Rows); NotifyViewport(); }
            InvalidateVisual();
        }
        int Index(Point p) { return System.Math.Max(0, System.Math.Min(Screen.Rows * Screen.Columns - 1, (int)((p.Y - 12) / cellHeight) * Screen.Columns + System.Math.Max(0, System.Math.Min(Screen.Columns - 1, (int)((p.X - 16) / cellWidth))))); }
        Cell[] Visible(int y) { int index = Screen.History.Count - offset + y; return index < Screen.History.Count ? Screen.History[System.Math.Max(0, index)] : Screen.Lines[System.Math.Min(Screen.Rows - 1, index - Screen.History.Count)]; }
        public void Copy() {
            var text = new StringBuilder();
            int start = System.Math.Min(selectionStart, selectionEnd), end = System.Math.Max(selectionStart, selectionEnd);
            if (start < 0 || start == end) return;
            for (int y = start / Screen.Columns; y <= end / Screen.Columns; y++) {
                var line = Visible(y); int from = y == start / Screen.Columns ? start % Screen.Columns : 0; int to = y == end / Screen.Columns ? end % Screen.Columns : line.Length - 1;
                for (int x = from; x <= to && x < line.Length; x++) text.Append(line[x].Text);
                if (y < end / Screen.Columns) text.AppendLine();
            }
            try { Clipboard.SetText(text.ToString()); } catch (ExternalException) { System.Media.SystemSounds.Beep.Play(); }
        }
        public void Paste() {
            try {
                if (!Clipboard.ContainsText()) return;
                string text = Clipboard.GetText().Replace("\r\n", "\n").Replace('\r', '\n');
                if (text.Length > 1000000) { MessageBox.Show("粘贴内容过大，请缩短后再试。", "知屿终端"); return; }
                if (text.Contains("\n") && MessageBox.Show("内容包含多行，粘贴后可能执行多条命令。继续粘贴？", "确认粘贴", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                text = text.Replace("\x1b", "");
                Input(Screen.BracketedPaste ? "\x1b[200~" + text + "\x1b[201~" : text.Replace('\n', '\r'));
            } catch (ExternalException) { System.Media.SystemSounds.Beep.Play(); }
        }
        public void Type(string value) { Input(value); }
        void Input(string value) { Latest(); cursorPhase = true; cursorAt = System.Diagnostics.Stopwatch.GetTimestamp(); if (Send != null) Send(value); InvalidateVisual(); }
        void OnKey(object sender, KeyEventArgs e) {
            var mods = Keyboard.Modifiers; Key key = e.Key == Key.System ? e.SystemKey : e.Key;
            bool ctrl = (mods & ModifierKeys.Control) != 0, shift = (mods & ModifierKeys.Shift) != 0;
            if (ctrl && shift && key == Key.C) { Copy(); e.Handled = true; return; }
            if (ctrl && shift && key == Key.V || shift && key == Key.Insert) { Paste(); e.Handled = true; return; }
            if (ctrl && (key == Key.OemPlus || key == Key.Add || key == Key.OemMinus || key == Key.Subtract)) { Zoom(key == Key.OemPlus || key == Key.Add ? 1 : -1); e.Handled = true; return; }
            if (shift && (key == Key.PageUp || key == Key.PageDown)) { ScrollHistory(key == Key.PageUp ? Screen.Rows - 1 : 1 - Screen.Rows); e.Handled = true; return; }
            if (ctrl && shift && key == Key.End) { Latest(); e.Handled = true; return; }
            string value = KeySequence(key, ctrl, shift, (mods & ModifierKeys.Alt) != 0, Screen.ApplicationCursor);
            if (value != null) { Input(value); e.Handled = true; }
        }
        public static string KeySequence(Key key, bool ctrl, bool shift, bool alt, bool app) {
            if (ctrl && key >= Key.A && key <= Key.Z) return ((char)(key - Key.A + 1)).ToString();
            if (ctrl && key == Key.Space) return "\0";
            if (ctrl && key == Key.OemOpenBrackets) return "\x1b";
            if (ctrl && key == Key.OemBackslash) return "\x1c";
            string suffix = null;
            if (key == Key.Up) suffix = "A"; if (key == Key.Down) suffix = "B";
            if (key == Key.Right) suffix = "C"; if (key == Key.Left) suffix = "D";
            if (key == Key.Home) suffix = "H"; if (key == Key.End) suffix = "F";
            if (suffix != null) { int mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0); return mod > 1 ? "\x1b[1;" + mod + suffix : "\x1b" + (app ? "O" : "[") + suffix; }
            string value = null;
            switch (key) {
                case Key.Enter: value = "\r"; break; case Key.Back: value = "\x7f"; break;
                case Key.Tab: value = shift ? "\x1b[Z" : "\t"; break; case Key.Escape: value = "\x1b"; break;
                case Key.Insert: value = "\x1b[2~"; break; case Key.Delete: value = "\x1b[3~"; break;
                case Key.PageUp: value = "\x1b[5~"; break; case Key.PageDown: value = "\x1b[6~"; break;
                case Key.F1: value = "\x1bOP"; break; case Key.F2: value = "\x1bOQ"; break; case Key.F3: value = "\x1bOR"; break; case Key.F4: value = "\x1bOS"; break;
                case Key.F5: value = "\x1b[15~"; break; case Key.F6: value = "\x1b[17~"; break; case Key.F7: value = "\x1b[18~"; break; case Key.F8: value = "\x1b[19~"; break;
                case Key.F9: value = "\x1b[20~"; break; case Key.F10: value = "\x1b[21~"; break; case Key.F11: value = "\x1b[23~"; break; case Key.F12: value = "\x1b[24~"; break;
            }
            return alt && value != null ? "\x1b" + value : value;
        }
        Brush ColorFor(int color) {
            if (color < 0) return Brushes.Transparent;
            if (color < 16) return (Brush)new BrushConverter().ConvertFromString(palette[color]);
            int r, g, b;
            if (color >= 0x1000000) { r = color >> 16 & 255; g = color >> 8 & 255; b = color & 255; }
            else if (color >= 232) r = g = b = 8 + (color - 232) * 10;
            else { int n = color - 16; int[] levels = { 0, 95, 135, 175, 215, 255 }; r = levels[n / 36]; g = levels[n / 6 % 6]; b = levels[n % 6]; }
            var brush = new SolidColorBrush(Color.FromRgb((byte)r, (byte)g, (byte)b)); brush.Freeze(); return brush;
        }
        protected override void OnRender(DrawingContext dc) {
            RenderCount++;
            dc.DrawRectangle(Brushes.Transparent, null, new Rect(RenderSize));
            Viewport.Scroll(offset, Screen.History.Count);
            for (int y = 0; y < Screen.Rows; y++) {
                var line = Visible(y);
                for (int x = 0; x < System.Math.Min(line.Length, Screen.Columns); x++) {
                    var cell = line[x]; var rect = new Rect(16 + x * cellWidth, 12 + y * cellHeight, cellWidth + 0.5, cellHeight);
                    if (cell.Background >= 0) dc.DrawRectangle(ColorFor(cell.Background), null, rect);
                    int index = y * Screen.Columns + x;
                    if (selectionStart != selectionEnd && index >= System.Math.Min(selectionStart, selectionEnd) && index <= System.Math.Max(selectionStart, selectionEnd)) dc.DrawRectangle(new SolidColorBrush(Color.FromArgb(95, 125, 160, 203)), null, rect);
                    if (cell.Text == " " || cell.Text == "") continue;
                    string cacheKey = cell.Text + ":" + cell.Foreground + ":" + cell.Bold;
                    FormattedText glyph;
                    if (!glyphs.TryGetValue(cacheKey, out glyph)) {
                        if (glyphs.Count > 4096) glyphs.Clear();
                        glyph = new FormattedText(cell.Text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, cell.Bold ? heavy : normal, fontSize, ColorFor(cell.Foreground), VisualTreeHelper.GetDpi(this).PixelsPerDip); glyphs[cacheKey] = glyph;
                    }
                    dc.DrawText(glyph, new Point(rect.X, rect.Y));
                }
            }
            if (offset == 0 && Screen.CursorVisible && (!cursorBlink || cursorPhase || !IsKeyboardFocusWithin)) DrawCursor(dc);
            if (!Screen.Alternate && Screen.History.Count > 0 && ActualHeight > 40) {
                var color = (Color)ColorConverter.ConvertFromString(palette[7]);
                dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromArgb(14, color.R, color.G, color.B)), null, new Rect(ActualWidth - 14, 8, 10, ActualHeight - 16), 4, 4);
                dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromArgb(90, color.R, color.G, color.B)), null, ScrollThumb(), 4, 4);
            }
            UpdateIme();
        }
        // 失去焦点时光标变暗或描边，便于判断键盘输入是否会进入终端。
        void DrawCursor(DrawingContext dc) {
            bool focused = IsKeyboardFocusWithin;
            var color = (Color)ColorConverter.ConvertFromString(palette[7]);
            var brush = new SolidColorBrush(focused ? color : Color.FromArgb(120, color.R, color.G, color.B)); brush.Freeze();
            var line = Screen.Lines[Screen.Y]; int x = System.Math.Min(Screen.X, line.Length - 1);
            bool wide = x + 1 < line.Length && line[x + 1].Text == "";
            var cell = new Rect(16 + Screen.X * cellWidth, 12 + Screen.Y * cellHeight, cellWidth * (wide ? 2 : 1), cellHeight);
            if (cursorStyle == "underline") { dc.DrawRectangle(brush, null, new Rect(cell.X, cell.Bottom - 3, cell.Width, 2)); return; }
            if (cursorStyle == "bar") { dc.DrawRectangle(brush, null, new Rect(cell.X, cell.Y + 2, 2, cell.Height - 4)); return; }
            if (!focused) { var pen = new Pen(brush, 1); pen.Freeze(); dc.DrawRectangle(null, pen, new Rect(cell.X + 0.5, cell.Y + 0.5, cell.Width - 1, cell.Height - 1)); return; }
            dc.DrawRectangle(brush, null, cell);
            string text = line[x].Text;
            if (text != " " && text != "") {
                var inverse = new SolidColorBrush(background); inverse.Freeze();
                dc.DrawText(new FormattedText(text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, line[x].Bold ? heavy : normal, fontSize, inverse, VisualTreeHelper.GetDpi(this).PixelsPerDip), cell.TopLeft);
            }
        }
        [StructLayout(LayoutKind.Sequential)] struct ImePoint { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct ImeRect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct CompositionForm { public int Style; public ImePoint Position; public ImeRect Area; }
        [StructLayout(LayoutKind.Sequential)] struct CandidateForm { public int Index, Style; public ImePoint Position; public ImeRect Area; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct LogFont {
            public int Height, Width, Escapement, Orientation, Weight;
            public byte Italic, Underline, StrikeOut, Charset, OutPrecision, ClipPrecision, Quality, PitchAndFamily;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FaceName;
        }
        [ComImport, Guid("aa80e801-2021-11d2-93e0-0060b067b86e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface ITfThreadMgr { void Activate(out int clientId); void Deactivate(); void CreateDocumentMgr(out IntPtr manager); void EnumDocumentMgrs(out IntPtr managers); void GetFocus(out IntPtr manager); void SetFocus(IntPtr manager); }
        [DllImport("msctf.dll")] static extern int TF_CreateThreadMgr(out ITfThreadMgr manager);
        [DllImport("imm32.dll")] static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hwnd);
        [DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr hwnd);
        [DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr hwnd, IntPtr context);
        [DllImport("imm32.dll")] static extern IntPtr ImmAssociateContext(IntPtr hwnd, IntPtr context);
        [DllImport("imm32.dll")] static extern bool ImmSetCompositionWindow(IntPtr context, ref CompositionForm form);
        [DllImport("imm32.dll")] static extern bool ImmSetCandidateWindow(IntPtr context, ref CandidateForm form);
        [DllImport("imm32.dll", EntryPoint = "ImmSetCompositionFontW", CharSet = CharSet.Unicode)] static extern bool ImmSetCompositionFont(IntPtr context, ref LogFont font);
        static ITfThreadMgr textServices; static bool textServicesLoaded;
        HwndSource imeSource; IntPtr imeWindow, imeContext, imePrevious;
        Point imeCaret = new Point(double.NaN, double.NaN);
        public bool ImeAnchored { get { return imeSource != null && imeContext != IntPtr.Zero; } }
        public void ActivateIme() { if (IsKeyboardFocused) ImeAttach(); }
        void ImeAttach() {
            ImeDetach();
            imeSource = PresentationSource.FromVisual(this) as HwndSource;
            if (imeSource == null) return;
            try {
                imeWindow = ImmGetDefaultIMEWnd(IntPtr.Zero); imeContext = ImmGetContext(imeWindow);
                imePrevious = ImmAssociateContext(imeSource.Handle, imeContext);
                imeSource.AddHook(ImeHook);
                // 让 TSF 输入法退回线程默认上下文，才会读取下面设置的 IMM32 组合窗口位置。
                if (!textServicesLoaded) { textServicesLoaded = true; TF_CreateThreadMgr(out textServices); }
                if (textServices != null) textServices.SetFocus(IntPtr.Zero);
            } catch (Exception) { }
            imeCaret = new Point(double.NaN, double.NaN); UpdateIme();
        }
        void ImeDetach() {
            if (imeSource == null) return;
            try {
                imeSource.RemoveHook(ImeHook);
                if (!imeSource.IsDisposed) ImmAssociateContext(imeSource.Handle, imePrevious);
                if (imeContext != IntPtr.Zero) ImmReleaseContext(imeWindow, imeContext);
            } catch (Exception) { }
            imeSource = null; imeContext = imePrevious = IntPtr.Zero;
        }
        IntPtr ImeHook(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled) {
            if (message == 0x51) Dispatcher.BeginInvoke(new Action(ActivateIme), DispatcherPriority.Input);
            else if (message == 0x10D || message == 0x10F) { imeCaret = new Point(double.NaN, double.NaN); UpdateIme(); }
            return IntPtr.Zero;
        }
        void UpdateIme() {
            if (imeSource == null || imeContext == IntPtr.Zero || imeSource.IsDisposed || imeSource.RootVisual == null) return;
            var local = new Point(16 + Screen.X * cellWidth, 12 + Screen.Y * cellHeight);
            if (local == imeCaret) return;
            imeCaret = local;
            try {
                var device = imeSource.CompositionTarget.TransformToDevice; var root = TransformToAncestor(imeSource.RootVisual);
                Point top = device.Transform(root.Transform(local)), bottom = device.Transform(root.Transform(new Point(local.X + cellWidth, local.Y + cellHeight)));
                var form = new CompositionForm { Style = 0x0020, Position = new ImePoint { X = (int)top.X, Y = (int)top.Y } };
                ImmSetCompositionWindow(imeContext, ref form);
                var candidate = new CandidateForm { Style = 0x0080, Position = new ImePoint { X = (int)top.X, Y = (int)bottom.Y }, Area = new ImeRect { Left = (int)top.X, Top = (int)top.Y, Right = (int)bottom.X, Bottom = (int)bottom.Y } };
                ImmSetCandidateWindow(imeContext, ref candidate);
                var font = new LogFont { Height = -(int)System.Math.Round(fontSize * device.M22), Weight = 400, Charset = 1, FaceName = normal.FontFamily.Source.Split(',')[0].Trim() };
                ImmSetCompositionFont(imeContext, ref font);
            } catch (InvalidOperationException) { }
        }
        Rect ScrollThumb() { double track = System.Math.Max(24, ActualHeight - 16); double height = System.Math.Min(track, System.Math.Max(24, track * Screen.Rows / (Screen.History.Count + Screen.Rows))); return new Rect(ActualWidth - 13, 8 + (track - height) * (Screen.History.Count - offset) / System.Math.Max(1, Screen.History.Count), 8, height); }
        void DragScroll(double y) { var thumb = ScrollThumb(); double distance = System.Math.Max(1, ActualHeight - 16 - thumb.Height); double ratio = System.Math.Max(0, System.Math.Min(1, (y - 8 - thumb.Height / 2) / distance)); Viewport.Scroll(Screen.History.Count - (int)(ratio * Screen.History.Count), Screen.History.Count); selectionStart = selectionEnd = -1; NotifyViewport(); InvalidateVisual(); }
    }
    public sealed class TerminalWindow : Window {
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        readonly TerminalView terminal = new TerminalView();
        readonly TextBlock status = new TextBlock(), destination = new TextBlock(), dimensions = new TextBlock();
        readonly Button reconnect;
        readonly Border frame;
        readonly IntPtr parentHandle;
        HwndSource embeddedSource;
        IntPtr Handle { get { return embeddedSource == null ? new WindowInteropHelper(this).Handle : embeddedSource.Handle; } }
        bool connected, ready, demo;
        bool viewportDirty;
        readonly Queue<Dictionary<string, object>> incoming = new Queue<Dictionary<string, object>>();
        readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [StructLayout(LayoutKind.Sequential)] struct Margins { public int Left, Right, Top, Bottom; }
        [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hwnd);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr process);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint source, uint target, bool attach);
        void FocusTerminal() {
            if (parentHandle != IntPtr.Zero) SetForegroundWindow(parentHandle);
            uint current = GetCurrentThreadId(), parent = GetWindowThreadProcessId(parentHandle, IntPtr.Zero);
            bool attached = parent != 0 && parent != current && AttachThreadInput(current, parent, true);
            try { SetFocus(Handle); terminal.Focus(); Keyboard.Focus(terminal); terminal.ActivateIme(); }
            finally { if (attached) AttachThreadInput(current, parent, false); }
        }
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        public TerminalWindow(bool preview) : this(preview, IntPtr.Zero) { }
        public TerminalWindow(bool preview, IntPtr parent) {
            parentHandle = parent;
            demo = preview; Title = "知屿 · 原生终端"; Width = 1100; Height = 720; MinWidth = 600; MinHeight = 360;
            WindowStartupLocation = WindowStartupLocation.CenterScreen; Background = Brush("#151A22"); Foreground = Brush("#D7DDE7"); FontFamily = new FontFamily("Segoe UI"); FontSize = 12;
            var grid = new Grid(); grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(76) }); grid.RowDefinitions.Add(new RowDefinition()); grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(34) }); Content = grid;
            var header = new DockPanel { Margin = new Thickness(24, 16, 20, 12) };
            var actions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            reconnect = Button("重新连接", () => { if (connected && MessageBox.Show("重新连接会结束当前会话，继续？", "知屿终端", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return; Start(); });
            actions.Children.Add(Button("复制", () => terminal.Copy())); actions.Children.Add(Button("粘贴", () => terminal.Paste())); actions.Children.Add(reconnect); DockPanel.SetDock(actions, Dock.Right); header.Children.Add(actions);
            var labels = new StackPanel(); labels.Children.Add(new TextBlock { Text = "知屿  /  SSH 工作台", FontSize = 15, FontWeight = FontWeights.SemiBold }); destination.Margin = new Thickness(0, 6, 0, 0); destination.Foreground = Brush("#98A5B7"); destination.Text = "正在准备安全连接…"; destination.TextTrimming = TextTrimming.CharacterEllipsis; labels.Children.Add(destination); header.Children.Add(labels); grid.Children.Add(header);
            frame = new Border { Margin = new Thickness(12, 0, 12, 0), Background = Brush("#0E1219"), BorderBrush = Brush("#2A3341"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Child = terminal }; Grid.SetRow(frame, 1); grid.Children.Add(frame);
            var footer = new DockPanel { Margin = new Thickness(24, 0, 24, 0), LastChildFill = true };
            dimensions.VerticalAlignment = VerticalAlignment.Center; dimensions.Foreground = Brush("#98A5B7"); DockPanel.SetDock(dimensions, Dock.Right); footer.Children.Add(dimensions);
            status.VerticalAlignment = VerticalAlignment.Center; status.Foreground = Brush("#A6C69F"); status.Text = "准备就绪"; status.MaxWidth = 300; status.TextTrimming = TextTrimming.CharacterEllipsis; footer.Children.Add(status);
            var help = new TextBlock { Text = "Ctrl+Shift+C / V  复制粘贴    ·    Ctrl+滚轮  字号    ·    滚轮  历史", Foreground = Brush("#98A5B7"), VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis }; footer.Children.Add(help); Grid.SetRow(footer, 2); grid.Children.Add(footer);
            terminal.Send = text => { if (connected) Write(new { type = "input", data = text }); };
            terminal.ViewportChanged = () => viewportDirty = true;
            terminal.Resized = (cols, rows) => { dimensions.Text = cols + " × " + rows; if (ready) Write(new { type = "resize", cols, rows }); };
            if (parentHandle != IntPtr.Zero) {
                WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize; ShowInTaskbar = false; ShowActivated = false;
                MinWidth = MinHeight = 1; Width = Height = 1; Left = Top = 0; WindowStartupLocation = WindowStartupLocation.Manual;
                header.Visibility = footer.Visibility = Visibility.Collapsed;
                grid.RowDefinitions[0].Height = grid.RowDefinitions[2].Height = new GridLength(0);
                frame.Margin = new Thickness(0); frame.BorderThickness = new Thickness(0); frame.CornerRadius = new CornerRadius(0);
            }
            SourceInitialized += (s, e) => {
                int dark = 1, mica = 2; IntPtr handle = new WindowInteropHelper(this).Handle;
                if (parentHandle != IntPtr.Zero) {
                    long style = GetWindowLongPtr(handle, -16).ToInt64();
                    SetWindowLongPtr(handle, -16, new IntPtr((style & ~0x80CF0000L) | 0x46000000L));
                    SetParent(handle, parentHandle);
                    if (GetParent(handle) != parentHandle) throw new InvalidOperationException("原生终端无法嵌入主窗口。");
                    SetWindowPos(handle, IntPtr.Zero, 0, 0, 1, 1, 0x0030);
                    Dispatcher.BeginInvoke(new Action(InitializeTransport), DispatcherPriority.ApplicationIdle);
                    return;
                }
                try {
                    DwmSetWindowAttribute(handle, 20, ref dark, 4);
                    if (DwmSetWindowAttribute(handle, 38, ref mica, 4) == 0) {
                        var margins = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 };
                        DwmExtendFrameIntoClientArea(handle, ref margins);
                        HwndSource.FromHwnd(handle).CompositionTarget.BackgroundColor = Colors.Transparent;
                        Background = Brush("#D9151A22");
                    }
                } catch (DllNotFoundException) { }
            };
            Loaded += (s, e) => InitializeTransport();
            Closed += (s, e) => { timer.Stop(); if (!demo) Write(new { type = "close" }); };
        }
        public void Attach() {
            // 从创建时就是子控件，避免顶层 Window 的可见性及合成规则覆盖嵌入布局。
            long parentStyle = GetWindowLongPtr(parentHandle, -16).ToInt64();
            SetWindowLongPtr(parentHandle, -16, new IntPtr(parentStyle | 0x02000000L));
            SetWindowPos(parentHandle, IntPtr.Zero, 0, 0, 0, 0, 0x0037);
            var root = (Visual)Content; Content = null;
            var parameters = new HwndSourceParameters("Zhiyu.EmbeddedTerminal") {
                ParentWindow = parentHandle, WindowStyle = 0x56000000, TreatAsInputRoot = true,
                PositionX = 0, PositionY = 0, Width = 1, Height = 1,
            };
            embeddedSource = new HwndSource(parameters);
            embeddedSource.CompositionTarget.BackgroundColor = Color.FromRgb(32, 32, 30);
            embeddedSource.RootVisual = root;
            embeddedSource.AddHook((IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled) => {
                if (message == 0x201) FocusTerminal();
                if (message == 0x202) Dispatcher.BeginInvoke(new Action(FocusTerminal), DispatcherPriority.Input);
                return IntPtr.Zero;
            });
            terminal.PreviewMouseDown += (s, e) => FocusTerminal();
            if (GetParent(Handle) != parentHandle) throw new InvalidOperationException("无法创建内嵌终端控件。");
            Dispatcher.BeginInvoke(new Action(InitializeTransport), DispatcherPriority.ApplicationIdle);
        }
        void CloseHost() {
            if (embeddedSource != null) { timer.Stop(); embeddedSource.Dispose(); embeddedSource = null; Application.Current.Shutdown(); }
            else Close();
        }
        void InitializeTransport() {
            if (ready) return;
            if (parentHandle == IntPtr.Zero) terminal.Focus(); ready = true;
            dimensions.Text = terminal.Screen.Columns + " × " + terminal.Screen.Rows;
            if (demo) Preview();
            else { timer.Tick += Drain; timer.Start(); Read(); Write(new { type = "ready", cols = terminal.Screen.Columns, rows = terminal.Screen.Rows, embedded = parentHandle != IntPtr.Zero, parentHandle = GetParent(Handle).ToInt64().ToString(), childHandle = Handle.ToInt64().ToString() }); }
        }
        static Brush Brush(string hex) { return (Brush)new BrushConverter().ConvertFromString(hex); }
        Button Button(string label, Action action) {
            var button = new Button { Content = label, Background = Brush("#242D3A"), Foreground = Brush("#D7DDE7"), BorderBrush = Brush("#354154"), BorderThickness = new Thickness(1), Padding = new Thickness(12, 7, 12, 7), Margin = new Thickness(8, 0, 0, 0), Cursor = Cursors.Hand, Focusable = false };
            button.Click += (s, e) => { action(); terminal.Focus(); }; return button;
        }
        void Start() { if (demo) { Preview(); return; } connected = false; reconnect.IsEnabled = false; status.Text = "●  正在连接…"; Write(new { type = "reconnect", cols = terminal.Screen.Columns, rows = terminal.Screen.Rows }); }
        void Write(object value) { try { Console.Out.WriteLine(json.Serialize(value)); Console.Out.Flush(); } catch (IOException) { CloseHost(); } }
        async void Read() {
            try {
                await Task.Run(() => {
                    var parser = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
                    string line;
                    while ((line = Console.In.ReadLine()) != null) {
                        var message = parser.Deserialize<Dictionary<string, object>>(line);
                        lock (incoming) { while (incoming.Count > 512) System.Threading.Monitor.Wait(incoming); incoming.Enqueue(message); }
                    }
                });
                CloseHost();
            } catch (Exception ex) { status.Text = "数据通道已断开：" + ex.Message; connected = false; reconnect.IsEnabled = false; }
        }
        void Drain(object sender, EventArgs args) {
            // 每帧合并多个输出分块，避免每个网络包触发布局和重绘。
            var batch = new List<Dictionary<string, object>>();
            lock (incoming) {
                int characters = 0;
                for (int i = 0; i < 128 && incoming.Count > 0; i++) {
                    object value; var next = incoming.Peek();
                    int length = next.TryGetValue("data", out value) && value is string ? ((string)value).Length : 0;
                    if (batch.Count > 0 && characters + length > 65536) break;
                    batch.Add(incoming.Dequeue()); characters += length;
                    if (characters >= 65536) break;
                }
                System.Threading.Monitor.PulseAll(incoming);
            }
            foreach (var message in batch) {
                string type = Convert.ToString(message["type"]);
                if (type == "data") terminal.Feed(Convert.ToString(message["data"]));
                else if (type == "init") { destination.Text = Convert.ToString(message["label"]); Title = destination.Text + " · 知屿终端"; status.Text = "●  正在连接…"; reconnect.IsEnabled = false; }
                else if (type == "focus") { if (parentHandle == IntPtr.Zero) { if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Activate(); SetForegroundWindow(new WindowInteropHelper(this).Handle); } FocusTerminal(); }
                else if (type == "bounds" && parentHandle != IntPtr.Zero) {
                    var handle = Handle;
                    bool visible = Convert.ToBoolean(message["visible"]);
                    terminal.PaintEnabled = visible;
                    if (visible) {
                        int width = System.Math.Max(1, Convert.ToInt32(message["width"])), height = System.Math.Max(1, Convert.ToInt32(message["height"]));
                        // 网页端把控件内缩在圆角卡片里，保持矩形即可；固定半径裁剪在高 DPI 下会切掉卡片的圆角边框。
                        SetWindowPos(handle, IntPtr.Zero, Convert.ToInt32(message["x"]), Convert.ToInt32(message["y"]), width, height, 0x0010);
                    }
                    ShowWindow(handle, visible ? 8 : 0);
                    if (visible) terminal.InvalidateVisual();
                    if (embeddedSource != null) ((UIElement)embeddedSource.RootVisual).UpdateLayout();
                    Write(new { type = "layout", embedded = true, visible, width = (int)terminal.ActualWidth, height = (int)terminal.ActualHeight, nativeVisible = IsWindowVisible(handle), renderCount = terminal.RenderCount, textLength = terminal.Screen.Text().Trim().Length });
                }
                else if (type == "appearance") {
                    string background = Convert.ToString(message["background"]);
                    Background = frame.Background = Brush(background);
                    var surface = (Color)ColorConverter.ConvertFromString(background); terminal.Surface(surface);
                    if (embeddedSource != null) embeddedSource.CompositionTarget.BackgroundColor = surface;
                    var colors = ((System.Collections.IEnumerable)message["colors"]).Cast<object>().Select(Convert.ToString).ToArray();
                    terminal.Appearance(Convert.ToString(message["fontFamily"]), Convert.ToDouble(message["fontSize"]), colors);
                    string cursorStyle = message.ContainsKey("cursorStyle") ? Convert.ToString(message["cursorStyle"]) : "bar";
                    terminal.Behavior(message.ContainsKey("cursorBlink") && Convert.ToBoolean(message["cursorBlink"]), !message.ContainsKey("autoFollow") || Convert.ToBoolean(message["autoFollow"]), message.ContainsKey("scrollback") ? Convert.ToInt32(message["scrollback"]) : 5000, cursorStyle);
                    Write(new { type = "appearance", background, foreground = Convert.ToString(message["foreground"]), fontFamily = Convert.ToString(message["fontFamily"]), fontSize = Convert.ToDouble(message["fontSize"]), cursorStyle, cursorBlink = message.ContainsKey("cursorBlink") && Convert.ToBoolean(message["cursorBlink"]), autoFollow = !message.ContainsKey("autoFollow") || Convert.ToBoolean(message["autoFollow"]), scrollback = message.ContainsKey("scrollback") ? Convert.ToInt32(message["scrollback"]) : 5000 });
                }
                else if (type == "copy") terminal.Copy();
                else if (type == "input") { if (connected) terminal.Type(Convert.ToString(message["data"])); }
                else if (type == "paste") terminal.Paste();
                else if (type == "latest") terminal.Latest();
                else if (type == "scroll-lock") terminal.ToggleScrollLock();
                else if (type == "reconnect") Start();
                else if (type == "preview") Preview();
                else if (type == "status") {
                    string value = Convert.ToString(message["value"]); connected = value == "open"; reconnect.IsEnabled = true;
                    status.Text = connected ? "●  已连接  ·  握手 " + (message.ContainsKey("elapsedMs") ? Convert.ToString(message["elapsedMs"]) : "—") + " ms" : "●  " + Convert.ToString(message["message"]);
                    status.ToolTip = status.Text;
                    status.Foreground = Brush(connected ? "#A6C69F" : "#E98989");
                }
            }
            terminal.TickCursor();
            if (viewportDirty) {
                viewportDirty = false;
                Write(new { type = "viewport", locked = terminal.Viewport.Locked, atBottom = terminal.Viewport.Offset == 0, unread = terminal.Viewport.Unread, history = terminal.Screen.History.Count, offset = terminal.Viewport.Offset });
            }
        }
        void Preview() {
            destination.Text = "界面预览 · 未连接服务器"; status.Text = "●  原生 C# / WPF  ·  界面预览"; reconnect.Content = "刷新预览";
            terminal.Feed("\x1b[2J\x1b[H\x1b[90m~/workspace  $ cat deployment.ts\x1b[0m\r\n\r\n");
            terminal.Feed("\x1b[90m// 部署配置示例\x1b[0m\r\n");
            terminal.Feed("\x1b[35mconst\x1b[0m service = {\r\n  name: \x1b[32m\"zhiyu-api\"\x1b[0m,\r\n  port: \x1b[33m8080\x1b[0m,\r\n  healthy: \x1b[35mtrue\x1b[0m,\r\n};\r\n\r\n\x1b[35mawait\x1b[0m \x1b[34mdeploy\x1b[0m(service);\r\n\r\n");
            terminal.Feed("\x1b[90m// 此处只预览外观，不执行命令或连接服务器。\x1b[0m\r\n");
        }
    }
    public static class Program {
        [STAThread] public static void Main(string[] args) {
            // GUI 子系统没有控制台代码页，直接包装继承的匿名管道，不能设置 Console.InputEncoding。
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
            int embed = Array.IndexOf(args, "--embed"); long parent = 0;
            if (embed >= 0 && (embed + 1 >= args.Length || !long.TryParse(args[embed + 1], out parent) || parent == 0)) throw new ArgumentException("主窗口句柄无效。");
            var app = new Application();
            var host = new TerminalWindow(args.Contains("--preview"), new IntPtr(parent));
            if (parent != 0) { app.ShutdownMode = ShutdownMode.OnExplicitShutdown; host.Attach(); app.Run(); }
            else app.Run(host);
        }
    }
}
