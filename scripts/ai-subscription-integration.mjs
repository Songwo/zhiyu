import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { chooseOption, verifyOptions } from "./select-helper.mjs";

const providerNames = {
  openai: "OpenAI / ChatGPT",
  claude: "Anthropic / Claude",
  grok: "xAI / Grok",
  gemini: "Google / Gemini",
};

const directory = await mkdtemp(join(tmpdir(), "nanpad-ai-subscriptions-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
try {
  instance = await electron.launch({
    args: [resolve("scripts/ai-subscription-test-main.mjs")],
    env,
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await completeOnboarding(page);
  // 仅替换测试进程的上游传输和浏览器启动；沿用真实授权服务、IPC、回调及资产持久化。
  await instance.evaluate(
    async ({ ipcMain }, config) => {
      const { AiAccounts, AI_PROVIDERS, Vault } = globalThis.__qaModules;
      const vault = new Vault(config.vaultPath);
      await vault.create("isolated-oauth-test-master");
      const providers = Object.fromEntries(
        Object.entries(AI_PROVIDERS).map(([id, provider]) => [
          id,
          {
            ...provider,
            ...(provider.mode === "loopback" ? { redirect: "http://127.0.0.1:0/callback" } : {}),
          },
        ]),
      );
      globalThis.__qaOpened = [];
      globalThis.__qaUsed = 25;
      globalThis.__qaFailUsage = false;
      globalThis.__qaFailureStatus = 503;
      globalThis.__qaOpenaiIdentity = "qa-openai";
      globalThis.__qaDelayUsage = false;
      globalThis.__qaReleaseUsage = null;
      globalThis.__qaDelayToken = false;
      globalThis.__qaReleaseToken = null;
      const service = new AiAccounts({
        vault,
        providers,
        openExternal: async (url) => {
          globalThis.__qaOpened.push(url);
        },
        fetchImpl: async (url) => {
          const [id, provider] =
            Object.entries(providers).find(([, p]) =>
              [p.token, p.userinfo, p.profile, p.usage, p.monthlyUsage].includes(url),
            ) ?? [];
          if (!provider) throw new Error("Unexpected test request");
          let body;
          if (url === provider.token) {
            if (globalThis.__qaDelayToken)
              await new Promise((resolve) => {
                globalThis.__qaReleaseToken = resolve;
              });
            body = {
              access_token: "qa-only-access",
              refresh_token: "qa-only-refresh",
              expires_in: 3600,
              id_token:
                "x." +
                Buffer.from(
                  JSON.stringify({
                    sub: "qa-user",
                    email: id + "@example.test",
                    "https://api.openai.com/auth": {
                      chatgpt_account_id: globalThis.__qaOpenaiIdentity,
                      chatgpt_plan_type: "Plus",
                    },
                  }),
                ).toString("base64url") +
                ".x",
              account: { uuid: "qa-claude", email_address: "claude@example.test" },
            };
          } else if (url === provider.userinfo)
            body = { sub: "qa-user", email: id + "@example.test" };
          else if (url === provider.profile)
            body = { cloudaicompanionProject: "qa-project", currentTier: { name: "Code Assist" } };
          else {
            if (globalThis.__qaDelayUsage)
              await new Promise((resolve) => {
                globalThis.__qaReleaseUsage = resolve;
              });
            if (globalThis.__qaFailUsage)
              return new Response("unavailable", { status: globalThis.__qaFailureStatus });
            const used = globalThis.__qaUsed;
            body =
              id === "openai"
                ? {
                    plan_type: "Plus",
                    rate_limit: {
                      primary_window: {
                        used_percent: used,
                        reset_at: 1900000000,
                        limit_window_seconds: 18000,
                      },
                    },
                    code_review_rate_limit: {
                      primary_window: { used_percent: 12, reset_at: 1900000000 },
                    },
                    additional_rate_limits: [
                      {
                        limit_name: "Spark",
                        normal_model_slug: "codex-spark",
                        rate_limit: {
                          primary_window: {
                            used_percent: 17,
                            reset_at: 1900000000,
                            limit_window_seconds: 18000,
                          },
                        },
                      },
                    ],
                  }
                : id === "claude"
                  ? { five_hour: { utilization: used, resets_at: "2030-03-01T00:00:00Z" } }
                  : id === "grok"
                    ? {
                        config: {
                          creditUsagePercent: used,
                          currentPeriod: { end: "2030-03-01T00:00:00Z" },
                        },
                      }
                    : {
                        buckets: [
                          {
                            modelId: "gemini-pro",
                            remainingFraction: 1 - used / 100,
                            resetTime: "2030-03-01T00:00:00Z",
                          },
                          {
                            modelId: "gemini-flash",
                            tokenType: "REQUESTS",
                            remainingAmount: 1500,
                            resetTime: "2030-03-01T00:00:00Z",
                          },
                        ],
                      };
          }
          return new Response(JSON.stringify(body));
        },
      });
      globalThis.__qaAccounts = service;
      for (const method of ["list", "start", "status", "finish", "cancel", "refresh", "remove"]) {
        ipcMain.removeHandler("ai-accounts:" + method);
        ipcMain.handle("ai-accounts:" + method, async (_event, ...args) => {
          try {
            return { ok: true, data: await service[method](...args) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        });
      }
    },
    {
      vaultPath: join(directory, "oauth-test.enc"),
    },
  );

  await page.getByRole("button", { name: "AI 订阅", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加 AI 订阅", exact: true });
  const open = async () => {
    await page.getByRole("button", { name: "添加 AI 订阅", exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: /^订阅账号/ }).click();
  };
  const saved = async () =>
    page.evaluate(async () => (await window.sinan.store.load()).state.aiAssets);
  const authorize = async (provider, panel = dialog, afterCallback) => {
    await chooseOption(
      page,
      panel.getByRole("combobox", { name: "授权服务商" }),
      providerNames[provider],
    );
    await panel.getByRole("button", { name: "网页登录授权" }).click();
    await panel.getByRole("button", { name: "取消授权" }).waitFor();
    await panel.getByLabel("回调链接或授权码", { exact: true }).waitFor();
    const url = new URL(await instance.evaluate(() => globalThis.__qaOpened.at(-1)));
    if (provider === "claude") {
      assert.equal(await panel.locator("form form").count(), 0);
      await panel
        .getByLabel("回调链接或授权码", { exact: true })
        .fill("test-code#" + url.searchParams.get("state"));
      await panel.getByRole("button", { name: "完成授权", exact: true }).click();
    } else {
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("code", "test-code");
      if (provider === "openai") {
        await panel
          .getByLabel("回调链接或授权码")
          .fill(callback.toString().replace(url.searchParams.get("state"), "wrong-state"));
        await panel.getByRole("button", { name: "完成授权", exact: true }).click();
        await panel.getByRole("alert").waitFor();
        await panel.getByLabel("回调链接或授权码").fill(callback.toString());
        await panel.getByRole("button", { name: "完成授权", exact: true }).click();
      } else assert.equal((await fetch(callback)).status, 200);
    }
    await afterCallback?.();
    await panel.getByText("已添加到 AI 订阅", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "取消授权" }).waitFor({ state: "detached" });
  };
  await open();
  assert.equal(
    await dialog.getByRole("tab", { name: "快速登录", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await dialog.getByLabel("名称", { exact: true }).count(), 0);
  await verifyOptions(
    page,
    dialog.getByRole("combobox", { name: "授权服务商" }),
    Object.values(providerNames),
  );
  assert.equal(await dialog.isVisible(), true, "Escape 只关闭下拉菜单");
  await mkdir("release/screenshots", { recursive: true });
  await page.waitForFunction(() => {
    const panel = document.querySelector('[role="dialog"][aria-label="添加 AI 订阅"]');
    return panel?.getAttribute("data-shown") === "true" && getComputedStyle(panel).opacity === "1";
  });
  await page.screenshot({ path: "release/screenshots/nanpad-ai-quick-login.png" });
  await dialog.getByRole("combobox", { name: "授权服务商" }).click();
  await page.screenshot({ path: "release/screenshots/nanpad-select-desktop.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "release/screenshots/nanpad-ai-quick-login-mobile.png" });
  await dialog.getByRole("combobox", { name: "授权服务商" }).click();
  await page.screenshot({ path: "release/screenshots/nanpad-select-mobile.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByRole("tab", { name: "手动填写" }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("手动草稿");
  await dialog.getByRole("tab", { name: "快速登录", exact: true }).click();
  for (const provider of ["openai", "claude", "grok", "gemini"]) {
    await authorize(provider);
    const row = (await saved()).find((item) => item.oauthProvider === provider);
    assert.ok(row);
    assert.equal(row.usagePct, 25);
    assert.equal(row.usageAvailable, true);
    assert.equal(row.monthlyUsdKnown, false);
    assert.equal(row.renewsAt, "");
    assert.equal(row.subscriptionExpiresAt, null);
  }
  assert.equal((await saved()).length, 4);
  await authorize("grok");
  assert.equal((await saved()).length, 4, "重复登录不得重复创建订阅");
  await chooseOption(
    page,
    dialog.getByRole("combobox", { name: "授权服务商" }),
    providerNames.gemini,
  );
  await dialog.getByRole("button", { name: "网页登录授权" }).click();
  await dialog.getByRole("button", { name: "取消授权" }).click();
  assert.equal((await saved()).length, 4);
  assert.equal(
    await instance.evaluate(() =>
      [...globalThis.__qaAccounts.sessions.values()].every((s) => s.status !== "pending"),
    ),
    true,
  );

  await instance.evaluate(() => {
    globalThis.__qaFailUsage = true;
  });
  await authorize("grok");
  await dialog.getByRole("alert").filter({ hasText: "账号已保存，暂未取得用量" }).waitFor();
  assert.equal((await saved()).length, 4);
  await instance.evaluate(() => {
    globalThis.__qaFailUsage = false;
    globalThis.__qaUsed = 96;
  });
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const grok = (await saved()).find((item) => item.oauthProvider === "grok");
  await page.locator('[data-asset-id="' + grok.id + '"]').click();
  const details = page.getByRole("region", { name: "资产详情" });
  await details.getByRole("button", { name: "刷新用量", exact: true }).click();
  await details.getByText("96%", { exact: true }).first().waitFor();
  assert.equal((await saved()).find((item) => item.id === grok.id).usagePct, 96);
  await page.screenshot({ path: "release/screenshots/nanpad-ai-subscription-detail.png" });
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "detached" });
  const gemini = (await saved()).find((item) => item.oauthProvider === "gemini");
  await page.locator('[data-asset-id="' + gemini.id + '"]').click();
  await details.getByText("gemini-flash REQUESTS", { exact: true }).waitFor();
  const remainingQuota = details
    .locator("div.space-y-2.py-3")
    .filter({ has: page.getByText("gemini-flash REQUESTS", { exact: true }) });
  assert.equal(await remainingQuota.count(), 1);
  assert.match(await remainingQuota.innerText(), /1[,.]?500\s+REQUESTS/);
  assert.equal(await remainingQuota.getByRole("progressbar").count(), 0);
  assert.doesNotMatch(await remainingQuota.innerText(), /\d\s*%/);
  assert.equal(
    await details
      .getByRole("progressbar", { name: "gemini-pro", exact: true })
      .getAttribute("aria-valuenow"),
    "25",
  );
  await remainingQuota.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "release/screenshots/nanpad-ai-gemini-remaining.png" });
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "detached" });

  await open();
  await dialog.getByRole("tab", { name: "手动填写", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("团队 Codex 订阅");
  await dialog.getByLabel("月费 USD", { exact: true }).fill("19.99");
  await dialog.getByLabel("说明", { exact: true }).fill("保留手动资料并等待首次授权额度");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const manualSubscription = (await saved()).find((item) => item.name === "团队 Codex 订阅");
  assert.ok(manualSubscription);
  assert.equal(manualSubscription.oauthAccountId, undefined);
  await instance.evaluate(() => {
    globalThis.__qaOpenaiIdentity = "qa-openai-manual";
    globalThis.__qaUsed = 73;
    globalThis.__qaDelayUsage = true;
  });
  await page.locator('[data-asset-id="' + manualSubscription.id + '"]').click();
  await authorize("openai", details, async () => {
    // 先观察已落盘的账号关联，再放行上游响应，覆盖组件首次关联后被重建的竞态。
    await page.waitForFunction(async (id) => {
      const snapshot = await window.sinan.store.load();
      return Boolean(snapshot.state.aiAssets.find((item) => item.id === id)?.oauthAccountId);
    }, manualSubscription.id);
    await instance.evaluate(async () => {
      const started = Date.now();
      while (!globalThis.__qaReleaseUsage && Date.now() - started < 5000)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!globalThis.__qaReleaseUsage) throw new Error("Delayed usage request did not start");
      globalThis.__qaDelayUsage = false;
      globalThis.__qaReleaseUsage();
      globalThis.__qaReleaseUsage = null;
    });
  });
  const primaryQuota = details.getByRole("progressbar", { name: "primary_window", exact: true });
  await primaryQuota.waitFor();
  assert.equal(await primaryQuota.getAttribute("aria-valuenow"), "73");
  assert.equal(
    await details
      .getByRole("progressbar", { name: "Spark/primary_window", exact: true })
      .getAttribute("aria-valuenow"),
    "17",
  );
  await details.getByText("Spark / 主要额度", { exact: true }).waitFor();
  await details.getByText("codex-spark", { exact: true }).waitFor();
  await page.waitForFunction(async (id) => {
    const snapshot = await window.sinan.store.load();
    return snapshot.state.aiAssets.find((item) => item.id === id)?.usagePct === 73;
  }, manualSubscription.id);
  const linkedSubscription = (await saved()).find((item) => item.id === manualSubscription.id);
  assert.equal(linkedSubscription.name, "团队 Codex 订阅");
  assert.equal(linkedSubscription.monthlyUsd, 19.99);
  assert.equal(linkedSubscription.notes, "保留手动资料并等待首次授权额度");
  assert.equal((await saved()).length, 5);
  await details.getByText("Spark / 主要额度", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "release/screenshots/nanpad-ai-first-link-delayed-usage.png" });
  assert.equal(JSON.stringify(await saved()).includes("qa-only-access"), false);
  await page.reload();
  await page.getByText("桌面验证用户", { exact: true }).waitFor();
  assert.equal((await saved()).length, 5);
  assert.equal((await saved()).find((item) => item.id === manualSubscription.id).usagePct, 73);

  // 自动回调与额度失败分阶段验收；所有链接和响应仅在隔离测试进程内生成。
  await page
    .locator("nav")
    .getByRole("button", { name: /^AI 订阅/ })
    .click();
  await instance.evaluate(() => {
    globalThis.__qaOpenaiIdentity = "qa-openai-forbidden";
    globalThis.__qaDelayToken = true;
    globalThis.__qaDelayUsage = true;
    globalThis.__qaFailUsage = true;
    globalThis.__qaFailureStatus = 403;
  });
  await open();
  await chooseOption(
    page,
    dialog.getByRole("combobox", { name: "授权服务商" }),
    providerNames.openai,
  );
  await dialog.getByRole("button", { name: "网页登录授权", exact: true }).click();
  const callbackInput = dialog.getByLabel("回调链接或授权码", { exact: true });
  await callbackInput.waitFor();
  assert.equal(await callbackInput.getAttribute("type"), "password");
  assert.equal(await callbackInput.isEnabled(), true);
  await callbackInput.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "release/screenshots/nanpad-callback-visible-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await callbackInput.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "release/screenshots/nanpad-callback-visible-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  const openedUrl = new URL(await instance.evaluate(() => globalThis.__qaOpened.at(-1)));
  const automaticCallback = new URL(openedUrl.searchParams.get("redirect_uri"));
  automaticCallback.searchParams.set("state", openedUrl.searchParams.get("state"));
  automaticCallback.searchParams.set("code", "isolated-auto-callback");
  assert.equal((await fetch(automaticCallback)).status, 200);
  await dialog.getByText("已收到回调，正在验证授权…", { exact: true }).waitFor();
  assert.equal(await callbackInput.isDisabled(), true);
  assert.equal(
    await dialog.getByRole("button", { name: "完成授权", exact: true }).isDisabled(),
    true,
  );
  await instance.evaluate(() => {
    if (!globalThis.__qaReleaseToken) throw new Error("Delayed token request did not start");
    globalThis.__qaDelayToken = false;
    globalThis.__qaReleaseToken();
    globalThis.__qaReleaseToken = null;
  });
  await dialog.getByText("登录回调已处理，正在同步额度…", { exact: true }).waitFor();
  await callbackInput.waitFor({ state: "detached" });
  assert.equal(await dialog.getByRole("button", { name: "取消授权" }).isDisabled(), true);
  await instance.evaluate(() => {
    if (!globalThis.__qaReleaseUsage) throw new Error("Delayed quota request did not start");
    globalThis.__qaDelayUsage = false;
    globalThis.__qaReleaseUsage();
    globalThis.__qaReleaseUsage = null;
  });
  await dialog.getByRole("button", { name: "取消授权" }).waitFor({ state: "detached" });
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const failedAccount = await instance.evaluate(async () =>
    (await globalThis.__qaAccounts.list()).find((item) => item.accountId === "qa-openai-forbidden"),
  );
  assert.ok(failedAccount);
  const failedAsset = (await saved()).find((item) => item.oauthAccountId === failedAccount.id);
  assert.ok(failedAsset);
  assert.equal(failedAsset.usageAvailable, false);
  assert.equal(failedAccount.usage, null);
  assert.equal(failedAccount.usageRefresh.errorCode, "FORBIDDEN");
  await page.locator('[data-asset-id="' + failedAsset.id + '"]').click();
  await details.getByText("本机已保存授权", { exact: true }).waitFor();
  await details.getByText("当前没有进行中的登录授权。", { exact: true }).waitFor();
  await details.getByText("额度同步失败，尚无用量数据。", { exact: true }).waitFor();
  const explanation = details.getByText(
    "额度请求被拒绝不表示缺少登录回调；仅凭 HTTP 403 无法确定服务商拒绝的原因。",
    { exact: true },
  );
  await explanation.waitFor();
  assert.equal(await details.getByRole("progressbar").count(), 0);
  await explanation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "release/screenshots/nanpad-callback-403-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await explanation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "release/screenshots/nanpad-callback-403-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      providers: 4,
      actualComposer: true,
      callbacks: true,
      callbackInputVisible: true,
      automaticCallbackPhases: true,
      forbiddenQuotaSeparateFromAuthorization: true,
      cancellation: true,
      duplicatePrevention: true,
      refresh: true,
      persistence: true,
      quotaFailurePreservesAccount: true,
      firstLinkDelayedUsage: true,
      additionalQuotaCategories: true,
      remainingWithoutPercent: true,
      noTokenInAssets: true,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.evaluate(() => globalThis.__qaReleaseToken?.()).catch(() => {});
  await instance?.evaluate(() => globalThis.__qaReleaseUsage?.()).catch(() => {});
  await instance?.evaluate(() => globalThis.__qaAccounts?.stop()).catch(() => {});
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
}
