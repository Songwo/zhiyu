import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { ExtensionBridge } from "../electron/services/extension-bridge.mjs";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
const directory = await mkdtemp(join(tmpdir(), "zhiyu-browser-companion-"));
const extension = join(directory, "extension");
const login =
  '<!doctype html><html><head><meta charset="utf-8"><title>合成登录网站</title><style>body{padding:60px;font:16px system-ui}form{display:grid;gap:12px;max-width:340px}input,button{padding:12px}</style></head><body><h1>欢迎回来</h1><form onsubmit="event.preventDefault();window.loginCount=(window.loginCount||0)+1"><input autocomplete="username" aria-label="网站账号"><input type="password" autocomplete="current-password" aria-label="网站密码"><button type="submit">登录</button></form></body></html>';
const fixture = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(login);
});
let context;
const records = new Map(),
  documents = [],
  fills = [],
  pageErrors = [];
const bridge = new ExtensionBridge({
  isUnlocked: () => true,
  port: 0,
  accounts: {
    listForOrigin: async (url) =>
      [...records.values()]
        .filter((item) => new URL(item.url).origin === new URL(url).origin)
        .map(({ id, title, username }) => ({ id, title, username })),
    getForOrigin: async (id, url) => {
      const item = records.get(id);
      if (!item || new URL(item.url).origin !== new URL(url).origin) return null;
      fills.push(id);
      return { ...item };
    },
    saveCapture: async (capture) => {
      const existing = [...records.values()].find(
        (item) =>
          item.url === capture.url &&
          item.username === capture.username &&
          item.password === capture.password,
      );
      if (existing) return { id: existing.id, status: "existing" };
      const id = `saved-${records.size}`;
      records.set(id, { id, ...capture });
      return { id, status: "new" };
    },
  },
  saveDocument: async (capture) => {
    documents.push(capture);
    return { id: "document-fixture", status: "new" };
  },
});
async function shadowNodes(page) {
  const cdp = await context.newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);
  };
  visit(root);
  return { cdp, nodes };
}
async function shadowClick(page, action, index = 0) {
  const { cdp, nodes } = await shadowNodes(page);
  try {
    const node = nodes.filter((item) =>
      item.attributes?.some(
        (name, idx) => name === "data-action" && item.attributes[idx + 1] === action,
      ),
    )[index];
    assert.ok(node, `expected shadow action ${action}`);
    const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
    const [x1, y1, x2, , , y3] = model.border;
    await page.mouse.click((x1 + x2) / 2, (y1 + y3) / 2);
  } finally {
    await cdp.detach();
  }
}
async function shadowText(page) {
  const { cdp, nodes } = await shadowNodes(page);
  try {
    return nodes.map((node) => node.nodeValue || "").join(" ");
  } finally {
    await cdp.detach();
  }
}
async function waitFor(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`未观察到预期结果：${label}`);
}
try {
  await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
  const state = await bridge.start();
  assert.equal(state.running, true, state.error);
  await cp(resolve(`release/v${version}/zhiyu-browser-extension`), extension, { recursive: true });
  await writeFile(
    join(extension, "bridge-config.mjs"),
    `export const BRIDGE = "http://127.0.0.1:${state.port}";\n`,
  );
  records.set("work", {
    id: "work",
    url: `${fixtureBase}/`,
    title: "工作账号",
    username: "work@example.test",
    password: " work-secret ",
  });
  records.set("personal", {
    id: "personal",
    url: `${fixtureBase}/`,
    title: "个人账号",
    username: "personal@example.test",
    password: "personal-secret",
  });
  context = await chromium.launchPersistentContext(join(directory, "profile"), {
    headless: true,
    ...(process.env.NANPAD_EXTENSION_BROWSER_PATH
      ? { executablePath: process.env.NANPAD_EXTENSION_BROWSER_PATH }
      : { channel: "chromium" }),
    args: ["--enable-unsafe-extension-debugging"],
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1200, height: 850 },
  });
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send("Extensions.loadUnpacked", { path: extension });
  const website = await context.newPage();
  website.on("pageerror", (error) => pageErrors.push(error.message));
  await website.goto(`${fixtureBase}/login`);
  const popup = await context.newPage();
  popup.on("pageerror", (error) => pageErrors.push(error.message));
  await popup.addInitScript((base) => {
    const query = globalThis.chrome.tabs.query.bind(globalThis.chrome.tabs);
    globalThis.chrome.tabs.query = async () =>
      (await query({})).filter((tab) => tab.url?.startsWith(base));
  }, fixtureBase);
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByLabel("桌面配对码").fill(bridge.beginPairing().code);
  await popup.getByRole("button", { name: "连接", exact: true }).click();
  await popup.getByText("已连接本机知屿", { exact: true }).waitFor();
  try {
    await popup.locator(".saved-account").first().waitFor({ timeout: 10000 });
  } catch (error) {
    console.error({
      reason: await popup.evaluate(async () => {
        const [tab] = await globalThis.chrome.tabs.query({});
        const result = await globalThis.chrome.runtime.sendMessage({
          type: "zhiyu-list",
          tabId: tab.id,
        });
        return { reason: result.reason, ok: result.ok };
      }),
      accountState: await popup.locator("#account-empty").textContent(),
      status: await popup.locator("#status").textContent(),
      pageErrors,
    });
    throw error;
  }
  assert.equal(await popup.locator(".saved-account").count(), 2);
  assert.equal(fills.length, 0, "展示候选不能读取密码");
  await website.reload();
  await website.locator("[data-zhiyu-companion]").waitFor();
  assert.equal(
    await website.evaluate(() => document.querySelector("[data-zhiyu-companion]").shadowRoot),
    null,
  );
  assert.equal(await website.getByLabel("网站密码").inputValue(), "");
  await mkdir("screenshots", { recursive: true });
  await website.screenshot({ path: "screenshots/zhiyu-v130-browser-accounts.png" });
  await shadowClick(website, "fill-account", 1);
  await waitFor(
    async () => (await website.getByLabel("网站密码").inputValue()) === "personal-secret",
    "选择第二个账号后填写",
  );
  assert.equal(await website.getByLabel("网站账号").inputValue(), "personal@example.test");
  assert.equal(await website.evaluate(() => window.loginCount || 0), 0);
  assert.deepEqual(fills, ["personal"]);
  await website.getByLabel("网站密码").fill("");
  if (!(await popup.locator(".saved-account").count())) {
    console.error({
      stage: "after-native-choice",
      popup: await popup.locator("body").innerText(),
      connectionKeys: Object.keys(
        await popup.evaluate(() => globalThis.chrome.storage.session.get(null)),
      ),
      pageErrors,
    });
  }
  await popup.locator(".saved-account").first().click();
  await popup.getByRole("status").filter({ hasText: "已填写到当前登录表单" }).waitFor();
  assert.equal(await website.getByLabel("网站密码").inputValue(), " work-secret ");
  assert.equal(await website.evaluate(() => window.loginCount || 0), 0);

  await website.getByLabel("网站账号").fill("new@example.test");
  await website.getByLabel("网站密码").fill("new-secret");
  await website.getByRole("button", { name: "登录", exact: true }).click();
  await website.locator("[data-zhiyu-companion]").waitFor();
  assert.equal(records.size, 2, "自动采集尚未写入密钥库");
  await shadowClick(website, "save-account");
  await waitFor(() => records.size === 3, "确认一次后保存账号");
  assert.equal([...records.values()].at(-1).username, "new@example.test");
  await popup.reload();
  await popup.locator(".saved-account").nth(2).waitFor();
  assert.equal(await popup.getByLabel("密码", { exact: true }).getAttribute("type"), "password");
  await popup.getByRole("button", { name: "显示密码", exact: true }).click();
  assert.equal(await popup.getByLabel("密码", { exact: true }).getAttribute("type"), "text");
  await popup.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await popup.getByLabel("密码", { exact: true }).fill("newer-secret");
  await popup.getByRole("button", { name: "加密保存到知屿", exact: true }).click();
  await popup.getByRole("status").filter({ hasText: "已加密保存" }).waitFor();
  assert.equal(records.size, 4, "同一账号新密码保存为独立版本");
  assert.equal(await popup.getByLabel("密码", { exact: true }).inputValue(), "");
  await popup.setViewportSize({ width: 380, height: 700 });
  await popup.screenshot({ path: "screenshots/zhiyu-v130-extension-popup.png", fullPage: true });
  await popup.emulateMedia({ colorScheme: "dark" });
  await popup.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".saved-account")).backgroundColor ===
      "rgb(34, 43, 39)",
  );
  await popup.screenshot({ path: "screenshots/zhiyu-v130-extension-dark.png", fullPage: true });
  assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(
    await popup
      .locator("img")
      .evaluateAll((images) => images.every((item) => item.complete && item.naturalWidth > 0)),
  );
  const storage = await popup.evaluate(async () => ({
    session: await globalThis.chrome.storage.session.get(null),
    local: await globalThis.chrome.storage.local.get(null),
    sync: await globalThis.chrome.storage.sync.get(null),
  }));
  assert.deepEqual(Object.keys(storage.session), ["nanpadConnectionToken"]);
  assert.deepEqual(storage.local, {});
  assert.deepEqual(storage.sync, {});
  assert.ok(!JSON.stringify(storage).includes("secret"));
  await website.reload();
  await website.evaluate(() => {
    const form = document.querySelector("form");
    form.removeAttribute("onsubmit");
    form.action = "/logged-in";
    form.method = "post";
  });
  await website.getByLabel("网站账号").fill("native@example.test");
  await website.getByLabel("网站密码").fill("native-secret");
  await Promise.all([
    website.waitForURL(`${fixtureBase}/logged-in`),
    website.getByRole("button", { name: "登录", exact: true }).click(),
  ]);
  await waitFor(
    async () => (await shadowText(website)).includes("native@example.test"),
    "原生表单整页导航后保留待确认账号",
  );
  await shadowClick(website, "save-account");
  await waitFor(() => records.size === 5, "原生导航后确认保存");
  await popup.locator(".preferences > summary").click();
  await popup.getByLabel("登录时自动采集").uncheck();
  await website.reload();
  await website.getByLabel("网站账号").fill("disabled@example.test");
  await website.getByLabel("网站密码").fill("disabled-secret");
  await website.getByRole("button", { name: "登录", exact: true }).click();
  await popup.reload();
  assert.equal(await popup.locator("#pending-account").isVisible(), false);

  // 动态 DOM 与开放 Shadow DOM 使用相同安全定位，不向注册表单和隐藏密码框填写。
  await website.goto(`${fixtureBase}/dynamic`);
  await website.evaluate(() => {
    document.body.innerHTML = '<div id="login-shadow"></div>';
    document.querySelector("#login-shadow").attachShadow({ mode: "open" }).innerHTML =
      '<form><input autocomplete="username"><input type="password" autocomplete="current-password"></form>';
  });
  await waitFor(
    async () => (await shadowText(website)).includes("选择登录账号"),
    "动态 Shadow DOM 建议",
  );
  await shadowClick(website, "fill-account", 0);
  await waitFor(
    async () =>
      (await website.locator("#login-shadow input[type='password']").inputValue()) ===
      " work-secret ",
    "Shadow DOM 填写",
  );
  const before = fills.length;
  await website.goto(`${fixtureBase}/register`);
  await website.evaluate(() => {
    document.querySelector("form").id = "register";
    document.querySelector('input[type="password"]').autocomplete = "new-password";
  });
  await popup.reload();
  await popup.locator(".saved-account").first().click();
  await popup.getByRole("status").filter({ hasText: "没有可安全填写" }).waitFor();
  assert.equal(fills.length, before);
  assert.equal(await website.getByLabel("网站密码").inputValue(), "");

  await website.evaluate(() => {
    document.body.innerHTML =
      "<article><h1>弹窗保存文档</h1><p>通过弹窗保存的可见正文</p><p hidden>隐藏的内部值</p></article>";
  });
  await popup.getByRole("button", { name: "保存当前文档", exact: true }).click();
  await waitFor(() => documents.length === 1, "弹窗向目标文档发送提取请求");
  assert.match(documents[0].text, /通过弹窗保存的可见正文/);
  assert.ok(!documents[0].text.includes("隐藏的内部值"));
  documents.length = 0;

  await context.route("https://docs.qq.com/doc/zhiyu-fixture*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><title>合成项目说明</title><h1>合成项目说明</h1><article><p>需要保存的可见项目正文。</p><p hidden>隐藏片段绝不能进入文档</p><form><input value="private-form"><p>表单区域不能导入</p></form><script>window.documentFixture=true</script><p>另一个可见段落。</p></article>',
    }),
  );
  const doc = await context.newPage();
  doc.on("pageerror", (error) => pageErrors.push(error.message));
  await doc.goto("https://docs.qq.com/doc/zhiyu-fixture?token=private#private");
  await doc.locator("[data-zhiyu-companion]").waitFor();
  assert.equal(documents.length, 0);
  // Playwright 的禁用动画样式无法进入 closed shadow，等 200ms 入场动画自然结束后截图。
  await doc.waitForTimeout(250);
  await doc.screenshot({
    path: "screenshots/zhiyu-v130-document-prompt.png",
    animations: "disabled",
  });
  await shadowClick(doc, "save-document");
  await waitFor(() => documents.length === 1, "确认后保存可见文档");
  assert.match(documents[0].text, /可见项目正文/);
  assert.ok(!/隐藏片段|表单区域|private-form|window.documentFixture/.test(documents[0].text));
  assert.equal(documents[0].url, "https://docs.qq.com/doc/zhiyu-fixture?token=private");

  bridge.revoke();
  await popup.getByRole("button", { name: "重新读取当前页", exact: true }).click();
  await waitFor(
    async () =>
      Object.keys(await popup.evaluate(() => globalThis.chrome.storage.session.get(null)))
        .length === 0,
    "撤销配对清除扩展会话令牌",
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify({
      ok: true,
      version,
      realManifestV3: true,
      actualPairing: true,
      sameSiteMultiAccount: true,
      trustedChoiceBeforeFill: true,
      noAutoSubmit: true,
      confirmedSave: true,
      nativePostNavigation: true,
      passwordVersions: true,
      shadowAndDynamicForms: true,
      registrationRejected: true,
      documentConsentAndVisibleText: true,
      noCredentialStorage: true,
      revokedTokenCleared: true,
      pageErrors,
    }),
  );
} finally {
  await context?.close();
  await bridge.stop();
  fixture.closeAllConnections?.();
  await new Promise((done) => fixture.close(done));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
