using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Controls;
using System.Windows.Threading;
using System.Diagnostics;
using Microsoft.Win32;

internal sealed class FixtureHandler : HttpMessageHandler
{
    readonly byte[] bytes;
    internal FixtureHandler(byte[] bytes) { this.bytes = bytes; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new ByteArrayContent(bytes) });
    }
}
internal static class BootstrapperTests
{
    static int count;
    static void Check(bool value, string name) { if (!value) throw new Exception(name); count++; Console.WriteLine("PASS " + name); }
    [STAThread]
    public static int Main()
    {
        try {
            Check(Engine.ValidPath(@"D:\Apps\Zhiyu"), "标准安装路径");
            Check(Engine.ValidPath(@"E:\My Apps\知屿"), "含空格与中文的路径");
            var absentDrive = Enumerable.Range('A', 26).Select(c => ((char)c) + @":\").FirstOrDefault(d => !Directory.Exists(d));
            if (absentDrive != null) Check(!Engine.Writable(Path.Combine(absentDrive, "Zhiyu")), "磁盘断开时立即返回不可写，不循环查找父目录");
            foreach (var invalid in new[] { "", @"D:\", @"relative", @"D:\Apps\..", @"D:\Apps\CON", "D:\\bad\" /S", @"D:\bad?", @"D:\bad\", "D:\\bad\npath" }) Check(!Engine.ValidPath(invalid), "拒绝非法路径 " + invalid.Replace("\n", "\\n"));
            var args = Engine.Arguments(@"E:\My Apps\知屿", true, false, true);
            Check(args == @"/S /allusers --no-desktop-shortcut /ZH_STARTUP=1 /D=E:\My Apps\知屿", "NSIS 参数与目录顺序");
            Check(Engine.Arguments(@"D:\Apps\Zhiyu", false, true, false).Contains("/currentuser /ZH_STARTUP=0"), "当前用户与自启关闭");
            var bytes = Encoding.UTF8.GetBytes("synthetic installer bytes; never executed");
            var payload = new Payload { Url = "https://fixture.invalid/setup.exe", Size = bytes.Length };
            using (var client = new HttpClient(new FixtureHandler(bytes))) using (var stream = new MemoryStream()) {
                long reported = 0; Engine.Download(client, payload, stream, total => reported = total, CancellationToken.None).GetAwaiter().GetResult();
                Check(reported == bytes.Length && Engine.Hash(stream).Length == 64, "下载报告真实字节与 SHA256");
                payload.Sha256 = Engine.Hash(stream);
                Engine.Verify(stream, payload);
                Check(true, "接受正确长度和哈希");
                payload.Sha256 = new string('0', 64);
                bool badHash = false;
                try { Engine.Verify(stream, payload); } catch (InvalidDataException) { badHash = true; }
                Check(badHash, "拒绝同长度但哈希不同的载荷");
                payload.Size++;
                bool rejected = false;
                try { Engine.Download(client, payload, new MemoryStream(), total => {}, CancellationToken.None).GetAwaiter().GetResult(); } catch (InvalidDataException) { rejected = true; }
                Check(rejected, "拒绝与清单长度不一致的载荷");
            }
            var ui = new Application();
            new Installer(Payload.Read(), true).ShowWindow();
            var window = ui.Windows[0]; window.UpdateLayout();
            Check(window.FindName("Directory") != null && window.FindName("Start") != null, "原生 XAML 可加载与渲染");
            Check(window.ActualWidth > 800, "原生窗口布局");
            var bitmap = new RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(window);
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            Directory.CreateDirectory("screenshots/installer-preview");
            using (var output = File.Create("screenshots/installer-preview/native.png")) encoder.Save(output);
            ((CheckBox)window.FindName("Desktop")).IsChecked = false;
            ((CheckBox)window.FindName("Startup")).IsChecked = true;
            SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(window.Dispatcher));
            ((Button)window.FindName("Start")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            var frame = new DispatcherFrame(); var timer = new DispatcherTimer(); var deadline = DateTime.UtcNow.AddSeconds(12);
            timer.Interval = TimeSpan.FromMilliseconds(100);
            timer.Tick += delegate { if (((StackPanel)window.FindName("Done")).Visibility == Visibility.Visible || DateTime.UtcNow > deadline) frame.Continue = false; };
            timer.Start(); Dispatcher.PushFrame(frame); timer.Stop();
            Check(((StackPanel)window.FindName("Done")).Visibility == Visibility.Visible, "原生动画流程进入完成页");
            Check(((TextBlock)window.FindName("Summary")).Text.Contains("开机自启：开启") && ((TextBlock)window.FindName("Summary")).Text.Contains("桌面快捷方式：不创建"), "原生完成页保留安装偏好");
            var launch = (Button)window.FindName("Launch"); var finish = (Button)window.FindName("Finish");
            Check(Math.Abs(launch.ActualWidth - finish.ActualWidth) < 1, "完成页两个按钮共用宽度与居中轴线");
            bitmap = new RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(window);
            encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (var output = File.Create("screenshots/installer-preview/native-done.png")) encoder.Save(output);
            window.Close();
            if (Environment.GetEnvironmentVariable("ZHIYU_INSTALLER_REAL_TEST") == "1") RealInstall(Payload.Read());
            Console.WriteLine(count + " assertions passed"); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    static void RealInstall(Payload payload)
    {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true") throw new Exception("真实安装回归仅允许在一次性的 GitHub Actions Windows 环境运行。");
        Check(Engine.Existing(false) == null && Engine.Existing(true) == null, "真实安装回归环境没有已有知屿");
        var path = Path.Combine(Path.GetTempPath(), "ZhiyuFullInstallerTests-" + Guid.NewGuid().ToString("N"));
        var setup = Environment.GetEnvironmentVariable("ZHIYU_INSTALLER_TEST_PAYLOAD");
        using (var file = File.OpenRead(setup)) Engine.Verify(file, payload);
        using (var child = Process.Start(new ProcessStartInfo(setup, Engine.Arguments(path, false, false, true)) { UseShellExecute = false, CreateNoWindow = true })) {
            if (!child.WaitForExit(120000)) throw new Exception("真实安装超时。");
            Check(child.ExitCode == 0, "真实 NSIS 安装退出码");
        }
        try {
            Check(File.Exists(Path.Combine(path, "Zhiyu.exe")), "真实 NSIS 写入指定目录");
            Check(FileVersionInfo.GetVersionInfo(Path.Combine(path, "Zhiyu.exe")).ProductVersion.Split('+')[0] == payload.Version, "实际安装版本");
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) Check(key != null && (string)key.GetValue("Zhiyu") == "\"" + Path.Combine(path, "Zhiyu.exe") + "\"", "实际安装写入自启偏好");
            using (var child = Process.Start(new ProcessStartInfo(setup, Engine.Arguments(path, false, false, true).Replace(" /ZH_STARTUP=1", "")) { UseShellExecute = false, CreateNoWindow = true })) {
                if (!child.WaitForExit(120000)) throw new Exception("覆盖升级超时。");
                Check(child.ExitCode == 0, "离线覆盖升级成功");
            }
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) Check(key != null && key.GetValue("Zhiyu") != null, "离线覆盖升级保留自启偏好");
        } finally {
            var uninstall = Path.Combine(path, "Uninstall Zhiyu.exe");
            if (File.Exists(uninstall)) using (var child = Process.Start(new ProcessStartInfo(uninstall, "/S /currentuser") { UseShellExecute = false, CreateNoWindow = true })) child.WaitForExit(120000);
        }
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (File.Exists(Path.Combine(path, "Zhiyu.exe")) && DateTime.UtcNow < deadline) Thread.Sleep(200);
        Check(!File.Exists(Path.Combine(path, "Zhiyu.exe")), "真实卸载清理程序");
        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) Check(key == null || key.GetValue("Zhiyu") == null, "真实卸载移除本程序自启");
    }
}
