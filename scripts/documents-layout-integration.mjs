import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const results = [];
await mkdir("release/screenshots", { recursive: true });
async function scenario(name, viewport, run) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  await context.addInitScript(() => {
    if (localStorage.getItem("document-layout-fixture")) return;
    for (let index = 0; index < 32; index++) {
      const title =
        index === 0 ? "云服务运维手册" : index === 1 ? "项目交接清单" : `参考记录 ${index + 1}`;
      const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
      const content =
        index === 0
          ? Array.from({ length: 100 }, (_, i) => [
              {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: `第 ${i + 1} 节 · 部署与维护` }],
              },
              paragraph(
                "这是一份用于验证长文档布局的示例资料。记录部署步骤、日常巡检与问题排查，所有内容均为测试数据。",
              ),
            ]).flat()
          : [paragraph("项目资料与日常工作记录。")];
      const now = new Date(Date.UTC(2026, 9, 5, 12) - index * 3600000).toISOString();
      localStorage.setItem(
        `nanpad-doc:doc-layout-${index}`,
        JSON.stringify({
          id: `doc-layout-${index}`,
          title,
          content: { type: "doc", content },
          bindings: [],
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    localStorage.setItem(
      "sinan-settings-v1",
      JSON.stringify({ version: 0, state: { language: "zh", theme: "light", zoomPercent: 100 } }),
    );
    localStorage.setItem("document-layout-fixture", "true");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(process.env.NANPAD_QA_URL || "http://127.0.0.1:8080", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.locator('[data-app-ready="true"]').waitFor({ timeout: 60000 });
    await page
      .getByRole("button", { name: viewport.width < 768 ? "文档" : "文档资产", exact: true })
      .click();
    await page.locator(".document-list-item").first().click();
    await page.getByRole("region", { name: "文档正文", exact: true }).waitFor();
    await run(page);
    assert.deepEqual(errors, []);
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    await page
      .screenshot({
        path: `release/screenshots/document-layout-${viewport.width}-failure.png`,
        timeout: 3000,
      })
      .catch(() => {});
  } finally {
    await context.close();
  }
  console.log(JSON.stringify(results.at(-1)));
}

try {
  await scenario(
    "长正文独立滚动，列表和工具栏保持可见",
    { width: 1440, height: 900 },
    async (page) => {
      const box = await page.locator(".documents-workspace").boundingBox();
      assert.ok(box && box.y + box.height <= 901, "长文档不能拉长整个工作区");
      const appBar = await page.locator(".app-titlebar").boundingBox();
      const libraryBar = await page.locator(".documents-library-titlebar").boundingBox();
      const fileBar = await page.locator(".document-context-bar").boundingBox();
      assert.ok(Math.abs(box.y - appBar.y - appBar.height) < 1, "文档工作区应直接衔接应用标题栏");
      assert.ok(
        Math.abs(libraryBar.y - fileBar.y) < 1 && Math.abs(libraryBar.height - fileBar.height) < 1,
        "文档栏标题和文件栏应对齐",
      );
      await page.getByRole("button", { name: "未关联", exact: true }).click();
      assert.equal(await page.locator(".documents-filters").getAttribute("data-filter"), "unbound");
      await page.getByRole("button", { name: "全部文档", exact: true }).click();
      await page.screenshot({ path: "release/screenshots/documents-header-desktop.png" });
      await page.getByRole("button", { name: "切换主题外观", exact: true }).click();
      await page.getByRole("button", { name: "编辑文档", exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await page.screenshot({
        path: "release/screenshots/documents-header-dark.png",
        animations: "disabled",
      });
      await page.getByRole("button", { name: "切换主题外观", exact: true }).click();
      const search = page.getByRole("textbox", { name: "搜索文档", exact: true });
      const before = await search.boundingBox();
      const scroller = page.locator(".document-reader-scroll");
      await scroller.hover();
      await page.mouse.wheel(0, 2200);
      await page.waitForFunction(
        () => document.querySelector(".document-reader-scroll").scrollTop > 500,
      );
      const after = await search.boundingBox();
      assert.equal(Math.round(after.y), Math.round(before.y));
      assert.equal(await page.getByRole("button", { name: "粗体", exact: true }).isVisible(), true);
      assert.equal(await page.locator('.document-list-item[aria-current="page"]').count(), 1);
      await page.screenshot({ path: "release/screenshots/document-layout-long.png" });
      await page.locator(".document-list-item").first().focus();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector(".document-reading-title")?.textContent === "参考记录 32",
      );
      assert.ok(await page.locator(".documents-list-scroll").evaluate((el) => el.scrollTop > 0));
      await search.fill("项目交接");
      await page.locator(".document-list-item").click();
      assert.equal(
        await page.getByRole("heading", { name: "项目交接清单", exact: true }).innerText(),
        "项目交接清单",
      );
      assert.equal(await scroller.evaluate((el) => el.scrollTop), 0);
      await page.getByRole("button", { name: "编辑文档", exact: true }).click();
      await page.getByRole("textbox", { name: "文档标题", exact: true }).fill("已更新的交接清单");
      await search.fill("");
      await page.locator(".document-list-item").filter({ hasText: "云服务运维手册" }).click();
      await page.locator(".document-list-item").filter({ hasText: "已更新的交接清单" }).click();
      assert.equal(
        await page.getByRole("heading", { name: "已更新的交接清单", exact: true }).innerText(),
        "已更新的交接清单",
      );
      await page.getByRole("button", { name: /^关联与设置/ }).click();
      const details = page.getByRole("dialog", { name: "文档信息", exact: true });
      await details.getByRole("button", { name: "导出文档", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "hidden" });
      await search.fill("不存在的文档");
      await page.getByText("暂无匹配文档", { exact: true }).waitFor();
      await page.getByRole("button", { name: "添加文档", exact: true }).click();
      await page.getByRole("menuitem", { name: "新建文档", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector(".document-title")?.value === "未命名文档",
      );
      assert.equal(await search.inputValue(), "");
      assert.equal(await page.locator('.document-list-item[aria-current="page"]').count(), 1);
    },
  );
  await scenario(
    "窄屏通过列表切换文档，正文获得完整宽度",
    { width: 390, height: 844 },
    async (page) => {
      assert.equal(
        await page.getByRole("textbox", { name: "搜索文档", exact: true }).isVisible(),
        false,
      );
      const paper = await page.locator(".document-paper").boundingBox();
      assert.ok(paper.width > 340, "手机正文应获得完整阅读宽度");
      await page.locator(".document-reader-scroll").hover();
      await page.mouse.wheel(0, 2500);
      await page.getByRole("button", { name: "文档列表", exact: true }).click();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-current") === "page",
      );
      await page.locator(".documents-library-title").waitFor();
      await page.screenshot({ path: "release/screenshots/documents-header-mobile-list.png" });
      await page.getByRole("textbox", { name: "搜索文档", exact: true }).fill("项目交接");
      await page.locator(".document-list-item").click();
      assert.equal(
        await page.getByRole("heading", { name: "项目交接清单", exact: true }).innerText(),
        "项目交接清单",
      );
      await page.screenshot({ path: "release/screenshots/document-layout-mobile.png" });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const box = await page.locator(".documents-workspace").boundingBox();
      assert.ok(box.y + box.height <= 789, "文档区不能被底部导航遮挡");
    },
  );
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  }),
);
if (results.some((r) => !r.ok)) process.exitCode = 1;
