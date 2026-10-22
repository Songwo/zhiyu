import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { Vault } from "../electron/services/vault.mjs";

// 所有网络与系统浏览器调用在测试进程中替换，生产代码没有测试域名或任意回调后门。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-identity-totp-"));
const screenshotDirectory = resolve("release/identity-totp-qa");
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
const packaged = process.argv[2];
if (packaged) delete env.NANPAD_TEST_DATA_DIR;
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
const master = "integration-master-2026";
const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const fixtureName = "Linux.do · 回归身份";
const customName = "我的社区资料回归";
let instance;
let page;
const pageErrors = [];

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

try {
  await writeFile(
    join(directory, "preferences.json"),
    JSON.stringify({ locale: "zh", notifications: false, closeToTray: false }),
  );
  // 正式包没有测试日志根覆盖，因此必须在启动前关闭隔离样本的本机日志扫描。
  await writeFile(
    join(directory, "local-usage.json"),
    JSON.stringify({ version: 1, enabled: false, checkpoints: [], events: [], records: [] }),
  );
  await mkdir(screenshotDirectory, { recursive: true });
  const port = await freePort();
  instance = await electron.launch({
    ...(packaged ? { executablePath: resolve(packaged) } : {}),
    args: packaged ? [`--user-data-dir=${directory}`] : [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  assert.equal(await instance.evaluate(({ app }) => app.isPackaged), Boolean(packaged));
  await instance.evaluate(({ net, shell }) => {
    globalThis.identityFixture = {
      opened: [],
      calls: [],
      postsStatus: 200,
      detailStatus: 403,
      profile: {
        id: 709993,
        username: "qa_identity_owner",
        name: "回归身份",
        email: "identity-private@example.test",
        trust_level: 3,
        active: true,
        silenced: false,
      },
    };
    const originalFetch = net.fetch.bind(net);
    net.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (!["http:", "https:"].includes(url.protocol)) return originalFetch(input, init);
      globalThis.identityFixture.calls.push({
        url: url.href,
        headers: init.headers || {},
        body: init.body || "",
        redirect: init.redirect,
        credentials: init.credentials,
      });
      const json = (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.href === "https://connect.linux.do/oauth2/token")
        return json({
          access_token: "integration-private-access",
          refresh_token: "integration-private-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      if (url.href === "https://connect.linux.do/api/user")
        return json(globalThis.identityFixture.profile);
      if (url.origin === "https://linux.do" && url.pathname === "/user_actions.json") {
        if (globalThis.identityFixture.postsStatus !== 200)
          return json({ error: "private-provider-error" }, globalThis.identityFixture.postsStatus);
        return json({
          user_actions: [
            {
              action_type: 4,
              username: "qa_identity_owner",
              topic_id: 9001,
              post_id: 19001,
              post_number: 1,
              title: "桌面身份导入验证",
              excerpt: "<p>测试公开摘要 <b>可保存</b></p>",
              created_at: "2026-10-08T02:00:00Z",
            },
            {
              action_type: 5,
              username: "qa_identity_owner",
              topic_id: 9002,
              post_id: 19002,
              post_number: 3,
              title: "公开回复验证",
              excerpt: "<p>第二条回复摘要</p>",
              created_at: "2026-10-08T03:00:00Z",
            },
          ],
        });
      }
      if (url.origin === "https://linux.do" && url.pathname === "/posts/19001.json")
        return json({
          id: 19001,
          topic_id: 9001,
          post_number: 1,
          user_id: 709993,
          username: "qa_identity_owner",
          raw: "# 完整文章正文\n\n第一段完整内容。\n\n只有全文接口才有的末尾内容。\n\n| 名称 | 网址 | 账号 | 密码 |\n| --- | --- | --- | --- |\n| 帖子内示例账号 | https://docs-account.example.test/login | linked-account@example.test | Doc-Only-Password-2026 |",
        });
      if (url.origin === "https://linux.do" && url.pathname === "/posts/19002.json") {
        if (globalThis.identityFixture.detailStatus !== 200)
          return json({ error: "private-body-error" }, globalThis.identityFixture.detailStatus);
        return json({
          id: 19002,
          topic_id: 9002,
          post_number: 3,
          user_id: 709993,
          username: "qa_identity_owner",
          cooked: "<p>完整回复正文，恢复访问后导入。</p>",
        });
      }
      throw new Error("测试禁止访问未声明的外部接口");
    };
    shell.openExternal = async (url) => {
      globalThis.identityFixture.opened.push(url);
    };
  });
  page = await instance.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (value) => {
        window.__identityCopied = value;
      },
    });
  });
  const stored = () => page.evaluate(() => window.sinan.store.load());
  const importDialog = () => page.getByRole("dialog", { name: "导入身份", exact: true });
  const details = () => page.getByRole("region", { name: "资产详情", exact: true });
  const identityPanel = () => page.getByRole("region", { name: "Linux.do 身份资料", exact: true });
  const postCallCount = () =>
    instance.evaluate(
      () =>
        globalThis.identityFixture.calls.filter((call) =>
          call.url.startsWith("https://linux.do/user_actions.json"),
        ).length,
    );
  async function authorizeInFixture() {
    const openedBefore = await instance.evaluate(() => globalThis.identityFixture.opened.length);
    await importDialog()
      .getByRole("button", { name: "在浏览器登录 Linux.do", exact: true })
      .click();
    await page.getByText("等待浏览器授权", { exact: true }).waitFor();
    const opened = await instance.evaluate(() => globalThis.identityFixture.opened);
    assert.equal(opened.length, openedBefore + 1);
    const authorize = new URL(opened.at(-1));
    assert.equal(authorize.origin, "https://connect.linux.do");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(authorize.searchParams.get("redirect_uri"));
    assert.equal(callback.hostname, "127.0.0.1");
    assert.equal(callback.port, String(port));
    callback.search = new URLSearchParams({
      state: authorize.searchParams.get("state"),
      code: "integration-code",
    }).toString();
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await response.text();
    await importDialog().getByRole("button", { name: "确认导入身份", exact: true }).waitFor();
  }
  async function openAccount(name = customName) {
    await page
      .locator("aside:visible nav")
      .getByRole("button", { name: /^密钥库/ })
      .click();
    const group = page.getByRole("button", { name: "打开分组 未分组", exact: true });
    const row = page.getByRole("checkbox", { name: `选择密钥 ${name}`, exact: true });
    await group.or(row).first().waitFor();
    if (await group.isVisible()) await group.click();
    await row
      .locator("..")
      .getByRole("button", { name: `查看账号与凭据 ${name}`, exact: true })
      .click();
    await identityPanel().getByText("@qa_identity_owner", { exact: true }).waitFor();
  }

  await page
    .locator("aside:visible nav")
    .getByRole("button", { name: /^密钥库/ })
    .click();
  // 新主身份入口位于个人资料；通过原有真实 IPC 播种旧版本身份资产，验证升级兼容。
  assert.equal(await page.getByRole("button", { name: "导入身份", exact: true }).count(), 0);
  const configured = await page.evaluate(
    (port) =>
      window.sinan.identities.configure({
        clientId: "integration-client",
        clientSecret: "integration-private-client-secret",
        redirectUri: `http://127.0.0.1:${port}/oauth/linuxdo/callback`,
      }),
    port,
  );
  assert.equal(configured.configured, true);
  assert.equal(configured.hasClientSecret, true);
  assert.equal(JSON.stringify(configured).includes("integration-private-client-secret"), false);
  async function previewHistoricalIdentity() {
    const started = await page.evaluate(() => window.sinan.identities.start());
    const opened = await instance.evaluate(() => globalThis.identityFixture.opened.at(-1));
    const authorize = new URL(opened);
    assert.equal(authorize.origin, "https://connect.linux.do");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(authorize.searchParams.get("redirect_uri"));
    assert.equal(callback.hostname, "127.0.0.1");
    assert.equal(callback.port, String(port));
    callback.search = new URLSearchParams({
      state: authorize.searchParams.get("state"),
      code: "historical-integration-code",
    }).toString();
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await response.text();
    const preview = await page.evaluate((id) => window.sinan.identities.status(id), started.id);
    assert.equal(preview.status, "ready");
    assert.equal(preview.preview.username, "qa_identity_owner");
    return started.id;
  }
  const cancelledSession = await previewHistoricalIdentity();
  assert.equal(
    (await stored()).state.secrets.some((asset) => asset.identityProvider === "linuxdo"),
    false,
  );
  await page.evaluate((id) => window.sinan.identities.cancel(id), cancelledSession);
  assert.equal(
    (await stored()).state.secrets.some((asset) => asset.identityProvider === "linuxdo"),
    false,
  );
  const historicalSession = await previewHistoricalIdentity();
  await page.evaluate(
    (sessionId) => window.sinan.identities.commit({ sessionId }),
    historicalSession,
  );
  await openAccount(fixtureName);
  await identityPanel().getByText("@qa_identity_owner", { exact: true }).waitFor();
  const account = (await stored()).state.secrets.find(
    (asset) => asset.identityProvider === "linuxdo",
  );
  assert.equal(account.name, fixtureName);
  assert.equal(account.kind, "account");
  await identityPanel().getByText("信任等级 3", { exact: true }).waitFor();
  await identityPanel().getByRole("button", { name: "读取公开帖子", exact: true }).click();
  await identityPanel()
    .getByRole("checkbox", { name: "选择帖子 桌面身份导入验证", exact: true })
    .check();
  await identityPanel()
    .getByRole("checkbox", { name: "选择帖子 公开回复验证", exact: true })
    .check();
  await identityPanel()
    .getByRole("button", { name: /导入全文并关联/ })
    .click();
  await identityPanel()
    .getByRole("button", { name: "查看已保存的关联文档", exact: true })
    .waitFor();
  const docs = await page.evaluate(() => window.sinan.documents.list());
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0].bindings, [{ kind: "secret", id: account.id }]);
  const document = await page.evaluate((id) => window.sinan.documents.get(id), docs[0].id);
  assert.match(JSON.stringify(document), /只有全文接口才有的末尾内容/);
  assert.match(JSON.stringify(document.content), /https:\/\/linux.do\/t\/topic\/9001\/1/);
  assert.doesNotMatch(JSON.stringify(document.content), /private-|<p>|<b>|测试公开摘要/);
  // 真正从已导入的全文解析账号，预览和确认均走主进程 IPC，不调用模型或外部服务。
  const beforeExtraction = await instance.evaluate(() => globalThis.identityFixture.calls.length);
  const cancelled = await page.evaluate(
    (id) => window.sinan.documentAccounts.preview(id),
    document.id,
  );
  assert.equal(cancelled.candidates.length, 1);
  assert.equal(cancelled.candidates[0].username, "linked-account@example.test");
  assert.equal(cancelled.candidates[0].password, "Doc-Only-Password-2026");
  assert.equal((await stored()).state.secrets.length, 1);
  await page.evaluate((ticket) => window.sinan.documentAccounts.cancel(ticket), cancelled.ticket);
  const cancelledCommit = await page.evaluate(async (preview) => {
    try {
      await window.sinan.documentAccounts.commit({
        ticket: preview.ticket,
        candidates: preview.candidates,
      });
      return false;
    } catch {
      return true;
    }
  }, cancelled);
  assert.equal(cancelledCommit, true);
  const candidate = await page.evaluate(
    (id) => window.sinan.documentAccounts.preview(id),
    document.id,
  );
  const extracted = await page.evaluate(
    (preview) =>
      window.sinan.documentAccounts.commit({
        ticket: preview.ticket,
        candidates: preview.candidates,
      }),
    candidate,
  );
  assert.equal(extracted.added, 1);
  assert.equal(extracted.bindingError, undefined);
  const extractedId = extracted.assets[0].id;
  const extractedCredential = await page.evaluate(
    (id) => window.sinan.vault.get(`account:${id}`),
    extractedId,
  );
  assert.equal(extractedCredential.username, "linked-account@example.test");
  assert.equal(extractedCredential.password, "Doc-Only-Password-2026");
  const linkedDocument = await page.evaluate((id) => window.sinan.documents.get(id), document.id);
  assert.equal(linkedDocument.markdown, document.markdown);
  assert.deepEqual(linkedDocument.bindings, [
    { kind: "secret", id: account.id },
    { kind: "secret", id: extractedId },
  ]);
  const again = await page.evaluate((id) => window.sinan.documentAccounts.preview(id), document.id);
  const duplicateExtracted = await page.evaluate(
    (preview) =>
      window.sinan.documentAccounts.commit({
        ticket: preview.ticket,
        candidates: preview.candidates,
      }),
    again,
  );
  assert.equal(duplicateExtracted.added, 0);
  assert.equal(duplicateExtracted.existing, 1);
  assert.equal((await stored()).state.secrets.length, 2);
  assert.equal(
    await instance.evaluate(() => globalThis.identityFixture.calls.length),
    beforeExtraction,
  );
  await identityPanel().getByText("1 条帖子未能导入全文", { exact: true }).waitFor();
  await instance.evaluate(() => {
    globalThis.identityFixture.detailStatus = 200;
  });
  await identityPanel().getByRole("button", { name: "重试未导入的帖子", exact: true }).click();
  await page.waitForFunction(() =>
    window.sinan.documents.list().then((items) => items.length === 2),
  );
  assert.equal(await identityPanel().getByText("1 条帖子未能导入全文", { exact: true }).count(), 0);
  const cachedCalls = await postCallCount();
  await page.evaluate((id) => window.sinan.identities.loadPosts(id), account.id);
  assert.equal(await postCallCount(), cachedCalls);
  await instance.evaluate(() => {
    globalThis.identityFixture.postsStatus = 403;
  });
  await identityPanel().getByRole("button", { name: "刷新帖子", exact: true }).click();
  await identityPanel().getByText(/403/).waitFor();
  assert.equal(await identityPanel().getByRole("checkbox").count(), 2);
  const failedCalls = await postCallCount();
  await page.evaluate((id) => window.sinan.identities.loadPosts(id), account.id);
  assert.equal(await postCallCount(), failedCalls);

  // 用实际编辑表单重命名，重新授权必须保留使用者命名和已有密码。
  await details().getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "账号密码", exact: true });
  await editor.getByLabel("显示名称", { exact: true }).fill(customName);
  await editor.getByLabel("密码", { exact: true }).fill("integration-existing-password");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.waitForFunction(
    (id) =>
      window.sinan.store
        .load()
        .then(
          (value) =>
            value.state.secrets.find((asset) => asset.id === id)?.name === "我的社区资料回归",
        ),
    account.id,
  );
  await details().waitFor({ state: "detached" });
  await openAccount();
  await identityPanel().getByRole("button", { name: "查看已缓存帖子", exact: true }).click();
  assert.equal(await identityPanel().getByRole("checkbox").count(), 2);
  assert.equal(await postCallCount(), failedCalls);
  await identityPanel().getByRole("button", { name: "断开本机授权", exact: true }).click();
  await identityPanel().getByRole("button", { name: "确认断开本机授权", exact: true }).click();
  await identityPanel().getByText("已断开授权", { exact: true }).waitFor();
  await identityPanel().getByRole("button", { name: "重新授权", exact: true }).click();
  await authorizeInFixture();
  await importDialog().getByRole("button", { name: "确认导入身份", exact: true }).click();
  await importDialog().waitFor({ state: "detached" });
  await identityPanel().getByText("@qa_identity_owner", { exact: true }).waitFor();
  const repeated = (await stored()).state.secrets.filter(
    (asset) => asset.identityProvider === "linuxdo",
  );
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].name, customName);
  assert.equal(
    (await page.evaluate((id) => window.sinan.vault.get(`account:${id}`), account.id)).password,
    "integration-existing-password",
  );

  const totp = details().locator(".account-totp");
  await totp.getByRole("button", { name: /动态验证码/ }).click();
  await totp.getByRole("button", { name: "添加动态验证码", exact: true }).click();
  await totp
    .getByLabel("验证器密钥或 otpauth 链接", { exact: true })
    .fill(`otpauth://totp/Fixture%3Atest?secret=${seed}&issuer=Fixture`);
  await totp.getByRole("button", { name: "保存验证码配置", exact: true }).click();
  await totp.locator("[data-totp-code]").waitFor();
  const generated = await page.evaluate((id) => window.sinan.totp.code(id), account.id);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor((generated.expiresAt - 1) / 30000)));
  const digest = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const expected = String(
    (digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
  assert.equal(generated.code, expected);
  await totp.getByRole("button", { name: "复制动态验证码", exact: true }).click();
  assert.match(await page.evaluate(() => window.__identityCopied), /^\d{6}$/);
  assert.equal(await totp.getByLabel("验证器密钥或 otpauth 链接", { exact: true }).count(), 0);
  await page.screenshot({ path: join(screenshotDirectory, "identity-totp-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshotDirectory, "identity-totp-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 1000 });

  for (const key of [
    "identity-config:linuxdo",
    `identity-auth:${account.id}`,
    `totp:${account.id}`,
  ]) {
    const errors = await page.evaluate(async (id) => {
      const methods = [
        () => window.sinan.vault.get(id),
        () => window.sinan.vault.set(id, { secret: "bad" }),
        () => window.sinan.vault.remove(id),
      ];
      return Promise.all(
        methods.map(async (method) => {
          try {
            await method();
            return null;
          } catch (error) {
            return error.message;
          }
        }),
      );
    }, key);
    assert.ok(
      errors.every((message) => typeof message === "string" && /身份|验证码/.test(message)),
    );
  }

  const publicData = await readFile(join(directory, "assets.json"), "utf8");
  const vaultCipher = await readFile(join(directory, "vault.enc"), "utf8");
  for (const sensitive of [
    seed,
    "integration-private-client-secret",
    "integration-private-access",
    "integration-private-refresh",
    "identity-private@example.test",
    "integration-existing-password",
  ])
    assert.equal(
      (publicData + vaultCipher + JSON.stringify(document)).includes(sensitive),
      false,
      "普通资产、文档与库文件不得泄露敏感字段",
    );
  for (const sensitive of ["linked-account@example.test", "Doc-Only-Password-2026"])
    assert.equal(
      (publicData + vaultCipher).includes(sensitive),
      false,
      "提取的账号密码不得进入公开资产或明文密钥库",
    );

  await page.evaluate(() => window.sinan.vault.lock());
  await identityPanel().getByRole("button", { name: "解锁查看", exact: true }).waitFor();
  assert.equal(await totp.locator("[data-totp-code]").count(), 0);
  assert.equal(
    await identityPanel().getByText("identity-private@example.test", { exact: true }).count(),
    0,
  );
  const locked = await page.evaluate(
    async (id) =>
      Promise.all(
        [
          () => window.sinan.identities.get(id),
          () => window.sinan.identities.start(),
          () => window.sinan.totp.code(id),
        ].map(async (operation) => {
          try {
            await operation();
            return false;
          } catch {
            return true;
          }
        }),
      ),
    account.id,
  );
  assert.deepEqual(locked, [true, true, true]);
  await identityPanel().getByRole("button", { name: "解锁查看", exact: true }).click();
  await page.locator(".z-gate").locator('input[type="password"]').fill(master);
  await page.locator(".z-gate").getByRole("button", { name: "解锁", exact: true }).click();
  await page.locator(".z-gate").waitFor({ state: "detached" });
  await identityPanel().getByText("@qa_identity_owner", { exact: true }).waitFor();
  await identityPanel().getByRole("button", { name: "断开本机授权", exact: true }).click();
  await identityPanel().getByRole("button", { name: "确认断开本机授权", exact: true }).click();
  await identityPanel().getByText("已断开授权", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate((id) => window.sinan.identities.get(id), account.id)).connected,
    false,
  );
  assert.equal(
    (await page.evaluate((id) => window.sinan.totp.status(id), account.id)).configured,
    true,
  );
  await details().getByRole("button", { name: "删除", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除账号", exact: true })
    .getByRole("button", { name: "确认删除账号", exact: true })
    .click();
  await details().waitFor({ state: "detached" });
  await page.waitForFunction(
    (id) =>
      window.sinan.store
        .load()
        .then((value) => !value.state.secrets.some((asset) => asset.id === id)),
    account.id,
  );
  const records = await page.evaluate(() => window.sinan.vault.list());
  assert.equal(records.includes(`totp:${account.id}`), false);
  assert.equal(records.includes(`identity-auth:${account.id}`), false);
  assert.equal(records.includes(`account:${account.id}`), false);
  await page.evaluate(async (master) => {
    await window.sinan.vault.lock();
    await window.sinan.vault.unlock(master);
  }, master);
  assert.equal(
    (await stored()).state.secrets.some((asset) => asset.id === account.id),
    false,
  );
  assert.equal((await page.evaluate(() => window.sinan.documents.list())).length, 2);
  const network = await instance.evaluate(() => globalThis.identityFixture.calls);
  const publicCalls = network.filter((call) => call.url.startsWith("https://linux.do/"));
  assert.ok(publicCalls.every((call) => !call.headers.Authorization && !call.headers.Cookie));
  assert.deepEqual(pageErrors, []);
  const localUsage = JSON.parse(await readFile(join(directory, "local-usage.json"), "utf8"));
  assert.equal(localUsage.enabled, false);
  assert.deepEqual(localUsage.records, []);
  // 由第二个只读实例核验实际加密文件，避免仅相信渲染层返回值。
  const inspection = new Vault(join(directory, "vault.enc"));
  await inspection.unlock(master);
  assert.equal(await inspection.get(`totp:${account.id}`), null);
  assert.equal(await inspection.get(`identity-auth:${account.id}`), null);
  inspection.lock();
  console.log(
    JSON.stringify({
      ok: true,
      isolated: true,
      packaged: Boolean(packaged),
      realLocalLogMonitoringDisabled: true,
      officialEndpointsMocked: true,
      loopbackReal: true,
      confirmBeforeImport: true,
      historicalIdentityFixture: true,
      historicalReauthorizationUi: true,
      duplicateIdentityPreservesAccount: true,
      publicPostsNoCredentials: true,
      cacheAnd403: true,
      fullPostDocumentLinked: true,
      partialImportAndRetry: true,
      fullPostToAccountImport: true,
      extractionPreviewCancelDedupAndLocalOnly: true,
      privateIpcBlocked: true,
      totpRfcVerified: true,
      lockClearsPrivateUi: true,
      deleteClearsSeedAndIdentity: true,
      desktopMobile: true,
      pageErrors,
    }),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(screenshotDirectory, "identity-totp-failure.png") })
      .catch(() => {});
  throw error;
} finally {
  await instance?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("zhiyu-identity-totp-"));
  await rm(directory, { recursive: true, force: true });
}
