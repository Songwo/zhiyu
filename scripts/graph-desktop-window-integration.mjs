import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { demoSnapshot } from "../electron/services/demo.mjs";
import { navigateDesktop } from "./navigation-helper.mjs";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { chooseOption } from "./select-helper.mjs";

const profile = await mkdtemp(join(tmpdir(), "zhiyu-graph-window-"));
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const snapshot = demoSnapshot();
let app;
try {
  await writeFile(join(profile, "assets.json"), JSON.stringify({ version: 0, state: snapshot }));
  await writeFile(
    join(profile, "preferences.json"),
    JSON.stringify({ notifications: false, backgroundUpdateDownload: false, closeToTray: false }),
  );
  const env = { ...process.env };
  if (executablePath) delete env.NANPAD_TEST_DATA_DIR;
  else env.NANPAD_TEST_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (executablePath || !process.env.NANPAD_QA_DEV_URL) delete env.SINAN_DEV_URL;
  else env.SINAN_DEV_URL = process.env.NANPAD_QA_DEV_URL;
  app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : [resolve("electron/main.mjs")]), `--user-data-dir=${profile}`],
    env,
    locale: "zh-CN",
  });
  const identity = await app.evaluate(({ app }) => ({
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
  }));
  assert.equal(identity.userData, profile);
  assert.equal(identity.packaged, Boolean(executablePath));
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.setContentSize(960, 620);
    window.showInactive();
  });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await navigateDesktop(page, "服务器");
  await page
    .getByRole("group", { name: "显示方式", exact: true })
    .getByRole("button", { name: "关系图", exact: true })
    .click();
  const graph = page.getByRole("region", { name: "资产关系图", exact: true });
  await graph.locator(".asset-graph-node").first().waitFor();
  const checks = [];
  for (const zoom of [100, 125, 150]) {
    await page.evaluate((percent) => window.sinan.display.set(percent), zoom);
    const geometry = await graph.evaluate((element) => {
      const scroller = element.closest(".workspace-scroll");
      const bottom = scroller.getBoundingClientRect().bottom;
      const nav = document.querySelector('nav[aria-label="快捷导航"]');
      const navRect = nav?.getBoundingClientRect();
      const toolbar = element.querySelector(".graph-toolbar").getBoundingClientRect();
      const availableBottom = Math.min(bottom, navRect?.height ? navRect.top : innerHeight);
      const bounds = (selector) => {
        const item = scroller.querySelector(selector);
        if (!item) return null;
        const rect = item.getBoundingClientRect();
        return [Math.round(rect.top), Math.round(rect.bottom)];
      };
      return {
        bottom: availableBottom,
        toolbarBottom: toolbar.bottom,
        toolbarWidth: toolbar.width,
        toolbarScrollWidth: element.querySelector(".graph-toolbar").scrollWidth,
        scroll: scroller.scrollTop,
        ...(toolbar.bottom > availableBottom + 1 && {
          viewport: [innerWidth, innerHeight],
          layout: Object.fromEntries(
            [
              ".page-container",
              ".workspace-view",
              ".page-view-heading",
              ".asset-list-toolbar",
              ".asset-workspace",
              ".resource-graph-header",
              ".resource-chain-compact",
              ".asset-graph",
              ".react-flow",
            ].map((selector) => [selector, bounds(selector)]),
          ),
        }),
      };
    });
    checks.push({ zoom, ...geometry });
  }
  await page.evaluate(() => window.sinan.display.set(100));
  await graph.getByRole("button", { name: "全屏查看图谱", exact: true }).click();
  let fullscreen;
  try {
    await page.waitForFunction(
      () => document.fullscreenElement?.classList.contains("asset-graph"),
      null,
      { timeout: 4000 },
    );
    fullscreen = true;
  } catch {
    fullscreen = false;
  }
  console.log(JSON.stringify({ checks, fullscreen, errors }));
  assert.equal(fullscreen, true, "点击全屏应让资产关系图进入 HTML 全屏");
  for (const check of checks) {
    assert.equal(check.scroll, 0, `界面大小 ${check.zoom}% 时应从页面顶部开始`);
    assert.ok(check.toolbarBottom <= check.bottom + 1, `工具栏超出首屏 ${JSON.stringify(check)}`);
    assert.ok(
      check.toolbarScrollWidth <= check.toolbarWidth + 1,
      `工具栏横向溢出 ${JSON.stringify(check)}`,
    );
  }
  await chooseOption(page, graph.getByRole("combobox", { name: "布局方式" }), "关系分层");
  await graph.getByRole("button", { name: "连线配色", exact: true }).click();
  await graph.getByRole("button", { name: "关闭配色设置", exact: true }).click();
  await page.screenshot({ path: "screenshots/asset-graph-fullscreen.png" });
  await graph.getByRole("button", { name: "退出图谱全屏", exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await graph.getByRole("button", { name: "全屏查看图谱", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.fullscreenElement);
  await graph.getByRole("button", { name: "全屏查看图谱", exact: true }).waitFor();
  await page.screenshot({ path: "screenshots/asset-graph-window.png" });

  await graph.getByRole("button", { name: "全屏查看图谱", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await graph.getByRole("button", { name: "适应画布", exact: true }).click();
  const server = snapshot.servers[0];
  await graph.locator(`.asset-graph-node[data-asset-id="${server.id}"] .asset-name`).click();
  await page
    .getByRole("region", { name: "资产详情", exact: true })
    .getByRole("heading", { name: server.name, exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      packaged: identity.packaged,
      exitVia: ["button", "Escape", "asset"],
    }),
  );
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 8 });
}
