import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { demoSnapshot } from "../electron/services/demo.mjs";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { openDesktopDirectory } from "./navigation-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "zhiyu-sidebar-groups-"));
let instance;
try {
  await writeFile(
    join(directory, "assets.json"),
    JSON.stringify({ state: demoSnapshot(), version: 0 }),
  );
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  delete env.NODE_PATH;
  const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  instance = await electron.launch({
    cwd: process.env.NANPAD_QA_APP_CWD ?? process.cwd(),
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...(executablePath ? [] : [resolve("electron/main.mjs")]),
      `--user-data-dir=${directory}`,
    ],
    env,
    locale: "zh-CN",
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    win.showInactive();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  const sidebar = page.locator("#primary-navigation");
  const nav = sidebar.getByRole("navigation", { name: "主导航", exact: true });
  const button = (label) => nav.getByRole("button", { name: label, exact: true });
  const trigger = button("全部功能");
  const main = page.getByRole("main");
  const ready = (label) =>
    main.getByRole("heading", { name: label, exact: true }).first().waitFor();
  assert.deepEqual(
    await nav
      .locator("button")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label"))),
    ["资产总览", "费用与续费", "邮箱", "文档资产", "全部功能"],
  );
  assert.equal(await button("资产总览").getAttribute("aria-current"), "page");
  assert.equal(await button("服务器").count(), 0);
  await mkdir("screenshots", { recursive: true });

  const priority = main.getByRole("region", { name: "待处理事项" });
  const renewals = main.getByRole("region", { name: "近期续费" });
  const summary = main.getByRole("region", { name: "资产摘要" });
  const activity = main.getByRole("region", { name: "每日活动" });
  assert.ok((await priority.boundingBox()).y < (await summary.boundingBox()).y);
  assert.ok((await renewals.boundingBox()).y < (await summary.boundingBox()).y);
  assert.ok((await summary.boundingBox()).y < (await activity.boundingBox()).y);
  await page.mouse.move(1120, 90);
  await page.screenshot({ path: "screenshots/ui-layout-v1-overview.png" });

  await button("文档资产").click();
  await ready("文档资产");
  await button("资产总览").click();
  await ready("资产总览");

  await trigger.focus();
  await page.keyboard.press("Enter");
  const catalog = page.getByRole("dialog", { name: "全部功能", exact: true });
  await catalog.waitFor();
  assert.equal(await catalog.locator(".sidebar-directory-page").count(), 19);
  assert.equal(await catalog.getByRole("region").count(), 5);
  await page.screenshot({ path: "screenshots/ui-layout-v1-directory.png" });
  await page.keyboard.press("Escape");
  await catalog.waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "全部功能",
  );
  await (
    await openDesktopDirectory(page)
  )
    .getByRole("region", { name: "基础设施" })
    .getByRole("button", { name: "安全证书", exact: true })
    .click();
  await ready("安全证书");
  assert.equal(await button("安全证书").getAttribute("aria-current"), "page");
  assert.equal(await button("服务器").count(), 0);

  await openDesktopDirectory(page);
  await page.keyboard.press("Control+k");
  await catalog.waitFor({ state: "detached" });
  const search = page.getByRole("combobox", { name: "搜索资产与操作" });
  await search.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "搜索资产与操作",
  );
  await search.fill("域名");
  await page.getByRole("option", { name: "域名", exact: true }).click();
  await ready("域名");
  assert.equal(await button("域名").getAttribute("aria-current"), "page");
  const active = await button("域名").boundingBox();
  const pill = await nav.locator('.sidebar-active-pill[data-visible="true"]').boundingBox();
  assert.ok(active && pill && Math.abs(active.y - pill.y) < 2);
  await page.screenshot({ path: "screenshots/ui-layout-v1-current.png" });

  await page.getByRole("button", { name: "收起主导航", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#primary-navigation").dataset.collapsed === "true",
  );
  assert.equal(await button("域名").getAttribute("aria-current"), "page");
  assert.equal(await button("服务器").count(), 0);
  await trigger.focus();
  await page.getByRole("tooltip").filter({ hasText: "全部功能" }).waitFor();
  await (
    await openDesktopDirectory(page)
  )
    .getByRole("button", { name: "服务器", exact: true })
    .click();
  await ready("服务器");
  assert.equal(await button("服务器").getAttribute("aria-current"), "page");
  await page.getByRole("button", { name: "展开主导航", exact: true }).click();
  await button("资产总览").click();
  const theme = page.getByRole("button", { name: "切换主题外观", exact: true });
  if ((await page.locator("html").getAttribute("data-theme")) !== "dark") await theme.click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({ path: "screenshots/ui-layout-v1-dark.png" });
  await theme.click();

  await page.setViewportSize({ width: 390, height: 844 });
  await ready("资产总览");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
    false,
  );
  await page.screenshot({ path: "screenshots/ui-layout-v1-mobile.png" });
  const mobileCatalog = await openDesktopDirectory(page);
  const dialogBounds = await mobileCatalog.boundingBox();
  assert.ok(dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= 390);
  await page.screenshot({ path: "screenshots/ui-layout-v1-directory-mobile.png" });
  await mobileCatalog.getByRole("button", { name: "eSIM 卡", exact: true }).click();
  await mobileCatalog.waitFor({ state: "detached" });
  await page.locator(".app-sidebar.anim-drawer").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "quick access",
        "overview priority",
        "complete directory",
        "keyboard focus restoration",
        "search",
        "active page",
        "collapsed sidebar",
        "dark theme",
        "390px drawer",
      ],
      errors,
    }),
  );
} finally {
  if (instance) await instance.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await instance?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
