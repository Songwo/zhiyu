using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

internal sealed class Payload
{
    public string Version, Url, Sha256;
    public long Size;
    public static Payload Read()
    {
        using (var reader = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream("payload")))
        {
            var lines = reader.ReadToEnd().Trim().Split('\n').Select(s => s.Trim()).ToArray();
            var result = new Payload { Version = lines[0], Url = lines[1], Sha256 = lines[2], Size = long.Parse(lines[3]) };
            if (!Regex.IsMatch(result.Version, @"^\d+\.\d+\.\d+$") ||
                result.Url != "https://github.com/Songwo/zhiyu/releases/download/v" + result.Version + "/Zhiyu-" + result.Version + "-setup.exe" ||
                !Regex.IsMatch(result.Sha256, "^[a-f0-9]{64}$") || result.Size < 1 || result.Size > 1024L * 1024 * 1024)
                throw new InvalidDataException("安装文件清单无效。");
            return result;
        }
    }
}

internal static class Engine
{
    internal static bool ValidPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Regex.IsMatch(path, @"^[a-zA-Z]:\\[^<>:""/|?*]+$") || path.Any(c => c < 32)) return false;
        var parts = path.Substring(3).Split('\\');
        return parts.All(p => p.Length > 0 && p != "." && p != ".." && !p.EndsWith(".") && !p.EndsWith(" ") && !Regex.IsMatch(p, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", RegexOptions.IgnoreCase));
    }
    internal static string Arguments(string path, bool all, bool desktop, bool startup)
    {
        if (!ValidPath(path)) throw new ArgumentException("安装目录格式无效。");
        // NSIS 的 /D 必须最后出现，不加引号；拒绝路径里的引号、斜杠与控制字符。
        return "/S " + (all ? "/allusers" : "/currentuser") + (desktop ? "" : " --no-desktop-shortcut") + " /ZH_STARTUP=" + (startup ? "1" : "0") + " /D=" + path;
    }
    internal static string Hash(Stream stream)
    {
        stream.Position = 0;
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    internal static void Verify(Stream stream, Payload payload)
    {
        if (stream.Length != payload.Size || Hash(stream) != payload.Sha256) throw new InvalidDataException("文件校验失败，已拒绝执行。请重新下载。");
    }
    internal static async Task Download(HttpClient client, Payload payload, Stream output, Action<long> report, CancellationToken token)
    {
        using (var response = await client.GetAsync(payload.Url, HttpCompletionOption.ResponseHeadersRead, token))
        {
            response.EnsureSuccessStatusCode();
            if (response.RequestMessage.RequestUri.Scheme != "https") throw new InvalidDataException("拒绝不安全的下载连接。");
            var length = response.Content.Headers.ContentLength;
            if (length.HasValue && length.Value != payload.Size) throw new InvalidDataException("下载大小与发布清单不一致。");
            using (var input = await response.Content.ReadAsStreamAsync())
            {
                var buffer = new byte[65536];
                long total = 0;
                int count;
                while ((count = await input.ReadAsync(buffer, 0, buffer.Length, token)) != 0)
                {
                    total += count;
                    if (total > payload.Size) throw new InvalidDataException("下载文件超过预期大小。");
                    await output.WriteAsync(buffer, 0, count, token);
                    report(total);
                }
                if (total != payload.Size) throw new InvalidDataException("下载尚未完成，请重试。");
            }
        }
    }
    internal static string Existing(bool all)
    {
        using (var hive = RegistryKey.OpenBaseKey(all ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64))
        using (var key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
        {
            if (key == null) return null;
            foreach (var name in key.GetSubKeyNames())
                using (var app = key.OpenSubKey(name))
                {
                    if (app == null || !new[] { "Zhiyu", "Nanpad", "知屿" }.Contains(app.GetValue("DisplayName") as string)) continue;
                    var path = app.GetValue("InstallLocation") as string;
                    if (ValidPath(path) && (File.Exists(Path.Combine(path, "Zhiyu.exe")) || File.Exists(Path.Combine(path, "Nanpad.exe")))) return path;
                }
        }
        return null;
    }
    internal static bool Writable(string path)
    {
        // 仅在最近的已存在父目录写入并清理一个独立探针，不提前创建安装目录。
        while (path != null && !Directory.Exists(path)) path = Path.GetDirectoryName(path);
        if (path == null) return false;
        var probe = Path.Combine(path, ".zhiyu-write-" + Guid.NewGuid().ToString("N"));
        try { using (File.Create(probe, 1, FileOptions.DeleteOnClose)) { } return true; }
        catch (UnauthorizedAccessException) { return false; }
        catch (IOException) { return false; }
    }
}

internal sealed class Installer
{
    readonly Window window;
    readonly Payload payload;
    readonly bool preview;
    CancellationTokenSource cancellation;
    bool busy, installing, complete, cancelled;
    string selectedPath;
    bool selectedAll, selectedDesktop, selectedStartup;
    T Get<T>(string name) where T : class { return (T)window.FindName(name); }
    void Text(string name, string value) { Get<TextBlock>(name).Text = value; }
    void Show(string name) { foreach (var id in new[] { "Setup", "Installing", "Done" }) Get<StackPanel>(id).Visibility = id == name ? Visibility.Visible : Visibility.Collapsed; }
    public Installer(Payload payload, bool preview)
    {
        this.payload = payload;
        this.preview = preview;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ui")) window = (Window)XamlReader.Load(stream);
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo"))
        {
            var logo = new BitmapImage(); logo.BeginInit(); logo.CacheOption = BitmapCacheOption.OnLoad; logo.StreamSource = stream; logo.EndInit(); logo.Freeze();
            Get<Image>("BrandLogo").Source = logo; Get<Image>("IslandLogo").Source = logo; window.Icon = logo;
        }
        window.Height = Math.Min(window.Height, SystemParameters.WorkArea.Height - 24);
        var oldUser = Engine.Existing(false); var oldAll = Engine.Existing(true);
        var existing = oldUser ?? oldAll;
        Get<TextBox>("Directory").Text = existing ?? (DriveInfo.GetDrives().Any(d => d.Name == @"D:\" && d.IsReady && d.DriveType == DriveType.Fixed) ? @"D:\Apps\Zhiyu" : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Zhiyu"));
        Text("DirectoryHint", existing == null ? "优先使用 D 盘；资料与安装目录分别保存。" : "检测到已有安装，将沿用原位置与安装范围。");
        if (existing != null)
        {
            Get<TextBox>("Directory").IsEnabled = false; Get<Button>("Browse").IsEnabled = false;
            Get<RadioButton>("AllUsers").IsChecked = oldUser == null;
            Get<RadioButton>("CurrentUser").IsEnabled = false; Get<RadioButton>("AllUsers").IsEnabled = false;
            using (var hive = RegistryKey.OpenBaseKey(oldUser == null ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64))
            using (var key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) Get<CheckBox>("Startup").IsChecked = key != null && key.GetValue("Zhiyu") != null;
        }
        Text("Footer", "Windows 在线安装器 · " + payload.Version + (preview ? " · 交互预览，不修改系统" : ""));
        Get<Button>("Browse").Click += delegate {
            using (var dialog = new System.Windows.Forms.FolderBrowserDialog()) {
                dialog.Description = "选择知屿安装文件夹"; dialog.SelectedPath = Get<TextBox>("Directory").Text;
                if (dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK) Get<TextBox>("Directory").Text = dialog.SelectedPath;
            }
        };
        Get<RadioButton>("AllUsers").Checked += delegate { Text("Permission", "为所有用户安装需要管理员授权，Windows 将显示系统授权窗口。"); };
        Get<RadioButton>("CurrentUser").Checked += delegate { Text("Permission", "仅为当前用户安装；目录不可写时请换一个位置，或选择所有用户安装。"); };
        if (Get<RadioButton>("AllUsers").IsChecked == true) Text("Permission", "沿用已有的所有用户安装范围，安装时需要 Windows 管理员授权。");
        Get<Button>("Start").Click += async delegate { await Start(); };
        Get<Button>("Retry").Click += async delegate { await Start(); };
        Get<Button>("Cancel").Click += delegate { if (cancellation != null) { cancelled = true; cancellation.Cancel(); } };
        Get<Button>("Finish").Click += delegate { window.Close(); };
        Get<Button>("Launch").Click += delegate {
            if (preview) { window.Close(); return; }
            try { Process.Start(new ProcessStartInfo(Path.Combine(selectedPath, "Zhiyu.exe")) { UseShellExecute = true, WorkingDirectory = selectedPath }); window.Close(); }
            catch (Exception error) { MessageBox.Show(window, "程序已安装，但未能打开：" + error.Message, "知屿", MessageBoxButton.OK, MessageBoxImage.Information); }
        };
        window.Closing += delegate(object sender, CancelEventArgs e) {
            if (installing) { e.Cancel = true; MessageBox.Show(window, "正在写入程序，请等待安装结束。", "知屿"); }
            else if (busy) { e.Cancel = true; cancelled = true; cancellation.Cancel(); }
        };
    }
    void Motion(bool active)
    {
        foreach (var name in new[] { "DocumentNode", "AccountNode", "ServerNode" })
        {
            var transform = (TranslateTransform)Get<Border>(name).RenderTransform;
            var animation = new DoubleAnimation(0, name == "ServerNode" ? -38 : 28, TimeSpan.FromSeconds(1.8)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever };
            transform.BeginAnimation(TranslateTransform.YProperty, active && SystemParameters.ClientAreaAnimation ? animation : null);
        }
    }
    async Task Start()
    {
        if (busy || complete) return;
        selectedPath = Get<TextBox>("Directory").Text.Trim();
        selectedAll = Get<RadioButton>("AllUsers").IsChecked == true;
        selectedDesktop = Get<CheckBox>("Desktop").IsChecked == true;
        selectedStartup = Get<CheckBox>("Startup").IsChecked == true;
        if (!Engine.ValidPath(selectedPath)) { MessageBox.Show(window, "请输入包含文件夹的有效安装路径，例如 D:\\Apps\\Zhiyu。", "安装目录"); return; }
        if (!preview) {
            try { var drive = new DriveInfo(Path.GetPathRoot(selectedPath)); if (!drive.IsReady || drive.DriveType != DriveType.Fixed || drive.AvailableFreeSpace < payload.Size * 4) throw new IOException("请使用至少有 " + Math.Ceiling(payload.Size * 4 / 1048576.0) + " MB 空间的本地磁盘。"); if (!selectedAll && !Engine.Writable(selectedPath)) throw new UnauthorizedAccessException("当前用户无法写入此目录。请更换安装位置，或选择所有用户安装后由 Windows 请求管理员授权。"); }
            catch (Exception error) { MessageBox.Show(window, error.Message, "安装目录"); return; }
        }
        busy = true; cancelled = false; cancellation = new CancellationTokenSource(); cancellation.CancelAfter(TimeSpan.FromMinutes(20));
        var progress = Get<ProgressBar>("Progress"); progress.IsIndeterminate = false; progress.Value = 0;
        Get<Button>("Retry").Visibility = Visibility.Collapsed; Get<Button>("Cancel").IsEnabled = true;
        Text("Error", ""); Text("InstallHeading", "正在准备你的知屿"); Text("Percent", "0%");
        Text("DownloadTask", "● 下载程序"); Text("VerifyTask", "○ 校验文件完整性"); Text("InstallTask", "○ 安装并创建入口");
        Show("Installing"); Motion(true);
        string temporary = null;
        try {
            if (preview) {
                for (var i = 0; i <= 100; i += 2) { cancellation.Token.ThrowIfCancellationRequested(); progress.Value = i; Text("Percent", i + "%"); Text("Detail", "交互预览：不下载、不安装、不修改系统"); await Task.Delay(100, cancellation.Token); }
            } else {
                temporary = Path.Combine(Path.GetTempPath(), "ZhiyuInstaller-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(temporary);
                var target = Path.Combine(temporary, "setup.exe");
                using (var client = new HttpClient { Timeout = TimeSpan.FromMinutes(15) })
                using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 65536, true))
                {
                    client.DefaultRequestHeaders.UserAgent.ParseAdd("ZhiyuInstaller/" + payload.Version);
                    await Engine.Download(client, payload, output, bytes => { var value = bytes * 100.0 / payload.Size; progress.Value = value; Text("Percent", Math.Floor(value) + "%"); Text("Detail", (bytes / 1048576.0).ToString("F1") + " / " + (payload.Size / 1048576.0).ToString("F1") + " MB"); }, cancellation.Token);
                    Text("DownloadTask", "✓ 下载程序"); Text("VerifyTask", "● 校验文件完整性");
                    Text("Percent", "校验中"); await output.FlushAsync(cancellation.Token);
                    await Task.Run(() => Engine.Verify(output, payload));
                }
                cancellation.Token.ThrowIfCancellationRequested();
                // 读取锁阻止载荷在校验后被替换或删除，直到安装子进程结束。
                using (var locked = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                    Engine.Verify(locked, payload);
                    installing = true; Get<Button>("Cancel").IsEnabled = false; Motion(true);
                    Text("VerifyTask", "✓ 校验文件完整性"); Text("InstallTask", "● 安装并创建入口"); Text("Percent", "安装中"); Text("Detail", "正在写入程序；这一阶段请等待完成。"); progress.IsIndeterminate = true;
                    var info = new ProcessStartInfo(target, Engine.Arguments(selectedPath, selectedAll, selectedDesktop, selectedStartup)) { UseShellExecute = true, WorkingDirectory = temporary };
                    if (selectedAll) info.Verb = "runas";
                    using (var process = Process.Start(info)) {
                        if (process == null) throw new IOException("未能启动安装程序。");
                        await Task.Run(() => process.WaitForExit());
                        if (process.ExitCode != 0) throw new IOException("安装未完成（退出码 " + process.ExitCode + "），可以重试或使用离线安装包。");
                    }
                }
                var app = Path.Combine(selectedPath, "Zhiyu.exe");
                if (!File.Exists(app) || FileVersionInfo.GetVersionInfo(app).ProductVersion.Split('+')[0] != payload.Version) throw new IOException("没有找到本版本的已安装程序，请使用离线安装包检查安装结果。");
            }
            complete = true; Show("Done");
            Text("Summary", "安装位置：" + selectedPath + "\n安装范围：" + (selectedAll ? "所有用户" : "仅当前用户") + "\n桌面快捷方式：" + (selectedDesktop ? "创建" : "不创建") + "\n开机自启：" + (selectedStartup ? "开启" : "关闭"));
        } catch (OperationCanceledException) {
            if (cancelled) Show("Setup"); else Failure("下载超时，请检查网络后重新下载。");
        } catch (Exception error) {
            Failure(error is Win32Exception && ((Win32Exception)error).NativeErrorCode == 1223 ? "你取消了管理员授权。安装未完成，可以重新尝试。" : error.Message);
        } finally {
            installing = false; busy = false; Motion(false); progress.IsIndeterminate = false;
            cancellation.Dispose(); cancellation = null;
            if (temporary != null) { try { Directory.Delete(temporary, true); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
        }
    }
    void Failure(string message) { Text("InstallHeading", "安装暂未完成"); Text("Error", message); Get<Button>("Retry").Visibility = Visibility.Visible; Get<Button>("Cancel").IsEnabled = false; }
    public void ShowWindow() { window.Show(); }
}

internal static class Bootstrapper
{
    [STAThread]
    public static int Main(string[] args)
    {
        bool created;
        using (var mutex = new Mutex(true, @"Local\ZhiyuOnlineInstaller", out created)) {
            if (!created) { MessageBox.Show("知屿安装程序已经打开。", "知屿"); return 1; }
            try {
                if (!Environment.Is64BitOperatingSystem) throw new InvalidOperationException("此安装器适用于 64 位 Windows。");
                if (!args.Contains("--preview") && new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) throw new InvalidOperationException("请直接双击安装器，不要以管理员身份运行。安装时会按需请求 Windows 授权。");
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                var app = new Application();
                new Installer(Payload.Read(), args.Contains("--preview")).ShowWindow();
                app.Run(); return 0;
            } catch (Exception error) { MessageBox.Show(error.Message, "知屿安装程序", MessageBoxButton.OK, MessageBoxImage.Error); return 1; }
        }
    }
}
