import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { webResearchFixture } from "./web-research-fixture.mjs";
import { Vault } from "../electron/services/vault.mjs";

const f = await webResearchFixture({ built: true });
const browser = await chromium.launch();
const errors = [];
const evidence = {};
await mkdir("screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    locale: "zh-CN",
  });
  await context.addCookies([{ name: "zhiyu_session", value: f.cookie.split("=")[1], url: f.base }]);
  await context.route("https://connect.linux.do/oauth2/authorize?*", async (route) => {
    const result = await f.authorize({ authorizationUrl: route.request().url() });
    await route.fulfill({
      status: result.status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": result.headers.get("content-security-policy"),
        "referrer-policy": "no-referrer",
      },
      body: await result.text(),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => {
    if (event.type() === "error") errors.push(event.text());
  });
  const rpc = (channel, ...args) =>
    page.evaluate(
      async ({ channel, args }) => {
        const response = await fetch("/api/web/rpc", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-zhiyu": "1",
          },
          body: JSON.stringify({ channel, args }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        return body.data;
      },
      { channel, args },
    );
  await page.goto(f.base);
  await page.locator('[data-app-ready="true"]').waitFor({ timeout: 30000 });
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "个人资料", exact: true }).click();
  const identity = page.getByRole("region", { name: "Linux.do 主身份", exact: true });
  const popupEvent = context.waitForEvent("page");
  await identity.getByRole("button", { name: "使用 Linux.do 登录", exact: true }).click();
  const popup = await popupEvent;
  await identity.getByRole("button", { name: "确认绑定主身份", exact: true }).waitFor();
  await popup.waitForFunction(() => location.search === "");
  await popup.getByRole("button", { name: "关闭此页面", exact: true }).waitFor();
  assert.equal(await rpc("main-identity:get"), null);
  await identity.getByLabel("同步 Linux.do 昵称").check();
  await identity.getByRole("button", { name: "确认绑定主身份", exact: true }).click();
  await identity.getByText("已绑定主身份", { exact: true }).waitFor();
  evidence.webLogin = (await rpc("main-identity:get")).profile.username === "sample";
  await popup.close();
  // 模拟弹窗被拦截时，界面必须给出可手动打开的授权链接。
  await page.evaluate(() => {
    window.__realOpen = window.open;
    window.open = () => null;
  });
  await identity.getByRole("button", { name: "更换登录账号", exact: true }).click();
  await identity.getByRole("link", { name: "打开 Linux.do 授权页面" }).waitFor();
  evidence.blockedPopupFallback = true;
  await identity.getByRole("button", { name: /取消/ }).click();
  await page.evaluate(() => {
    window.open = window.__realOpen;
    delete window.__realOpen;
  });
  await page.getByRole("button", { name: "模型与知识库", exact: true }).click();
  await page.getByRole("checkbox", { name: "启用 Jev 文档分析", exact: true }).check();
  await page.getByLabel("Jev API Key", { exact: true }).fill("synthetic-typesafe-key");
  await page.getByRole("button", { name: "保存 Jev 设置", exact: true }).click();
  await page.getByText("Jev 设置已保存", { exact: true }).waitFor();
  assert.equal(
    (await readFile(join(f.root, "web/server/document-analysis.json"), "utf8")).includes(
      "synthetic-typesafe-key",
    ),
    false,
  );
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  const markdown = "# 合成部署手册\n\n明天之前必须更新服务证书。\n\n这是服务运行所需的关键配置。\n";
  await page.evaluate(async (markdown) => {
    const response = await fetch("/api/web/documents/doc-web-jev-original", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-zhiyu": "1" },
      body: JSON.stringify({
        id: "doc-web-jev-original",
        title: "Web 原文提示回归",
        markdown,
        content: { type: "doc", content: [] },
        bindings: [],
      }),
    });
    if (!response.ok) throw new Error(await response.text());
  }, markdown);
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "文档", exact: true })
    .click();
  await page.locator(".document-list-item").filter({ hasText: "Web 原文提示回归" }).click();
  const getDocuments = () => page.evaluate(async () => (await fetch("/api/web/documents")).json());
  const before = await getDocuments();
  f.behavior.delay = 600;
  await page.getByRole("button", { name: "Jev 文档提示", exact: true }).click();
  const panel = page.getByRole("region", { name: "Jev 分析面板", exact: true });
  await panel
    .getByRole("checkbox", { name: "允许本次将当前文档段落发送给 TypeSafe 分析", exact: true })
    .check();
  await panel.getByRole("button", { name: "分析当前文档", exact: true }).click();
  await panel.getByText("分析第 2 / 3 段", { exact: true }).waitFor();
  evidence.liveProgress = true;
  await page.waitForFunction(() => document.querySelectorAll("[data-jev-rule]").length === 3);
  await panel.locator("details:not([open])").waitFor();
  assert.deepEqual(await getDocuments(), before);
  const count = f.calls.filter((call) => call.path === "/v1/systemone").length;
  const config = await rpc("document-analysis:config");
  await rpc("document-analysis:saveConfig", { ...config, mode: "underline" });
  await page.evaluate(() => window.dispatchEvent(new Event("zhiyu:analysis-settings")));
  await page.waitForFunction(
    () => document.querySelectorAll('[data-jev-mode="underline"]').length === 3,
  );
  assert.equal(f.calls.filter((call) => call.path === "/v1/systemone").length, count);
  evidence.originalUnchanged = true;
  await page.screenshot({ path: "screenshots/web-jev-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: "screenshots/web-jev-mobile.png" });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await panel.getByRole("button", { name: "关闭分析面板", exact: true }).click();
  assert.equal(await page.locator("[data-jev-rule]").count(), 0);
  await page.getByRole("button", { name: "联网检索", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Exa 联网检索", exact: true });
  await search.getByText(/^50\s*\/\s*50$/).waitFor();
  await search.getByRole("textbox", { name: "联网检索问题", exact: true }).fill("合成公开检索问题");
  await search.getByRole("button", { name: "开始检索", exact: true }).click();
  await search.getByText("合成官方说明", { exact: true }).waitFor();
  await search.getByText(/^49\s*\/\s*50$/).waitFor();
  await search.getByRole("button", { name: "购买与消耗记录", exact: true }).click();
  await search.getByText(/消耗 1 次免费额度.*已完成/).waitFor();
  assert.equal((await rpc("research:quota")).paidRemaining, 0);
  evidence.quotaAndRecords = true;
  await page.screenshot({ path: "screenshots/web-exa-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: "screenshots/web-exa-mobile.png" });
  await page.setViewportSize({ width: 1360, height: 900 });
  await search.getByRole("button", { name: "关闭", exact: true }).click();
  await search.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "创建密钥库", exact: true }).click();
  const master = "synthetic-web-vault-2026";
  const gate = page.getByRole("dialog", { name: "设置主密码", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill(master);
  await gate.getByLabel("再输一次", { exact: true }).fill(master);
  await gate.getByRole("button", { name: "创建", exact: true }).click();
  await gate.waitFor({ state: "detached", timeout: 30000 });
  await page.evaluate(async () => {
    const response = await fetch("/api/web/documents/doc-web-account-extract", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-zhiyu": "1" },
      body: JSON.stringify({
        id: "doc-web-account-extract",
        title: "Web 账号提取回归",
        markdown:
          "# 合成账号\n\n网址：https://example.test/login\n账号：synthetic-user\n密码：synthetic-extracted-password\n",
        content: { type: "doc", content: [] },
        bindings: [],
      }),
    });
    if (!response.ok) throw new Error(await response.text());
  });
  await page.locator(".document-list-item").filter({ hasText: "Web 账号提取回归" }).click();
  await page.getByRole("button", { name: "提取账号", exact: true }).click();
  await page.getByLabel("账号 1 密码", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("账号 1 密码", { exact: true }).getAttribute("type"),
    "password",
  );
  await page.getByRole("button", { name: "保存并关联 1 项账号", exact: true }).click();
  await page.getByText("新增 1 项账号，复用 0 项已有账号。", { exact: true }).waitFor();
  const vault = new Vault(join(f.root, "web/workspace/vault.enc"));
  await vault.unlock(master);
  const ids = await vault.list();
  const credentialId = ids.find((id) => id.startsWith("account:"));
  assert.ok(credentialId);
  assert.equal((await vault.get(credentialId)).password, "synthetic-extracted-password");
  const doc = await page.evaluate(async () =>
    (await fetch("/api/web/documents/doc-web-account-extract")).json(),
  );
  assert.equal(doc.bindings[0].id, credentialId.slice("account:".length));
  assert.equal(doc.markdown.includes("synthetic-extracted-password"), true, "提取后不改动原文");
  assert.equal(
    (await readFile(join(f.root, "web/workspace/vault.enc"), "utf8")).includes(
      "synthetic-extracted-password",
    ),
    false,
  );
  evidence.documentAccountExtraction = true;
  await page
    .getByRole("dialog", { name: "从文档提取账号", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "U 卡与支付卡", exact: true }).click();
  await page.getByRole("button", { name: "添加支付卡", exact: true }).first().click();
  let editor = page.getByRole("dialog", { name: "添加支付卡", exact: true });
  await editor.getByLabel("卡片名称", { exact: true }).fill("Web 合成国内卡");
  await editor.getByLabel("用于识别的卡号", { exact: true }).fill("6222020000000000000");
  assert.equal(await editor.getByLabel("发卡服务商", { exact: true }).inputValue(), "中国工商银行");
  assert.equal(await editor.getByLabel("卡组织", { exact: true }).inputValue(), "UnionPay");
  await editor.getByLabel("卡面有效月份", { exact: true }).fill("2028-02");
  await editor.getByRole("button", { name: "保存卡片", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal(
    await page.locator(".card-3d-scene").evaluate((element) => {
      const card = element.getBoundingClientRect(),
        parent = element.parentElement.getBoundingClientRect();
      return Math.abs(card.left + card.width / 2 - parent.left - parent.width / 2) < 2;
    }),
    true,
  );
  await page.getByRole("button", { name: "翻到背面", exact: true }).click();
  await page.locator('.card-3d-scene[data-flipped="true"]').waitFor();
  await page.getByRole("button", { name: "录入或编辑加密资料", exact: true }).click();
  const privateEditor = page.getByRole("dialog", { name: "加密卡片资料", exact: true });
  await privateEditor.getByLabel("完整卡号", { exact: true }).fill("6222020000000000000");
  await privateEditor.getByRole("button", { name: "保存加密资料", exact: true }).click();
  await privateEditor.waitFor({ state: "detached" });
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedCard = text;
        },
      },
    }),
  );
  await page.getByRole("button", { name: "复制完整卡号", exact: true }).click();
  await page.waitForFunction(() => window.__copiedCard === "6222020000000000000");
  assert.equal((await page.locator("body").innerText()).includes("6222020000000000000"), false);
  await page.getByRole("button", { name: "翻回正面", exact: true }).click();
  await page.screenshot({ path: "screenshots/web-card-front.png" });
  // 详情抽屉关闭后用「更多」切换 eSIM。
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "U 卡与支付卡", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "eSIM 卡", exact: true }).click();
  await page.getByRole("button", { name: "添加 eSIM", exact: true }).first().click();
  editor = page.getByRole("dialog", { name: "添加 eSIM", exact: true });
  await editor.getByLabel("卡片名称", { exact: true }).fill("Web 合成 eSIM");
  await editor.getByLabel("eSIM 服务商", { exact: true }).fill("Airalo");
  await editor.getByLabel("套餐到期日（以此为准）", { exact: true }).fill("2027-01-20");
  await editor.getByLabel("保号截止日期", { exact: true }).fill("2027-02-20");
  await editor.getByRole("button", { name: "保存卡片", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.waitForTimeout(900);
  const snapshot = await page.evaluate(
    async () => (await (await fetch("/api/web/store")).json()).data,
  );
  const card = snapshot.state.services.find((asset) => asset.name === "Web 合成国内卡");
  const esim = snapshot.state.services.find((asset) => asset.name === "Web 合成 eSIM");
  assert.equal(card.expiresAt, "2028-02-29");
  assert.equal(esim.expiresAt, "2027-01-20");
  assert.equal(esim.card.keepAliveAt, "2027-02-20");
  assert.equal(JSON.stringify(snapshot).includes("6222020000000000000"), false);
  evidence.cardsAndEsim = true;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...evidence, errors }, null, 2));
} catch (error) {
  console.error("Web UI regression failed:", error.message);
  for (const page of browser.contexts().flatMap((context) => context.pages()))
    if (!page.isClosed()) {
      console.error((await page.locator("body").innerText()).slice(-6000));
      await page.screenshot({ path: "screenshots/web-research-failure.png" }).catch(() => {});
    }
  throw error;
} finally {
  await browser.close();
  await f.close();
}
