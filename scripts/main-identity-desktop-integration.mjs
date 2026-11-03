import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright";

// 使用真实 Electron、真实本机回调和系统加密；仅外部登录服务与论坛响应为合成样本。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-main-identity-"));
const screenshots = resolve("release/main-identity-qa");
const packaged = process.argv[2];
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
if (packaged) delete env.NANPAD_TEST_DATA_DIR;
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
const credential = "synthetic-identity-broker-credential-2026";
const master = "integration-master-2026";
const errors = [];
const checks = [];
let instance;
let page;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function launch() {
  instance = await electron.launch({
    ...(packaged ? { executablePath: resolve(packaged) } : {}),
    args: packaged ? [`--user-data-dir=${directory}`] : [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  assert.equal(await instance.evaluate(({ app }) => app.isPackaged), Boolean(packaged));
  await instance.evaluate(({ net, shell, session, nativeImage }, credential) => {
    globalThis.mainIdentityFixture = {
      configured: false,
      opened: [],
      calls: [],
      starts: [],
      unknown: [],
      profile: {
        subject: "709995",
        username: "qa_main_identity",
        name: "主身份验证用户",
        email: "main-identity@example.test",
        trustLevel: 2,
        avatarUrl: "https://linux.do/user_avatar/linux.do/qa_main_identity/96/fixture.png",
        profileUrl: "https://linux.do/u/qa_main_identity",
        active: true,
        silenced: false,
      },
    };
    const image = nativeImage
      .createFromBitmap(
        Buffer.from([50, 80, 90, 255, 60, 90, 100, 255, 80, 110, 120, 255, 90, 120, 130, 255]),
        { width: 2, height: 2 },
      )
      .toPNG();
    // 浏览器页面不允许触发外部网络，OAuth只记录系统浏览器目标。
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({
        cancel:
          ["http:", "https:"].includes(url.protocol) &&
          !["127.0.0.1", "localhost"].includes(url.hostname),
      });
    });
    const originalFetch = net.fetch.bind(net);
    net.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (!["http:", "https:"].includes(url.protocol)) return originalFetch(input, init);
      const fixture = globalThis.mainIdentityFixture;
      fixture.calls.push({
        url: url.href,
        headers: init.headers || {},
        credentials: init.credentials,
        redirect: init.redirect,
      });
      const json = (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.href === "https://auth.allinsong.top/healthz")
        return json({ ok: true, configured: fixture.configured });
      if (url.href === "https://auth.allinsong.top/v1/login/start") {
        fixture.starts.push(JSON.parse(init.body));
        return json({
          id: "broker-" + fixture.starts.length,
          expiresAt: Date.now() + 300000,
          authorizationUrl:
            "https://connect.linux.do/oauth2/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Fauth.allinsong.top%2Foauth%2Flinuxdo%2Fcallback&state=synthetic-official-state",
        });
      }
      if (
        [
          "https://auth.allinsong.top/v1/login/exchange",
          "https://auth.allinsong.top/v1/session/profile",
        ].includes(url.href)
      )
        return json({ credential, expiresAt: Date.now() + 3600000, profile: fixture.profile });
      if (url.href === fixture.profile.avatarUrl)
        return new Response(image, { status: 200, headers: { "Content-Type": "image/png" } });
      if (url.origin === "https://linux.do" && url.pathname === "/user_actions.json")
        return json({
          user_actions: [
            {
              action_type: 4,
              username: "qa_main_identity",
              user_id: 709995,
              topic_id: 9010,
              post_id: 19010,
              post_number: 1,
              title: "主身份本人帖子",
              excerpt: "<p>合成摘要，不应代替全文</p>",
              created_at: "2026-10-09T03:00:00Z",
            },
          ],
        });
      if (url.href === "https://linux.do/posts/19010.json")
        return json({
          id: 19010,
          topic_id: 9010,
          post_number: 1,
          user_id: 709995,
          username: "qa_main_identity",
          raw: "# 本人帖子完整内容\n\n这是只有全文接口提供的末尾。\n\n| 名称 | 网址 | 账号 | 密码 |\n| --- | --- | --- | --- |\n| 合成文档账号 | https://fixture.example.test/login | document@example.test | Synthetic-Password-Only-2026 |",
        });
      fixture.unknown.push(url.href);
      throw new Error("测试阻止未声明的外部请求");
    };
    shell.openExternal = async (url) => {
      globalThis.mainIdentityFixture.opened.push(url);
    };
  }, credential);
  page = await instance.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 1000 });
}

try {
  await mkdir(screenshots, { recursive: true });
  await writeFile(
    join(directory, "preferences.json"),
    JSON.stringify({
      locale: "zh",
      notifications: false,
      closeToTray: false,
      serverMonitorMinutes: 0,
    }),
  );
  await writeFile(
    join(directory, "local-usage.json"),
    JSON.stringify({ version: 1, enabled: false, checkpoints: [], events: [], records: [] }),
  );
  await launch();
  const onboarding = () => page.getByRole("dialog", { name: "首次设置", exact: true });
  const identity = () => page.getByRole("region", { name: "Linux.do 主身份", exact: true });
  const settings = () => page.getByRole("dialog", { name: "设置", exact: true });
  async function showProfile() {
    await page
      .locator("aside:visible")
      .getByRole("button", { name: "更多操作", exact: true })
      .click();
    await page
      .locator("aside:visible")
      .getByRole("button", { name: "个人资料", exact: true })
      .click();
    await identity().waitFor();
  }
  async function authorize(label = "使用 Linux.do 登录") {
    await identity().getByRole("button", { name: label, exact: true }).click();
    await identity()
      .getByText("请在浏览器完成 Linux.do 登录，授权后这里会显示资料预览。", { exact: true })
      .waitFor();
    const request = await instance.evaluate(() => globalThis.mainIdentityFixture.starts.at(-1));
    const official = new URL(
      await instance.evaluate(() => globalThis.mainIdentityFixture.opened.at(-1)),
    );
    assert.equal(official.origin, "https://connect.linux.do");
    assert.match(request.challenge, /^[A-Za-z0-9_-]{43}$/);
    const callback = new URL(request.redirectUri);
    assert.equal(callback.hostname, "127.0.0.1");
    assert.equal(callback.pathname, "/oauth/zhiyu/callback");
    assert.ok(Number(callback.port) > 0);
    callback.search = new URLSearchParams({
      state: "bad-state",
      code: "synthetic-code",
    }).toString();
    const rejected = await fetch(callback);
    assert.equal(rejected.status, 400);
    await rejected.text();
    callback.search = new URLSearchParams({
      state: request.state,
      code: "synthetic-code",
    }).toString();
    const accepted = await fetch(callback);
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get("content-type"), /text\/html/);
    const html = await accepted.text();
    assert.match(html, /回到知屿，确认绑定/);
    assert.match(html, /关闭此页/);
    assert.ok(!html.includes(request.state));
    assert.ok(!html.includes("synthetic-code"));
    await identity().getByText("登录成功，请确认主身份", { exact: true }).waitFor();
  }
  await onboarding().waitFor();
  await identity()
    .getByText("Linux.do 登录服务尚未配置完成，暂可使用本地账户。", { exact: true })
    .waitFor();
  assert.equal(
    await identity().getByRole("button", { name: "使用 Linux.do 登录", exact: true }).isDisabled(),
    true,
  );
  await instance.evaluate(() => {
    globalThis.mainIdentityFixture.configured = true;
  });
  await identity().getByRole("button", { name: "重新检查", exact: true }).click();
  await identity().getByRole("button", { name: "使用 Linux.do 登录", exact: true }).click();
  await identity().getByRole("button", { name: "浏览器报错？重新发起", exact: true }).waitFor();
  const previousRequest = await instance.evaluate(() =>
    globalThis.mainIdentityFixture.starts.at(-1),
  );
  await identity().getByRole("button", { name: "浏览器报错？重新发起", exact: true }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".primary-identity-actions button")).some(
      (button) => button.textContent.includes("浏览器报错？重新发起") && !button.disabled,
    ),
  );
  const nextRequest = await instance.evaluate(() => globalThis.mainIdentityFixture.starts.at(-1));
  assert.notEqual(nextRequest.state, previousRequest.state);
  assert.notEqual(nextRequest.challenge, previousRequest.challenge);
  assert.equal(await page.evaluate(() => window.sinan.mainIdentity.get()), null);
  await identity().getByRole("button", { name: "取消本次授权", exact: true }).click();
  checks.push("浏览器错误恢复重新生成 state 与 PKCE，取消旧授权且不写入主身份");
  await authorize();
  assert.equal(await exists(join(directory, "main-identity.enc")), false);
  assert.equal(await exists(join(directory, "vault.enc")), false);
  assert.equal(await page.evaluate(() => window.sinan.mainIdentity.get()), null);
  await identity().getByRole("button", { name: "取消本次授权", exact: true }).click();
  assert.equal(await exists(join(directory, "main-identity.enc")), false);
  checks.push("未创建密钥库即可登录预览；未配置服务禁止启动；随机回调校验state；取消不落盘");

  await authorize();
  assert.equal(
    await identity().getByLabel("同步 Linux.do 昵称", { exact: true }).isChecked(),
    false,
  );
  assert.equal(
    await identity().getByLabel("同步 Linux.do 头像", { exact: true }).isChecked(),
    false,
  );
  await identity().getByLabel("同步 Linux.do 昵称", { exact: true }).check();
  await identity().getByLabel("同步 Linux.do 头像", { exact: true }).check();
  await identity().getByRole("button", { name: "确认绑定主身份", exact: true }).click();
  await identity().getByText("已绑定主身份", { exact: true }).waitFor();
  const beforeVault = await page.evaluate(() => window.sinan.profile.get());
  assert.equal(beforeVault.ready, false);
  assert.equal(beforeVault.vaultExists, false);
  assert.equal(beforeVault.name, "主身份验证用户");
  assert.match(beforeVault.avatarDataUrl, /^data:image\/png;base64,/);
  assert.equal(await exists(join(directory, "vault.enc")), false);
  assert.equal(
    await onboarding().getByRole("textbox", { name: "工作区名称", exact: true }).inputValue(),
    "主身份验证用户",
  );
  await onboarding().getByRole("textbox", { name: "主密码", exact: true }).fill(master);
  await onboarding().getByRole("textbox", { name: "确认主密码", exact: true }).fill(master);
  await onboarding().getByRole("button", { name: "进入知屿", exact: true }).click();
  await onboarding().waitFor({ state: "detached" });
  await page.locator('[data-app-ready="true"]').waitFor();
  await page
    .locator("aside:visible .sidebar-profile-details")
    .getByText("主身份验证用户", { exact: true })
    .waitFor();
  assert.match(
    await page.locator("aside:visible .sidebar-profile-avatar img").getAttribute("src"),
    /^data:image\/png;base64,/,
  );
  const profile = await page.evaluate(() => window.sinan.profile.get());
  assert.equal(profile.mainIdentity.syncName, true);
  assert.equal(profile.mainIdentity.syncAvatar, true);
  assert.equal(profile.ready, true);
  checks.push("确认同步头像昵称后仍需本地主密码；保存密码不关闭同步；侧栏展示同步资料");

  await page.evaluate(() => window.sinan.vault.lock());
  await showProfile();
  await instance.evaluate(() => {
    globalThis.mainIdentityFixture.profile.trustLevel = 3;
  });
  await identity().getByRole("button", { name: "刷新身份资料", exact: true }).click();
  await identity().getByText("信任等级 3", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.sinan.vault.status())).unlocked, false);
  const publicIdentity = await page.evaluate(() => window.sinan.mainIdentity.get());
  assert.equal(Object.hasOwn(publicIdentity, "credential"), false);
  assert.equal(JSON.stringify(publicIdentity).includes(credential), false);
  const assets = (await page.evaluate(() => window.sinan.store.load()))?.state;
  assert.equal(assets?.secrets?.length || 0, 0);
  checks.push("锁库状态可刷新主身份；资料DTO不含凭据；绑定不创建普通账号资产");

  await identity().getByRole("button", { name: "加载我的帖子", exact: true }).click();
  await identity().getByLabel("选择帖子 主身份本人帖子", { exact: true }).check();
  const listCallsBefore = await instance.evaluate(
    () =>
      globalThis.mainIdentityFixture.calls.filter((call) => call.url.includes("/user_actions.json"))
        .length,
  );
  await page.evaluate(() => window.sinan.mainIdentity.loadPosts());
  assert.equal(
    await instance.evaluate(
      () =>
        globalThis.mainIdentityFixture.calls.filter((call) =>
          call.url.includes("/user_actions.json"),
        ).length,
    ),
    listCallsBefore,
  );
  await identity().getByRole("button", { name: "保存所选全文（1）", exact: true }).click();
  await identity().getByRole("button", { name: "打开已保存文档", exact: true }).waitFor();
  const docs = await page.evaluate(() => window.sinan.documents.list());
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0].bindings, []);
  const document = await page.evaluate((id) => window.sinan.documents.get(id), docs[0].id);
  assert.match(document.markdown, /只有全文接口提供的末尾/);
  assert.doesNotMatch(document.markdown, /合成摘要/);
  assert.equal(
    (await page.evaluate(() => window.sinan.store.load()))?.state?.secrets?.length || 0,
    0,
  );
  await page.screenshot({ path: join(screenshots, "main-identity-posts-desktop.png") });
  await identity().locator("h3").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "main-identity-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await identity().locator("h3").scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshots, "main-identity-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await identity().getByRole("button", { name: "打开已保存文档", exact: true }).click();
  await settings().waitFor({ state: "detached" });
  checks.push(
    "本人帖子缓存与全文导入真实落盘；锁库仍可保存文档，无不存在的secret关联；桌面与390px渲染通过",
  );

  const encrypted = await readFile(join(directory, "main-identity.enc"));
  const profileFile = await readFile(join(directory, "profile.json"), "utf8");
  assert.equal(encrypted.includes(Buffer.from(credential)), false);
  assert.equal(profileFile.includes(credential), false);
  assert.equal(profileFile.includes("main-identity@example.test"), false);
  const encryptedProof = await instance.evaluate(
    ({ safeStorage }, bytes) => {
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(bytes)));
      return {
        version: value.version,
        hasCredential: typeof value.identity?.credential === "string",
        subject: value.identity?.profile?.subject,
      };
    },
    [...encrypted],
  );
  assert.deepEqual(encryptedProof, { version: 1, hasCredential: true, subject: "709995" });
  checks.push("系统safeStorage能解密身份文件；磁盘密文、个人资料及renderer DTO没有登录凭据明文");

  await showProfile();
  await identity().getByRole("button", { name: "退出 Linux.do 登录", exact: true }).click();
  await identity().getByRole("button", { name: "确认退出 Linux.do 登录", exact: true }).click();
  await identity().getByText("已退出登录", { exact: true }).waitFor();
  const signedOut = await page.evaluate(() => window.sinan.mainIdentity.get());
  assert.equal(signedOut.connected, false);
  assert.equal(signedOut.profile.username, "qa_main_identity");
  const blocked = await page.evaluate(async () => {
    try {
      await window.sinan.mainIdentity.loadPosts();
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blocked, true);
  const signedOutProof = await instance.evaluate(
    ({ safeStorage }, bytes) => {
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(bytes)));
      return { credential: value.identity.credential, posts: value.identity.posts.items.length };
    },
    [...(await readFile(join(directory, "main-identity.enc")))],
  );
  assert.deepEqual(signedOutProof, { credential: null, posts: 0 });
  const network = await instance.evaluate(() => globalThis.mainIdentityFixture.calls);
  const publicCalls = network.filter((call) => call.url.startsWith("https://linux.do/"));
  assert.ok(publicCalls.length >= 3);
  assert.ok(publicCalls.every((call) => !call.headers.Authorization && !call.headers.Cookie));
  assert.ok(network.every((call) => call.credentials === "omit" && call.redirect === "error"));
  await instance.close();
  instance = null;
  await launch();
  await page.locator('[data-app-ready="true"]').waitFor();
  const reopened = await page.evaluate(() => window.sinan.profile.get());
  assert.equal(reopened.mainIdentity.connected, false);
  assert.equal(reopened.mainIdentity.profile.username, "qa_main_identity");
  assert.equal((await page.evaluate(() => window.sinan.documents.list())).length, 1);
  checks.push("退出清除登录凭据和帖子缓存并禁止后续读取；重启后保留身份展示与已导入文档");
  await instance.evaluate(() => {
    globalThis.mainIdentityFixture.configured = true;
    globalThis.mainIdentityFixture.profile.subject = "709996";
    globalThis.mainIdentityFixture.profile.username = "qa_without_avatar";
    globalThis.mainIdentityFixture.profile.avatarUrl = null;
  });
  await showProfile();
  await authorize("重新登录 Linux.do");
  assert.equal(
    await identity().getByLabel("同步 Linux.do 头像", { exact: true }).isChecked(),
    false,
  );
  await identity()
    .getByRole("checkbox", { name: /确认将主身份从 @qa_main_identity 更换为 @qa_without_avatar/ })
    .check();
  await identity().getByRole("button", { name: "确认更换主身份", exact: true }).click();
  await identity().getByText("已绑定主身份", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.sinan.mainIdentity.get())).avatarDataUrl, "");
  await instance.close();
  instance = null;
  await launch();
  await page.locator('[data-app-ready="true"]').waitFor();
  const withoutAvatar = await page.evaluate(() => window.sinan.mainIdentity.get());
  assert.equal(withoutAvatar.profile.subject, "709996");
  assert.equal(withoutAvatar.avatarDataUrl, "");
  assert.equal(withoutAvatar.syncAvatar, false);
  const missingAvatar = await page.evaluate(() =>
    window.sinan.mainIdentity.preferences({ syncName: false, syncAvatar: true }),
  );
  assert.equal(missingAvatar.avatarDataUrl, "");
  assert.match(missingAvatar.avatarMessage, /未提供/);
  await instance.close();
  instance = null;
  await launch();
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.equal((await page.evaluate(() => window.sinan.mainIdentity.get())).avatarDataUrl, "");
  checks.push("改绑主身份需确认；未勾选头像及平台缺失头像两种情况均可重启恢复");
  const usage = JSON.parse(await readFile(join(directory, "local-usage.json"), "utf8"));
  assert.equal(usage.enabled, false);
  assert.deepEqual(usage.records, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        packaged: Boolean(packaged),
        isolated: true,
        realLoopback: true,
        externalResponsesMocked: true,
        localUsageDisabled: true,
        checks,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page?.screenshot({ path: join(screenshots, "main-identity-failure.png") }).catch(() => {});
  throw error;
} finally {
  await instance?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("zhiyu-main-identity-"));
  await rm(directory, { recursive: true, force: true });
}
