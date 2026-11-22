import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

await mkdir("release/screenshots", { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "zh-CN",
  viewport: { width: 1280, height: 850 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const errors = [];
const fixture = {
  servers: [],
  domains: [],
  mailboxes: [],
  secrets: [],
  certs: [],
  phoneNumbers: [],
  links: [],
  activity: [],
  aiAssets: ["a", "b"].map((id) => ({
    id: `qa-ai-${id}`,
    name: `号码验收账号 ${id.toUpperCase()}`,
    provider: "Test",
    plan: "Test",
    accountEmail: `${id}@example.test`,
    keyHint: "",
    monthlyUsd: 0,
    monthlyUsdKnown: false,
    usagePct: 0,
    renewsAt: "",
    status: "online",
    notes: "",
    tags: [],
  })),
};
await context.addInitScript((state) => {
  if (!localStorage.getItem("phone-qa-seeded")) {
    localStorage.setItem("sinan-assets-v1", JSON.stringify({ state, version: 0 }));
    localStorage.setItem(
      "sinan-settings-v1",
      JSON.stringify({
        state: { theme: "light", language: "zh", assetLayout: "cards", zoomPercent: 100 },
        version: 0,
      }),
    );
    localStorage.setItem("phone-qa-seeded", "true");
  }
}, fixture);
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
const row = () => page.locator("[data-phone-id]").filter({ hasText: "+1 555 100 2000" });
try {
  await page.goto("http://127.0.0.1:8080/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.locator('[data-app-ready="true"]').waitFor({ timeout: 90000 });
  await navigateDesktop(page, "号码管理");
  await page.getByText("还没有保存号码", { exact: true }).waitFor();
  await page.getByRole("button", { name: "添加号码", exact: true }).click();
  const form = page.getByRole("form", { name: "添加号码", exact: true });
  await form.getByRole("textbox", { name: "号码", exact: true }).fill("+1 555 100 2000");
  await form.getByRole("textbox", { name: "号码名称", exact: true }).fill("测试主号码");
  await form.getByRole("textbox", { name: "号码服务商", exact: true }).fill("Example carrier");
  await form.getByLabel("号码到期日", { exact: true }).fill("2020-01-01");
  await form.getByRole("checkbox", { name: /号码验收账号 A/ }).check();
  await form.getByRole("checkbox", { name: /号码验收账号 B/ }).check();
  await form.getByRole("button", { name: "保存号码", exact: true }).click();
  await row().waitFor();
  let data = await stored();
  assert.deepEqual(data.phoneNumbers[0].subscriptionIds, ["qa-ai-a", "qa-ai-b"]);
  assert.ok(await row().getByText("已到期", { exact: true }).isVisible());

  await row().getByRole("button", { name: "复制号码 +1 555 100 2000", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "+1 555 100 2000");
  await row().getByRole("button", { name: "编辑号码 +1 555 100 2000", exact: true }).click();
  await page
    .getByRole("textbox", { name: "号码备注", exact: true })
    .fill("编辑后保留原到期日与两个绑定");
  await page.getByRole("button", { name: "保存号码", exact: true }).click();
  data = await stored();
  assert.equal(data.phoneNumbers[0].expiresAt, "2020-01-01");
  assert.equal(data.phoneNumbers[0].notes, "编辑后保留原到期日与两个绑定");
  assert.equal(data.phoneNumbers[0].subscriptionIds.length, 2);

  await page.keyboard.press("Control+n");
  await page.getByRole("form", { name: "添加号码", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "号码", exact: true }).fill("+44 7700 900 555");
  await page.getByRole("button", { name: "保存号码", exact: true }).click();
  assert.equal((await stored()).phoneNumbers.length, 2);
  await page.getByRole("textbox", { name: "搜索号码", exact: true }).fill("1555100");
  await page.waitForFunction(() => document.querySelectorAll("[data-phone-id]").length === 1);
  assert.equal(await page.locator("[data-phone-id]").count(), 1);
  await page.getByRole("textbox", { name: "搜索号码", exact: true }).fill("");
  await page.getByRole("combobox", { name: "到期筛选", exact: true }).click();
  await page.getByRole("option", { name: "未填到期日", exact: true }).click();
  assert.equal(await page.locator("[data-phone-id]").count(), 1);
  assert.ok(
    await page
      .locator("[data-phone-id]")
      .getByText("+44 7700 900 555", { exact: true })
      .isVisible(),
  );
  await page.getByRole("combobox", { name: "到期筛选", exact: true }).click();
  await page.getByRole("option", { name: "全部号码", exact: true }).click();
  await page.screenshot({ path: "release/screenshots/phone-desktop.png" });

  await navigateDesktop(page, "AI 订阅");
  await page.locator('[data-asset-id="qa-ai-a"]').click();
  await page.getByRole("button", { name: "解绑号码 +1 555 100 2000", exact: true }).click();
  assert.deepEqual(
    (await stored()).phoneNumbers.find((record) => record.number === "+1 555 100 2000")
      .subscriptionIds,
    ["qa-ai-b"],
  );
  await page.getByRole("combobox", { name: "选择已保存的号码", exact: true }).click();
  await page.getByRole("option", { name: "+1 555 100 2000 · 测试主号码", exact: true }).click();
  await page.getByRole("button", { name: "关联号码", exact: true }).click();
  assert.equal(
    (await stored()).phoneNumbers.find((record) => record.number === "+1 555 100 2000")
      .subscriptionIds.length,
    2,
  );
  await page.getByRole("button", { name: "管理号码", exact: true }).click();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-app-ready="true"]').waitFor();
  await navigateDesktop(page, "号码管理");
  await page.locator("[data-phone-id]").first().waitFor();
  assert.equal(await page.locator("[data-phone-id]").count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "release/screenshots/phone-mobile.png" });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await page.getByRole("button", { name: "删除号码 +44 7700 900 555", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  assert.equal((await stored()).phoneNumbers.length, 1);
  assert.equal((await stored()).aiAssets.length, 2);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "create",
          "multiple-bindings",
          "edit-preserves-fields",
          "copy",
          "keyboard-create",
          "number-search",
          "expiry-filter",
          "account-unlink-and-rebind",
          "reload",
          "mobile",
          "delete-preserves-accounts",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: "release/screenshots/phone-failure.png" });
  console.log(
    JSON.stringify({ body: (await page.locator("body").innerText()).slice(0, 4000), errors }),
  );
  throw error;
} finally {
  await browser.close();
}
