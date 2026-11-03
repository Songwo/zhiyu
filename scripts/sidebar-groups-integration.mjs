import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "zhiyu-sidebar-groups-"));
let instance;
try {
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
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    win.showInactive();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await completeOnboarding(page, { expandNavigation: false });
  const sidebar = page.locator("#primary-navigation");
  const nav = sidebar.getByRole("navigation", { name: "主导航", exact: true });
  assert.equal(await nav.locator('.sidebar-group-toggle[aria-expanded="false"]').count(), 4);
  assert.equal(await nav.locator(".sidebar-nav-item:visible").count(), 1);
  assert.equal(
    await nav.getByRole("button", { name: "资产总览", exact: true }).getAttribute("aria-current"),
    "page",
  );
  assert.equal(await nav.getByRole("button", { name: "服务器", exact: true }).isVisible(), false);
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/sidebar-groups-default.png" });

  const workspace = () => nav.getByRole("button", { name: "工作台", exact: true });
  await workspace().focus();
  await page.keyboard.press("Space");
  assert.equal(await workspace().getAttribute("aria-expanded"), "true");
  await nav.getByRole("button", { name: "文档资产", exact: true }).click();
  await workspace().click();
  assert.equal(
    await nav.getByRole("button", { name: "文档资产", exact: true }).getAttribute("aria-current"),
    "page",
  );
  assert.equal(await nav.getByRole("button", { name: "AI 助手", exact: true }).isVisible(), false);
  const infrastructure = () => nav.getByRole("button", { name: "基础设施", exact: true });
  await infrastructure().click();
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.equal(await workspace().getAttribute("aria-expanded"), "false");
  assert.equal(await infrastructure().getAttribute("aria-expanded"), "true");
  await infrastructure().click();

  const accounts = () => nav.getByRole("button", { name: "账号与订阅", exact: true });
  await accounts().click();
  await nav.getByRole("button", { name: "U 卡与支付卡", exact: true }).click();
  await accounts().click();
  assert.equal(
    await nav.getByRole("button", { name: "U 卡与支付卡", exact: true }).isVisible(),
    true,
  );
  assert.equal(await nav.getByRole("button", { name: "eSIM 卡", exact: true }).isVisible(), false);
  const active = await nav.locator('.sidebar-nav-item[aria-current="page"]').boundingBox();
  const pill = await nav.locator('.sidebar-active-pill[data-visible="true"]').boundingBox();
  assert.ok(active && pill && Math.abs(active.y - pill.y) < 2, "折叠后当前入口高亮仍准确定位");
  await page.screenshot({ path: "screenshots/sidebar-groups-current.png" });

  await page.getByRole("button", { name: "收起主导航", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#primary-navigation").dataset.collapsed === "true",
  );
  assert.equal(await nav.getByRole("button", { name: "服务器", exact: true }).isVisible(), true);
  assert.equal(await nav.getByRole("button", { name: "eSIM 卡", exact: true }).isVisible(), true);
  await nav.getByRole("button", { name: "eSIM 卡", exact: true }).click();
  await page.getByRole("button", { name: "展开主导航", exact: true }).click();
  assert.equal(await accounts().getAttribute("aria-expanded"), "false");
  assert.equal(
    await nav.getByRole("button", { name: "eSIM 卡", exact: true }).getAttribute("aria-current"),
    "page",
  );
  assert.equal(
    await nav.getByRole("button", { name: "U 卡与支付卡", exact: true }).isVisible(),
    false,
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.equal(await infrastructure().getAttribute("aria-expanded"), "false");
  assert.equal(await accounts().getAttribute("aria-expanded"), "false");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开菜单", exact: true }).click();
  const drawer = page.locator(".app-sidebar.anim-drawer");
  const background = await drawer.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.ok(background !== "transparent" && !background.endsWith(", 0)"), `移动侧栏应有不透明背景：${background}`);
  const drawerWorkspace = drawer.getByRole("button", { name: "工作台", exact: true });
  assert.equal(await drawerWorkspace.getAttribute("aria-expanded"), "false");
  const uniqueControls = await drawerWorkspace.evaluate((el) => {
    const id = el.getAttribute("aria-controls");
    return Array.from(document.querySelectorAll("[id]")).filter((element) => element.id === id)
      .length;
  });
  assert.equal(uniqueControls, 1, "移动抽屉和桌面侧栏的分组标识不重复");
  await drawerWorkspace.click();
  await page.screenshot({ path: "screenshots/sidebar-groups-mobile.png" });
  await drawer.getByRole("button", { name: "文档资产", exact: true }).click();
  await drawer.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "默认折叠四个分组",
          "鼠标与键盘展开",
          "当前页面入口始终可见",
          "折叠后的高亮位置",
          "展开和收起均持久化",
          "图标栏保留全部入口",
          "移动抽屉分组与导航",
        ],
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  if (instance) await instance.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await instance?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
