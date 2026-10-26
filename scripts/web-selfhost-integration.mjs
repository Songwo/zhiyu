// 自托管网页版端到端：首次设置 → 空白工作区 → 新建提醒 → 另一台设备登录看到同一份资料 → 退出登录。
// 使用真实构建产物（npm run web:build）与临时资料目录，不连接任何外部服务。
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createWebServer } from "../selfhost/server.mjs";

const root = await mkdtemp(join(tmpdir(), "zhiyu-web-e2e-"));
const web = await createWebServer({
  root,
  staticDir: resolve("dist-web"),
  log: { log() {}, error() {} },
  schedulePush: false,
});
await new Promise((r) => web.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${web.server.address().port}`;
const browser = await chromium.launch();
await mkdir("screenshots", { recursive: true });
const result = {};
const errors = [];
const password = "home-and-office-2026";
try {
  // 设备 A：首次设置
  const home = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const a = await home.newPage();
  a.on("pageerror", (e) => errors.push(`A ${e.message}`));
  await a.goto(base);
  assert.equal(new URL(a.url()).pathname, "/login");
  await a.getByLabel("设置口令").waitFor();
  await a.screenshot({ path: "screenshots/web-setup.png" });
  await a.getByLabel("设置口令").fill(web.setupToken);
  await a.getByLabel("用户名").fill("song");
  await a.getByLabel("登录密码").fill(password);
  await a.getByLabel("再次输入密码").fill(password);
  await a.getByRole("button", { name: "创建并登录" }).click();
  await a.locator('[data-app-ready="true"]').waitFor({ timeout: 30000 });
  result.noDemo = !(await a.getByText("hk-api-01").count());
  await a
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "费用与续费" })
    .click();
  await a.getByRole("button", { name: "新建提醒" }).click();
  await a.getByRole("textbox", { name: "提醒什么" }).fill("宽带续费");
  await a.getByRole("button", { name: "保存" }).click();
  await a.getByRole("article", { name: "提醒 宽带续费" }).waitFor();
  await a.waitForTimeout(1200);
  await a.screenshot({ path: "screenshots/web-reminders.png" });

  // 设备 B：另一台电脑登录，看到同一份资料
  const office = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const b = await office.newPage();
  b.on("pageerror", (e) => errors.push(`B ${e.message}`));
  await b.goto(base);
  await b.getByLabel("用户名").fill("song");
  await b.getByLabel("登录密码").fill("wrong-password-1");
  await b.getByRole("button", { name: "登录" }).click();
  result.wrongPassword = await b.getByRole("alert").innerText();
  await b.getByLabel("登录密码").fill(password);
  await b.getByRole("button", { name: "登录" }).click();
  await b.locator('[data-app-ready="true"]').waitFor({ timeout: 30000 });
  await b
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "费用与续费" })
    .click();
  await b.getByRole("article", { name: "提醒 宽带续费" }).waitFor();
  result.syncedToOffice = true;

  // 设备 B 完成提醒，设备 A 回到页面时载入新资料
  await b.getByRole("button", { name: "完成 宽带续费" }).click();
  await b.waitForTimeout(1200);
  await a.evaluate(() => window.dispatchEvent(new Event("focus")));
  await a.waitForTimeout(1500);
  result.homeSeesCompletion =
    (await a.getByRole("article", { name: "提醒 宽带续费" }).count()) === 0;

  // 网页版没有 SSH 终端，密钥库可用
  await b.goto(`${base}/`);
  await b.locator('[data-app-ready="true"]').waitFor();

  // 设置 → 提醒推送：服务器保存渠道，浏览器只看到「已保存」
  await b.keyboard.press("Control+,");
  const settings = b.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "提醒推送", exact: true }).click();
  await settings.getByLabel("开启服务器提醒推送").check();
  await settings.getByRole("textbox", { name: "Chat ID" }).fill("42");
  await settings.getByLabel("推送凭据").fill(`123456789:${"A".repeat(35)}`);
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await settings.getByText("提醒推送配置已保存。").waitFor();
  await b.screenshot({ path: "screenshots/web-push.png" });
  const pushConfig = await (await b.request.get(`${base}/api/web/push`)).json();
  result.pushSaved = pushConfig.enabled && pushConfig.hasToken && !("token" in pushConfig);
  await b.keyboard.press("Escape");
  await b.getByRole("button", { name: "更多操作" }).click();
  await b.getByText("退出登录").click();
  await b.waitForURL(/\/login$/);
  result.loggedOut = true;
  result.afterLogoutApi = (await b.request.get(`${base}/api/web/store`)).status();
} finally {
  await browser.close();
  web.server.close();
  await rm(root, { recursive: true, force: true });
}
result.errors = errors;
console.log(JSON.stringify(result, null, 1));
assert.equal(result.noDemo, true);
assert.match(result.wrongPassword, /用户名或密码不正确/);
assert.equal(result.syncedToOffice, true);
assert.equal(result.loggedOut, true);
assert.equal(result.pushSaved, true);
assert.equal(result.homeSeesCompletion, true);
assert.equal(result.afterLogoutApi, 401);
assert.deepEqual(errors, []);
