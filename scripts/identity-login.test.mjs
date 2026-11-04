import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createIdentityLoginServer } from "../services/identity-login/server.mjs";

const nonce = () => randomBytes(32).toString("base64url");
const challenge = (value) => createHash("sha256").update(value).digest("base64url");

test("Web 轮询只接受原始 PKCE，拒绝任意回跳、错误验证器、取消、过期和交接码重放", async (t) => {
  const f = await fixture(t);
  const verifier = nonce();
  const start = () =>
    f.request("/v1/login/start", {
      transport: "poll",
      state: nonce(),
      challenge: challenge(verifier),
    });
  assert.equal(
    (
      await f.request("/v1/login/start", {
        transport: "poll",
        redirectUri: "https://evil.test",
        state: nonce(),
        challenge: challenge(verifier),
      })
    ).status,
    400,
  );
  const session = await (await start()).json();
  assert.equal(
    (await f.request("/v1/login/poll", { id: session.id, verifier: nonce() })).status,
    400,
  );
  assert.equal(
    (await (await f.request("/v1/login/poll", { id: session.id, verifier })).json()).status,
    "waiting",
  );
  const callback = `/oauth/linuxdo/callback?code=synthetic-code&state=${new URL(session.authorizationUrl).searchParams.get("state")}`;
  const result = await f.request(callback);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("location"), null);
  assert.equal((await result.text()).includes("private-access"), false);
  assert.equal((await f.request(callback)).status, 400);
  const ready = await (await f.request("/v1/login/poll", { id: session.id, verifier })).json();
  assert.equal(ready.status, "ready");
  assert.equal(
    (await f.request("/v1/login/exchange", { code: ready.code, verifier: nonce() })).status,
    400,
  );
  assert.equal((await f.request("/v1/login/exchange", { code: ready.code, verifier })).status, 200);
  assert.equal((await f.request("/v1/login/exchange", { code: ready.code, verifier })).status, 400);
  const cancelled = await (await start()).json();
  assert.equal(
    (await f.request("/v1/login/poll", { id: cancelled.id, verifier, cancel: true })).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        `/oauth/linuxdo/callback?code=x&state=${new URL(cancelled.authorizationUrl).searchParams.get("state")}`,
      )
    ).status,
    400,
  );
  const expired = await (await start()).json();
  f.advance(300001);
  assert.equal((await f.request("/v1/login/poll", { id: expired.id, verifier })).status, 400);
});
const profile = {
  id: 73,
  username: "sample",
  name: "示例用户",
  trust_level: 2,
  email: "sample@example.test",
  avatar_template: "/user_avatar/linux.do/sample/{size}/1.png",
};

async function fixture(t, configOverrides = {}, limits = {}) {
  let time = Date.now();
  const calls = [];
  const diagnostics = [];
  const behavior = { profile, status: 200, tokenStatus: 200, oversize: false, hang: false };
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      url: req.url,
      authorization: req.headers.authorization,
      form: new URLSearchParams(Buffer.concat(chunks).toString()),
    });
    if (behavior.hang) return;
    res.setHeader("Content-Type", behavior.contentType || "application/json");
    if (behavior.challenge) res.setHeader("cf-mitigated", "challenge");
    if (req.url === "/oauth2/token") {
      res.statusCode = behavior.tokenStatus;
      res.end(
        JSON.stringify({
          access_token: "private-access",
          refresh_token: "private-refresh",
          expires_in: 60,
          token_type: "Bearer",
        }),
      );
    } else {
      res.statusCode = behavior.status;
      res.end(behavior.oversize ? "x".repeat(1024 * 1024 + 1) : JSON.stringify(behavior.profile));
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const config = {
    publicOrigin: "https://auth.allinsong.top",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    sessionEncryptionKey: randomBytes(32).toString("base64"),
    ...configOverrides,
  };
  const service = createIdentityLoginServer({
    config,
    onDiagnostic: (event) => diagnostics.push(event),
    now: () => time,
    limits,
    fetchImpl: (url, options) => {
      if (behavior.networkError) throw behavior.networkError;
      assert.equal(new URL(url).origin, "https://connect.linux.do");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      return fetch(`http://127.0.0.1:${provider.address().port}${new URL(url).pathname}`, options);
    },
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  t.after(async () => {
    service.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise((r) => service.close(r)),
      new Promise((r) => provider.close(r)),
    ]);
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const request = (path, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        `${base}${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: "auth.allinsong.top",
            ...(encoded === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(encoded),
                }),
            ...headers,
          },
        },
        (res) => {
          const parts = [];
          res.on("data", (part) => parts.push(part));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(parts), { status: res.statusCode, headers: res.headers }),
            ),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(encoded);
    });
  async function start() {
    const verifier = nonce();
    const state = nonce();
    const result = await request("/v1/login/start", {
      redirectUri: "http://127.0.0.1:50111/oauth/zhiyu/callback",
      state,
      challenge: challenge(verifier),
    });
    assert.equal(result.status, 200);
    const data = await result.json();
    return { ...data, verifier, state, authorization: new URL(data.authorizationUrl) };
  }
  async function handoff(session = undefined) {
    session ??= await start();
    const callback = `/oauth/linuxdo/callback?state=${session.authorization.searchParams.get("state")}&code=provider-code`;
    const response = await request(callback);
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("location"));
    return { ...session, callback, target, code: target.searchParams.get("code") };
  }
  async function login() {
    const session = await handoff();
    const response = await request("/v1/login/exchange", {
      code: session.code,
      verifier: session.verifier,
    });
    assert.equal(response.status, 200);
    return { session, ...(await response.json()) };
  }
  return {
    base,
    request,
    start,
    handoff,
    login,
    calls,
    diagnostics,
    behavior,
    config,
    advance: (ms) => {
      time += ms;
    },
  };
}

test("登录完成后返回固定资料结构与加密凭据，客户端与提供方各自使用 PKCE", async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  assert.equal(session.authorization.origin, "https://connect.linux.do");
  assert.equal(session.authorization.pathname, "/oauth2/authorize");
  assert.equal(
    session.authorization.searchParams.get("redirect_uri"),
    "https://auth.allinsong.top/oauth/linuxdo/callback",
  );
  assert.equal(session.authorization.searchParams.get("code_challenge_method"), "S256");
  assert.notEqual(session.authorization.searchParams.get("state"), session.state);
  assert.notEqual(
    session.authorization.searchParams.get("code_challenge"),
    challenge(session.verifier),
  );
  const delivery = await f.handoff(session);
  assert.equal(delivery.target.origin, "http://127.0.0.1:50111");
  assert.equal(delivery.target.searchParams.get("state"), session.state);
  assert.equal(delivery.target.searchParams.size, 2);
  const token = f.calls.find((entry) => entry.url === "/oauth2/token");
  assert.equal(
    challenge(token.form.get("code_verifier")),
    session.authorization.searchParams.get("code_challenge"),
  );
  const result = await f.request("/v1/login/exchange", {
    code: delivery.code,
    verifier: session.verifier,
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const data = await result.json();
  assert.equal(data.profile.subject, "73");
  assert.equal(data.profile.trustLevel, 2);
  assert.equal(data.profile.email, profile.email);
  assert.deepEqual(
    Object.keys(data.profile).sort(),
    [
      "subject",
      "username",
      "name",
      "email",
      "trustLevel",
      "avatarUrl",
      "profileUrl",
      "active",
      "silenced",
    ].sort(),
  );
  assert.equal(JSON.stringify(data).includes("private-access"), false);
  assert.equal(JSON.stringify(data).includes("private-refresh"), false);
  assert.match(data.credential, /^v1\.[A-Za-z0-9_-]+$/);
});

test("未配置时健康检查可访问且登录明确拒绝", async (t) => {
  const f = await fixture(t, { clientSecret: "" });
  assert.deepEqual(await (await f.request("/healthz")).json(), { ok: true, configured: false });
  const result = await f.request("/v1/login/start", {});
  assert.equal(result.status, 503);
  assert.match((await result.json()).message, /尚未配置/);
});

test("只允许精确 IPv4 本机回调，不接受非本机、低端口和额外参数", async (t) => {
  const f = await fixture(t);
  for (const redirectUri of [
    "https://evil.test/oauth/zhiyu/callback",
    "http://localhost:50111/oauth/zhiyu/callback",
    "http://127.0.0.1:80/oauth/zhiyu/callback",
    "http://127.0.0.1:50111/other",
    "http://127.0.0.1:50111/oauth/zhiyu/callback?x=1",
    "http://evil@127.0.0.1:50111/oauth/zhiyu/callback",
    "http://2130706433:50111/oauth/zhiyu/callback",
  ]) {
    assert.equal(
      (await f.request("/v1/login/start", { redirectUri, state: nonce(), challenge: nonce() }))
        .status,
      400,
    );
  }
});

test("未知 state、重复参数和已经使用的提供方回调不会换码", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(`/oauth/linuxdo/callback?state=${nonce()}&code=x`)).status, 400);
  const session = await f.start();
  const state = session.authorization.searchParams.get("state");
  assert.equal(
    (await f.request(`/oauth/linuxdo/callback?state=${state}&state=${state}&code=x`)).status,
    400,
  );
  const ready = await f.handoff(session);
  assert.equal((await f.request(ready.callback)).status, 400);
  assert.equal(f.calls.filter((call) => call.url === "/oauth2/token").length, 1);
});

test("取消授权时只传固定错误码，不能把提供方错误或秘密反射到页面", async (t) => {
  const f = await fixture(t);
  const s = await f.start();
  const response = await f.request(
    `/oauth/linuxdo/callback?state=${s.authorization.searchParams.get("state")}&error=access_denied&error_description=secret-payload`,
  );
  assert.equal(response.status, 302);
  const redirect = new URL(response.headers.get("location"));
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), s.state);
  assert.equal((await response.text()).includes("secret-payload"), false);
  assert.equal(f.calls.length, 0);
});

test("交接码需正确 verifier 且只能成功使用一次", async (t) => {
  const f = await fixture(t);
  const s = await f.handoff();
  assert.equal(
    (await f.request("/v1/login/exchange", { code: s.code, verifier: nonce() })).status,
    400,
  );
  assert.equal(
    (await f.request("/v1/login/exchange", { code: s.code, verifier: s.verifier })).status,
    200,
  );
  assert.equal(
    (await f.request("/v1/login/exchange", { code: s.code, verifier: s.verifier })).status,
    400,
  );
});

test("OAuth 五分钟和交接码一分钟后失效", async (t) => {
  const f = await fixture(t);
  const s = await f.start();
  f.advance(300_001);
  assert.equal(
    (
      await f.request(
        `/oauth/linuxdo/callback?state=${s.authorization.searchParams.get("state")}&code=x`,
      )
    ).status,
    400,
  );
  const ready = await f.handoff();
  f.advance(60_001);
  assert.equal(
    (await f.request("/v1/login/exchange", { code: ready.code, verifier: ready.verifier })).status,
    400,
  );
});

test("用户资料刷新使用原身份和加密续期凭据，三十天之后不能继续", async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  f.advance(61_000);
  const result = await f.request(
    "/v1/session/profile",
    {},
    { Authorization: `Bearer ${login.credential}` },
  );
  assert.equal(result.status, 200);
  const updated = await result.json();
  assert.equal(updated.expiresAt, login.expiresAt);
  assert.equal(updated.profile.subject, login.profile.subject);
  assert.equal(f.calls.filter((call) => call.form.get("grant_type") === "refresh_token").length, 1);
  f.advance(30 * 86400_000);
  assert.equal(
    (await f.request("/v1/session/profile", {}, { Authorization: `Bearer ${updated.credential}` }))
      .status,
    401,
  );
});

test("资料返回其他 subject 时拒绝刷新，不重新绑定身份", async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  f.behavior.profile = { ...profile, id: 999 };
  const result = await f.request(
    "/v1/session/profile",
    {},
    { Authorization: `Bearer ${login.credential}` },
  );
  assert.equal(result.status, 401);
  assert.equal(JSON.stringify(await result.json()).includes("999"), false);
});

test("被修改的加密凭据不能读取个人资料", async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  const corrupted = `${login.credential.slice(0, 25)}${login.credential[25] === "a" ? "b" : "a"}${login.credential.slice(26)}`;
  assert.equal(
    (await f.request("/v1/session/profile", {}, { Authorization: `Bearer ${corrupted}` })).status,
    401,
  );
});

test("上游超大正文和错误响应仅返回安全错误", async (t) => {
  const f = await fixture(t);
  f.behavior.oversize = true;
  const s = await f.handoff();
  assert.equal(s.target.searchParams.get("error"), "login_failed");
  assert.equal(s.code, null);
  f.behavior.oversize = false;
  f.behavior.tokenStatus = 500;
  const retry = await f.handoff();
  assert.equal(retry.target.searchParams.get("error"), "login_failed");
});

test("登录失败诊断只记录阶段和固定元数据，不包含授权或资料", async (t) => {
  const f = await fixture(t);
  f.behavior.tokenStatus = 401;
  const failed = await f.handoff();
  assert.equal(failed.target.searchParams.get("error"), "login_failed");
  assert.deepEqual(f.diagnostics, [
    {
      stage: "token",
      reason: "http_error",
      httpStatus: 401,
      contentType: "json",
      challenge: false,
    },
  ]);
  f.behavior.tokenStatus = 200;
  f.behavior.profile = { ...profile, username: "invalid/private-value" };
  await f.handoff();
  assert.equal(f.diagnostics[1].stage, "profile");
  assert.equal(f.diagnostics[1].reason, "invalid_profile");
  const serialized = JSON.stringify(f.diagnostics);
  for (const secret of [
    "private-access",
    "private-refresh",
    "provider-code",
    "fixture-secret",
    "invalid/private-value",
    "sample@example.test",
    failed.state,
  ])
    assert.equal(serialized.includes(secret), false);
});

test("网络错误仅允许固定代码进入诊断，不记录错误正文或地址", async (t) => {
  const f = await fixture(t);
  for (const code of ["ENOTFOUND", "PRIVATE-CREDENTIAL"]) {
    f.behavior.networkError = new TypeError("PRIVATE-CREDENTIAL URL", {
      cause: Object.assign(new Error("PRIVATE-CREDENTIAL"), { code }),
    });
    const result = await f.handoff();
    assert.equal(result.target.searchParams.get("error"), "login_failed");
  }
  assert.equal(f.diagnostics[0].networkCode, "ENOTFOUND");
  assert.equal(f.diagnostics[0].reason, "network_error");
  assert.equal(f.diagnostics[1].networkCode, undefined);
  assert.equal(JSON.stringify(f.diagnostics).includes("PRIVATE-CREDENTIAL"), false);
});

test("上游 HTML 挑战能够与 JSON 鉴权错误区分且不输出正文", async (t) => {
  const f = await fixture(t);
  f.behavior.tokenStatus = 403;
  f.behavior.contentType = "text/html; charset=utf-8";
  f.behavior.challenge = true;
  await f.handoff();
  assert.deepEqual(f.diagnostics, [
    {
      stage: "token",
      reason: "http_error",
      httpStatus: 403,
      contentType: "html",
      challenge: true,
    },
  ]);
});

test("跨站 Origin、恶意 Host、错误媒体类型和超大请求被拒绝", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("/v1/login/start", {}, { Origin: "https://evil.test" })).status,
    403,
  );
  assert.equal((await f.request("/healthz", undefined, { Host: "evil.test" })).status, 400);
  assert.equal(
    (await f.request("/v1/login/start", {}, { "Content-Type": "text/plain" })).status,
    415,
  );
  assert.equal((await f.request("/v1/login/start", { content: "x".repeat(16385) })).status, 413);
  assert.equal((await f.request("/v1/login/start")).status, 405);
});

test("缺失邮箱和等级不编造，外部头像地址会丢弃", async (t) => {
  const f = await fixture(t);
  f.behavior.profile = {
    id: 73,
    username: "sample",
    avatar_url: "https://linux.do.evil.test/me.png",
  };
  const result = await f.login();
  assert.equal(result.profile.email, null);
  assert.equal(result.profile.trustLevel, null);
  assert.equal(result.profile.avatarUrl, null);
});

test("待授权容量和请求速率有上限", async (t) => {
  const f = await fixture(t, {}, { maxPending: 1, rateLimit: 5 });
  await f.start();
  assert.equal(
    (
      await f.request("/v1/login/start", {
        redirectUri: "http://127.0.0.1:50111/oauth/zhiyu/callback",
        state: nonce(),
        challenge: nonce(),
      })
    ).status,
    503,
  );
  for (let i = 0; i < 5; i++) await f.request("/v1/login/exchange", {});
  assert.equal((await f.request("/v1/login/exchange", {})).status, 429);
});

test("同时兑换相同交接码只允许一个成功", async (t) => {
  const f = await fixture(t);
  const session = await f.handoff();
  const responses = await Promise.all(
    [1, 2].map(() =>
      f.request("/v1/login/exchange", { code: session.code, verifier: session.verifier }),
    ),
  );
  assert.deepEqual(responses.map((value) => value.status).sort(), [200, 400]);
});

test("上游不响应时中止登录并释放处理能力", async (t) => {
  const f = await fixture(t, {}, { providerTimeoutMs: 30, maxConcurrent: 1 });
  f.behavior.hang = true;
  const result = await f.handoff();
  assert.equal(result.target.searchParams.get("error"), "login_failed");
  f.behavior.hang = false;
  const retry = await f.login();
  assert.equal(retry.profile.subject, "73");
});

test("重启后保留密钥可恢复会话，轮换密钥立即拒绝旧凭据", async (t) => {
  const original = await fixture(t);
  const login = await original.login();
  const restarted = await fixture(t, original.config);
  assert.equal(
    (
      await restarted.request(
        "/v1/session/profile",
        {},
        { Authorization: `Bearer ${login.credential}` },
      )
    ).status,
    200,
  );
  const rotated = await fixture(t);
  assert.equal(
    (
      await rotated.request(
        "/v1/session/profile",
        {},
        { Authorization: `Bearer ${login.credential}` },
      )
    ).status,
    401,
  );
});

test("同一加密密钥也不能将另一服务域名的凭据用作本服务登录", async (t) => {
  const original = await fixture(t);
  const login = await original.login();
  const another = await fixture(t, {
    ...original.config,
    publicOrigin: "https://auth-other.allinsong.top",
  });
  assert.equal(
    (
      await another.request(
        "/v1/session/profile",
        {},
        { Host: "auth-other.allinsong.top", Authorization: `Bearer ${login.credential}` },
      )
    ).status,
    401,
  );
});

test("本机 Host 只允许健康检查，业务请求必须使用公开域名", async (t) => {
  const f = await fixture(t);
  const localHost = new URL(f.base).host;
  assert.equal((await f.request("/healthz", undefined, { Host: localHost })).status, 200);
  assert.equal((await f.request("/v1/login/start", {}, { Host: localHost })).status, 400);
});

test("浏览器官方回调允许跨站 GET，但 API 仍拒绝跨站请求", async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const result = await f.request(
    `/oauth/linuxdo/callback?state=${session.authorization.searchParams.get("state")}&code=provider-code`,
    undefined,
    { Origin: "https://connect.linux.do", "Sec-Fetch-Site": "cross-site" },
  );
  assert.equal(result.status, 302);
  assert.ok(new URL(result.headers.get("location")).searchParams.get("code"));
  assert.equal(
    (await f.request("/v1/login/start", {}, { "Sec-Fetch-Site": "cross-site" })).status,
    403,
  );
});

test("过期授权释放容量后可以重新登录", async (t) => {
  const f = await fixture(t, {}, { maxPending: 1 });
  await f.start();
  f.advance(300_001);
  assert.ok((await f.start()).id);
});
