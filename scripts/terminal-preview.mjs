import { cp, mkdir, readdir, stat, access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron, chromium } from "playwright";

// 手工测试使用固定目录；自动集成测试继续使用独立临时目录。
const directory = join(process.env.LOCALAPPDATA, "ZhiyuTerminalPreview");
// 已打开时更新原窗口，避免同一数据目录的多个实例争用文件锁。
try {
  const port = (await readFile(join(directory, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.reload();
  await page.bringToFront();
  console.log("PREVIEW_READY: 已刷新保留服务器数据的原窗口");
  await browser.close();
  process.exit(0);
} catch { /* 原窗口不存在时，从固定数据目录启动。 */ }
try {
  await access(join(directory, "assets.json"));
} catch {
  const backups = join(process.env.LOCALAPPDATA, "ZhiyuTerminalPreviewBackups");
  const candidates = await Promise.all((await readdir(backups)).map(async (name) => {
    const path = join(backups, name);
    return { path, modified: (await stat(join(path, "assets.json"))).mtimeMs };
  }));
  candidates.sort((a, b) => b.modified - a.modified);
  if (!candidates.length) throw new Error("没有找到已保存的预览数据");
  await mkdir(directory, { recursive: true });
  await cp(candidates[0].path, directory, { recursive: true });
}
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [resolve("electron/main.mjs")], env });
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1280, 900); window.show(); window.focus(); });
await page.locator('[data-app-ready="true"]').waitFor();
await page.locator("nav:visible").getByRole("button", { name: /^终端/ }).first().click();
await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
console.log("PREVIEW_READY: 已打开保留服务器数据的终端预览");
await new Promise((resolveExit) => app.process().once("exit", resolveExit));
