import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

await mkdir("release/screenshots", { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];
try {
  for (const dpi of process.env.NANPAD_QA_DPI
    ? [Number(process.env.NANPAD_QA_DPI)]
    : [1.25, 1.5, 1.75, 2]) {
    const context = await browser.newContext({
      locale: "zh-CN",
      deviceScaleFactor: dpi,
      viewport: { width: Math.floor(1920 / dpi), height: Math.floor(1080 / dpi) },
    });
    await context.addInitScript(() => {
      if (localStorage.getItem("phone-display-seeded")) return;
      localStorage.setItem(
        "sinan-settings-v1",
        JSON.stringify({ version: 0, state: { language: "zh", theme: "light", zoomPercent: 100 } }),
      );
      localStorage.setItem(
        "sinan-assets-v1",
        JSON.stringify({
          version: 0,
          state: {
            servers: [],
            domains: [],
            certs: [],
            mailboxes: [],
            aiAssets: [],
            secrets: [],
            links: [],
            phoneNumbers: [
              {
                id: "display-phone",
                number: "+44 7700 900 555",
                label: "高分屏验证号码",
                provider: "Example carrier",
                expiresAt: "2027-01-01",
                notes: "",
                subscriptionIds: [],
                createdAt: "2026-09-30T00:00:00.000Z",
                updatedAt: "2026-09-30T00:00:00.000Z",
              },
            ],
          },
        }),
      );
      localStorage.setItem("phone-display-seeded", "true");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:8080/", { waitUntil: "domcontentloaded" });
    await page.locator('[data-app-ready="true"]').waitFor({ timeout: 60000 });
    assert.equal(await page.evaluate(() => devicePixelRatio), dpi);
    await navigateDesktop(page, "号码管理");
    const phone = page.locator('[data-phone-id="display-phone"]');
    await phone.waitFor();
    for (const zoom of [100, 110, 125, 150]) {
      await page.keyboard.press("Control+,");
      const settings = page.getByRole("dialog", { name: "设置", exact: true });
      await settings
        .getByRole("group", { name: "界面大小", exact: true })
        .getByRole("button", { name: `${zoom}%`, exact: true })
        .click();
      await page.waitForFunction(
        (value) =>
          JSON.parse(localStorage.getItem("sinan-settings-v1")).state.zoomPercent === value,
        zoom,
      );
      assert.equal(
        await page.evaluate(() => Number(document.documentElement.style.zoom)),
        zoom / 100,
      );
      assert.equal(
        await settings
          .getByRole("button", { name: `${zoom}%`, exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await settings.getByRole("button", { name: "关闭", exact: true }).click();
      await settings.waitFor({ state: "hidden" });
      await phone.getByRole("button", { name: "编辑号码 +44 7700 900 555", exact: true }).click();
      const form = page.getByRole("form", { name: "编辑号码", exact: true });
      await form
        .getByRole("textbox", { name: "号码备注", exact: true })
        .fill(`DPI ${dpi * 100}%, app ${zoom}%`);
      await form.getByRole("button", { name: "保存号码", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      await phone.scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem("sinan-assets-v1")).state.phoneNumbers[0].notes,
        ),
        `DPI ${dpi * 100}%, app ${zoom}%`,
      );
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      assert.ok(
        widths.scroll <= widths.client + 1,
        `Horizontal overflow at DPI ${dpi}, zoom ${zoom}: ${JSON.stringify(widths)}`,
      );
      for (const name of [
        "复制号码 +44 7700 900 555",
        "编辑号码 +44 7700 900 555",
        "删除号码 +44 7700 900 555",
      ]) {
        await phone.getByRole("button", { name, exact: true }).click({ trial: true });
      }
      if (zoom === 150 || (dpi === 1.25 && zoom === 100))
        await page.screenshot({
          path: `release/screenshots/phone-dpi${dpi * 100}-zoom${zoom}.png`,
        });
      results.push({
        dpi: dpi * 100,
        zoom,
        viewport: page.viewportSize(),
        overflow: false,
        editSave: true,
        buttonsReachable: true,
      });
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-app-ready="true"]').waitFor();
    assert.equal(await page.evaluate(() => Number(document.documentElement.style.zoom)), 1.5);
    await page.keyboard.press("Control+0");
    await page.waitForFunction(() => Number(document.documentElement.style.zoom) === 1);
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("sinan-settings-v1")).state.zoomPercent,
      ),
      100,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  const verdict = {
    ok: true,
    simulatedDisplayScales: true,
    checks: results,
    persistenceAndReset: true,
    pageErrors: errors,
  };
  await writeFile(
    "release/screenshots/phone-display-matrix.json",
    JSON.stringify(verdict, null, 2),
  );
  console.log(JSON.stringify(verdict, null, 2));
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) {
    await page.screenshot({ path: "release/screenshots/phone-display-failure.png" });
    console.error(
      JSON.stringify({
        passed: results,
        layout: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          zoom: document.documentElement.style.zoom,
          options: [...document.querySelectorAll('[role="option"]')].map((el) => ({
            label: el.textContent,
            rect: el.getBoundingClientRect().toJSON(),
          })),
        })),
      }),
    );
  }
  throw error;
} finally {
  await browser.close();
}
