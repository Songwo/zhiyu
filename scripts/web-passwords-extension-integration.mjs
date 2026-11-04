import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { webResearchFixture } from "./web-research-fixture.mjs";

const f = await webResearchFixture({ built: true });
const profile = await mkdtemp(join(tmpdir(), "zhiyu-web-extension-"));
const site = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    '<!doctype html><html><head><meta charset="utf-8"><title>合成登录网站</title></head><body><h1>合成登录网站</h1><form onsubmit="event.preventDefault()"><input aria-label="网站账号" autocomplete="username"><input aria-label="网站密码" type="password" autocomplete="current-password"><button>登录</button></form><p>合成可见正文</p></body></html>',
  );
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteBase = `http://127.0.0.1:${site.address().port}`;
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  args: ["--enable-unsafe-extension-debugging"],
  ignoreDefaultArgs: ["--disable-extensions"],
  viewport: { width: 1360, height: 900 },
  locale: "zh-CN",
  reducedMotion: "reduce",
});
const errors = [],
  checks = [];
await mkdir("screenshots", { recursive: true });
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve(`release/v${version}/zhiyu-browser-extension`),
  });
  await context.addCookies([{ name: "zhiyu_session", value: f.cookie.split("=")[1], url: f.base }]);
  const app = await context.newPage();
  app.on("pageerror", (error) => errors.push(error.message));
  await app.goto(f.base);
  await app.locator('[data-app-ready="true"]').waitFor();
  await app.getByRole("button", { name: "创建密钥库", exact: true }).click();
  const gate = app.getByRole("dialog", { name: "设置主密码", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill("web-csv-master-2026");
  await gate.getByLabel("再输一次", { exact: true }).fill("web-csv-master-2026");
  await gate.getByRole("button", { name: "创建", exact: true }).click();
  await gate.waitFor({ state: "detached", timeout: 30000 });
  await app.getByRole("button", { name: "更多", exact: true }).click();
  await app.getByRole("menuitem", { name: "密钥库", exact: true }).click();
  await app.getByRole("button", { name: "浏览器密码", exact: true }).click();
  const transfer = app.getByRole("dialog", { name: "浏览器密码", exact: true });
  const chooser = app.waitForEvent("filechooser");
  await transfer.getByRole("button", { name: "选择 CSV 文件", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "synthetic.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `name,url,username,password,note\r\nExample,${siteBase},sample,synthetic-csv-password,\r\n`,
    ),
  });
  await transfer.getByRole("table").waitFor();
  assert.equal((await transfer.innerText()).includes("synthetic-csv-password"), false);
  await transfer.getByRole("button", { name: "导入 1 个账号", exact: true }).click();
  await transfer.getByText(/已导入/).waitFor();
  await transfer.getByRole("button", { name: "导出到浏览器", exact: true }).click();
  await transfer
    .getByRole("checkbox", { name: "我了解明文风险，导入浏览器后会删除 CSV 文件。", exact: true })
    .check();
  const download = app.waitForEvent("download");
  await transfer.getByRole("button", { name: "导出 CSV 文件", exact: true }).click();
  const file = await download;
  assert.equal(
    (await readFile(await file.path(), "utf8")).includes("synthetic-csv-password"),
    true,
  );
  assert.equal(
    (await readFile(join(f.root, "web/workspace/vault.enc"), "utf8")).includes(
      "synthetic-csv-password",
    ),
    false,
  );
  checks.push("CSV 浏览器本地导入、无密码预览、明确确认导出、密文落盘");
  await transfer.getByRole("button", { name: "完成", exact: true }).click();
  await app.keyboard.press("Control+,");
  const settings = app.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "浏览器插件", exact: true }).click();
  await settings.getByRole("button", { name: "生成配对码", exact: true }).click();
  const code = await settings.getByLabel("配对码", { exact: true }).inputValue();
  const website = await context.newPage();
  website.on("pageerror", (error) => errors.push(error.message));
  await website.goto(siteBase + "/login");
  const popup = await context.newPage();
  popup.on("pageerror", (error) => errors.push(error.message));
  // 实际工具栏弹窗不占当前网页标签；这里用独立标签承载弹窗并保持同样的目标网页语义。
  await popup.addInitScript((base) => {
    const query = globalThis.chrome.tabs.query.bind(globalThis.chrome.tabs);
    globalThis.chrome.tabs.query = async (options) =>
      options?.active
        ? (await query({})).filter((tab) => tab.url?.startsWith(base))
        : query(options);
  }, siteBase);
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator(".workspace-choice summary").click();
  await popup.getByLabel("连接方式", { exact: true }).selectOption("web");
  await popup.getByLabel("Web 工作区地址", { exact: true }).fill(f.base);
  await popup.getByRole("button", { name: "保存连接方式", exact: true }).click();
  await popup.getByText("连接方式已保存，请重新配对", { exact: true }).waitFor();
  await popup.getByLabel("桌面配对码", { exact: true }).fill(code);
  await popup.getByRole("button", { name: "连接", exact: true }).click();
  await popup.getByText("已连接 Web 工作区", { exact: true }).waitFor();
  await popup.locator(".saved-account").first().waitFor();
  assert.equal(await website.getByLabel("网站密码").inputValue(), "");
  await popup.locator(".saved-account").first().click();
  await website.waitForFunction(
    () => document.querySelector('input[type="password"]').value === "synthetic-csv-password",
  );
  await popup.getByRole("button", { name: "保存当前文档", exact: true }).click();
  await popup.getByText(/已保存当前可见正文|已保存来源链接/).waitFor();
  const stored = await f.call("/api/web/store", { method: "GET", cookie: f.cookie });
  assert.equal((await stored.text()).includes("synthetic-csv-password"), false);
  checks.push("真实 MV3 扩展通过已解锁 Web 标签页配对、候选与明确填写、文档保存");
  await popup.screenshot({ path: "screenshots/web-extension-popup.png" });
  await app.screenshot({ path: "screenshots/web-extension-settings.png" });
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await app.getByRole("button", { name: "锁定密钥库", exact: true }).click();
  await popup.reload();
  await popup
    .getByText(/密钥库已锁定|连接已失效/)
    .first()
    .waitFor();
  assert.deepEqual(errors, []);
  checks.push("锁库立即撤销插件权限，不保存明文到服务器");
  console.log(JSON.stringify({ passed: true, checks, errors }, null, 2));
} catch (error) {
  for (const page of context.pages())
    if (!page.isClosed()) {
      console.error((await page.locator("body").innerText()).slice(-5000));
    }
  throw error;
} finally {
  await context.close();
  await f.close();
  site.closeAllConnections();
  await new Promise((resolve) => site.close(resolve));
  assert.ok(profile.startsWith(join(tmpdir(), "zhiyu-web-extension-")));
  await rm(profile, { recursive: true, force: true });
}
