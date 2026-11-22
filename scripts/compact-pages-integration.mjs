import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { demoSnapshot } from "../electron/services/demo.mjs";
import { navigateDesktop } from "./navigation-helper.mjs";

// 合成工作区验证紧凑页头、按需说明及首屏数据，禁止连接外部服务。
const url = process.env.NANPAD_QA_URL;
assert.ok(url, "请指定隔离预览地址 NANPAD_QA_URL");
const snapshot = demoSnapshot();
for (const [index, domain] of snapshot.domains.entries())
  Object.assign(domain, {
    name: `domain-${index}.example.test`,
    registrar: "测试注册商",
    dns: "Cloudflare",
    expiresAt: "2028-12-01",
    autoRenew: true,
    tags: index === 0 ? [...domain.tags, "审核样例"] : domain.tags,
  });
snapshot.servers = [];
snapshot.services = [
  {
    id: "compact-payment",
    name: "差旅卡（测试）",
    category: "custom",
    status: "online",
    provider: "Wise",
    tags: [],
    card: {
      kind: "payment",
      network: "Visa",
      formFactor: "虚拟卡",
      last4: "4242",
      expiryMonth: "2028-02",
    },
  },
];
const browser = await chromium.launch();
const errors = [],
  results = [];
await mkdir("screenshots", { recursive: true });
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === new URL(url).origin
        ? route.continue()
        : route.abort(),
    );
    await context.addInitScript(
      ({ snapshot, theme }) => {
        if (localStorage.getItem("compact-test-seeded")) return;
        localStorage.setItem("sinan-assets-v1", JSON.stringify({ version: 0, state: snapshot }));
        localStorage.setItem(
          "sinan-settings-v1",
          JSON.stringify({
            version: 0,
            state: {
              theme,
              language: "zh",
              motionMode: "off",
              sidebarCollapsed: false,
              assetLayout: "cards",
              quickStartHidden: true,
            },
          }),
        );
        localStorage.setItem("compact-test-seeded", "true");
      },
      { snapshot, theme },
    );
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator("[data-app-ready=true]").waitFor();
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [id, label] of [
        ["overview", "资产总览"],
        ["domains", "域名"],
        ["cards", "U 卡与支付卡"],
        ["esims", "eSIM 卡"],
        ["renewals", "费用与续费"],
        ["phones", "号码管理"],
        ["mail", "邮箱"],
        ["vault", "密钥库"],
        ["docs", "文档资产"],
      ]) {
        await navigateDesktop(page, label);
        await page.waitForFunction(
          () =>
            ![...document.querySelectorAll("main [role=status]")].some(
              (n) => n.textContent.trim() === "正在加载…",
            ),
        );
        assert.equal(await page.locator(".depth-hero").count(), 0);
        if (id === "docs") {
          const search = page.getByRole("textbox", { name: "搜索文档", exact: true });
          await search.fill("仅用于验收");
          await page.getByRole("button", { name: "清除搜索", exact: true }).click();
          assert.equal(await search.inputValue(), "");
          assert.equal(await search.evaluate((input) => input === document.activeElement), true);
        } else {
          const help = page.getByRole("button", { name: "使用说明", exact: true });
          try {
            await help.click({ timeout: 10000 });
          } catch (error) {
            console.error(
              JSON.stringify({
                id,
                width,
                theme,
                errors,
                body: (await page.locator("body").innerText()).slice(-2200),
              }),
            );
            await page.screenshot({ path: "screenshots/compact-pages-failure.png" });
            throw error;
          }
          const content = page.locator(".page-help-content");
          await content.waitFor();
          const rect = await content.boundingBox();
          assert(rect.x >= 0 && rect.x + rect.width <= width + 1, `${id} 说明超出窗口`);
          assert.ok((await content.innerText()).trim().length > 5);
          await page.keyboard.press("Escape");
          await content.waitFor({ state: "detached" });
          // Radix 在卸载后的下一帧恢复焦点，等待实际焦点状态。
          await page.waitForFunction(
            () => document.activeElement?.getAttribute("aria-label") === "使用说明",
          );
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        if (id === "cards") assert.equal(await page.locator(".managed-card-entry").count(), 1);
        if (id === "domains" && [1440, 390].includes(width)) {
          const tags = page.getByRole("button", { name: "标签筛选", exact: true });
          assert.equal(await tags.getAttribute("aria-expanded"), "false");
          await tags.click();
          const panel = page.getByRole("dialog", { name: "标签筛选", exact: true });
          const tagSearch = panel.getByRole("textbox", { name: "搜索标签", exact: true });
          await tagSearch.fill("审核");
          const option = panel.getByRole("button", { name: "审核样例", exact: true });
          await option.click();
          assert.equal(await option.getAttribute("aria-pressed"), "true");
          if (theme === "light")
            await page.screenshot({ path: `screenshots/compact-${theme}-${width}-tag-filter.png` });
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "detached" });
          assert.equal(await tags.getAttribute("data-selected"), "true");
          assert.equal(await page.locator(".asset-card-grid article").count(), 1);
          const search = page.getByRole("textbox", { name: "筛选当前列表", exact: true });
          await search.fill("not-a-domain.example.test");
          assert.equal(await page.locator(".asset-card-grid article").count(), 0);
          await page.getByRole("button", { name: "重置筛选", exact: true }).click();
          assert.equal(await search.inputValue(), "");
          assert.equal(
            await page.locator(".asset-card-grid article").count(),
            snapshot.domains.length,
          );
        }
        if (id === "renewals") {
          const calendar = page.getByRole("region", { name: "续费日历", exact: true });
          const notes = page.getByRole("region", { name: "备忘提醒", exact: true });
          assert.ok((await calendar.boundingBox()).y < (await notes.boundingBox()).y);
          if (width >= 1024) {
            const empty = await page.locator(".reminder-empty").boundingBox();
            assert.ok(empty.height < 150, "空提醒不应挤占续费数据");
          }
          if (width === 390) {
            const jumps = page.getByRole("navigation", { name: "费用与续费版块", exact: true });
            await jumps.getByRole("button", { name: "备忘提醒", exact: true }).click();
            assert.equal(
              await notes.evaluate((section) => section === document.activeElement),
              true,
            );
            await notes.getByRole("button", { name: "新建提醒", exact: true }).click();
            const editor = page.getByRole("dialog", { name: "新建提醒", exact: true });
            await editor.waitFor();
            await page.keyboard.press("Escape");
            await editor.waitFor({ state: "detached" });
            await page.locator(".workspace-scroll").evaluate((node) => {
              node.scrollTop = 0;
            });
          }
        }
        if (id === "overview") {
          assert.equal(await page.locator(".overview-summary-line button").count(), 4);
          assert.ok(
            await page
              .locator(".overview-data-grid")
              .evaluate((priority) =>
                Boolean(
                  priority.compareDocumentPosition(
                    document.querySelector(".overview-summary-line"),
                  ) & Node.DOCUMENT_POSITION_FOLLOWING,
                ),
              ),
          );
        }
        if ([1440, 390].includes(width))
          await page.screenshot({ path: `screenshots/compact-${theme}-${width}-${id}.png` });
        results.push({ theme, width, id });
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    "screenshots/compact-pages-receipt.json",
    JSON.stringify({ passed: true, results, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, scenarios: results.length, errors }));
} finally {
  await browser.close();
}
