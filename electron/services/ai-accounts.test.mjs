import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { AiAccounts, AI_PROVIDERS, normalizeUsage } from "./ai-accounts.mjs";
import { ProfileService } from "./profile.mjs";
import { Vault } from "./vault.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "nanpad-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = new Vault(join(directory, "vault.enc"));
  const profile = new ProfileService(join(directory, "profile.json"), vault);
  return { directory, vault, profile };
}
test("首次设置创建加密库，升级时使用原密码且保留凭据", async (t) => {
  const { directory, vault, profile } = await fixture(t);
  assert.equal((await profile.get()).ready, false);
  await assert.rejects(profile.save({ name: "用户", password: "short" }), /10/);
  await profile.save({ name: "  测试用户  ", password: "test-master-long" });
  assert.equal((await profile.get()).name, "测试用户");
  await vault.set("keep", { password: "private-test-only" });
  assert.ok(!(await readFile(join(directory, "profile.json"), "utf8")).includes("test-master"));
  assert.ok(!(await readFile(join(directory, "vault.enc"), "utf8")).includes("private-test-only"));
  await rm(join(directory, "profile.json"));
  vault.lock();
  await assert.rejects(profile.save({ name: "升级用户", password: "incorrect" }), /不正确/);
  await profile.save({ name: "升级用户", password: "test-master-long" });
  assert.deepEqual(await vault.get("keep"), { password: "private-test-only" });
  vault.lock();
  await profile.save({ name: "改名" });
  assert.equal((await profile.get()).name, "改名");
  await assert.rejects(profile.save({ name: " " }), /姓名/);
});
test("损坏的密钥库不得被首次设置覆盖", async (t) => {
  const { directory, profile } = await fixture(t);
  await writeFile(join(directory, "vault.enc"), "invalid-json");
  await assert.rejects(profile.save({ name: "用户", password: "test-master-long" }), /读取失败/);
  assert.equal(await readFile(join(directory, "vault.enc"), "utf8"), "invalid-json");
});
for (const provider of Object.keys(AI_PROVIDERS)) {
  test(`${provider}: PKCE、回调校验、加密存储、刷新及用量`, async (t) => {
    const { vault, profile, directory } = await fixture(t);
    await profile.save({ name: "OAuth 测试", password: "test-master-long" });
    let opened;
    let geminiProfile = { cloudaicompanionProject: "test-project", currentTier: { name: "Free" } };
    const requests = [];
    const claims = {
      sub: "test-user",
      email: "qa@example.test",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "test-account",
        chatgpt_plan_type: "plus",
      },
    };
    const idToken = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;
    const p = { ...AI_PROVIDERS[provider] };
    if (p.mode === "loopback") p.redirect = "http://127.0.0.1:0/callback";
    const service = new AiAccounts({
      vault,
      providers: { [provider]: p },
      openExternal: async (url) => {
        opened = new URL(url);
      },
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        let body;
        if (url === p.token)
          body = {
            access_token: "test-access-token",
            refresh_token: "test-refresh-token",
            expires_in: 1,
            id_token: idToken,
            account: { uuid: "test-claude", email_address: "qa@example.test" },
          };
        else if (url === p.userinfo) body = { sub: "test-user", email: "qa@example.test" };
        else if (url === p.profile) body = geminiProfile;
        else
          body =
            provider === "openai"
              ? {
                  plan_type: "plus",
                  rate_limit: { primary_window: { used_percent: 25, reset_at: 1800000000 } },
                }
              : provider === "claude"
                ? { five_hour: { utilization: 25, resets_at: "2026-09-08T00:00:00Z" } }
                : provider === "grok"
                  ? {
                      config: {
                        creditUsagePercent: 25,
                        currentPeriod: { end: "2026-09-08T00:00:00Z" },
                      },
                    }
                  : {
                      buckets: [
                        {
                          modelId: "gemini-pro",
                          remainingFraction: 0.75,
                          resetTime: "2026-09-08T00:00:00Z",
                        },
                      ],
                    };
        return new Response(JSON.stringify(body));
      },
    });
    t.after(() => service.stop());
    const session = await service.start(provider);
    assert.equal(opened.searchParams.get("code_challenge_method"), "S256");
    assert.ok(opened.searchParams.get("code_challenge").length >= 43);
    await assert.rejects(service.finish(session.id, "code#wrong"), /不匹配/);
    assert.equal(requests.length, 0);
    if (p.mode === "loopback") {
      const callback = new URL(opened.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", "wrong");
      callback.searchParams.set("code", "code");
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("state", opened.searchParams.get("state"));
      assert.equal((await fetch(callback)).status, 200);
      for (let i = 0; i < 100 && service.status(session.id).status !== "connected"; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    } else await service.finish(session.id, `code#${opened.searchParams.get("state")}`);
    assert.equal(service.status(session.id).status, "connected");
    const [account] = await service.list();
    assert.equal(service.status(session.id).accountId, account.id);
    assert.ok(!JSON.stringify(account).includes("test-access-token"));
    assert.ok(
      !(await readFile(join(directory, "vault.enc"), "utf8")).includes("test-refresh-token"),
    );
    await assert.rejects(service.finish(session.id, "code#again"), /已结束/);
    const updated = await service.refresh(account.id);
    assert.equal(updated.usage.windows[0].usedPercent, 25);
    assert.equal(updated.subscriptionExpiresAt, null);
    assert.equal(requests.filter((req) => req.url === p.token).length, 2);
    assert.ok(requests.every((req) => req.options.redirect === "error"));
    if (provider === "gemini") {
      const quotaCalls = requests.filter((req) => req.url === p.usage).length;
      geminiProfile = {
        ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT", reasonMessage: "private detail" }],
      };
      await assert.rejects(service.refresh(account.id), { code: "UNSUPPORTED_CLIENT" });
      const [stale] = await service.list();
      assert.equal(stale.usage.windows[0].usedPercent, 25);
      assert.equal(stale.usage.status, "stale");
      assert.match(stale.usageRefresh.message, /Antigravity CLI/);
      assert.doesNotMatch(stale.usageRefresh.message, /private detail/);
      geminiProfile = {};
      await assert.rejects(service.refresh(account.id), { code: "PROJECT_REQUIRED" });
      assert.equal(requests.filter((req) => req.url === p.usage).length, quotaCalls);
    }
    await service.remove(account.id);
    assert.deepEqual(await service.list(), []);
    await assert.rejects(service.remove("ssh:private"), /无效/);
    vault.lock();
    await assert.rejects(service.start(provider), /解锁/);
  });
}
test("取消及服务异常不会保存令牌或泄漏响应正文", async (t) => {
  const { vault, profile } = await fixture(t);
  await profile.save({ name: "用户", password: "test-master-long" });
  let url;
  const service = new AiAccounts({
    vault,
    openExternal: async (value) => {
      url = new URL(value);
    },
    fetchImpl: async () => new Response("private-token", { status: 401 }),
  });
  t.after(() => service.stop());
  const session = await service.start("claude");
  await assert.rejects(
    service.finish(session.id, `code#${url.searchParams.get("state")}`),
    (error) => error.message.includes("401") && !error.message.includes("private-token"),
  );
  assert.deepEqual(await service.list(), []);
  const cancelled = await service.start("claude");
  service.cancel(cancelled.id);
  await assert.rejects(service.finish(cancelled.id, "code#state"), /已结束/);
  await assert.rejects(service.start("__proto__"), /不支持/);
});
test("缺失额度不转成零用量，错误日期不展示", () => {
  assert.deepEqual(normalizeUsage("openai", {}).windows, []);
  assert.equal(
    normalizeUsage("claude", { five_hour: { utilization: 0, resets_at: "invalid" } }).windows[0]
      .resetsAt,
    null,
  );
});

function memoryVault() {
  const values = new Map();
  return {
    unlocked: true,
    async get(id) {
      return structuredClone(values.get(id));
    },
    async set(id, value) {
      values.set(id, structuredClone(value));
    },
    async remove(id) {
      values.delete(id);
    },
    async list() {
      return [...values.keys()];
    },
  };
}
const testJwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;
const openaiTokens = () => ({
  access_token: "test-access-secret",
  refresh_token: "test-refresh-secret",
  expires_in: 3600,
  id_token: testJwt({
    sub: "test-user",
    email: "qa@example.test",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "test-account",
      chatgpt_plan_type: "plus",
    },
  }),
});
async function seededService(t, provider, fetchImpl) {
  const vault = memoryVault(),
    id = "ai-oauth:test-account";
  await vault.set(id, {
    provider,
    accountId: "test-account",
    email: "qa@example.test",
    plan: "plus",
    tokens: openaiTokens(),
    tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    usage: {
      windows: [{ label: "primary_window", usedPercent: 12, resetsAt: null }],
      checkedAt: "2026-09-01T00:00:00.000Z",
    },
  });
  const service = new AiAccounts({ vault, openExternal: async () => {}, fetchImpl });
  t.after(() => service.stop());
  return { service, vault, id };
}

for (const [status, errorCode] of [
  [403, "FORBIDDEN"],
  [429, "RATE_LIMITED"],
]) {
  test(`授权码交换 HTTP ${status} 不误报额度失败，不重试且不泄漏响应正文`, async (t) => {
    let opened;
    const calls = [];
    const vault = memoryVault();
    const service = new AiAccounts({
      vault,
      providers: {
        openai: { ...AI_PROVIDERS.openai, redirect: "http://127.0.0.1:0/auth/callback" },
      },
      openExternal: async (url) => {
        opened = new URL(url);
      },
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response("private-token-response-secret", { status });
      },
    });
    t.after(() => service.stop());
    const session = await service.start("openai");
    const callback = new URL(session.redirectUri);
    callback.searchParams.set("code", "test-code");
    callback.searchParams.set("state", opened.searchParams.get("state"));
    await assert.rejects(service.finish(session.id, callback.toString()), (error) => {
      assert.equal(error.code, errorCode);
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /额度|private-token-response-secret/);
      if (status === 403) assert.match(error.message, /无法确定具体原因/);
      return true;
    });
    const failed = service.status(session.id);
    assert.equal(failed.status, "error");
    assert.doesNotMatch(JSON.stringify(failed), /private-token-response-secret|额度/);
    assert.deepEqual(await service.list(), []);
    assert.deepEqual(await vault.list(), []);
    assert.deepEqual(calls, [AI_PROVIDERS.openai.token]);
  });
}

test("完整回调链接严格匹配地址、state和唯一参数；成功后不可重放", async (t) => {
  let opened,
    calls = 0;
  const vault = memoryVault();
  const service = new AiAccounts({
    vault,
    providers: { openai: { ...AI_PROVIDERS.openai, redirect: "http://127.0.0.1:0/auth/callback" } },
    openExternal: async (value) => {
      opened = new URL(value);
    },
    fetchImpl: async () => {
      calls++;
      return Response.json(openaiTokens());
    },
  });
  t.after(() => service.stop());
  const session = await service.start("openai");
  assert.equal(session.redirectUri, opened.searchParams.get("redirect_uri"));
  assert.equal(session.manualCallback, false);
  const callback = new URL(session.redirectUri);
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("state", opened.searchParams.get("state"));
  for (const mutate of [
    (url) => {
      url.hostname = "example.test";
    },
    (url) => {
      url.pathname = "/other";
    },
    (url) => {
      url.searchParams.set("state", "other-session");
    },
    (url) => {
      url.searchParams.append("state", opened.searchParams.get("state"));
    },
    (url) => {
      url.searchParams.append("code", "other-code");
    },
    (url) => {
      url.username = "invalid";
    },
    (url) => {
      url.hash = "extra";
    },
  ]) {
    const invalid = new URL(callback);
    mutate(invalid);
    await assert.rejects(service.finish(session.id, invalid.toString()));
  }
  await assert.rejects(
    service.finish(session.id, `code#${opened.searchParams.get("state")}#extra`),
  );
  assert.equal(calls, 0);
  await service.finish(session.id, callback.toString());
  assert.equal(service.status(session.id).status, "connected");
  await assert.rejects(service.finish(session.id, callback.toString()), /已结束/);
  assert.equal(calls, 1);
});

test("固定端口被占用仍可打开登录并手动完成回调，不关闭其他服务", async (t) => {
  const occupied = createServer((_, res) => res.end("existing-service"));
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const redirect = `http://127.0.0.1:${occupied.address().port}/auth/callback`;
  let opened;
  const service = new AiAccounts({
    vault: memoryVault(),
    providers: { openai: { ...AI_PROVIDERS.openai, redirect } },
    openExternal: async (url) => {
      opened = new URL(url);
    },
    fetchImpl: async () => Response.json(openaiTokens()),
  });
  t.after(() => service.stop());
  const session = await service.start("openai");
  assert.equal(session.manualCallback, true);
  assert.equal(session.redirectUri, redirect);
  assert.equal(await (await fetch(redirect)).text(), "existing-service");
  const callback = new URL(redirect);
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("state", opened.searchParams.get("state"));
  await service.finish(session.id, callback.toString());
  assert.equal(service.status(session.id).status, "connected");
  assert.equal(await (await fetch(redirect)).text(), "existing-service");
});

test("取消正在交换的授权不会保存账号，也不能重用回调", async (t) => {
  let opened, complete;
  const vault = memoryVault();
  const service = new AiAccounts({
    vault,
    openExternal: async (url) => {
      opened = new URL(url);
    },
    fetchImpl: async () =>
      new Promise((resolve) => {
        complete = () =>
          resolve(Response.json({ ...openaiTokens(), account: { uuid: "claude-account" } }));
      }),
  });
  t.after(() => service.stop());
  const session = await service.start("claude");
  const pending = service.finish(session.id, `code#${opened.searchParams.get("state")}`);
  await new Promise((resolve) => setImmediate(resolve));
  service.cancel(session.id);
  complete();
  await assert.rejects(pending, /取消/);
  assert.deepEqual(await service.list(), []);
  await assert.rejects(
    service.finish(session.id, `code#${opened.searchParams.get("state")}`),
    /已结束/,
  );
});

test("OpenAI额度保留主次窗口、额外模型与实际余额，不推算网页权益", () => {
  const usage = normalizeUsage("openai", {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1800000000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
    },
    code_review_rate_limit: { primary_window: { used_percent: 8 } },
    additional_rate_limits: [
      {
        limit_name: "Codex Spark",
        metered_feature: "codex_bengalfox",
        rate_limit: { primary_window: { used_percent: 60 } },
      },
    ],
    credits: { balance: "24.50", unlimited: false },
  });
  assert.equal(usage.windows.length, 5);
  assert.equal(usage.windows[0].windowSeconds, 18000);
  assert.equal(usage.windows[3].model, "codex_bengalfox");
  assert.deepEqual(usage.windows[4], {
    label: "credits",
    usedPercent: null,
    remaining: 24.5,
    unit: "credits",
    resetsAt: null,
  });
  assert.equal(usage.source, "openai-wham");
  assert.equal(usage.webUsageAvailable, false);
  assert.ok(usage.windows.every((window) => window.limit === undefined));
});

test("Gemini保留实际剩余数量、模型和计量单位，不从百分比反算总额度", () => {
  const usage = normalizeUsage("gemini", {
    buckets: [
      {
        modelId: "gemini-pro",
        tokenType: "REQUESTS",
        remainingFraction: 0.25,
        remainingAmount: "25",
      },
      { modelId: "gemini-flash", tokenType: "REQUESTS", remainingAmount: "100" },
      { modelId: "invalid", remainingAmount: "", remainingFraction: 8 },
    ],
  });
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].usedPercent, 75);
  assert.equal(usage.windows[0].remaining, 25);
  assert.equal(usage.windows[1].usedPercent, null);
  assert.equal(usage.windows[1].remaining, 100);
  assert.equal(usage.windows[0].unit, "REQUESTS");
  assert.ok(
    usage.windows.every((window) => window.limit === undefined && window.used === undefined),
  );
  assert.equal(usage.scope, "code-assist");
});

test("Grok读取周和月两个接口，金额采用上游单位且不猜订阅月费与套餐", async (t) => {
  const seen = [];
  const { service, id } = await seededService(t, "grok", async (url) => {
    seen.push(url);
    return Response.json({
      config: url.includes("format=credits")
        ? {
            creditUsagePercent: 25,
            productUsage: [{ product: "grok-code", usagePercent: 15 }],
            prepaidBalance: { val: 12 },
            currentPeriod: { end: "2026-09-08T00:00:00Z" },
          }
        : {
            used: { val: 7500 },
            monthlyLimit: { val: 15000 },
            onDemandCap: { val: 20 },
            onDemandUsed: { val: 4 },
            billingPeriodEnd: "2026-10-01T00:00:00Z",
          },
    });
  });
  const account = await service.refresh(id);
  assert.deepEqual(seen, [AI_PROVIDERS.grok.usage, AI_PROVIDERS.grok.monthlyUsage]);
  assert.deepEqual(
    account.usage.windows.find((entry) => entry.label === "monthly"),
    {
      label: "monthly",
      usedPercent: 50,
      used: 75,
      limit: 150,
      unit: "USD",
      resetsAt: "2026-10-01T00:00:00.000Z",
    },
  );
  assert.equal(account.usage.windows.find((entry) => entry.label === "prepaid").remaining, 12);
  assert.equal(account.plan, "plus");
  assert.equal(account.subscriptionExpiresAt, null);
});

test("401触发一次刷新并使用新令牌查询，403保留旧快照与可读失败原因", async (t) => {
  const calls = [];
  let forbidden = false;
  const { service, vault, id } = await seededService(t, "openai", async (url, options) => {
    calls.push({ url, token: options.headers.Authorization });
    if (url === AI_PROVIDERS.openai.token)
      return Response.json({
        access_token: "rotated-secret",
        refresh_token: "rotated-refresh-secret",
        expires_in: 3600,
      });
    if (forbidden) return new Response("private upstream response secret", { status: 403 });
    if (options.headers.Authorization === "Bearer test-access-secret")
      return new Response("expired-secret", { status: 401 });
    return Response.json({
      plan_type: "pro",
      account_id: "test-account",
      rate_limit: { primary_window: { used_percent: 27 } },
    });
  });
  const first = await service.refresh(id);
  assert.equal(first.plan, "pro");
  assert.equal(first.usage.windows[0].usedPercent, 27);
  assert.equal(calls.filter((call) => call.url === AI_PROVIDERS.openai.token).length, 1);
  assert.equal(calls.at(-1).token, "Bearer rotated-secret");
  forbidden = true;
  await assert.rejects(service.refresh(id), (error) => {
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.status, 403);
    assert.match(error.message, /HTTP 403/);
    assert.match(error.message, /无法确定具体原因/);
    return true;
  });
  const stored = (await service.list())[0];
  assert.equal(stored.usage.status, "stale");
  assert.equal(stored.usage.checkedAt, first.usage.checkedAt);
  assert.equal(stored.usage.windows[0].usedPercent, 27);
  assert.equal(stored.usageRefresh.errorCode, "FORBIDDEN");
  assert.ok(!JSON.stringify(stored).includes("secret"));
  assert.ok(!JSON.stringify((await vault.get(id)).usageRefresh).includes("upstream"));
  assert.equal(calls.filter((call) => call.url === AI_PROVIDERS.openai.token).length, 1);
});

test("令牌轮换后额度失败仍持久化新令牌，且不会串用其他账号的额度", async (t) => {
  const { service, vault, id } = await seededService(t, "openai", async (url) =>
    url === AI_PROVIDERS.openai.token
      ? Response.json({
          access_token: "rotated-only-secret",
          refresh_token: "new-refresh-secret",
          expires_in: 3600,
        })
      : Response.json({
          account_id: "wrong-account",
          plan_type: "enterprise",
          rate_limit: { primary_window: { used_percent: 99 } },
        }),
  );
  const previous = await vault.get(id);
  previous.tokenExpiresAt = "2020-01-01T00:00:00Z";
  await vault.set(id, previous);
  await assert.rejects(service.refresh(id), /其他账号/);
  const stored = await vault.get(id);
  assert.equal(stored.tokens.refresh_token, "new-refresh-secret");
  assert.equal(stored.usage.windows[0].usedPercent, 12);
  assert.equal(stored.plan, "plus");
  assert.equal(stored.usageRefresh.errorCode, "ACCOUNT_MISMATCH");
});

test("身份令牌缺套餐时读取访问令牌授权字段，不以用户sub充当OpenAI工作区", () => {
  const service = new AiAccounts({ vault: memoryVault(), openExternal: async () => {} });
  const identity = service.identity("openai", {
    id_token: testJwt({ email: "qa@example.test", sub: "user-only" }),
    access_token: testJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace", chatgpt_plan_type: "pro" },
    }),
  });
  assert.equal(identity.accountId, "workspace");
  assert.equal(identity.plan, "pro");
  assert.equal(identity.email, "qa@example.test");
  assert.equal(
    service.identity("openai", { id_token: testJwt({ sub: "user-only" }) }).accountId,
    "",
  );
});

test("无额度与异常响应不会报成零用量或泄露响应正文", async (t) => {
  assert.equal(normalizeUsage("openai", { rate_limit: null }).status, "unavailable");
  assert.deepEqual(normalizeUsage("gemini", { buckets: {} }).windows, []);
  assert.deepEqual(normalizeUsage("openai", { additional_rate_limits: {} }).windows, []);
  const { service, id } = await seededService(
    t,
    "openai",
    async () => new Response('["private-secret"]'),
  );
  await assert.rejects(service.refresh(id), /有效 JSON/);
  const [account] = await service.list();
  assert.equal(account.usageRefresh.errorCode, "INVALID_RESPONSE");
  assert.ok(!JSON.stringify(account).includes("private-secret"));
});

test("Grok单个账单接口失败保留另一个的新数据，并标记失败分类的旧快照", async (t) => {
  const { service, vault, id } = await seededService(t, "grok", async (url) =>
    url === AI_PROVIDERS.grok.monthlyUsage
      ? new Response("private-billing-secret", { status: 503 })
      : Response.json({ config: { creditUsagePercent: 33 } }),
  );
  const before = await vault.get(id);
  before.usage.windows = [
    { label: "weekly", usedPercent: 12, resetsAt: null },
    { label: "product/removed-product", usedPercent: 40, resetsAt: null },
    { label: "monthly", usedPercent: 20, used: 30, limit: 150, unit: "USD", resetsAt: null },
  ];
  await vault.set(id, before);
  await assert.rejects(service.refresh(id), /HTTP 503/);
  const [account] = await service.list();
  assert.equal(account.usage.status, "stale");
  assert.equal(account.usage.windows.find((window) => window.label === "weekly").usedPercent, 33);
  assert.equal(account.usage.windows.find((window) => window.label === "weekly").stale, undefined);
  assert.equal(account.usage.windows.find((window) => window.label === "monthly").stale, true);
  assert.equal(
    account.usage.windows.find((window) => window.label === "product/removed-product"),
    undefined,
  );
  assert.ok(!JSON.stringify(account).includes("private-billing-secret"));
});

test("持续401只刷新一次，不重复轮换令牌", async (t) => {
  let refreshCount = 0;
  const { service, id } = await seededService(t, "openai", async (url) => {
    if (url === AI_PROVIDERS.openai.token) {
      refreshCount++;
      return Response.json({ access_token: "new-secret", expires_in: 3600 });
    }
    return new Response("rejected-secret", { status: 401 });
  });
  await assert.rejects(service.refresh(id), /HTTP 401/);
  assert.equal(refreshCount, 1);
});
