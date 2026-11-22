import { navigateDesktop, openDesktopDirectory } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const count = Number(process.env.NANPAD_QA_RECORDS || 10000);
const browser = await chromium.launch({ headless: true });
await mkdir("release/screenshots", { recursive: true });
const context = await browser.newContext({
  locale: "zh-CN",
  viewport: { width: 1280, height: 850 },
});
await context.addInitScript((size) => {
  if (localStorage.getItem("usability-qa-seeded")) return;
  const accounts = ["a", "b"].map((id) => ({
    id: `ux-ai-${id}`,
    name: `体验账号 ${id}`,
    accountEmail: `${id}@example.test`,
    provider: "Test",
    plan: "Test",
    keyHint: "",
    monthlyUsd: 0,
    monthlyUsdKnown: false,
    usagePct: 0,
    renewsAt: "",
    status: "online",
    notes: "",
    tags: [],
  }));
  const phoneNumbers = Array.from({ length: size }, (_, i) => ({
    id: `ux-phone-${i}`,
    number: `+44 7700 ${String(i).padStart(6, "0")}`,
    label: `号码 ${String(i).padStart(6, "0")}`,
    provider: "Example",
    expiresAt: i < 2 ? "2020-01-01" : "",
    notes: "",
    subscriptionIds: i === 0 ? ["ux-ai-a"] : [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  }));
  localStorage.setItem(
    "sinan-assets-v1",
    JSON.stringify({
      version: 0,
      state: {
        servers: [],
        domains: [],
        mailboxes: [],
        certs: [],
        secrets: [],
        links: [],
        activity: [],
        aiAssets: accounts,
        phoneNumbers,
      },
    }),
  );
  localStorage.setItem(
    "sinan-settings-v1",
    JSON.stringify({
      version: 0,
      state: { language: "zh", theme: "light", zoomPercent: 100, assetLayout: "cards" },
    }),
  );
  localStorage.setItem("usability-qa-seeded", "true");
}, count);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const nav = () => page.locator("aside:visible nav");
const waitCount = async (selector, size) =>
  page.waitForFunction(
    ({ selector, size }) => document.querySelectorAll(selector).length === size,
    { selector, size },
  );
try {
  await page.goto(process.env.NANPAD_QA_URL || "http://127.0.0.1:8080/", {
    waitUntil: "domcontentloaded",
  });
  await page.locator('[data-app-ready="true"]').waitFor();
  await navigateDesktop(page, "号码管理");
  await page.locator("[data-phone-id]").first().waitFor();
  const initialCards = await page.locator("[data-phone-id]").count();
  console.log(JSON.stringify({ records: count, initialCards }));
  assert.equal(initialCards, 50, "大列表只应挂载当前页的50张号码卡片");
  assert.equal(await page.getByRole("heading", { name: "号码管理", exact: true }).count(), 1);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.locator('[data-phone-id="ux-phone-50"]').waitFor();
  await page.getByRole("textbox", { name: "搜索号码", exact: true }).fill("447700000000");
  await waitCount("[data-phone-id]", 1);
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await waitCount("[data-phone-id]", 50);
  await page.locator('[data-phone-id="ux-phone-0"]').waitFor();

  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "搜索资产与操作", exact: true });
  await search.waitFor();
  assert.ok((await page.locator("[cmdk-item]").count()) <= 60);
  await search.fill(`447700${String(count - 1).padStart(6, "0")}`);
  await waitCount("[cmdk-item]", 1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await search.waitFor({ state: "detached" });
  await waitCount("[data-phone-id]", 1);
  await page.locator(`[data-phone-id="ux-phone-${count - 1}"]`).waitFor();

  await nav()
    .getByRole("button", { name: /^资产总览/ })
    .click();
  await page.getByRole("button", { name: /号码台账 · 2 项需要留意/ }).click();
  await waitCount("[data-phone-id]", 2);
  assert.match(
    await page.getByRole("combobox", { name: "到期筛选", exact: true }).innerText(),
    /需关注/,
  );
  const first = page.locator('[data-phone-id="ux-phone-0"]');
  await first.getByRole("button", { name: /查看订阅 体验账号 a/ }).click();
  const choosePhone = page.getByRole("combobox", { name: "选择已保存的号码", exact: true });
  await choosePhone.click();
  assert.ok((await page.getByRole("option").count()) <= 50);
  await page.keyboard.press("Escape");
  const lastNumber = `+44 7700 ${String(count - 1).padStart(6, "0")}`;
  await page.getByRole("textbox", { name: "搜索可关联号码", exact: true }).fill(lastNumber);
  await choosePhone.click();
  await page.getByRole("option", { name: new RegExp(lastNumber.replace(/[+]/g, "\\+")) }).click();
  await page.getByRole("button", { name: "关联号码", exact: true }).click();
  await page.getByRole("button", { name: `解绑号码 ${lastNumber}`, exact: true }).click();
  await page.getByRole("button", { name: "查看号码 +44 7700 000000", exact: true }).click();
  await waitCount("[data-phone-id]", 1);
  await first.getByRole("button", { name: "编辑号码 +44 7700 000000", exact: true }).click();
  const editor = page.getByRole("form", { name: "编辑号码", exact: true });
  await editor.getByRole("textbox", { name: "搜索关联订阅", exact: true }).fill("b@example.test");
  assert.equal(await editor.getByRole("checkbox").count(), 1);
  await editor.getByRole("checkbox", { name: /体验账号 b/ }).check();
  await editor.getByRole("button", { name: "保存号码", exact: true }).click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("sinan-assets-v1")).state.phoneNumbers.find(
      (phone) => phone.id === "ux-phone-0",
    ),
  );
  assert.deepEqual(saved.subscriptionIds, ["ux-ai-a", "ux-ai-b"]);

  await navigateDesktop(page, "号码管理");
  await page.getByRole("textbox", { name: "搜索号码", exact: true }).fill("没有这个号码");
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await waitCount("[data-phone-id]", 50);
  const directory = await openDesktopDirectory(page);
  assert.ok(await directory.getByRole("button", { name: "终端", exact: true }).isVisible());
  await page.keyboard.press("Escape");
  await directory.waitFor({ state: "detached" });
  await navigateDesktop(page, "号码管理");
  await page.locator('[data-phone-id="ux-phone-0"]').waitFor();
  await page.screenshot({ path: "release/screenshots/ux-polish-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.getByRole("navigation", { name: "快捷导航", exact: true });
  await mobile.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByRole("heading", { name: "文档资产", exact: true }).waitFor();
  await mobile.getByRole("button", { name: "号码", exact: true }).click();
  await page.getByRole("heading", { name: "号码管理", exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.locator('[data-phone-id="ux-phone-50"]').waitFor();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.locator('[data-phone-id="ux-phone-0"]').waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
    false,
  );
  await page.screenshot({ path: "release/screenshots/ux-polish-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("sinan-assets-v1"));
    saved.state.phoneNumbers = saved.state.phoneNumbers.slice(0, 51).map((phone, index) => ({
      ...phone,
      number: "+1 555 900 0000",
      subscriptionIds: index === 50 ? ["ux-ai-a"] : [],
    }));
    localStorage.setItem("sinan-assets-v1", JSON.stringify(saved));
  });
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.keyboard.press("Control+k");
  await search.fill("号码 000050");
  await waitCount("[cmdk-item]", 1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await search.waitFor({ state: "detached" });
  const duplicateTarget = page.locator('[data-phone-id="ux-phone-50"]');
  await duplicateTarget.waitFor();
  await waitCount("[data-phone-id]", 1);
  await duplicateTarget.getByRole("button", { name: /查看订阅 体验账号 a/ }).click();
  await page.getByRole("button", { name: "查看号码 +1 555 900 0000", exact: true }).click();
  await duplicateTarget.waitFor();
  await waitCount("[data-phone-id]", 1);
  await page.getByRole("button", { name: "查看全部号码", exact: true }).click();
  await waitCount("[data-phone-id]", 50);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await duplicateTarget.waitFor();
  assert.deepEqual(errors, []);
  const report = {
    ok: true,
    records: count,
    initialCards,
    maxSearchResults: 60,
    pagination: true,
    tailSearch: true,
    linkedAccounts: true,
    attentionFilter: true,
    mobileNavigation: true,
    mobilePagination: true,
    duplicateNumberNavigation: true,
    pageErrors: errors,
  };
  await writeFile("release/screenshots/ux-polish-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
