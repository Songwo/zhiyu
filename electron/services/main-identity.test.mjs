import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { MainIdentityService } from "./main-identity.mjs";
import { ProfileService } from "./profile.mjs";

const profile = {
  subject: "42",
  username: "tester",
  name: "测试用户",
  email: "user@example.com",
  trustLevel: 2,
  avatarUrl: null,
  profileUrl: "https://linux.do/u/tester",
  active: true,
  silenced: false,
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zhiyu-main-identity-"));
  const key = randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "dpapi",
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString();
    },
  };
  const calls = [];
  let login, opened;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (overrides.fetch) {
      const result = await overrides.fetch(url, init);
      if (result) return result;
    }
    if (String(url).endsWith("/healthz")) return json({ ok: true, configured: true });
    if (String(url).endsWith("/v1/login/start")) {
      login = JSON.parse(init.body);
      return json({
        id: "broker-session",
        authorizationUrl: "https://connect.linux.do/oauth2/authorize?state=broker-state",
        expiresAt: Date.now() + 300000,
      });
    }
    if (String(url).endsWith("/v1/login/exchange")) {
      assert.equal(
        createHash("sha256").update(JSON.parse(init.body).verifier).digest("base64url"),
        login.challenge,
      );
      return json({
        credential: "private-broker-credential",
        profile: overrides.profile || profile,
        expiresAt: Date.now() + 86400000,
      });
    }
    if (String(url).endsWith("/v1/session/profile"))
      return json({
        credential: "private-broker-credential",
        profile: overrides.refreshProfile || profile,
        expiresAt: Date.now() + 86400000,
      });
    throw new Error("unexpected request");
  };
  const options = {
    file: join(dir, "main-identity.bin"),
    safeStorage,
    fetchImpl,
    openExternal: async (url) => {
      opened = url;
    },
    ...overrides.options,
  };
  const service = new MainIdentityService(options);
  t.after(async () => {
    service.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const authorize = async () => {
    const session = await service.start();
    assert.match(opened, /^https:\/\/connect.linux.do/);
    const response = await fetch(`${login.redirectUri}?code=one-time-code&state=${login.state}`);
    assert.equal(response.status, 200);
    for (let i = 0; i < 100; i++) {
      if ((await service.status(session.id)).status !== "waiting") break;
      await new Promise((r) => setTimeout(r, 2));
    }
    return session;
  };
  return { service, options, calls, authorize, login: () => login };
}

test("重新发起使用新的 state 与 PKCE，旧监听失效，已绑定身份保持不变", async (t) => {
  const f = await setup(t);
  const authorized = await f.authorize();
  await f.service.bind({ sessionId: authorized.id, syncName: false, syncAvatar: false });
  const before = await f.service.get();
  const first = await f.service.start();
  const previous = structuredClone(f.login());
  const second = await f.service.start();
  const current = f.login();
  assert.notEqual(second.id, first.id);
  assert.notEqual(current.state, previous.state);
  assert.notEqual(current.challenge, previous.challenge);
  assert.equal((await f.service.status(first.id)).status, "cancelled");
  assert.equal((await f.service.status(second.id)).status, "waiting");
  const stale = new URL(current.redirectUri);
  stale.search = new URLSearchParams({ state: previous.state, code: "stale-code" }).toString();
  const rejected = await fetch(stale);
  assert.equal(rejected.status, 400);
  await rejected.text();
  assert.equal((await f.service.status(second.id)).status, "waiting");
  assert.deepEqual(await f.service.get(), before);
  await f.service.cancel(second.id);
  assert.deepEqual(await f.service.get(), before);
});

test("主身份首次授权只预览，确认后整体加密持久化，脱离密钥库重启可读取", async (t) => {
  const f = await setup(t);
  assert.equal(await f.service.get(), null);
  const session = await f.authorize();
  assert.equal((await f.service.status(session.id)).status, "ready");
  assert.equal(await f.service.get(), null);
  const result = await f.service.bind({ sessionId: session.id, syncName: true, syncAvatar: false });
  assert.equal(result.profile.subject, "42");
  assert.equal(JSON.stringify(result).includes("credential"), false);
  const disk = await readFile(f.options.file);
  assert.equal(disk.includes(Buffer.from("private-broker-credential")), false);
  assert.equal(disk.includes(Buffer.from("user@example.com")), false);
  const fresh = new MainIdentityService(f.options);
  t.after(() => fresh.stop());
  assert.deepEqual(await fresh.get(), result);
  assert.equal((await f.service.status(session.id)).status, "cancelled");
});

test("系统加密不可用或basic_text时拒绝登录，不能降级写明文", async (t) => {
  for (const safeStorage of [
    { isEncryptionAvailable: () => false },
    { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" },
  ]) {
    const { service, calls } = await setup(t, { options: { safeStorage } });
    await assert.rejects(service.start(), /系统.*加密/);
    assert.equal(calls.length, 0);
  }
});

test("错误state或重复参数不消费登录，取消后无法绑定或交换", async (t) => {
  const f = await setup(t);
  const session = await f.service.start();
  const url = f.login().redirectUri;
  assert.equal((await fetch(`${url}?code=x&state=wrong`)).status, 400);
  assert.equal((await fetch(`${url}?code=x&code=y&state=${f.login().state}`)).status, 400);
  assert.equal((await f.service.status(session.id)).status, "waiting");
  await f.service.cancel(session.id);
  assert.equal((await f.service.status(session.id)).status, "cancelled");
  await assert.rejects(
    f.service.bind({ sessionId: session.id, syncName: true, syncAvatar: false }),
    /失效/,
  );
  assert.equal(
    f.calls.some(({ url }) => url.endsWith("exchange")),
    false,
  );
});

test("不同身份覆盖需要精确确认旧subject，刷新不能偷偷切换身份", async (t) => {
  const overrides = { profile: { ...profile }, refreshProfile: { ...profile, subject: "666" } };
  const f = await setup(t, overrides);
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  await assert.rejects(f.service.refresh(), /不同.*身份/);
  assert.equal((await f.service.get()).profile.subject, "42");
  overrides.profile.subject = "43";
  const session = await f.authorize();
  await assert.rejects(
    f.service.bind({ sessionId: session.id, syncName: true, syncAvatar: false }),
    /确认/,
  );
  await f.service.bind({
    sessionId: session.id,
    replaceSubject: "42",
    syncName: false,
    syncAvatar: false,
  });
  assert.equal((await f.service.get()).profile.subject, "43");
});

test("刷新失败保留已绑定资料，断开会使在途刷新结果失效", async (t) => {
  let mode = "normal",
    finish,
    entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await setup(t, {
    fetch: async (url) => {
      if (!String(url).endsWith("/v1/session/profile")) return;
      if (mode === "fail") return json({ error: "raw-secret" }, 500);
      if (mode === "delay") {
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    },
  });
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  mode = "fail";
  await assert.rejects(f.service.refresh(), (error) => !error.message.includes("raw-secret"));
  assert.equal((await f.service.get()).profile.subject, "42");
  mode = "delay";
  const refresh = f.service.refresh();
  await waiting;
  const disconnected = f.service.disconnect();
  finish(json({ credential: "late-credential", profile, expiresAt: Date.now() + 100000 }));
  await assert.rejects(refresh, /取消|失效/);
  await disconnected;
  assert.equal((await f.service.get()).connected, false);
  assert.equal((await f.service.get()).profile.subject, "42");
});

test("加密或原子提交失败保留旧记录并可重试", async (t) => {
  const f = await setup(t);
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  const before = await readFile(f.options.file);
  const encrypt = f.options.safeStorage.encryptString;
  f.options.safeStorage.encryptString = () => {
    throw new Error("dpapi unavailable");
  };
  await assert.rejects(f.service.preferences({ syncName: false, syncAvatar: false }));
  assert.equal((await f.service.get()).syncName, true);
  assert.deepEqual(await readFile(f.options.file), before);
  f.options.safeStorage.encryptString = encrypt;
  await f.service.preferences({ syncName: false, syncAvatar: false });
  assert.equal((await f.service.get()).syncName, false);
});

test("损坏的身份文件不能被自动覆盖", async (t) => {
  const f = await setup(t);
  await writeFile(f.options.file, "corrupt");
  await assert.rejects(f.service.get(), /读取/);
  assert.equal(await readFile(f.options.file, "utf8"), "corrupt");
});

test("公开帖子复用作者校验和全文缓存，永不向论坛发送登录服务凭据", async (t) => {
  let contents = 0,
    listRequests = 0;
  const f = await setup(t, {
    fetch: async (url, init) => {
      if (String(url).startsWith("https://linux.do/")) {
        assert.equal(init.headers?.Authorization, undefined);
        assert.equal(init.headers?.authorization, undefined);
        if (String(url).includes("user_actions.json")) {
          listRequests++;
          return json({
            user_actions: [
              {
                action_type: 4,
                username: "tester",
                topic_id: 12,
                post_number: 1,
                post_id: 91,
                title: "自己的文章",
                excerpt: "仅摘要",
                created_at: new Date().toISOString(),
              },
              {
                action_type: 4,
                username: "other",
                topic_id: 15,
                post_number: 1,
                post_id: 95,
                title: "其他人",
              },
            ],
          });
        }
        if (String(url).endsWith("/posts/91.json")) {
          contents++;
          return json({
            id: 91,
            topic_id: 12,
            post_number: 1,
            username: "tester",
            user_id: 42,
            raw: "# 完整正文\n账号：me\n密码：local-test-value",
          });
        }
      }
    },
  });
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  const capture = f.service.captureSession();
  const list = await f.service.loadPosts();
  assert.equal(list.posts.items.length, 1);
  assert.equal((await f.service.loadPosts()).posts.items.length, 1);
  assert.equal(listRequests, 1);
  const result = await f.service.readPosts(["12:1"]);
  assert.match(result.items[0].content, /完整正文/);
  await f.service.readPosts(["12:1"]);
  assert.equal(contents, 1);
  const disk = await readFile(f.options.file);
  assert.equal(disk.includes(Buffer.from("local-test-value")), false);
  assert.equal(JSON.stringify(await f.service.get()).includes("local-test-value"), false);
  await f.service.disconnect();
  assert.throws(() => f.service.assertCurrent(capture), /取消/);
  await assert.rejects(f.service.loadPosts(), /绑定/);
});

test("未勾选头像不请求图片，错误图片或外部域名不能阻止身份保存", async (t) => {
  const f = await setup(t, {
    profile: { ...profile, avatarUrl: "https://linux.do/avatar/tester.png" },
  });
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  assert.equal(
    f.calls.some(({ url }) => url.startsWith("https://linux.do/")),
    false,
  );
  const enabled = await f.service.preferences({ syncName: true, syncAvatar: true });
  assert.equal(enabled.profile.subject, "42");
  assert.match(enabled.avatarMessage, /失败/);
  const external = await setup(t, {
    profile: { ...profile, avatarUrl: "https://evil.example/avatar.png" },
  });
  const bound = await external.service.bind({
    sessionId: (await external.authorize()).id,
    syncName: true,
    syncAvatar: true,
  });
  assert.equal(bound.profile.avatarUrl, null);
  assert.equal(
    external.calls.some(({ url }) => url.includes("evil.example")),
    false,
  );
});

test("响应超限和非官方授权地址被拒绝且不会打开浏览器", async (t) => {
  for (const authorizationUrl of [
    "https://evil.example/oauth2/authorize",
    "https://connect.linux.do@evil.example/oauth2/authorize",
    "https://connect.linux.do/not-oauth",
  ]) {
    const f = await setup(t, {
      fetch: async (url) =>
        String(url).endsWith("/v1/login/start")
          ? json({ id: "broker", authorizationUrl, expiresAt: Date.now() + 100000 })
          : undefined,
    });
    await assert.rejects(f.service.start(), /非官方/);
  }
  const f = await setup(t, {
    fetch: async (url) =>
      String(url).endsWith("/healthz")
        ? new Response("x".repeat(1024 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          })
        : undefined,
  });
  assert.equal((await f.service.availability()).configured, false);
});

test("原子替换失败不会更新内存身份或破坏先前加密文件", async (t) => {
  const f = await setup(t);
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  const backup = `${f.options.file}.backup`;
  const bytes = await readFile(f.options.file);
  await rename(f.options.file, backup);
  await mkdir(f.options.file);
  await assert.rejects(f.service.preferences({ syncName: false, syncAvatar: false }), /保存失败/);
  assert.equal((await f.service.get()).syncName, true);
  assert.deepEqual(await readFile(backup), bytes);
  await rm(f.options.file, { recursive: true });
  await rename(backup, f.options.file);
  await f.service.preferences({ syncName: false, syncAvatar: false });
  assert.equal((await f.service.get()).syncName, false);
});

test("取消交换中的登录不能留下预览或持久身份", async (t) => {
  let resolveExchange, started;
  const exchanging = new Promise((resolve) => {
    started = resolve;
  });
  const f = await setup(t, {
    fetch: async (url) => {
      if (String(url).endsWith("/v1/login/exchange")) {
        started();
        return new Promise((resolve) => {
          resolveExchange = resolve;
        });
      }
    },
  });
  const session = await f.service.start();
  const callback = fetch(`${f.login().redirectUri}?code=one-time&state=${f.login().state}`).catch(
    () => null,
  );
  await exchanging;
  await f.service.cancel(session.id);
  resolveExchange(
    json({ credential: "private-broker-credential", profile, expiresAt: Date.now() + 100000 }),
  );
  await callback;
  assert.equal((await f.service.status(session.id)).status, "cancelled");
  assert.equal(await f.service.get(), null);
});

test("登录预览五分钟失效，过期后不能确认绑定", async (t) => {
  const f = await setup(t);
  const session = await f.authorize();
  const future = Date.now() + 300001;
  t.mock.method(Date, "now", () => future);
  assert.equal((await f.service.status(session.id)).status, "error");
  await assert.rejects(
    f.service.bind({ sessionId: session.id, syncName: true, syncAvatar: false }),
    /失效/,
  );
  assert.equal(await f.service.get(), null);
});

test("等待最终写入时取消绑定，临时密文不会成为主身份文件", async (t) => {
  const f = await setup(t);
  const session = await f.authorize();
  const encrypt = f.options.safeStorage.encryptString;
  f.options.safeStorage.encryptString = (value) => {
    queueMicrotask(() => f.service.cancel(session.id));
    return encrypt(value);
  };
  await assert.rejects(
    f.service.bind({ sessionId: session.id, syncName: true, syncAvatar: false }),
    /失效/,
  );
  assert.equal(await f.service.get(), null);
  await assert.rejects(readFile(f.options.file), { code: "ENOENT" });
});

test("并发重复回调只交换一次，不破坏第一次有效授权", async (t) => {
  let resolveExchange,
    started,
    exchanges = 0;
  const exchanging = new Promise((resolve) => {
    started = resolve;
  });
  const f = await setup(t, {
    fetch: async (url) => {
      if (String(url).endsWith("/v1/login/exchange")) {
        exchanges++;
        started();
        return new Promise((resolve) => {
          resolveExchange = resolve;
        });
      }
    },
  });
  const session = await f.service.start();
  const url = `${f.login().redirectUri}?code=one-time&state=${f.login().state}`;
  const first = fetch(url);
  await exchanging;
  assert.equal((await fetch(url)).status, 400);
  resolveExchange(
    json({ credential: "private-broker-credential", profile, expiresAt: Date.now() + 100000 }),
  );
  assert.equal((await first).status, 200);
  assert.equal((await f.service.status(session.id)).status, "ready");
  assert.equal(exchanges, 1);
});

test("同一身份并发刷新复用单次请求，避免重复轮换授权令牌", async (t) => {
  let finish,
    entered,
    requests = 0;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await setup(t, {
    fetch: async (url) => {
      if (String(url).endsWith("/v1/session/profile")) {
        requests++;
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    },
  });
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  const first = f.service.refresh();
  await waiting;
  const second = f.service.refresh();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const count = requests;
  finish(json({ credential: "new-broker-credential", profile, expiresAt: Date.now() + 100000 }));
  assert.equal(count, 1);
  assert.deepEqual(await first, await second);
});

test("平台用户名发生变化后，在途旧用户名帖子不能重新写入缓存", async (t) => {
  let finish, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await setup(t, {
    refreshProfile: { ...profile, username: "renamed" },
    fetch: async (url) => {
      if (String(url).includes("/user_actions.json")) {
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    },
  });
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  const capture = f.service.captureSession();
  const posts = f.service.loadPosts();
  await waiting;
  await f.service.refresh();
  finish(
    json({
      user_actions: [
        {
          action_type: 4,
          username: "tester",
          topic_id: 12,
          post_number: 1,
          post_id: 91,
          title: "旧用户名文章",
        },
      ],
    }),
  );
  await assert.rejects(posts, /取消|锁定/);
  assert.throws(() => f.service.assertCurrent(capture), /取消/);
});

test("拒绝授权或上游失败回调立即结束等待，仅本次state可终止登录", async (t) => {
  for (const code of ["access_denied", "login_failed", "raw-server-error-secret"]) {
    const f = await setup(t);
    const session = await f.service.start();
    const base = f.login().redirectUri;
    assert.equal((await fetch(`${base}?error=${code}&state=other-state`)).status, 400);
    assert.equal((await f.service.status(session.id)).status, "waiting");
    assert.equal(
      (await fetch(`${base}?error=${code}&error=duplicate&state=${f.login().state}`)).status,
      400,
    );
    assert.equal((await f.service.status(session.id)).status, "waiting");
    assert.equal((await fetch(`${base}?error=${code}&state=${f.login().state}`)).status, 200);
    const status = await f.service.status(session.id);
    assert.equal(status.status, "error");
    assert.equal(status.error.includes("raw-server-error-secret"), false);
    assert.match(status.error, code === "access_denied" ? /取消/ : /未完成|失败/);
    await assert.rejects(
      f.service.bind({ sessionId: session.id, syncName: true, syncAvatar: false }),
      /失效/,
    );
    assert.equal(
      f.calls.some(({ url }) => url.endsWith("exchange")),
      false,
    );
    assert.equal(await f.service.get(), null);
    assert.ok((await f.service.start()).id);
  }
});

test("退出登录清除服务凭据但保留主身份和同步偏好，重启后可修改显示设置并重新登录", async (t) => {
  const f = await setup(t);
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  await f.service.disconnect();
  const current = await f.service.get();
  assert.equal(current.connected, false);
  assert.deepEqual(current.profile, profile);
  assert.equal(current.syncName, true);
  const saved = JSON.parse(f.options.safeStorage.decryptString(await readFile(f.options.file)));
  assert.equal(saved.identity.credential, null);
  assert.equal(saved.identity.expiresAt, null);
  assert.deepEqual(saved.identity.postContents, {});
  assert.throws(() => f.service.captureSession(), /登录|绑定/);
  await assert.rejects(f.service.refresh(), /登录|绑定/);
  await assert.rejects(f.service.loadPosts(), /登录|绑定/);
  const fresh = new MainIdentityService(f.options);
  t.after(() => fresh.stop());
  assert.deepEqual(await fresh.get(), current);
  await fresh.preferences({ syncName: false, syncAvatar: false });
  assert.equal((await fresh.get()).syncName, false);
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: false, syncAvatar: false });
  assert.equal((await f.service.get()).connected, true);
});

test("过期登录保留主身份资料并显示未连接，不能使用旧credential读取", async (t) => {
  const f = await setup(t);
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  const future = Date.now() + 86400001;
  t.mock.method(Date, "now", () => future);
  assert.equal((await f.service.get()).connected, false);
  assert.equal((await f.service.get()).profile.subject, "42");
  assert.throws(() => f.service.captureSession(), /登录|绑定|过期/);
  const fresh = new MainIdentityService(f.options);
  t.after(() => fresh.stop());
  assert.equal((await fresh.get()).profile.subject, "42");
  assert.equal((await fresh.get()).connected, false);
});

test("退出后修改个人昵称能关闭同步，切换头像同步只使用缓存不联网", async (t) => {
  const f = await setup(t, {
    profile: { ...profile, avatarUrl: "https://linux.do/avatar/tester.png" },
  });
  const localFile = `${f.options.file}.profile.json`;
  await writeFile(localFile, JSON.stringify({ name: "原本地昵称", avatarDataUrl: "" }));
  const personal = new ProfileService(localFile, { status: async () => ({ exists: true }) });
  personal.setIdentitySource(f.service);
  await f.service.bind({ sessionId: (await f.authorize()).id, syncName: true, syncAvatar: false });
  await f.service.disconnect();
  assert.equal((await personal.get()).name, "测试用户");
  const count = f.calls.length;
  await personal.save({ name: "新的本地昵称" });
  assert.equal((await personal.get()).name, "新的本地昵称");
  assert.equal((await personal.get()).mainIdentity.syncName, false);
  await f.service.preferences({ syncName: false, syncAvatar: true });
  await f.service.preferences({ syncName: false, syncAvatar: false });
  assert.equal(f.calls.length, count);
  assert.equal((await f.service.get()).connected, false);
});
