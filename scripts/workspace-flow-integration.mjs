import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// 每个用例使用独立浏览器数据，验证真实操作结果，不接触用户资产。
const browser = await chromium.launch({ headless: true });
const results = [];
const baseUrl = process.env.NANPAD_QA_URL || "http://127.0.0.1:8080/";
await mkdir("release/screenshots", { recursive: true });

async function scenario(name, run) {
  if (process.env.NANPAD_QA_CASE && !name.includes(process.env.NANPAD_QA_CASE)) return;
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 850 },
  });
  await context.addInitScript(() => {
    if (localStorage.getItem("workspace-flow-seeded")) return;
    const domain = {
      registrar: "Example",
      dns: "Example",
      nameservers: [],
      autoRenew: false,
      tags: [],
      notes: "",
    };
    const account = {
      provider: "Example",
      plan: "Monthly",
      monthlyUsd: 20,
      monthlyUsdKnown: true,
      renewsAt: "",
      keyHint: "",
      notes: "",
      tags: [],
    };
    localStorage.setItem(
      "sinan-assets-v1",
      JSON.stringify({
        version: 0,
        state: {
          servers: [],
          mailboxes: [],
          certs: [],
          secrets: [],
          links: [],
          activity: [],
          phoneNumbers: [],
          domains: [
            {
              ...domain,
              id: "expired",
              name: "expired.example.test",
              status: "offline",
              expiresAt: "2000-01-01",
            },
            {
              ...domain,
              id: "healthy",
              name: "healthy.example.test",
              status: "online",
              expiresAt: "2099-01-01",
            },
          ],
          aiAssets: [
            { ...account, id: "alert", name: "告警订阅", status: "warning", usagePct: 95 },
            { ...account, id: "normal", name: "正常订阅", status: "online", usagePct: 10 },
          ],
        },
      }),
    );
    localStorage.setItem(
      "sinan-settings-v1",
      JSON.stringify({
        version: 0,
        state: {
          language: "zh",
          theme: "light",
          zoomPercent: 100,
          assetLayout: "cards",
          reduceMotion: true,
        },
      }),
    );
    localStorage.setItem("workspace-flow-seeded", "true");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator('[data-app-ready="true"]').waitFor({ timeout: 60000 });
    await run(page);
    assert.deepEqual(errors, [], "不能出现页面运行错误");
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  } finally {
    await context.close();
  }
  console.log(JSON.stringify(results.at(-1)));
}
const nav = (page) => page.locator("aside:visible nav");
const main = (page) => page.locator("main");

try {
  await scenario("总览待处理入口仅显示需关注资产", async (page) => {
    await page.getByRole("button", { name: "域名 · 1 项需要留意", exact: true }).click();
    await main(page).getByText("expired.example.test", { exact: true }).waitFor();
    assert.equal(
      await main(page).getByText("healthy.example.test", { exact: true }).count(),
      0,
      "待处理入口不应显示正常域名",
    );
  });
  await scenario("切换资产分类不会继承上一分类的筛选", async (page) => {
    await navigateDesktop(page, "域名");
    await page.getByRole("button", { name: /^即将到期/ }).click();
    await navigateDesktop(page, "AI 订阅");
    assert.equal(
      await main(page).getByText("正常订阅", { exact: true }).count(),
      1,
      "切换分类后应看到正常订阅",
    );
    await page.getByRole("button", { name: /^用量告警/ }).click();
    assert.equal(await main(page).getByText("正常订阅", { exact: true }).count(), 0);
  });
  await scenario("文档快捷键新建并保留文档，不打开服务器", async (page) => {
    await nav(page).getByRole("button", { name: "文档资产", exact: true }).click();
    await page.getByRole("button", { name: "添加文档", exact: true }).waitFor();
    await page.keyboard.press("Control+n");
    assert.equal(
      await page.getByRole("heading", { name: "添加服务器", exact: true }).count(),
      0,
      "文档快捷键不能打开服务器表单",
    );
    await page.locator(".document-title").waitFor();
    assert.equal(await page.locator(".document-list-item").count(), 1);
    await page.reload();
    await page.locator('[data-app-ready="true"]').waitFor();
    await nav(page).getByRole("button", { name: "文档资产", exact: true }).click();
    await page.locator(".document-list-item").waitFor();
  });
  await scenario("总览选择新增类型后可保存号码", async (page) => {
    await page.getByRole("button", { name: "添加资产", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择资产类型", exact: true });
    await picker.getByRole("button", { name: "添加号码", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "添加号码", exact: true });
    await editor.getByRole("textbox", { name: "号码", exact: true }).fill("+44 7700 900777");
    await editor.getByRole("button", { name: "保存号码", exact: true }).click();
    await page.getByText("+44 7700 900777", { exact: true }).waitFor();
    await page.reload();
    await page.locator('[data-app-ready="true"]').waitFor();
    await navigateDesktop(page, "号码管理");
    await page.getByText("+44 7700 900777", { exact: true }).waitFor();
  });
  await scenario("选择新建文档及分类新增按钮对应正确类型", async (page) => {
    await page.getByRole("button", { name: "添加资产", exact: true }).click();
    await page
      .getByRole("dialog", { name: "选择资产类型", exact: true })
      .getByRole("button", { name: "新建文档", exact: true })
      .click();
    await page.locator(".document-title").waitFor();
    await navigateDesktop(page, "域名");
    await page.getByRole("button", { name: "添加域名", exact: true }).click();
    await page.getByRole("heading", { name: "添加域名", exact: true }).waitFor();
  });
  await scenario("类型选择交接到服务器表单后可操作，快捷键不会清空草稿", async (page) => {
    await page.getByRole("button", { name: "添加资产", exact: true }).click();
    const serverType = page
      .getByRole("dialog", { name: "选择资产类型", exact: true })
      .getByRole("button", { name: "添加服务器", exact: true });
    await serverType.focus();
    await serverType.press("Enter");
    const editor = page.getByRole("dialog", { name: "服务器", exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
    await editor.getByRole("textbox", { name: "主机名", exact: true }).fill("工作流测试主机");
    await editor.getByRole("textbox", { name: "IP / Host", exact: true }).fill("host.example.test");
    await page.keyboard.press("Control+n");
    assert.equal(
      await editor.getByRole("textbox", { name: "主机名", exact: true }).inputValue(),
      "工作流测试主机",
    );
    await page.setViewportSize({ width: 390, height: 600 });
    await editor.getByRole("radio", { name: "配置 SSH", exact: true }).check();
    const add = editor.getByRole("button", { name: "添加", exact: true });
    for (const scroll of [0, 10000]) {
      await editor.locator(".editor-scroll").evaluate((el, y) => {
        el.scrollTop = y;
      }, scroll);
      const rect = await add.boundingBox();
      assert.ok(
        rect && rect.y >= 0 && rect.y + rect.height <= 600,
        "资产保存按钮必须始终在可见区域",
      );
    }
    await editor.getByRole("radio", { name: "仅记录", exact: true }).check();
    await add.click();
    await editor.waitFor({ state: "hidden" });
    const hosts = await page.evaluate(
      () => JSON.parse(localStorage.getItem("sinan-assets-v1")).state.servers,
    );
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].name, "工作流测试主机");
    assert.equal(hosts[0].sshConfigured, false);
  });
  await scenario("嵌套订阅下拉按 Escape 只关闭下拉，固定完成按钮可操作", async (page) => {
    await navigateDesktop(page, "AI 订阅");
    await page.getByRole("button", { name: "添加 AI 订阅", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "添加 AI 订阅", exact: true });
    await editor.getByRole("button", { name: /^订阅账号/ }).click();
    await editor.getByRole("combobox", { name: "授权服务商", exact: true }).click();
    await page.getByRole("listbox").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.equal(await editor.isVisible(), true);
    await editor.getByRole("button", { name: "完成", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
  });
  await scenario("手机号码弹窗保存始终可见且关闭后保留列表焦点", async (page) => {
    await navigateDesktop(page, "号码管理");
    await page.setViewportSize({ width: 390, height: 600 });
    await page.getByRole("button", { name: "添加号码", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "添加号码", exact: true });
    await editor.waitFor();
    const save = editor.getByRole("button", { name: "保存号码", exact: true });
    for (const scroll of [0, 10000]) {
      await editor.locator(".editor-scroll").evaluate((el, y) => {
        el.scrollTop = y;
      }, scroll);
      const rect = await save.boundingBox();
      assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= 600, "保存按钮不应随长表单滚出屏幕");
    }
    await page.screenshot({ path: "release/screenshots/iteration-phone-mobile.png" });
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "添加号码");
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent?.trim()),
      "添加号码",
    );
  });
  await scenario("手机主导航单行且列表操作触摸区域足够", async (page) => {
    assert.equal(
      await page.getByRole("button", { name: "打开菜单", exact: true }).isVisible(),
      false,
    );
    await navigateDesktop(page, "域名");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByRole("banner").count(), 1, "手机不应出现重复的品牌栏");
    for (const name of ["全部域名", "卡片视图", "表格视图", "关系图", "批量整理"]) {
      const rect = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(rect && rect.height >= 44 && rect.width >= 44, `${name}触摸区域应至少44px`);
    }
    await page.getByRole("button", { name: "打开菜单", exact: true }).click();
    await nav(page)
      .getByRole("button", { name: /^文档资产/ })
      .click();
    await page.getByRole("button", { name: "添加文档", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
  });
  await scenario("首页常用操作优先于统计，无服务器时不显示大空面板", async (page) => {
    const quick = page.getByRole("heading", { name: "常用操作", exact: true });
    const summary = page.getByRole("region", { name: "资产摘要", exact: true });
    const quickBox = await quick.boundingBox();
    const summaryBox = await summary.boundingBox();
    assert.ok(quickBox && summaryBox && quickBox.y < summaryBox.y, "常用操作应优先于资产统计");
    assert.equal(await page.getByText("尚未添加服务器", { exact: true }).count(), 0);
    await page.screenshot({ path: "release/screenshots/iteration-home-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "release/screenshots/iteration-home-mobile.png" });
  });
} finally {
  await browser.close();
}
const failed = results.filter((result) => !result.ok);
console.log(
  JSON.stringify({
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
  }),
);
if (failed.length) process.exitCode = 1;
