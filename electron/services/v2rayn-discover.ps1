$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 只申请有限查询权限，避免普通权限进程读取高权限客户端路径时返回空值。
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class V2raynProcessPath {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder text, ref int length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Read(int id) {
    IntPtr process = OpenProcess(0x1000, false, id);
    if (process == IntPtr.Zero) return null;
    try { int length = 32768; var text = new StringBuilder(length); return QueryFullProcessImageName(process, 0, text, ref length) ? text.ToString() : null; }
    finally { CloseHandle(process); }
  }
}
'@
$directories = [System.Collections.Generic.List[string]]::new()
Get-Process -Name v2rayN | Select-Object -First 16 | ForEach-Object {
  $target = [V2raynProcessPath]::Read($_.Id)
  if ($target) { $directories.Add([System.IO.Path]::GetDirectoryName($target)) }
}
$shell = New-Object -ComObject WScript.Shell
$programs = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('DesktopDirectory'))
foreach ($directory in $programs) {
  Get-ChildItem -LiteralPath $directory -Filter '*v2rayN*.lnk' -File -Recurse -Depth 2 | Select-Object -First 16 | ForEach-Object {
    $target = $shell.CreateShortcut($_.FullName).TargetPath
    if ([System.IO.Path]::GetFileName($target) -ieq 'v2rayN.exe') { $directories.Add([System.IO.Path]::GetDirectoryName($target)) }
  }
}
ConvertTo-Json -InputObject @($directories | Select-Object -Unique -First 32) -Compress
