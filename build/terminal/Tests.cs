using System;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Runtime.InteropServices;
using Zhiyu.Terminal;

public static class TerminalTests {
    static int checks;
    static void Check(bool ok, string name) { if (!ok) throw new Exception("FAIL: " + name); checks++; }
    [StructLayout(LayoutKind.Sequential)] struct WindowRect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out WindowRect rect);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
    [STAThread] public static void Main(string[] args) {
        if (args.Length == 2 && args[0] == "--type-native") {
            SetProcessDPIAware(); WindowRect bounds;
            Check(GetWindowRect(new IntPtr(long.Parse(args[1])), out bounds), "输入目标有效");
            SetCursorPos(bounds.Left + 80, bounds.Top + 80);
            Console.WriteLine("hit=" + WindowFromPoint(new Point { X = bounds.Left + 80, Y = bounds.Top + 80 }) + " target=" + args[1] + " foreground=" + GetForegroundWindow());
            mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(200);
            keybd_event(0x58, 0, 0, UIntPtr.Zero); keybd_event(0x58, 0, 2, UIntPtr.Zero);
            System.Threading.Thread.Sleep(200);
            keybd_event(0x0D, 0, 0, UIntPtr.Zero); keybd_event(0x0D, 0, 2, UIntPtr.Zero);
            return;
        }
        if (args.Length == 2 && args[0] == "--check-highlight") {
            int green = 0, blue = 0;
            using (var picture = new System.Drawing.Bitmap(args[1])) {
                for (int y = picture.Height / 4; y < picture.Height * 4 / 5; y++) for (int x = picture.Width / 4; x < picture.Width * 4 / 5; x++) {
                    var color = picture.GetPixel(x, y);
                    if (color.G > color.R + 20 && color.G > color.B + 15) green++;
                    if (color.B > color.R + 25 && color.B > color.G + 15) blue++;
                }
            }
            Check(green > 30 && blue > 30, "实际窗口中必须看到原生代码高亮，不能只有网页底图");
            Console.WriteLine("PASS: native highlight visible"); return;
        }
        if (args.Length == 3 && (args[0] == "--capture" || args[0] == "--capture-screen")) {
            SetProcessDPIAware(); WindowRect rect;
            if (!GetWindowRect(new IntPtr(long.Parse(args[1])), out rect)) throw new Exception("截图窗口无效");
            using (var captureBitmap = new System.Drawing.Bitmap(rect.Right - rect.Left, rect.Bottom - rect.Top)) {
                using (var graphics = System.Drawing.Graphics.FromImage(captureBitmap)) {
                    if (args[0] == "--capture-screen") graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, captureBitmap.Size);
                    else {
                        var dc = graphics.GetHdc(); bool captured;
                        try { captured = PrintWindow(new IntPtr(long.Parse(args[1])), dc, 2); } finally { graphics.ReleaseHdc(dc); }
                        if (!captured) throw new Exception("窗口截图失败");
                    }
                }
                captureBitmap.Save(args[2], System.Drawing.Imaging.ImageFormat.Png);
            }
            return;
        }
        var screen = new Screen(20, 6);
        screen.Feed("hello\r\nworld");
        Check(screen.Lines[0][0].Text == "h" && screen.Lines[1][0].Text == "w", "换行输出");
        screen.Feed("\x1b[2;1H\x1b[31"); screen.Feed("mR\x1b[0m");
        Check(screen.Lines[1][0].Text == "R" && screen.Lines[1][0].Foreground == 1, "跨分块 ANSI 颜色与定位");
        screen.Feed("\x1b[2J\x1b[H中文😀");
        Check(screen.X == 6 && screen.Lines[0][1].Text == "" && screen.Lines[0][4].Text == "😀", "中文与 emoji 双宽");
        screen.Feed("\x1b[?1049h\x1b[Hvim"); screen.Resize(22, 8); screen.Feed("\x1b[?1049l");
        Check(screen.Lines[0][0].Text == "中" && screen.Lines.Length == 8 && screen.Lines[0].Length == 22, "备用屏幕缩放与恢复");
        string reply = null; screen.Reply = text => reply = text; screen.Feed("\x1b[3;4H\x1b[6n");
        Check(reply == "\x1b[3;4R", "光标位置响应");
        screen.Feed("\x1b[?2004h\x1b[?1h\x1b[?25l");
        Check(screen.BracketedPaste && screen.ApplicationCursor && !screen.CursorVisible, "终端私有模式");
        screen.Feed("\x1b[H\x1b[38;2;12;34;56mX");
        Check(screen.Lines[0][0].Foreground == (0x1000000 | 12 << 16 | 34 << 8 | 56), "真彩色");
        screen.Feed("\x1b]0;忽略远程标题\x1b\\Z");
        Check(screen.Lines[0][1].Text == "Z", "OSC 安全忽略");
        screen.Feed("\x1b[0m\x1b[2J\x1b[H1234567890123456789012X");
        Check(screen.Lines[1][0].Text == "X", "行尾自动换行");
        screen.Feed("\x1b[Habcdef\x1b[1;3H\x1b[2P");
        Check(screen.Lines[0][2].Text == "e", "删除字符");
        screen.Feed("\x1b[1;3H\x1b[2@Q");
        Check(screen.Lines[0][2].Text == "Q" && screen.Lines[0][4].Text == "e", "插入字符");
        screen.Feed("\x1b[2;4r\x1b[4;1Hbottom\n");
        Check(screen.Lines[2][0].Text == "b" && screen.History.Count == 0, "局部滚动区域");
        screen.Feed("\x1b[r\x1b[8;1H\n"); Check(screen.History.Count == 1, "主屏滚动历史");
        Check(TerminalView.KeySequence(Key.C, true, false, false, false) == "\x03", "Ctrl+C 中断");
        Check(TerminalView.KeySequence(Key.Up, false, false, false, true) == "\x1bOA", "应用光标键");
        Check(TerminalView.KeySequence(Key.Left, true, false, false, false) == "\x1b[1;5D", "Ctrl+方向键");
        var random = new Random(71);
        for (int i = 0; i < 3000; i++) {
            screen.Feed("\x1b[" + random.Next(10000) + ";" + random.Next(10000) + "H\x1b[" + random.Next(10000) + "P");
        }
        Check(screen.X >= 0 && screen.X < screen.Columns && screen.Y >= 0 && screen.Y < screen.Rows, "异常 ANSI 参数保持边界");
        var view = new TerminalView(); string input = null; view.Send = text => input = text;
        var ring = new ScrollbackBuffer(4);
        for (int i = 0; i < 9; i++) ring.Add(new[] { new Cell { Text = i.ToString() } });
        Check(ring.Count == 4 && ring[0][0].Text == "5" && ring[3][0].Text == "8", "环形缓冲保留最新行并按顺序读取");
        ring.SetLimit(6); ring.Add(new[] { new Cell { Text = "9" } });
        Check(ring.Count == 5 && ring[0][0].Text == "5", "扩容历史不丢失现有输出");
        ring.SetLimit(4); Check(ring.Count == 4 && ring[0][0].Text == "6", "缩小历史仅移除最旧输出");
        var viewport = new HistoryViewport(); viewport.Output(20, 20);
        Check(viewport.Offset == 0 && viewport.Unread == 0, "默认跟随最新输出");
        viewport.Scroll(10, 20); viewport.Output(5, 25);
        Check(viewport.Offset == 15 && viewport.Unread == 5, "读取历史时新输出不改变阅读锚点");
        viewport.Lock(true); viewport.Scroll(0, 25); viewport.Output(10, 35);
        Check(viewport.Offset == 10 && viewport.Locked, "在底部锁定后新输出不抢回视图");
        viewport.Latest(); Check(viewport.Offset == 0 && !viewport.Locked && viewport.Unread == 0, "回到最新恢复跟随并清零未读");
        var burst = new TerminalView(); burst.Screen.History.SetLimit(1000);
        burst.Feed(string.Concat(Enumerable.Range(0, 10000).Select(i => "L" + i.ToString("D5") + "\r\n")));
        Check(burst.Screen.History.Count == 1000 && burst.Screen.History.TotalAdded > 9000, "大量输出受历史上限约束");
        burst.ScrollHistory(100); string anchor = string.Concat(burst.Screen.History[burst.Screen.History.Count - burst.Viewport.Offset].Select(c => c.Text));
        burst.Feed("new1\r\nnew2\r\n");
        Check(string.Concat(burst.Screen.History[burst.Screen.History.Count - burst.Viewport.Offset].Select(c => c.Text)) == anchor, "环形缓冲已满时仍保留滚动阅读位置");
        burst.ToggleScrollLock(); burst.Latest(); Check(burst.Viewport.Offset == 0 && !burst.Viewport.Locked, "原生视图回到最新");
        var wheel = new MouseWheelEventArgs(Mouse.PrimaryDevice, 0, 120) { RoutedEvent = Mouse.MouseWheelEvent }; burst.RaiseEvent(wheel);
        Check(burst.Viewport.Offset == 3 && wheel.Handled, "鼠标滚轮读取历史，阻止外层页面滚动");
        var shrinking = new Screen(20, 6); shrinking.Feed("A0\r\nA1\r\nA2\r\nA3\r\nA4\r\nA5"); shrinking.Resize(20, 4);
        Check(shrinking.History.Count == 2 && shrinking.Y == 3 && shrinking.Lines[3][1].Text == "5", "增大字号或缩小窗口时保留当前提示行，被移出的旧行进入历史");
        view.RaiseEvent(new KeyEventArgs(Keyboard.PrimaryDevice, new FakeSource(), 0, Key.C) { RoutedEvent = Keyboard.PreviewKeyDownEvent });
        var composition = new TextComposition(InputManager.Current, view, "输入测试");
        view.RaiseEvent(new TextCompositionEventArgs(Keyboard.PrimaryDevice, composition) { RoutedEvent = TextCompositionManager.TextInputEvent });
        Check(input == "输入测试", "原生文本输入事件");
        view.Type("df -h"); Check(input == "df -h", "工具栏常用命令走原生输入路径");
        Check(InputMethod.GetIsInputMethodSuspended(view), "输入法由 IMM32 跟随光标定位，不使用左上角的默认 TSF 上下文");
        view.Behavior(true, true, 5000, "block"); view.Surface(Colors.White); view.Behavior(true, true, 5000, "unknown");
        var app = new Application(); var window = new TerminalWindow(true); window.Show();
        app.Dispatcher.Invoke(new Action(() => { }), System.Windows.Threading.DispatcherPriority.ApplicationIdle);
        window.UpdateLayout();
        var bitmap = new RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(window);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        Directory.CreateDirectory("screenshots"); using (var file = File.Create("screenshots/native-terminal.png")) encoder.Save(file);
        Check(window.ActualWidth >= 600, "真实 WPF 窗口布局与截图"); window.Close();
        Console.WriteLine("PASS: " + checks + " native terminal checks");
    }
    sealed class FakeSource : PresentationSource {
        public override Visual RootVisual { get; set; }
        public override bool IsDisposed { get { return false; } }
        protected override CompositionTarget GetCompositionTargetCore() { return null; }
    }
}
