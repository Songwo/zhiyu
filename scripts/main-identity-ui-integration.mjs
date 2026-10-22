import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = new URL(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8080").origin;
const browser = await chromium.launch({ headless: true });
const errors = [];
const checks = [];
await mkdir("release/screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    locale: "zh-CN",
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.fulfill({ status: 204, body: "" }),
  );
  await context.route(`${origin}/__ui-regression/main-identity`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="root" style="max-width:620px;margin:24px auto;padding:16px"></main></body></html>',
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/__ui-regression/main-identity`);
  await page.evaluate(async () => {
    window.__configured = true;
    window.__ready = false;
    window.__cancelled = [];
    window.__binds = [];
    window.__saves = [];
    window.__postLoads = [];
    window.__postSaves = [];
    window.__assetWrites = 0;
    window.__profile = {
      name: "我的本机昵称",
      avatarDataUrl: "",
      ready: false,
      vaultExists: false,
      mainIdentity: null,
    };
    window.__provider = {
      subject: "100",
      username: "demo_user",
      name: "社区昵称",
      email: "demo@example.test",
      trustLevel: 2,
      avatarUrl: null,
      profileUrl: "https://linux.do/u/demo_user",
      active: true,
      silenced: false,
    };
    const copy = (value) => structuredClone(value);
    const update = () => {
      const identity = window.__profile.mainIdentity;
      if (identity?.syncName)
        window.__profile.name = identity.profile.name || identity.profile.username;
      if (identity?.syncAvatar && identity.avatarDataUrl)
        window.__profile.avatarDataUrl = identity.avatarDataUrl;
    };
    let sequence = 0;
    window.sinan = {
      store: {
        load: async () => null,
        save: async (value) => {
          if (value.state?.secrets?.length || value.secrets?.length) window.__assetWrites++;
        },
      },
      onVaultChanged: () => () => {},
      openExternal: async () => {},
      profile: {
        get: async () => {
          update();
          return copy(window.__profile);
        },
        save: async (value) => {
          window.__saves.push(copy(value));
          if (value.password && value.password.length < 10) throw new Error("主密码至少 10 位");
          window.__profile.name = value.name;
          if (value.avatarDataUrl !== undefined)
            window.__profile.avatarDataUrl = value.avatarDataUrl;
          if (value.password) {
            window.__profile.ready = true;
            window.__profile.vaultExists = true;
          }
          return copy(window.__profile);
        },
      },
      vault: { status: async () => ({ exists: window.__profile.vaultExists, unlocked: false }) },
      mainIdentity: {
        get: async () => copy(window.__profile.mainIdentity),
        availability: async () => ({
          configured: window.__configured,
          message: window.__configured ? "" : "登录服务未配置，稍后可重试。",
        }),
        start: async () => {
          if (!window.__configured) throw new Error("登录服务未配置");
          return { id: "session-" + ++sequence, expiresAt: Date.now() + 300000 };
        },
        status: async (id) => ({
          id,
          status: window.__ready ? "ready" : "waiting",
          ...(window.__ready ? { preview: copy(window.__provider), avatarDataUrl: "" } : {}),
        }),
        cancel: async (id) => {
          window.__cancelled.push(id);
        },
        bind: async (value) => {
          window.__binds.push(copy(value));
          window.__profile.mainIdentity = {
            provider: "linuxdo",
            profile: copy(window.__provider),
            connected: true,
            updatedAt: new Date().toISOString(),
            syncName: value.syncName,
            syncAvatar: value.syncAvatar,
            avatarDataUrl: "",
          };
          update();
          return copy(window.__profile.mainIdentity);
        },
        preferences: async (value) => {
          Object.assign(window.__profile.mainIdentity, value);
          update();
          return copy(window.__profile.mainIdentity);
        },
        refresh: async () => {
          window.__profile.mainIdentity.profile.trustLevel = 3;
          update();
          return copy(window.__profile.mainIdentity);
        },
        disconnect: async () => {
          window.__profile.mainIdentity.connected = false;
        },
        loadPosts: async (options) => {
          window.__postLoads.push(copy(options));
          return {
            assetId: "",
            provider: "linuxdo",
            profile: copy(window.__provider),
            connected: true,
            updatedAt: new Date().toISOString(),
            posts: {
              items: [
                {
                  id: "post-1",
                  postId: 1,
                  title: "我的部署记录",
                  url: "https://linux.do/t/topic/1",
                  kind: "topic",
                  excerpt: "本人公开帖子摘要",
                  createdAt: new Date().toISOString(),
                },
              ],
              fetchedAt: new Date().toISOString(),
              status: "ready",
              message: "",
              nextOffset: 1,
              hasMore: false,
            },
          };
        },
        savePosts: async (options) => {
          window.__postSaves.push(copy(options));
          return window.__postSaves.length === 1
            ? {
                documentId: null,
                imported: 0,
                errors: [{ id: "post-1", message: "平台暂时限制访问，请重试。" }],
              }
            : { documentId: "doc-main-identity", imported: 1, errors: [] };
        },
      },
      documents: {
        get: async () => ({
          id: "doc-main-identity",
          title: "本人帖子",
          content: { type: "doc", content: [] },
          bindings: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        list: async () => [],
      },
    };
    const RefreshRuntime = (await import("/@react-refresh")).default;
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { PrimaryIdentityPanel } = await import("/src/components/primary-identity-panel.tsx");
    const { Onboarding, ProfileForm } = await import("/src/components/onboarding.tsx");
    const { Settings, SettingsPage } = await import("/src/components/settings.tsx");
    const { Sidebar } = await import("/src/components/sidebar.tsx");
    const { VaultWorkspace } = await import("/src/components/vault-workspace.tsx");
    const resource = (path) =>
      performance.getEntriesByType("resource").find((item) => item.name.includes(path)).name;
    window.__profileStore = (await import(resource("/src/lib/profile.ts"))).useProfile;
    window.__vaultStore = (await import(resource("/src/lib/vault-state.ts"))).useVault;
    window.__appStore = (await import(resource("/src/lib/store.ts"))).useAppStore;
    window.__vaultStore.setState({ checked: true, unlocked: false, exists: true });
    window.__appStore.setState({
      secrets: [],
      servers: [],
      mailboxes: [],
      services: [],
      aiAssets: [],
      certs: [],
      domains: [],
      settingsOpen: false,
    });
    window.__mount = async (mode) => {
      window.__root?.unmount();
      await window.__profileStore.getState().refresh();
      window.__root = ReactDOM.createRoot(document.getElementById("root"));
      const children =
        mode === "onboarding"
          ? React.createElement(Onboarding)
          : mode === "settings"
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(Sidebar),
                React.createElement(Settings),
                React.createElement(SettingsPage),
              )
            : mode === "vault"
              ? React.createElement(VaultWorkspace)
              : React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(PrimaryIdentityPanel),
                  React.createElement(ProfileForm),
                );
      window.__root.render(children);
    };
    await window.__mount("onboarding");
  });

  const onboarding = page.getByRole("dialog", { name: "首次设置", exact: true });
  await onboarding.getByRole("button", { name: "使用 Linux.do 登录", exact: true }).click();
  await page
    .getByText("请在浏览器完成 Linux.do 登录，授权后这里会显示资料预览。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "取消本次授权", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__cancelled.length), 1);
  assert.equal(await page.evaluate(() => window.__binds.length), 0);
  checks.push("首次设置原生弹窗内可启动与取消登录，取消不会创建主身份或账号资产");

  await page.evaluate(() => {
    window.__ready = true;
  });
  await onboarding.getByRole("textbox", { name: "工作区名称", exact: true }).fill("正在编辑的草稿");
  await onboarding.getByRole("button", { name: "使用 Linux.do 登录", exact: true }).click();
  await page.getByText("登录成功，请确认主身份", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("同步 Linux.do 昵称", { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel("同步 Linux.do 头像", { exact: true }).isChecked(), false);
  assert.equal(await page.evaluate(() => window.__binds.length), 0);
  await page.getByLabel("同步 Linux.do 昵称", { exact: true }).check();
  await page.getByLabel("同步 Linux.do 头像", { exact: true }).check();
  await page.getByRole("button", { name: "确认绑定主身份", exact: true }).click();
  await page.getByText("已绑定主身份", { exact: true }).waitFor();
  assert.equal(
    await onboarding.getByRole("textbox", { name: "工作区名称", exact: true }).inputValue(),
    "社区昵称",
  );
  assert.equal(await onboarding.isVisible(), true);
  assert.equal(await page.evaluate(() => window.__profile.ready), false);
  assert.deepEqual(
    await page.evaluate(() => ({
      syncName: window.__binds[0].syncName,
      syncAvatar: window.__binds[0].syncAvatar,
    })),
    { syncName: true, syncAvatar: true },
  );
  await onboarding
    .getByRole("textbox", { name: "主密码", exact: true })
    .fill("integration-master-2026");
  await onboarding
    .getByRole("textbox", { name: "确认主密码", exact: true })
    .fill("integration-master-2026");
  await onboarding.getByRole("button", { name: "进入知屿", exact: true }).click();
  await onboarding.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__saves[0].name), "社区昵称");
  checks.push("登录先预览并选择同步；确认同步更新草稿，绑定身份不会跳过本地主密码设置");

  await page.evaluate(() => window.__mount("profile"));
  await page.getByText("信任等级 2", { exact: true }).waitFor();
  await page.getByText("demo@example.test", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "你的名字", exact: true }).fill("未保存的本机昵称");
  await page.getByLabel("同步 Linux.do 昵称", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存同步偏好", exact: true }).click();
  await page
    .getByRole("button", { name: "保存同步偏好", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("textbox", { name: "你的名字", exact: true }).inputValue(),
    "未保存的本机昵称",
  );
  await page.getByRole("button", { name: "刷新身份资料", exact: true }).click();
  await page.getByText("信任等级 3", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__vaultStore.getState().unlocked), false);
  assert.equal(
    await page.getByRole("textbox", { name: "你的名字", exact: true }).inputValue(),
    "未保存的本机昵称",
  );
  checks.push("密钥库锁定时仍可管理主身份、刷新等级和修改同步偏好，未同步字段的编辑草稿保留");

  await page.getByRole("button", { name: "加载我的帖子", exact: true }).click();
  await page.getByLabel("选择帖子 我的部署记录", { exact: true }).check();
  await page.getByRole("button", { name: "保存所选全文（1）", exact: true }).click();
  await page.getByText("1 条帖子未能导入全文", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重试未导入的帖子", exact: true }).click();
  await page.getByRole("button", { name: "打开已保存文档", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__postSaves[1].force), true);
  await page.screenshot({ path: "release/screenshots/main-identity-profile.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "release/screenshots/main-identity-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "打开已保存文档", exact: true }).click();
  await page.waitForFunction(() => window.__appStore.getState().view === "docs");
  checks.push("本人帖子读取缓存、勾选全文、失败强制重试、打开文档贯通，390px布局无横向溢出");

  await page.evaluate(() => {
    window.__provider.subject = "200";
    window.__provider.username = "second_user";
    window.__provider.email = null;
  });
  await page.getByRole("button", { name: "更换登录账号", exact: true }).click();
  await page.getByText("登录成功，请确认主身份", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "确认更换主身份", exact: true }).isDisabled(),
    true,
  );
  await page.getByText("未提供", { exact: true }).waitFor();
  await page
    .getByLabel("确认将主身份从 @demo_user 更换为 @second_user，已有本机资产和文档保留。", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "确认更换主身份", exact: true }).click();
  await page.getByText("已绑定主身份", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__binds[1].replaceSubject), "100");
  assert.equal(await page.evaluate(() => window.__binds[1].syncName), false);
  assert.equal(await page.evaluate(() => window.__assetWrites), 0);
  checks.push(
    "更换主身份必须明确确认并提交旧subject，缺失邮箱显示未提供，全流程不创建密钥库账号资产",
  );

  await page.getByRole("button", { name: "退出 Linux.do 登录", exact: true }).click();
  await page.getByRole("button", { name: "确认退出 Linux.do 登录", exact: true }).click();
  await page.getByText("已退出登录", { exact: true }).waitFor();
  await page.evaluate(async () => {
    window.__profile.mainIdentity = null;
    window.__profile.ready = false;
    window.__profile.vaultExists = false;
    window.__configured = false;
    await window.__mount("onboarding");
  });
  await page.getByText("登录服务未配置，稍后可重试。", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "使用 Linux.do 登录", exact: true }).isDisabled(),
    true,
  );
  await onboarding
    .getByRole("textbox", { name: "主密码", exact: true })
    .fill("local-only-master-2026");
  await onboarding
    .getByRole("textbox", { name: "确认主密码", exact: true })
    .fill("local-only-master-2026");
  await onboarding.getByRole("button", { name: "进入知屿", exact: true }).click();
  await onboarding.waitFor({ state: "detached" });
  checks.push("退出登录保留身份资料；未配置登录服务明确提示且仍能完成纯本机首次设置");

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.evaluate(() => window.__mount("settings"));
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("button", { name: "个人资料", exact: true }).click();
  // 头像菜单进入的设置是页面，不是弹窗。
  await page
    .getByRole("region", { name: "设置", exact: true })
    .getByText("Linux.do 主身份", { exact: true })
    .waitFor();
  await page.evaluate(() => window.__mount("vault"));
  await page.getByRole("button", { name: "添加账号", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "导入身份", exact: true }).count(), 0);
  checks.push("侧栏个人资料直达绑定入口，密钥库移除新身份导入入口");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, errors }, null, 2));
} finally {
  await browser.close();
}
