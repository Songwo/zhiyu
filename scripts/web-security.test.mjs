import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../selfhost/server.mjs";
import {
  LoginGuard,
  PRIVATE_NETS,
  appendLog,
  base32Decode,
  base32Encode,
  hashRecovery,
  isKnownIp,
  newRecoveryCodes,
  normalizeIp,
  otpauthUri,
  parseAllowedNets,
  shortAgent,
  totpCode,
  verifyTotp,
} from "../selfhost/security.mjs";

// ———— 单元：来源白名单 ————

test("来源白名单：IP、网段、private 关键字、IPv4 映射地址；空表示不限制", () => {
  assert.equal(parseAllowedNets("").empty, true);
  assert.equal(parseAllowedNets(undefined).allows("203.0.113.9"), true);
  const list = parseAllowedNets("203.0.113.7, 192.168.0.0/16 2001:db8::/32");
  assert.equal(list.allows("203.0.113.7"), true);
  assert.equal(list.allows("203.0.113.8"), false);
  assert.equal(list.allows("192.168.5.20"), true);
  assert.equal(list.allows("::ffff:192.168.5.20"), true, "IPv4 映射地址按 IPv4 比较");
  assert.equal(list.allows("2001:db8::1"), true);
  assert.equal(list.allows("2001:db9::1"), false);
  assert.equal(list.allows("not-an-ip"), false);
  assert.equal(list.allows(undefined), false);
  const priv = parseAllowedNets("private");
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.1",
    "100.100.1.1",
    "::1",
    "fd00::1",
    "169.254.1.1",
  ])
    assert.equal(priv.allows(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1"])
    assert.equal(priv.allows(ip), false, ip);
  assert.ok(PRIVATE_NETS.length >= 9);
});

test("来源白名单写错时直接报错，不会悄悄变成不限制", () => {
  for (const bad of ["abc", "1.2.3.4/33", "1.2.3.4/x", "::1/129", "1.2.3", "10.0.0.0/8, oops"])
    assert.throws(() => parseAllowedNets(bad), /ZHIYU_ALLOWED_NETS/, bad);
  assert.equal(normalizeIp("[::ffff:1.2.3.4]"), "1.2.3.4");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
});

// ———— 单元：TOTP ————

test("TOTP 与 RFC 6238 的标准测试向量一致（SHA-1，取后 6 位）", () => {
  const secret = Buffer.from("12345678901234567890");
  const vectors = {
    59: "287082",
    1111111109: "081804",
    1111111111: "050471",
    1234567890: "005924",
    2000000000: "279037",
    20000000000: "353130",
  };
  for (const [time, code] of Object.entries(vectors))
    assert.equal(totpCode(secret, Math.floor(Number(time) / 30)), code, time);
});

test("TOTP 验证：允许前后各一个时间窗，同一个或更早的时间窗不能重放，格式不对直接拒绝", () => {
  const secret = Buffer.from("12345678901234567890");
  const now = 1_111_111_109_000;
  const step = Math.floor(now / 30_000);
  assert.deepEqual(verifyTotp(secret, totpCode(secret, step), now), { ok: true, step });
  assert.equal(verifyTotp(secret, totpCode(secret, step - 1), now).ok, true, "慢一个时间窗");
  assert.equal(verifyTotp(secret, totpCode(secret, step + 1), now).ok, true, "快一个时间窗");
  assert.equal(verifyTotp(secret, totpCode(secret, step - 2), now).ok, false);
  assert.equal(verifyTotp(secret, totpCode(secret, step + 2), now).ok, false);
  assert.equal(
    verifyTotp(secret, totpCode(secret, step), now, step).ok,
    false,
    "用过的时间窗不能再用",
  );
  assert.equal(verifyTotp(secret, totpCode(secret, step - 1), now, step).ok, false, "更早的也不行");
  assert.equal(verifyTotp(secret, totpCode(secret, step + 1), now, step).ok, true);
  for (const bad of ["", "12345", "1234567", "abcdef", null, undefined, "12 34 5x"])
    assert.equal(verifyTotp(secret, bad, now).ok, false, String(bad));
  assert.equal(
    verifyTotp(
      secret,
      ` ${totpCode(secret, step).slice(0, 3)} ${totpCode(secret, step).slice(3)} `,
      now,
    ).ok,
    true,
    "允许空格",
  );
});

test("base32 往返、otpauth 链接格式、恢复码", () => {
  const secret = Buffer.from([
    1, 2, 3, 250, 251, 252, 253, 254, 255, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  ]);
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.throws(() => base32Decode("1!"), /密钥/);
  const uri = otpauthUri({ secret, account: "song" });
  assert.match(
    uri,
    /^otpauth:\/\/totp\/.+secret=[A-Z2-7]+&issuer=.+&algorithm=SHA1&digits=6&period=30$/,
  );
  const codes = newRecoveryCodes();
  assert.equal(new Set(codes).size, 8);
  assert.ok(codes.every((code) => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(code)));
  assert.equal(
    hashRecovery(codes[0].toLowerCase().replace("-", " "), "salt"),
    hashRecovery(codes[0], "salt"),
    "大小写、空格、连字符不影响",
  );
  assert.notEqual(hashRecovery(codes[0], "salt"), hashRecovery(codes[0], "other"));
});

// ———— 单元：限流与记录 ————

test("登录限流：单个来源失败 8 次后拒绝；全站失败多了每次尝试都要多等；请求过密也拒绝", () => {
  let now = 0;
  const guard = new LoginGuard({ now: () => now, perIp: 3, globalFree: 2, perMinute: 6 });
  assert.equal(guard.check("1.1.1.1").blocked, false);
  for (let i = 0; i < 3; i += 1) guard.fail("1.1.1.1");
  assert.deepEqual(guard.check("1.1.1.1"), { blocked: true, reason: "ip" });
  assert.equal(guard.check("2.2.2.2").blocked, false, "别的来源不受影响");
  assert.equal(guard.delayMs(), 400, "全站失败 3 次，超出免费额度 1 次");
  for (let i = 0; i < 40; i += 1) guard.fail(`9.9.9.${i}`);
  assert.equal(guard.delayMs(), 5000, "延迟有上限");
  now += 16 * 60_000;
  assert.equal(guard.check("1.1.1.1").blocked, false, "15 分钟后恢复");
  assert.equal(guard.delayMs(), 0);
  for (let i = 0; i < 6; i += 1) guard.check("3.3.3.3");
  assert.deepEqual(guard.check("3.3.3.3"), { blocked: true, reason: "rate" });
  guard.success("1.1.1.1");
  assert.equal(guard.recentFailures, 0);
});

test("登录记录：只留最近 100 条，认得 60 天内成功登录过的来源，User-Agent 只留浏览器和系统", () => {
  let log = [];
  for (let i = 0; i < 130; i += 1)
    log = appendLog(log, { kind: "fail", ip: `1.1.1.${i % 250}` }, 1000 + i);
  assert.equal(log.length, 100);
  const now = Date.parse("2026-10-28T00:00:00Z");
  const withLogin = appendLog([], { kind: "login", ip: "5.5.5.5" }, now - 10 * 86_400_000);
  assert.equal(isKnownIp(withLogin, "5.5.5.5", now), true);
  assert.equal(isKnownIp(withLogin, "6.6.6.6", now), false);
  assert.equal(isKnownIp(withLogin, "5.5.5.5", now + 70 * 86_400_000), false, "超过 60 天");
  assert.equal(
    isKnownIp(appendLog([], { kind: "fail", ip: "5.5.5.5" }, now), "5.5.5.5", now),
    false,
    "失败的不算认识",
  );
  assert.equal(
    shortAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124.0",
    ),
    "Edge · Windows",
  );
  assert.equal(shortAgent(undefined), "");
});

// ———— 集成：真实启动网页版服务器 ————

const quiet = { log() {}, error() {} };
const account = { username: "song", password: "home-and-office-2026" };

async function rig(t, options = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "zhiyu-sec-")));
  const staticDir = await mkdtemp(join(tmpdir(), "zhiyu-sec-static-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html>");
  const calls = [];
  const web = await createWebServer({
    root,
    staticDir,
    log: quiet,
    schedulePush: false,
    sampleHost: false,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: init?.body });
      return Response.json({ ok: true });
    },
    ...options.server,
  });
  await new Promise((resolve) => web.server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = web.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  if (!options.keep)
    t.after(async () => {
      web.server.closeAllConnections();
      web.server.close();
      await rm(root, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    });
  const client = () => {
    let cookie = "";
    const call = async (path, { method = "GET", body, headers = {}, raw } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(method === "GET" ? {} : { "content-type": "application/json", "x-zhiyu": "1" }),
          ...headers,
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return res;
    };
    return { call, cookie: () => cookie, clear: () => (cookie = "") };
  };
  return { web, root, base, client, calls, staticDir };
}
const signUp = async (r) => {
  const c = r.client();
  const res = await c.call("/api/web/setup", {
    method: "POST",
    body: { ...account, token: r.web.setupToken },
  });
  assert.equal(res.status, 200);
  return c;
};

test("来源白名单：不在名单里的连接被直接断开，什么都不回；在名单里正常使用", async (t) => {
  const blocked = await rig(t, { server: { allowedNets: "203.0.113.0/24" } });
  // 带代理头的请求不算「本机探针」，按名单判断，被直接断开。
  const proxied = { headers: { "x-forwarded-for": "198.51.100.7" } };
  await assert.rejects(fetch(`${blocked.base}/api/web/state`, proxied), "连接被断开");
  await assert.rejects(fetch(`${blocked.base}/login`, proxied));
  // 容器自己的健康检查（本机直连、不经代理）始终放行，名单不会把自己锁在外面。
  assert.equal((await fetch(`${blocked.base}/api/web/state`)).status, 200);
  const open = await rig(t, { server: { allowedNets: "private" } });
  assert.equal((await fetch(`${open.base}/api/web/state`)).status, 200);
});

test("服务器启动时来源白名单写错会直接失败", async (t) => {
  await assert.rejects(rig(t, { server: { allowedNets: "10.0.0.0/99" } }), /ZHIYU_ALLOWED_NETS/);
});

test("未登录的人只能看到登录页：状态接口不暴露版本和用户名，数据接口一律 401，其他路径一律跳去登录", async (t) => {
  const r = await rig(t);
  const state = await (await fetch(`${r.base}/api/web/state`)).json();
  assert.deepEqual(Object.keys(state).sort(), ["insecure", "setup", "totp", "username"]);
  assert.equal(state.username, null);
  const c = await signUp(r);
  const anon = r.client();
  const after = await (await anon.call("/api/web/state")).json();
  assert.equal(after.version, undefined, "未登录不给版本号");
  assert.equal(after.setup, false);
  for (const path of [
    "/api/web/store",
    "/api/web/vault",
    "/api/web/documents",
    "/api/web/session",
    "/api/web/security",
    "/api/web/sync",
    "/api/web/backup",
  ])
    assert.equal((await anon.call(path)).status, 401, path);
  assert.equal(
    (await anon.call("/api/web/rpc", { method: "POST", body: { channel: "ssh:probe", args: [] } }))
      .status,
    401,
  );
  for (const path of [
    "/",
    "/admin",
    "/.env",
    "/index.html",
    "/assets/app.js",
    "/../../etc/passwd",
  ]) {
    const res = await fetch(`${r.base}${path}`, { redirect: "manual" });
    assert.ok([302, 400, 404].includes(res.status), `${path} → ${res.status}`);
    if (res.status === 302) assert.equal(res.headers.get("location"), "/login");
  }
  assert.equal((await c.call("/api/web/session")).status, 200);
  assert.equal((await (await c.call("/api/web/state")).json()).version.length > 0, true);
});

test("登录前的接口只收很小的请求体", async (t) => {
  const r = await rig(t);
  await signUp(r);
  const res = await r.client().call("/api/web/login", {
    method: "POST",
    raw: JSON.stringify({ username: "x", password: "y".repeat(20_000) }),
  });
  assert.equal(res.status, 413);
});

test("响应头：不嗅探、不被嵌入、不被收录；只有 HTTPS 才带 HSTS", async (t) => {
  const plain = await rig(t);
  const res = await fetch(`${plain.base}/api/web/state`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(res.headers.get("permissions-policy"), /camera=\(\)/);
  assert.equal(res.headers.get("strict-transport-security"), null);
  assert.equal((await res.json()).insecure, true);
  const secure = await rig(t, { server: { secureCookie: true } });
  const secured = await fetch(`${secure.base}/api/web/state`);
  assert.match(secured.headers.get("strict-transport-security"), /max-age=\d+/);
  assert.equal((await secured.json()).insecure, false);
  const proxied = await rig(t, { server: { trustProxy: true } });
  const viaProxy = await fetch(`${proxied.base}/api/web/state`, {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.match(viaProxy.headers.get("strict-transport-security"), /max-age/);
});

test("放在反向代理后面：来源取代理追加的最后一项，客户端自己填的伪造地址不算数", async (t) => {
  const r = await rig(t, { server: { trustProxy: true } });
  const c = r.client();
  await c.call("/api/web/setup", {
    method: "POST",
    body: { ...account, token: r.web.setupToken },
    headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" },
  });
  const security = await (await c.call("/api/web/security")).json();
  assert.equal(security.log[0].ip, "8.8.8.8");
  // 白名单同样按这个地址判断：把允许的地址写在第一项没用。
  const guarded = await rig(t, { server: { trustProxy: true, allowedNets: "8.8.8.8" } });
  assert.equal(
    (
      await fetch(`${guarded.base}/api/web/state`, {
        headers: { "x-forwarded-for": "1.2.3.4, 8.8.8.8" },
      })
    ).status,
    200,
  );
  await assert.rejects(
    fetch(`${guarded.base}/api/web/state`, { headers: { "x-forwarded-for": "8.8.8.8, 1.2.3.4" } }),
  );
});

test(
  "登录限流：同一来源连续失败后拒绝，且正确密码也要等；失败与成功都进登录记录",
  async (t) => {
    const r = await rig(t);
    const owner = await signUp(r);
    const attacker = r.client();
    for (let i = 0; i < 8; i += 1) {
      const res = await attacker.call("/api/web/login", {
        method: "POST",
        body: { username: "song", password: `wrong-password-${i}` },
      });
      assert.equal(res.status, 401);
    }
    const blocked = await attacker.call("/api/web/login", { method: "POST", body: { ...account } });
    assert.equal(blocked.status, 429, "正确密码也被拒绝，不给在线猜测留空间");
    const log = (await (await owner.call("/api/web/security")).json()).log;
    assert.ok(log.filter((entry) => entry.kind === "fail").length >= 8);
    assert.ok(log.some((entry) => entry.kind === "blocked"));
    assert.ok(log.some((entry) => entry.kind === "setup"));
    assert.ok(
      log.every((entry) => !JSON.stringify(entry).includes("wrong-password")),
      "记录里没有密码",
    );
  },
  { timeout: 60_000 },
);

test(
  "两步验证：开启、登录需要验证码、验证码不能重放、恢复码一次性、关闭需要密码和验证码",
  async (t) => {
    const r = await rig(t);
    const owner = await signUp(r);
    // 开启前必须重新输入密码。
    assert.equal(
      (
        await owner.call("/api/web/totp/start", {
          method: "POST",
          body: { password: "wrong-password-xx" },
        })
      ).status,
      403,
    );
    const started = await (
      await owner.call("/api/web/totp/start", {
        method: "POST",
        body: { password: account.password },
      })
    ).json();
    const secret = base32Decode(started.secret);
    assert.match(started.uri, /^otpauth:\/\/totp\//);
    assert.equal(
      (await owner.call("/api/web/totp/enable", { method: "POST", body: { code: "000000" } }))
        .status,
      400,
      "验证码不对不能开启",
    );
    const step = Math.floor(Date.now() / 30_000);
    const enabled = await owner.call("/api/web/totp/enable", {
      method: "POST",
      body: { code: totpCode(secret, step) },
    });
    assert.equal(enabled.status, 200);
    const { recovery } = await enabled.json();
    assert.equal(recovery.length, 8);
    const stored = await readFile(join(r.root, "server", "account.json"), "utf8");
    assert.ok(
      !stored.includes(started.secret) && !stored.includes(recovery[0]),
      "密钥与恢复码不以明文落盘",
    );
    assert.equal((await (await r.client().call("/api/web/state")).json()).totp, true);

    const login = (body, c = r.client()) =>
      c
        .call("/api/web/login", { method: "POST", body: { ...account, ...body } })
        .then((res) => ({ res, c }));
    const noCode = await login({});
    assert.equal(noCode.res.status, 401);
    assert.match((await noCode.res.json()).error, /验证码/);
    assert.equal((await login({ code: "123456" })).res.status, 401);
    assert.equal(
      (await login({ username: "nobody", code: totpCode(secret, step + 1) })).res.status,
      401,
    );
    // 开启时用掉的验证码不能再用；下一个时间窗的可以。
    assert.equal((await login({ code: totpCode(secret, step) })).res.status, 401, "重放被拒绝");
    const good = await login({ code: totpCode(secret, step + 1) });
    assert.equal(good.res.status, 200);
    assert.equal((await good.c.call("/api/web/session")).status, 200);
    assert.equal(
      (await login({ code: totpCode(secret, step + 1) })).res.status,
      401,
      "同一个验证码不能用两次",
    );
    // 恢复码只能用一次。
    const viaRecovery = await login({ code: recovery[0] });
    assert.equal(viaRecovery.res.status, 200);
    assert.equal((await login({ code: recovery[0] })).res.status, 401);
    assert.equal((await (await good.c.call("/api/web/security")).json()).totp.recoveryLeft, 7);
    // 关闭：密码和验证码都要对。
    assert.equal(
      (
        await good.c.call("/api/web/totp/disable", {
          method: "POST",
          body: { password: account.password, code: "000000" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await good.c.call("/api/web/totp/disable", {
          method: "POST",
          body: { password: "wrong-password-xx", code: recovery[1] },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await good.c.call("/api/web/totp/disable", {
          method: "POST",
          body: { password: account.password, code: recovery[1] },
        })
      ).status,
      200,
    );
    assert.equal((await login({})).res.status, 200, "关闭后只需要密码");
  },
  { timeout: 90_000 },
);

test("登录设备：能看到每个设备、踢掉单个或全部其他设备，被踢的立刻失效", async (t) => {
  const r = await rig(t);
  const a = await signUp(r);
  const b = r.client();
  await b.call("/api/web/login", {
    method: "POST",
    body: account,
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/124.0 Safari/537.36" },
  });
  const c = r.client();
  await c.call("/api/web/login", { method: "POST", body: account });
  const view = await (await a.call("/api/web/security")).json();
  assert.equal(view.sessions.length, 3);
  assert.equal(view.sessions.filter((s) => s.current).length, 1);
  assert.ok(view.sessions.some((s) => s.agent === "Chrome · Windows"));
  assert.ok(view.sessions.every((s) => /^[0-9a-f]{12}$/.test(s.id)));
  const bId = (await (await b.call("/api/web/security")).json()).sessions.find((s) => s.current).id;
  assert.equal(
    (await a.call("/api/web/sessions/revoke", { method: "POST", body: { id: bId } })).status,
    200,
  );
  assert.equal((await b.call("/api/web/session")).status, 401, "被踢的设备立刻失效");
  const own = view.sessions.find((s) => s.current).id;
  assert.equal(
    (await a.call("/api/web/sessions/revoke", { method: "POST", body: { id: own } })).status,
    400,
  );
  assert.equal(
    (await a.call("/api/web/sessions/revoke", { method: "POST", body: { id: "zzzzzzzzzzzz" } }))
      .status,
    404,
  );
  assert.equal(
    (await a.call("/api/web/sessions/revoke-others", { method: "POST", body: {} })).status,
    200,
  );
  assert.equal((await c.call("/api/web/session")).status, 401);
  assert.equal((await a.call("/api/web/session")).status, 200);
});

test("超过 7 天没有任何操作的登录自动失效，重启后也一样", async (t) => {
  const r = await rig(t, { keep: true });
  t.after(async () => {
    await rm(r.root, { recursive: true, force: true });
    await rm(r.staticDir, { recursive: true, force: true });
  });
  const owner = await signUp(r);
  const cookie = owner.cookie();
  r.web.server.closeAllConnections();
  await new Promise((resolve) => r.web.server.close(resolve));
  const file = join(r.root, "server", "sessions.json");
  const sessions = JSON.parse(await readFile(file, "utf8"));
  for (const session of Object.values(sessions)) session.seen = Date.now() - 8 * 86_400_000;
  await writeFile(file, JSON.stringify(sessions));
  const again = await rig(t, { root: r.root, keep: true });
  t.after(() => {
    again.web.server.closeAllConnections();
    again.web.server.close();
  });
  const res = await fetch(`${again.base}/api/web/session`, { headers: { cookie } });
  assert.equal(res.status, 401);
});

test(
  "异常登录会通过推送渠道提醒：新来源登录、同一来源反复失败（每小时最多一条）",
  async (t) => {
    const r = await rig(t);
    const owner = await signUp(r);
    // 没开启推送时不发。
    await r.client().call("/api/web/login", { method: "POST", body: account });
    assert.equal(r.calls.length, 0);
    const saved = await owner.call("/api/web/push", {
      method: "PUT",
      body: {
        enabled: true,
        provider: "telegram",
        destination: "12345",
        token: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        leadDays: 21,
      },
    });
    assert.equal(saved.status, 200);
    const outsider = r.client();
    for (let i = 0; i < 4; i += 1)
      await outsider.call("/api/web/login", {
        method: "POST",
        body: { username: "song", password: `wrong-password-${i}` },
      });
    const alerts = r.calls.filter((call) => call.url.includes("api.telegram.org"));
    assert.equal(alerts.length, 1, "失败提醒每小时最多一条");
    assert.match(JSON.parse(alerts[0].body).text, /反复尝试登录/);
    assert.ok(!alerts[0].body.includes("wrong-password"), "提醒里没有猜过的密码");
  },
  { timeout: 60_000 },
);
