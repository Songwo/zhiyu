import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { Vault } from "../electron/services/vault.mjs";
import { webResearchFixture } from "./web-research-fixture.mjs";
import { chooseOption } from "./select-helper.mjs";

const upstream = createServer(async (req, res) => {
  for await (const _c of req) {
    /* 消费请求体 */
  }
  const url = new URL(req.url.slice(1));
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify(
      url.pathname.endsWith("/token")
        ? {
            access_token: "ui-private-token",
            refresh_token: "ui-private-refresh",
            expires_in: 3600,
            account: { uuid: "ui-claude", email_address: "ui@example.test" },
          }
        : url.pathname === "/api/user"
          ? { id: 99, username: "independent", name: "合成独立身份", trust_level: 2 }
          : url.pathname === "/v1.0/me"
            ? { mail: "ui@example.test", displayName: "合成邮箱" }
            : { five_hour: { utilization: 25 } },
    ),
  );
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const f = await webResearchFixture({
  built: true,
  additionalFetch: (url, init) => {
    if (new URL(url).origin === "https://auth.allinsong.top") return;
    assert.ok(
      [
        "https://platform.claude.com",
        "https://api.anthropic.com",
        "https://login.microsoftonline.com",
        "https://graph.microsoft.com",
        "https://api.telegram.org",
        "https://connect.linux.do",
      ].includes(new URL(url).origin),
    );
    return fetch(`http://127.0.0.1:${upstream.address().port}/${url}`, init);
  },
});
const master = "synthetic-oauth-ui-master-2026";
const vault = new Vault(join(f.root, "web/workspace/vault.enc"));
await vault.create(master);
await vault.set("account:mail-ui", {
  username: "background@example.test",
  password: "background-ui-private",
});
vault.lock();
const identityId =
  "secret-linuxdo-" +
  createHash("sha256").update("https://connect.linux.do\n99").digest("hex").slice(0, 32);
await f.call("/api/web/store", {
  cookie: f.cookie,
  method: "PUT",
  body: {
    revision: null,
    data: {
      version: 0,
      state: {
        secrets: [
          {
            id: identityId,
            name: "旧身份测试",
            kind: "account",
            identityProvider: "linuxdo",
            hint: "",
            value: "",
            tags: [],
            status: "online",
            lastRotated: "2026-11-04",
            notes: "",
          },
        ],
        mailboxes: [
          {
            id: "mail-ui",
            address: "background@example.test",
            kind: "mailbox",
            domain: "example.test",
            tags: [],
            status: "online",
            imap: { host: "imap.example.test", port: 993, secure: true },
          },
        ],
      },
    },
  },
});
const browser = await chromium.launch(),
  errors = [],
  checks = [];
await mkdir("screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  await context.route("https://**/*", (route) => route.abort());
  await context.addCookies([{ name: "zhiyu_session", value: f.cookie.split("=")[1], url: f.base }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.base);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.getByRole("button", { name: "解锁密钥库", exact: true }).click();
  const gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill(master);
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.waitFor({ state: "detached", timeout: 30000 });
  await page.getByRole("button", { name: "新建资产", exact: true }).click();
  await page
    .getByRole("dialog", { name: "选择资产类型", exact: true })
    .getByRole("button", { name: "添加 AI 订阅", exact: true })
    .click();
  const ai = page.getByRole("dialog", { name: "添加 AI 订阅", exact: true });
  await ai.getByRole("button", { name: /^订阅账号/ }).click();
  await chooseOption(page, ai.getByRole("combobox", { name: "授权服务商" }), "Anthropic / Claude");
  assert.equal(
    await ai.getByRole("button", { name: "网页登录授权", exact: true }).isDisabled(),
    true,
  );
  await ai.getByRole("checkbox", { name: /^我允许服务器加密保存本次 AI/ }).check();
  const aiStart = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/web/rpc") &&
      res.request().postDataJSON()?.channel === "ai-accounts:start",
  );
  await ai.getByRole("button", { name: "网页登录授权", exact: true }).click();
  const session = (await (await aiStart).json()).data;
  await ai
    .getByLabel("回调链接或授权码")
    .fill(`code#${new URL(session.authorizationUrl).searchParams.get("state")}`);
  await ai.getByRole("button", { name: "完成授权", exact: true }).click();
  await ai.getByText("已添加到 AI 订阅", { exact: true }).waitFor({ timeout: 30000 });
  assert.equal((await ai.innerText()).includes("ui-private-token"), false);
  await page.screenshot({ path: "screenshots/web-oauth-ai.png" });
  await ai.getByRole("button", { name: "关闭", exact: true }).click();
  checks.push("Web AI 同意后手动授权、刷新真实合成用量并创建订阅，无令牌明文显示");
  await page.getByRole("button", { name: "新建资产", exact: true }).click();
  await page
    .getByRole("dialog", { name: "选择资产类型", exact: true })
    .getByRole("button", { name: "添加邮箱", exact: true })
    .click();
  const mail = page.getByRole("dialog", { name: "邮箱", exact: true });
  await mail.getByRole("button", { name: /^快捷登录/ }).click();
  await mail.getByRole("button", { name: "Microsoft", exact: true }).click();
  const client = mail.getByText("客户端 ID", { exact: true }).locator("..").locator("input");
  await client.fill("synthetic-mail-ui-client");
  await mail.getByRole("button", { name: "保存客户端配置", exact: true }).click();
  await mail.getByRole("checkbox", { name: /^我允许可信部署服务器临时处理/ }).check();
  const mailStart = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/web/rpc") &&
      res.request().postDataJSON()?.channel === "mail:oauth-start",
  );
  await mail.getByRole("button", { name: "用 Microsoft 登录", exact: true }).click();
  const m = (await (await mailStart).json()).data,
    callback = new URL(m.redirectUri);
  callback.searchParams.set("state", new URL(m.authorizationUrl).searchParams.get("state"));
  callback.searchParams.set("code", "ui-code");
  await mail.getByLabel("完整授权回调地址").fill(callback.href);
  await mail.getByRole("button", { name: "确认授权回调", exact: true }).click();
  await mail.getByText("Microsoft · ui@example.test", { exact: true }).waitFor();
  await page.screenshot({ path: "screenshots/web-oauth-mail.png" });
  await mail.getByRole("button", { name: "关闭", exact: true }).click();
  checks.push("邮箱 OAuth 完整回调、地址核验及客户端配置保存在浏览器密钥库");
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "提醒推送", exact: true }).click();
  const push = settings
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "邮件推送", exact: true }) });
  assert.equal(
    await push.getByRole("checkbox", { name: "启用自动邮件推送", exact: true }).isDisabled(),
    true,
  );
  await push.getByRole("checkbox", { name: /^我允许服务器加密保存所选邮箱/ }).check();
  await push.getByRole("checkbox", { name: "启用自动邮件推送", exact: true }).check();
  await push.getByRole("textbox", { name: "Chat ID", exact: true }).fill("42");
  await push
    .getByRole("textbox", { name: "推送凭据", exact: true })
    .fill(`123456789:${"A".repeat(35)}`);
  await push.getByRole("checkbox", { name: "background@example.test", exact: true }).check();
  await push.getByRole("button", { name: "保存", exact: true }).click();
  await push.getByText("邮件推送配置已保存。", { exact: true }).waitFor();
  assert.equal(
    (await readFile(join(f.root, "web/server/background-mail.json"), "utf8")).includes(
      "background-ui-private",
    ),
    false,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await push.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "screenshots/web-background-mail-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await push.getByRole("checkbox", { name: "启用自动邮件推送", exact: true }).uncheck();
  await push.getByRole("button", { name: "保存", exact: true }).click();
  await push.getByText("邮件推送配置已保存。", { exact: true }).waitFor();
  checks.push("后台邮件默认关闭、单独同意、加密持久化与关闭清理，移动界面无横向溢出");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "密钥库", exact: true }).click();
  await page.getByRole("button", { name: "打开分组 未分组", exact: true }).click();
  await page.getByRole("button", { name: "查看账号与凭据 旧身份测试", exact: true }).click();
  await page.getByRole("button", { name: "重新连接身份", exact: true }).click();
  const identity = page.getByRole("dialog", { name: "导入身份", exact: true });
  await identity.getByRole("checkbox", { name: /^我允许服务器加密保存独立身份/ }).check();
  await identity.getByLabel("Client ID", { exact: true }).fill("synthetic-independent-client");
  await identity.getByLabel("Client Secret", { exact: true }).fill("synthetic-independent-secret");
  await identity.getByRole("button", { name: "保存接入配置", exact: true }).click();
  const identityStart = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/web/rpc") &&
      res.request().postDataJSON()?.channel === "identities:start",
  );
  await identity.getByRole("button", { name: "在浏览器登录 Linux.do", exact: true }).click();
  const i = (await (await identityStart).json()).data,
    identityCallback = new URL(i.redirectUri);
  identityCallback.searchParams.set("state", new URL(i.authorizationUrl).searchParams.get("state"));
  identityCallback.searchParams.set("code", "ui-code");
  await identity.getByLabel("完整授权回调地址").fill(identityCallback.href);
  await identity.getByRole("button", { name: "确认授权回调", exact: true }).click();
  await identity.getByText("授权成功，确认要导入的身份", { exact: true }).waitFor();
  await page.screenshot({ path: "screenshots/web-independent-identity.png" });
  await identity.getByRole("button", { name: "确认导入身份", exact: true }).click();
  await identity.waitFor({ state: "detached" });
  await page
    .getByRole("region", { name: "Linux.do 身份资料" })
    .getByText("已连接", { exact: true })
    .waitFor();
  const assets = await (await f.call("/api/web/store", { cookie: f.cookie, method: "GET" })).json();
  assert.equal(assets.data.state.secrets.filter((s) => s.id === identityId).length, 1);
  assert.equal(assets.data.state.secrets.find((s) => s.id === identityId).name, "旧身份测试");
  checks.push("旧独立身份从 Web 重新授权、原会话预览确认、保留名称且不重复创建资产");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks, errors }, null, 2));
} catch (error) {
  for (const p of browser.contexts().flatMap((c) => c.pages()))
    if (p.url().startsWith(f.base))
      console.error((await p.locator("body").innerText()).slice(-7000));
  throw error;
} finally {
  await browser.close();
  await f.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
}
