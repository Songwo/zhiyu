import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { demoSnapshot } from "../electron/services/demo.mjs";
import { expandNavigationGroups } from "./navigation-helper.mjs";

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
        ["renewals", "费用与续费"],
        ["phones", "号码管理"],
      ]) {
        if (width < 768) await page.getByRole("button", { name: "打开菜单", exact: true }).click();
        await expandNavigationGroups(page);
        await page
          .getByRole("navigation", { name: "主导航", exact: true })
          .getByRole("button", { name: label, exact: true })
          .click();
        await page.waitForFunction(
          () =>
            ![...document.querySelectorAll("main [role=status]")].some(
              (n) => n.textContent.trim() === "正在加载…",
            ),
        );
        assert.equal(await page.locator(".depth-hero").count(), 0);
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
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        if (id === "cards") assert.equal(await page.locator(".managed-card-entry").count(), 1);
        if (id === "renewals" && width >= 1024) {
          const empty = await page.locator(".reminder-empty").boundingBox();
          assert.ok(empty.height < 150, "空提醒不应挤占续费数据");
        }
        if (id === "overview")
          assert.equal(await page.locator(".overview-shortcuts button").count(), 4);
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
