import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AI_PROVIDERS } from "../electron/services/ai-accounts.mjs";
import { webResearchFixture } from "./web-research-fixture.mjs";

export async function webAiFixture(options = {}) {
  const calls = [],
    behavior = { status: 200, delay: 0 };
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url.slice(1));
    calls.push({ url: url.href, body, headers: req.headers });
    await new Promise((resolve) => setTimeout(resolve, behavior.delay));
    res.setHeader("Content-Type", "application/json");
    res.statusCode = behavior.status;
    if (behavior.status !== 200) {
      res.end('"private-provider-error-token"');
      return;
    }
    const p = Object.values(AI_PROVIDERS).find((p) => p.token === url.href);
    const claims = {
      sub: "synthetic-subject",
      email: "test@example.test",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "synthetic-openai",
        chatgpt_plan_type: "plus",
      },
    };
    const result = p
      ? {
          access_token: "synthetic-web-access",
          refresh_token: "synthetic-web-refresh",
          expires_in: 3600,
          id_token: `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`,
          account: { uuid: "synthetic-claude", email_address: "test@example.test" },
        }
      : url.href.endsWith("/userinfo")
        ? { sub: "synthetic-subject", email: "test@example.test" }
        : url.href.endsWith("loadCodeAssist")
          ? { cloudaicompanionProject: "synthetic-project", currentTier: { name: "Free" } }
          : url.href.includes("wham/usage")
            ? { plan_type: "plus", rate_limit: { primary_window: { used_percent: 25 } } }
            : url.href.includes("anthropic.com")
              ? { five_hour: { utilization: 25 } }
              : url.href.includes("grok.com")
                ? { config: { creditUsagePercent: 25 } }
                : { buckets: [{ modelId: "gemini-pro", remainingFraction: 0.75 }] };
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const endpoints = new Set(
    Object.values(AI_PROVIDERS).flatMap((p) =>
      [p.token, p.userinfo, p.profile, p.usage, p.monthlyUsage].filter(Boolean),
    ),
  );
  const f = await webResearchFixture({
    ...options,
    additionalFetch: (url, init) => {
      if (new URL(url).origin === "https://auth.allinsong.top") return undefined;
      assert.equal(
        endpoints.has(String(url)),
        true,
        `不允许未声明的供应商网络请求：${new URL(url).origin}`,
      );
      return fetch(`http://127.0.0.1:${provider.address().port}/${url}`, {
        ...init,
        redirect: "error",
      });
    },
  });
  return {
    ...f,
    calls,
    behavior,
    async close() {
      await f.close();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
    },
  };
}

for (const name of Object.keys(AI_PROVIDERS))
  test(`Web ${name}：明确同意、手动 PKCE、会话隔离、加密及刷新`, async () => {
    const f = await webAiFixture();
    try {
      assert.match((await f.rpc("ai-accounts:start", [name])).body.error, /确认允许服务器/);
      const start = await f.rpc("ai-accounts:start", [name, { allowServerStorage: true }]);
      assert.equal(start.status, 200);
      const session = start.body.data;
      const url = new URL(session.authorizationUrl);
      assert.equal(url.origin, new URL(AI_PROVIDERS[name].authorize).origin);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(session.manualCallback, true);
      assert.notEqual(new URL(session.redirectUri).port, "0");
      const login = await f.call("/api/web/login", {
        body: { username: "tester", password: f.password },
      });
      const other = login.headers.get("set-cookie").split(";")[0];
      assert.match((await f.rpc("ai-accounts:status", [session.id], other)).body.error, /不属于/);
      assert.match(
        (await f.rpc("ai-accounts:finish", [session.id, "code#wrong"])).body.error,
        /不匹配/,
      );
      assert.equal(f.calls.length, 0);
      const finish = await f.rpc("ai-accounts:finish", [
        session.id,
        `code#${url.searchParams.get("state")}`,
      ]);
      assert.equal(finish.status, 200, JSON.stringify(finish.body));
      assert.equal(JSON.stringify(finish.body).includes("synthetic-web-access"), false);
      const id = finish.body.data.id;
      assert.match(
        (await f.rpc("ai-accounts:finish", [session.id, `code#${url.searchParams.get("state")}`]))
          .body.error,
        /已结束/,
      );
      const disk = await readFile(join(f.root, "web/server/ai-accounts.json"), "utf8");
      assert.equal(disk.includes("synthetic-web-access"), false);
      assert.equal(disk.includes("synthetic-web-refresh"), false);
      const token = f.calls.find((call) => call.url === AI_PROVIDERS[name].token);
      const params = new URLSearchParams(token.body);
      const verifier =
        name === "claude" ? JSON.parse(token.body).code_verifier : params.get("code_verifier");
      assert.ok(verifier.length >= 43);
      assert.equal((await f.rpc("ai-accounts:refresh", [id])).status, 200);
      assert.equal((await f.rpc("ai-accounts:list")).body.data.length, 1);
      await f.rpc("ai-accounts:remove", [id]);
      assert.deepEqual((await f.rpc("ai-accounts:list")).body.data, []);
    } finally {
      await f.close();
    }
  });

test("Web AI 授权：失败隐藏响应，取消或退出后不写入令牌", async () => {
  const f = await webAiFixture();
  const start = async () =>
    (await f.rpc("ai-accounts:start", ["claude", { allowServerStorage: true }])).body.data;
  const input = (s) => `code#${new URL(s.authorizationUrl).searchParams.get("state")}`;
  try {
    const failed = await start();
    f.behavior.status = 401;
    const result = await f.rpc("ai-accounts:finish", [failed.id, input(failed)]);
    assert.match(result.body.error, /401/);
    assert.equal(result.body.error.includes("private-provider"), false);
    f.behavior.status = 200;
    f.behavior.delay = 250;
    const cancelled = await start();
    const before = f.calls.length;
    const pending = f.rpc("ai-accounts:finish", [cancelled.id, input(cancelled)]);
    while (f.calls.length === before) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.rpc("ai-accounts:cancel", [cancelled.id]);
    await pending;
    assert.deepEqual((await f.rpc("ai-accounts:list")).body.data, []);
    const revoked = await start();
    const next = f.calls.length;
    const inFlight = f.rpc("ai-accounts:finish", [revoked.id, input(revoked)]);
    while (f.calls.length === next) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.call("/api/web/logout", { cookie: f.cookie });
    await inFlight;
    const disk = await readFile(join(f.root, "web/server/ai-accounts.json"), "utf8").catch(
      (error) => (error.code === "ENOENT" ? "{}" : Promise.reject(error)),
    );
    assert.equal(disk, "{}");
  } finally {
    await f.close();
  }
});
