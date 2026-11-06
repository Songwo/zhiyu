import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { webResearchFixture } from "./web-research-fixture.mjs";

// 用真实构建验证长号码表单，只允许字段区滚动，标题与保存栏固定在弹窗两端。
const fixture = await webResearchFixture({ built: true });
const browser = await chromium.launch();
const errors = [];
const now = new Date().toISOString();
try {
  const response = await fixture.call("/api/web/store", {
    cookie: fixture.cookie,
    method: "PUT",
    body: {
      revision: null,
      data: {
        version: 0,
        state: {
          servers: [],
          domains: [],
          mailboxes: [],
          aiAssets: [],
          secrets: [],
          certs: [],
          services: [],
          links: [],
          phoneNumbers: Array.from({ length: 25 }, (_, index) => ({
            id: "layout-phone-" + index,
            number: "+1555000" + String(index).padStart(4, "0"),
            label: "布局测试号码 " + index,
            provider: "test",
            expiresAt: "",
            notes: "",
            subscriptionIds: [],
            createdAt: now,
            updatedAt: now,
          })),
        },
      },
    },
  });
  assert.equal(response.ok, true, await response.text());
  await mkdir("screenshots", { recursive: true });
  const results = [];
  for (const [name, width, height] of [
    ["desktop", 1280, 850],
    ["mobile", 390, 844],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: "zh-CN",
      reducedMotion: "reduce",
    });
    await context.addCookies([
      { name: "zhiyu_session", value: fixture.cookie.split("=")[1], url: fixture.base },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.base);
    await page.locator('[data-app-ready="true"]').waitFor();
    if (width < 768) {
      await page.getByRole("button", { name: "全部", exact: true }).click();
      await page
        .getByRole("dialog", { name: "全部页面", exact: true })
        .getByRole("button", { name: /^号码管理/ })
        .click();
    } else {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("menuitem", { name: "号码管理", exact: true }).click();
    }
    await page
      .locator("[data-phone-id=layout-phone-0]")
      .getByRole("button", { name: /^编辑号码/ })
      .click();
    const form = page.getByRole("form", { name: "编辑号码", exact: true });
    const inspect = () =>
      page.evaluate(() => {
        const dialog = document.querySelector(".editor-dialog");
        const heading = dialog.querySelector(".editor-heading").getBoundingClientRect();
        const footer = dialog.querySelector(".editor-footer").getBoundingClientRect();
        const scroll = dialog.querySelector(".editor-scroll").getBoundingClientRect();
        const bounds = dialog.getBoundingClientRect();
        return {
          headingTop: heading.top,
          headingBottom: heading.bottom,
          footerTop: footer.top,
          footerBottom: footer.bottom,
          scrollTop: scroll.top,
          scrollBottom: scroll.bottom,
          dialogTop: bounds.top,
          dialogBottom: bounds.bottom,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
    await form.getByRole("textbox", { name: "号码备注", exact: true }).scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".editor-dialog")).opacity === "1",
    );
    const before = await inspect();
    await form
      .getByRole("textbox", { name: "搜索资产名称或类型", exact: true })
      .scrollIntoViewIfNeeded();
    const after = await inspect();
    for (const state of [before, after]) {
      assert.equal(state.overflow, false, name);
      assert.ok(
        state.headingTop >= state.dialogTop && state.headingBottom <= state.scrollTop + 1,
        name + " 标题不能随字段滚走",
      );
      assert.ok(
        state.footerTop >= state.scrollBottom - 1 && state.footerBottom <= state.dialogBottom + 1,
        name + " 保存栏必须在字段区下方",
      );
    }
    assert.ok(Math.abs(before.headingTop - after.headingTop) <= 1, name + " 标题位置固定");
    assert.ok(Math.abs(before.footerBottom - after.footerBottom) <= 1, name + " 保存栏位置固定");
    await page.screenshot({ path: "screenshots/phone-editor-layout-" + name + ".png" });
    results.push({ name, headingFixed: true, footerFixed: true, noOverflow: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, results, errors }));
} finally {
  await browser.close();
  await fixture.close();
}
