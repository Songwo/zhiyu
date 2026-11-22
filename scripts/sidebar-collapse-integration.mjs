import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const errors = [];
await mkdir("release/screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  await context.addInitScript(() => {
    if (localStorage.getItem("collapse-fixture")) return;
    const now = "2026-10-06T00:00:00.000Z";
    for (const [id, title] of [
      ["guide", "项目部署手册"],
      ["notes", "交接与维护记录"],
    ]) {
      localStorage.setItem(
        `nanpad-doc:doc-collapse-${id}`,
        JSON.stringify({
          id: `doc-collapse-${id}`,
          title,
          bindings: [],
          createdAt: now,
          updatedAt: now,
          content: {
            type: "doc",
            content: [
              {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: "部署前的准备" }],
              },
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "这是一份示例文档。记录环境配置、发布步骤与回滚检查，便于下次部署时快速查阅。",
                  },
                ],
              },
              {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: "日常维护" }],
              },
              ...Array.from({ length: 18 }, (_, i) => ({
                type: "paragraph",
                content: [
                  { type: "text", text: `检查项 ${i + 1}：确认服务运行、备份与日志状态。` },
                ],
              })),
            ],
          },
        }),
      );
    }
    localStorage.setItem(
      "sinan-settings-v1",
      JSON.stringify({ version: 0, state: { language: "zh", theme: "light", zoomPercent: 100 } }),
    );
    localStorage.setItem("collapse-fixture", "true");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const start = async () => {
    await page.goto(process.env.NANPAD_QA_URL || "http://127.0.0.1:8080", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.locator('[data-app-ready="true"]').waitFor({ timeout: 60000 });
  };
  await start();
  await page.locator('#primary-navigation[data-motion-ready="true"]').waitFor();
  const motion = await page.evaluate(async () => {
    const sidebar = document.querySelector("#primary-navigation");
    const toggle = document.querySelector('[aria-controls="primary-navigation"]');
    const frame = () => new Promise(requestAnimationFrame);
    toggle.click();
    await frame();
    await frame();
    const animating = sidebar.getAnimations().some((a) => a.transitionProperty === "width");
    const widths = [];
    for (let i = 0; i < 4; i++) {
      widths.push(sidebar.getBoundingClientRect().width);
      await frame();
    }
    toggle.click();
    await frame();
    await frame();
    await Promise.all(sidebar.getAnimations().map((a) => a.finished.catch(() => {})));
    return { animating, widths, finalWidth: sidebar.getBoundingClientRect().width };
  });
  assert.ok(
    motion.animating && motion.widths.some((width) => width > 73 && width < 239),
    "侧栏应经过可见的中间宽度",
  );
  assert.ok(motion.finalWidth >= 239, "动画中途反向展开应恢复完整宽度");
  await page.getByRole("button", { name: "收起主导航", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#primary-navigation").getBoundingClientRect().width <= 73,
  );
  const sidebar = page.locator("#primary-navigation");
  const collapsed = await sidebar.boundingBox();
  assert.ok(collapsed.width <= 80, "主导航收起后应为窄图标栏");
  const documents = sidebar.getByRole("button", { name: "文档资产", exact: true });
  await documents.hover();
  await page.getByRole("tooltip").filter({ hasText: "文档资产" }).waitFor();
  await documents.click();
  await page.locator(".document-list-item").filter({ hasText: "项目部署手册" }).click();
  await page.getByRole("region", { name: "文档正文", exact: true }).waitFor();
  await page.screenshot({ path: "release/screenshots/sidebar-collapsed-documents.png" });
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await page
    .getByRole("textbox", { name: "文档标题", exact: true })
    .fill("项目部署手册 · 草稿保留");
  const libraryMotion = await page.evaluate(async () => {
    const workspace = document.querySelector(".documents-workspace");
    const library = document.querySelector("#document-library");
    const editor = document.querySelector(".document-detail");
    const toggle = document.querySelector('[aria-controls="document-library"]');
    const frame = () => new Promise(requestAnimationFrame);
    toggle.click();
    await frame();
    await frame();
    const animating = workspace
      .getAnimations()
      .some((a) => a.transitionProperty === "grid-template-columns");
    const widths = [];
    for (let i = 0; i < 4; i++) {
      widths.push(library.getBoundingClientRect().width);
      await frame();
    }
    toggle.click();
    await frame();
    await frame();
    await Promise.all(workspace.getAnimations().map((a) => a.finished.catch(() => {})));
    return {
      animating,
      widths,
      width: library.getBoundingClientRect().width,
      sameEditor: document.querySelector(".document-detail") === editor,
    };
  });
  assert.ok(
    libraryMotion.animating && libraryMotion.widths.some((width) => width > 1 && width < 279),
    "文档列表应平滑收起",
  );
  assert.ok(
    libraryMotion.width >= 279 && libraryMotion.sameEditor,
    "反向展开应恢复列表且不卸载编辑器",
  );
  await page.getByRole("button", { name: "收起文档列表", exact: true }).click();
  await page.locator("#document-library").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#document-library").evaluate((el) => el.inert), true);
  assert.equal(
    await page.evaluate(() => {
      const input = document.querySelector("#document-library input");
      input.focus();
      return document.activeElement === input;
    }),
    false,
    "收起的列表不能接收键盘焦点",
  );
  assert.equal(
    await page.getByRole("textbox", { name: "搜索文档", exact: true }).isVisible(),
    false,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "文档标题", exact: true }).inputValue(),
    "项目部署手册 · 草稿保留",
  );
  await page.screenshot({ path: "release/screenshots/document-focus-mode.png" });
  await page.waitForFunction(() =>
    JSON.parse(localStorage.getItem("nanpad-doc:doc-collapse-guide")).title.endsWith("草稿保留"),
  );
  await start();
  assert.ok((await sidebar.boundingBox()).width <= 80, "主导航收起状态应在刷新后保留");
  assert.equal(
    await sidebar.evaluate((el) =>
      el.getAnimations().some((a) => a.transitionProperty === "width"),
    ),
    false,
    "刷新恢复偏好不应播放收起动画",
  );
  await documents.click();
  await page.locator(".documents-workspace").waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "搜索文档", exact: true }).isVisible(),
    true,
    "未选中文档时应保留选择入口",
  );
  await page.locator(".document-list-item").filter({ hasText: "项目部署手册" }).click();
  await page.getByRole("button", { name: "展开文档列表", exact: true }).click();
  await page.locator(".document-list-item").filter({ hasText: "交接与维护记录" }).click();
  assert.equal(
    await page.getByRole("heading", { name: "交接与维护记录", exact: true }).innerText(),
    "交接与维护记录",
  );
  await sidebar.getByRole("button", { name: "更多操作", exact: true }).click();
  const exportButton = sidebar.getByRole("button", { name: "导出 JSON 快照", exact: true });
  const menu = await exportButton.boundingBox();
  assert.ok(menu.width > 150 && menu.x + menu.width < 1440, "图标栏账户菜单应正常展开");
  await page.keyboard.press("Escape");

  await navigateDesktop(page, "终端");
  assert.equal(
    await sidebar.getByRole("button", { name: "终端", exact: true }).getAttribute("aria-current"),
    "page",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.getByRole("button", { name: "展开主导航", exact: true }).isVisible(),
    false,
  );
  await page.getByRole("button", { name: "打开菜单", exact: true }).click();
  await page.locator('aside.anim-drawer[data-shown="true"]').waitFor();
  const mobileNav = page.locator("aside:visible nav");
  assert.equal(
    await mobileNav.getByText("文档资产", { exact: true }).isVisible(),
    true,
    "手机抽屉不应继承桌面的图标模式",
  );
  await page.screenshot({ path: "release/screenshots/sidebar-mobile-drawer.png" });
  await mobileNav.getByRole("button", { name: "文档资产", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "展开主导航", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#primary-navigation").getBoundingClientRect().width >= 239,
  );
  assert.ok((await sidebar.boundingBox()).width >= 220);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "收起主导航", exact: true }).click();
  assert.ok((await sidebar.boundingBox()).width <= 80, "减少动态效果时应立即收起");
  assert.equal(await sidebar.evaluate((el) => el.getAnimations({ subtree: true }).length), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      persisted: true,
      collapsePreservesDraft: true,
      navigationAndTooltip: true,
      accountMenu: true,
      mobileDrawer: true,
      interruptibleMotion: true,
      reducedMotion: true,
      hiddenListUnfocusable: true,
      pageErrors: errors,
    }),
  );
} finally {
  await browser.close();
}
