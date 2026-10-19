import { cp, readFile, rm, stat, writeFile, mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 便携版直接复用安装包同一份 win-unpacked，只追加便携标记与说明，不重新编译。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const directory = join(root, "release", `v${version}`);
const unpacked = join(directory, "win-unpacked");
const archive = join(directory, `Zhiyu-${version}-portable-x64.zip`);

try {
  await stat(join(unpacked, "Zhiyu.exe"));
} catch {
  throw new Error(`缺少 ${unpacked}\\Zhiyu.exe，请先运行 npm run desktop:dist。`);
}

// 标记文件名与 electron/services/windows-identity.mjs 的 PORTABLE_MARKER 保持一致。
const MARKER = `知屿 Zhiyu ${version} 便携版
================================

这个文件让知屿以便携模式运行，请不要删除。

使用方法
- 解压到任意可写入的文件夹（例如 D:\\Zhiyu 或 U 盘），双击 Zhiyu.exe 启动。
- 不要放在 C:\\Program Files 等受保护目录，否则无法保存资料。
- 资料（资产、文档、密钥库、设置）全部保存在同目录的 data 文件夹。

更新
- 便携版不会自动安装更新。在「设置 → 关于知屿」可以检查新版本。
- 下载新的 Zhiyu-x.y.z-portable-x64.zip，退出知屿，解压覆盖程序文件即可，保留 data 文件夹。

备份与迁移
- 退出知屿后复制整个文件夹（含 data）即可备份或换电脑使用。
- 密钥库由主密码加密，换电脑后输入主密码即可解锁。
- 模型 API Key、Cloudflare 等连接凭据、图床密钥和 Linux.do 登录由 Windows
  系统加密，只能在原电脑、原 Windows 账户中解密。换电脑或换账户后需要重新填写。

从安装版迁移
- 安装版资料位于 %APPDATA%\\Nanpad。退出两个版本后，把该目录的内容复制到 data 文件夹。

删除
- 退出知屿后删除整个文件夹即可，便携版不写入注册表，也不创建开始菜单项。

使用教程：https://github.com/Songwo/zhiyu/blob/main/docs/USER-GUIDE.md
`;

const stage = await mkdtemp(join(tmpdir(), "zhiyu-portable-"));
try {
  const folder = join(stage, `Zhiyu-${version}-portable`);
  await cp(unpacked, folder, { recursive: true });
  await writeFile(join(folder, "portable.txt"), `\uFEFF${MARKER.replace(/\n/g, "\r\n")}`, "utf8");
  await writeFile(
    join(folder, "User-Guide.url"),
    "[InternetShortcut]\r\nURL=https://github.com/Songwo/zhiyu/blob/main/docs/USER-GUIDE.md\r\n",
  );
  await rm(archive, { force: true });
  // Windows 10 起自带 bsdtar，生成标准 zip，比 Compress-Archive 快且无需额外依赖。
  // 显式使用系统 tar，避免 PATH 中 Git 自带的 GNU tar（不支持 zip）。
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const result = spawnSync(
    tar,
    ["-a", "-c", "-f", archive, "-C", stage, `Zhiyu-${version}-portable`],
    {
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`压缩便携版失败：${result.status}`);
  const { size } = await stat(archive);
  console.log(`便携版：${archive}（${(size / 1024 / 1024).toFixed(1)} MB）`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
