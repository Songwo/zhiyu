import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 只用临时资料与终端外观预览，不连接真实服务器。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-lazy-terminal-"));
let app;
try {
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  app = await electron.launch({
    args: [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  const page = await app.firstWindow();
  const scripts = new Set();
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Debugger.scriptParsed", ({ url }) => scripts.add(url));
  await cdp.send("Debugger.enable");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    win.showInactive();
  });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  const terminalLoads = () =>
    [...scripts].filter((url) => /\/ssh-terminal-[^/]+\.js/.test(url)).length;
  assert.equal(await terminalLoads(), 0, "首页不应加载终端代码");
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog");
  await settings.getByRole("button", { name: "终端", exact: true }).click();
  await page.getByRole("button", { name: "查看终端效果", exact: true }).click();
  await page.locator(".terminal-workspace").waitFor();
  await page.locator('.terminal-status[data-status="preview"]').waitFor();
  assert.equal(await terminalLoads(), 1, "第一次打开终端加载代码");
  await page.locator(".terminal-workspace").evaluate((node) => {
    node.dataset.persistenceProbe = "kept";
  });
  await page
    .locator("#primary-navigation")
    .getByRole("button", { name: "资产总览", exact: true })
    .click();
  await page.keyboard.press("Control+,");
  await page.getByRole("dialog").getByRole("button", { name: "终端", exact: true }).click();
  await page.getByRole("button", { name: "返回终端", exact: true }).click();
  assert.equal(
    await page.locator(".terminal-workspace").getAttribute("data-persistence-probe"),
    "kept",
    "切换页面保留终端实例",
  );
  assert.equal(await terminalLoads(), 1);
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page
    .locator("#primary-navigation")
    .getByRole("button", { name: "资产总览", exact: true })
    .click();
  await page.waitForFunction(() => {
    const hero = document.querySelector(".depth-hero");
    return !hero || getComputedStyle(hero).opacity === "1";
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/lazy-terminal-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/lazy-terminal-mobile.png" });
  assert.deepEqual(errors, []);
  const receipt = {
    passed: true,
    firstUseLoadsTerminal: true,
    preservesTerminalAcrossNavigation: true,
    pageErrors: errors,
  };
  await writeFile("screenshots/lazy-terminal-receipt.json", JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
