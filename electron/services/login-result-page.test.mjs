import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { loginResultPage } from "./login-result-page.mjs";

test("登录回调页转义文案，成功与失败明确区分，CSP 不允许任意脚本", () => {
  const page = loginResultPage({ message: '<script>secret()</script>"&', success: true });
  assert.ok(page.html.includes("&lt;script&gt;secret()&lt;/script&gt;&quot;&amp;"));
  assert.ok(!page.html.includes("<script>secret()"));
  assert.match(page.html, /回到知屿，确认绑定/);
  assert.match(page.csp, /default-src 'none'/);
  assert.ok(!page.csp.includes("unsafe-inline"));
  assert.notEqual(page.csp, loginResultPage({ message: "合成提示" }).csp);
  assert.match(loginResultPage({ message: "合成错误" }).html, /本次登录未完成/);
});

test("真实浏览器显示登录回调、移除查询参数、关闭失败提示及窄屏深色布局", async () => {
  const server = createServer((_req, res) => {
    const page = loginResultPage({
      message: "身份验证成功，请返回知屿确认绑定。此页面可以关闭。",
      success: true,
    });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": page.csp,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    res.end(page.html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  const errors = [];
  try {
    await mkdir("screenshots", { recursive: true });
    for (const [name, width, height, colorScheme] of [
      ["desktop", 1360, 900, "light"],
      ["mobile-dark", 390, 844, "dark"],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme });
      await context.addInitScript(() => {
        window.close = () => {};
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const requests = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.goto(
        `http://127.0.0.1:${server.address().port}/oauth/zhiyu/callback?code=SYNTHETIC-ONLY&state=SYNTHETIC-ONLY`,
      );
      await page.getByRole("heading", { name: "身份验证成功", exact: true }).waitFor();
      assert.equal(new URL(page.url()).search, "");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "关闭此页", exact: true })
          .evaluate((el) => el.getBoundingClientRect().height >= 44),
        true,
      );
      await page.getByRole("button", { name: "关闭此页", exact: true }).click();
      await page
        .getByText("浏览器未允许自动关闭，请手动关闭此标签页，然后返回知屿。", { exact: true })
        .waitFor();
      assert.equal(requests.length, 1, "回调页不下载外部资源或发起额外接口请求");
      await page.screenshot({ path: `screenshots/login-result-${name}.png` });
      await context.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
