import { mkdir, rename, stat } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";

export function windowsAppId(packaged) {
  return packaged ? "dev.songwo.zhiyu" : "dev.songwo.zhiyu.development";
}

/** 程序目录中存在此文件时以便携模式运行，资料保存在同目录的 data 文件夹。 */
export const PORTABLE_MARKER = "portable.txt";

/** 便携版只认 Windows 正式程序旁的标记文件；显式指定的用户目录始终优先。 */
export function portableDataDirectory({
  packaged,
  platform = process.platform,
  execPath = process.execPath,
  argv = process.argv,
  exists = existsSync,
} = {}) {
  if (!packaged || platform !== "win32") return null;
  if (argv.some((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir=")))
    return null;
  const root = win32.dirname(execPath);
  return exists(win32.join(root, PORTABLE_MARKER)) ? win32.join(root, "data") : null;
}

/** 便携目录不可写时不能悄悄退回系统目录，否则资料位置与用户预期不一致。 */
function assertWritable(directory) {
  mkdirSync(directory, { recursive: true });
  const probe = join(directory, `.write-test-${process.pid}`);
  writeFileSync(probe, "");
  rmSync(probe, { force: true });
}

/** 显示身份独立于安装与存储身份；改名不能迁移用户资料或 Chromium 会话。 */
export function initializeAppIdentity(
  app,
  { testDataDirectory, portableDirectory, platform = process.platform } = {},
) {
  app.setName("Nanpad");
  const isolated = !app.isPackaged && testDataDirectory;
  const portable = !isolated && app.isPackaged && portableDirectory;
  if (portable) assertWritable(portable);
  const userData = isolated || portable || app.getPath("userData");
  const sessionData = isolated || portable || app.getPath("sessionData");
  for (const directory of new Set([userData, sessionData]))
    mkdirSync(directory, { recursive: true });
  // macOS/Linux 的系统密钥存储依赖原应用名，Windows Shell 改名仅作用于 Windows。
  if (platform === "win32") app.setName("知屿 Zhiyu");
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
  return { portable: Boolean(portable) };
}

/** 只迁移抢占正式版身份的 Electron 开发快捷方式，并保留可恢复备份。 */
export async function migrateLegacyWindowsShortcut({
  programsDirectory,
  backupDirectory,
  readShortcut,
}) {
  const source = join(programsDirectory, "Electron.lnk");
  try {
    await stat(source);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const entry = readShortcut(source);
  if (
    entry.appUserModelId !== "dev.songwo.nanpad" ||
    win32.basename(entry.target).toLowerCase() !== "electron.exe"
  )
    return null;
  await mkdir(backupDirectory, { recursive: true });
  const destination = join(backupDirectory, `Electron-${Date.now()}-${crypto.randomUUID()}.lnk`);
  await rename(source, destination);
  return destination;
}
