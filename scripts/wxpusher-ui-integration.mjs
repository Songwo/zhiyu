import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { chooseOption } from "./select-helper.mjs";

// 合成桥接配置；不读取真实推送凭据、不发送外部消息。
const origin = new URL(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8080").origin;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}/__wxpusher-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="root" style="max-width:660px;padding:32px;margin:auto"></main></body></html>',
    }),
  );
  await page.goto(`${origin}/__wxpusher-test`);
  await page.evaluate(async () => {
    const RefreshRuntime = (await import("/@react-refresh")).default;
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    window.__saves = [];
    window.__testCount = 0;
    let config = {
      enabled: false,
      provider: "telegram",
      destination: "",
      hasToken: false,
      mailboxIds: [],
      intervalMinutes: 15,
    };
    window.sinan = {
      store: { load: async () => null, save: async () => {} },
      mailPush: {
        config: async () => config,
        save: async (input) => {
          window.__saves.push(input);
          const { token, clearToken, ...rest } = input;
          config = { ...rest, hasToken: Boolean(token) || (!clearToken && config.hasToken) };
          return config;
        },
        test: async () => {
          window.__testCount++;
          return { ok: true };
        },
      },
    };
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { MailPushSettings } = await import("/src/components/mail-push-settings.tsx");
    const resources = performance.getEntriesByType("resource");
    const { useVault } = await import(
      resources.find((entry) => entry.name.includes("/src/lib/vault-state.ts")).name
    );
    useVault.setState({ unlocked: true, exists: true });
    const { useAppStore } = await import(
      resources.find((entry) => entry.name.includes("/src/lib/store.ts")).name
    );
    useAppStore.setState({
      hydrated: true,
      mailboxes: [
        {
          id: "test-mail",
          kind: "mailbox",
          address: "fixture@example.test",
          status: "online",
          tags: [],
        },
      ],
    });
    ReactDOM.createRoot(document.getElementById("root")).render(
      React.createElement(MailPushSettings),
    );
  });
  await chooseOption(page, page.getByRole("combobox", { name: "推送渠道" }), "WxPusher");
  await page.getByLabel("接收用户 UID", { exact: true }).fill("UID_syntheticRecipient2026");
  await page.getByLabel("推送凭据", { exact: true }).fill("AT_syntheticWxpusherToken2026");
  await page.getByRole("checkbox", { name: "fixture@example.test" }).check();
  await page.getByRole("checkbox", { name: "启用自动邮件推送" }).check();
  assert.equal(await page.getByRole("button", { name: "发送测试消息" }).isDisabled(), true);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "邮件推送配置已保存。" }).waitFor();
  const saved = await page.evaluate(() => window.__saves.at(-1));
  assert.equal(saved.provider, "wxpusher");
  assert.equal(saved.destination, "UID_syntheticRecipient2026");
  assert.equal(saved.token, "AT_syntheticWxpusherToken2026");
  assert.deepEqual(saved.mailboxIds, ["test-mail"]);
  assert.equal(await page.getByLabel("推送凭据", { exact: true }).inputValue(), "");
  await page.getByRole("button", { name: "发送测试消息" }).click();
  await page.getByRole("status").filter({ hasText: "测试消息已发送。" }).waitFor();
  assert.equal(await page.evaluate(() => window.__testCount), 1);
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/wxpusher-settings-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/wxpusher-settings-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await chooseOption(page, page.getByRole("combobox", { name: "推送渠道" }), "Telegram");
  assert.equal(await page.getByLabel("接收用户 UID", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Chat ID", { exact: true }).inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "发送测试消息" }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        wxpusherSettings: true,
        credentialsCleared: true,
        testAction: true,
        mobileOverflow: false,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
