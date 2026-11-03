import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { expandNavigationGroups } from "./navigation-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "zhiyu-sidebar-centering-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
await writeFile(
  join(directory, "local-usage.json"),
  JSON.stringify({ version: 1, enabled: false, checkpoints: [], events: [], records: [] }),
);
let instance;
let page;
const measurements = [];
try {
  // 测试按中文标签定位，固定语言，避免跟随 CI 主机的系统语言。
  instance = await electron.launch({
    args: [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  page = await instance.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await completeOnboarding(page);
  await expandNavigationGroups(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  const sidebar = page.locator("#primary-navigation");
  assert.equal(await sidebar.getByRole("button", { name: "关系图", exact: true }).count(), 0);
  assert.equal(await sidebar.getByRole("button", { name: "设置", exact: true }).count(), 0);
  await page
    .locator("header.app-titlebar")
    .getByRole("button", { name: "系统设置…", exact: true })
    .click();
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "detached" });
  await sidebar.getByRole("button", { name: "锁定密钥库", exact: true }).click();
  await sidebar.getByRole("button", { name: "解锁密钥库", exact: true }).waitFor();
  await sidebar.getByRole("button", { name: "文档资产", exact: true }).click();
  await mkdir("screenshots", { recursive: true });
  for (const zoom of [100, 125, 150]) {
    await page.evaluate((zoom) => window.sinan.display.set(zoom), zoom);
    for (const collapsed of [true, false, true]) {
      const toggle = page.getByRole("button", {
        name: collapsed ? "收起主导航" : "展开主导航",
        exact: true,
      });
      if (await toggle.isVisible()) await toggle.click();
      await page.waitForFunction(
        (collapsed) =>
          document.querySelector("#primary-navigation").dataset.collapsed === String(collapsed),
        collapsed,
      );
      const geometry = await sidebar.evaluate((root) => {
        const rect = root.getBoundingClientRect();
        const border = parseFloat(getComputedStyle(root).borderRightWidth);
        const nav = root.querySelector("nav");
        const names = ["文档资产", "用量记录", "解锁密钥库"];
        return {
          railCenter: rect.left + (rect.width - border) / 2,
          scrolls: nav.scrollHeight > nav.clientHeight,
          items: names.map((name) => {
            const button = root.querySelector(`button[aria-label="${name}"]`);
            const box = button.getBoundingClientRect();
            const icon = button.querySelector("svg").getBoundingClientRect();
            return {
              name,
              buttonCenter: box.left + box.width / 2,
              iconCenter: icon.left + icon.width / 2,
              width: box.width,
              height: box.height,
            };
          }),
        };
      });
      if (collapsed) {
        for (const item of geometry.items) {
          assert.ok(
            Math.abs(item.buttonCenter - item.iconCenter) < 1,
            `${zoom}% ${item.name}:图标与背景中心一致 ${JSON.stringify(item)}`,
          );
          assert.ok(
            Math.abs(item.buttonCenter - geometry.railCenter) < 1,
            `${zoom}% ${item.name}:按钮在rail居中 ${JSON.stringify(geometry)}`,
          );
          assert.ok(
            item.width >= 44 && item.height >= 44,
            `${zoom}% ${item.name}:点击区域至少44px`,
          );
        }
      }
      measurements.push({ zoom, collapsed, ...geometry });
    }
    await sidebar.getByRole("button", { name: "解锁密钥库", exact: true }).hover();
    await page.getByRole("tooltip").filter({ hasText: "解锁密钥库" }).waitFor();
    await page.mouse.move(200, 100);
    for (const theme of ["light", "dark"]) {
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page.getByRole("button", { name: "切换主题外观", exact: true }).click();
      await page.screenshot({ path: `screenshots/sidebar-centered-${zoom}-${theme}.png` });
    }
  }
  assert.ok(
    measurements.some((row) => row.scrolls),
    "覆盖存在滚动条的导航",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ ok: true, zooms: [100, 125, 150], themes: ["light", "dark"], measurements }),
  );
} catch (error) {
  await page?.screenshot({ path: "screenshots/sidebar-centering-failure.png" }).catch(() => {});
  throw error;
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
}
