import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createPreviewServer, exportPreview } from "./installer-preview-server.mjs";

test("安装设计预览：设置、权限、异常恢复和完成流程", async (t) => {
  const server = createPreviewServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const screenshots = resolve("screenshots/installer-preview");
  await mkdir(screenshots, { recursive: true });
  await page.goto(`http://127.0.0.1:${server.address().port}/installer-preview/`);

  await t.test("默认目录、快捷方式、自启和实际页面渲染", async () => {
    assert.equal(await page.locator("#directory").inputValue(), "D:\\Apps\\Zhiyu");
    assert.equal(await page.locator("#desktop").isChecked(), true);
    assert.equal(await page.locator("#startup").isChecked(), false);
    assert.equal(await page.locator("#setup").isVisible(), true);
    await page.screenshot({ path: resolve(screenshots, "setup.png"), fullPage: true });
  });
  await t.test("非法路径被拦截，更改路径和安装范围生效", async () => {
    for (const invalid of [
      "",
      "D:\\",
      "relative",
      "D:\\Apps\\..",
      "D:\\Apps\\CON",
      "D:\\bad?path",
    ]) {
      await page.locator("#directory").fill(invalid);
      assert.equal(await page.locator("#start").isDisabled(), true, invalid);
    }
    await page.locator("#browse").click();
    await page.locator("#custom-path").fill("E:\\My Apps\\知屿");
    await page.getByRole("button", { name: "使用此位置" }).click();
    // dialog 的 close 事件异步触发，等待页面完成路径提交后再核对按钮状态。
    await page.waitForFunction(
      () => document.querySelector("#directory").value === "E:\\My Apps\\知屿",
    );
    assert.equal(await page.locator("#start").isEnabled(), true);
    await page.locator('input[value="all"]').check();
    assert.match(await page.locator("#permission-text").textContent(), /管理员授权/);
    await page.locator('input[value="user"]').check();
    await page.locator("#scenario").selectOption("no-drive");
    assert.match(await page.locator("#directory").inputValue(), /^C:/);
  });
  await t.test("暂停、取消确认与保留安装偏好", async () => {
    await page.locator("#startup").check();
    await page.locator("#desktop").uncheck();
    await page.locator("#start").click();
    await page.waitForFunction(
      () => Number(document.querySelector("#progress-number").textContent) > 0,
    );
    await page.locator("#pause").click();
    const value = await page.locator("#progress-number").textContent();
    await page.waitForTimeout(550);
    assert.equal(await page.locator("#progress-number").textContent(), value);
    await page.locator("#cancel").click();
    await page.locator("#keep").click();
    assert.equal(await page.locator("#pause").textContent(), "继续");
    await page.locator("#pause").click();
    await page.locator("#cancel").click();
    await page.getByRole("button", { name: "退出安装", exact: true }).click();
    assert.equal(await page.locator("#setup").isVisible(), true);
    assert.equal(await page.locator("#startup").isChecked(), true);
  });
  await t.test("网络中断后重试，完成页反映用户选择", async () => {
    await page.locator("#scenario").selectOption("offline");
    await page.locator("#start").click();
    await page.locator("#retry").waitFor({ state: "visible" });
    assert.equal(await page.locator("#install-error").isVisible(), true);
    await page.screenshot({ path: resolve(screenshots, "interrupted.png"), fullPage: true });
    await page.locator("#retry").click();
    await page.locator("#pause").click();
    await page.screenshot({ path: resolve(screenshots, "installing.png"), fullPage: true });
    await page.locator("#pause").click();
    await page.locator("#done").waitFor({ state: "visible", timeout: 20000 });
    assert.equal(await page.locator("#result-desktop").textContent(), "不创建");
    assert.equal(await page.locator("#result-startup").textContent(), "开启");
    assert.equal(await page.locator("#result-path").textContent(), "D:\\Apps\\Zhiyu");
    const centers = await page.evaluate(() =>
      ["launch", "restart"].map((id) => {
        const button = document.getElementById(id);
        const range = document.createRange();
        range.selectNodeContents(button.firstChild);
        const label = range.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        return { label: label.x + label.width / 2, button: bounds.x + bounds.width / 2 };
      }),
    );
    for (const center of centers)
      assert.ok(Math.abs(center.label - center.button) < 1, "两个按钮的文字须共用中央轴线");
    await page.screenshot({ path: resolve(screenshots, "done.png"), fullPage: true });
    await page.locator("#launch").click();
    assert.equal(await page.locator("#launch-dialog").isVisible(), true);
    await page.getByRole("button", { name: "知道了" }).click();
  });
  await t.test("移动端与减少动态效果，无控制台错误", async () => {
    await page.locator("#restart").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: resolve(screenshots, "mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(
      (await fetch(`http://127.0.0.1:${server.address().port}/package.json`)).status,
      404,
    );
  });
  await t.test("独立 HTML 可直接打开，图标与交互无外部依赖", async () => {
    const destination = resolve(screenshots, "知屿安装体验.html");
    await exportPreview(destination);
    await page.goto(pathToFileURL(destination).href);
    await page.locator("#skip").click();
    assert.equal(await page.locator("#done").isVisible(), true);
    assert.equal(
      await page.locator(".brand img").evaluate((img) => img.complete && img.naturalWidth > 0),
      true,
    );
    assert.deepEqual(errors, []);
  });
});
