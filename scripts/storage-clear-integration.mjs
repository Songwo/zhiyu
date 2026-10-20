import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 回归：storage:clear 曾把 scope 当第二个参数读取，两个清理按钮都报「未知的清理范围」。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-storage-clear-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
try {
  instance = await electron.launch({
    args: [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // 测试模式下窗口默认隐藏且会节流动画帧，Playwright 的点击会一直等不到「稳定」。
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);

  const bridge = await page.evaluate(async () => {
    const storage = window.sinan.storage;
    const result = { mail: await storage.clear("mail"), chromium: await storage.clear("chromium") };
    try {
      await storage.clear("everything");
      result.unknown = null;
    } catch (error) {
      result.unknown = error.message;
    }
    return result;
  });
  assert.deepEqual(bridge, { mail: "mail", chromium: "chromium", unknown: "未知的清理范围" });

  await page.getByRole("banner").getByRole("button", { name: "系统设置…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("button", { name: "存储", exact: true }).click();
  for (const [button, message] of [
    ["清空邮件会话缓存", "已清空邮件会话缓存"],
    ["清理网页缓存", "已清理网页缓存"],
  ]) {
    await dialog.getByRole("button", { name: button, exact: true }).click();
    await page.getByText(message, { exact: true }).waitFor();
  }
  assert.equal(await page.getByText("未知的清理范围").count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, bridge, buttons: 2 }, null, 2));
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
