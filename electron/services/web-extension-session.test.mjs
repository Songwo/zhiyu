import test from "node:test";
import assert from "node:assert/strict";
import { WebExtensionSession } from "./web-extension-session.mjs";

function rig(t, overrides = {}) {
  let time = Date.now(),
    count = 0,
    locked = false;
  const listeners = new Set();
  const vault = {
    get unlocked() {
      return !locked;
    },
    onLock(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const events = [];
  const service = new WebExtensionSession({
    vault,
    now: () => time,
    random: () => (++count).toString(16).padStart(64, "0"),
    onChange: () => events.push("changed"),
    accounts: {
      listForOrigin: async () => [
        { id: "one", title: "Example", username: "sample", password: "must-not-leak" },
      ],
      getForOrigin: async (id, origin) => {
        assert.equal(id, "one");
        assert.equal(origin, "https://example.test");
        return { username: "sample", password: "synthetic-secret" };
      },
      saveCapture: async (_input, guard) => {
        guard();
        return { id: "saved", status: "created" };
      },
      ...overrides.accounts,
    },
    saveDocument: async (_input, guard) => {
      guard();
      return { id: "doc-web", status: "created" };
    },
  });
  t.after(() => service.stop());
  const extensionId = "a".repeat(32);
  let token;
  const call = (path, body = {}, extra = {}) =>
    service.call(`/v1/${path}`, { extensionId, token, body, ...extra });
  const pair = async () => {
    const { code } = service.beginPairing();
    const result = await call("pair", { code });
    assert.equal(result.status, 200);
    token = result.data.token;
    return token;
  };
  return {
    service,
    call,
    pair,
    events,
    advance(ms) {
      time += ms;
    },
    lock() {
      locked = true;
      for (const listener of listeners) listener();
    },
  };
}

test("Web 插件配对一次有效、来源和令牌绑定；锁库清理所有授权", async (t) => {
  const f = rig(t);
  assert.equal((await f.call("status")).status, 401);
  const code = f.service.beginPairing().code;
  assert.equal((await f.call("pair", { code }, { extensionId: "not-extension" })).status, 403);
  const result = await f.call("pair", { code });
  assert.equal(result.status, 200);
  assert.equal((await f.call("pair", { code })).status, 401);
  await f.pair();
  assert.equal((await f.call("status")).status, 200);
  assert.equal((await f.call("status", {}, { extensionId: "b".repeat(32) })).status, 401);
  f.lock();
  assert.equal(f.service.status().pairedClients, 0);
  assert.equal((await f.call("status")).status, 423);
});

test("Web 插件只返回展示字段；选票限制站点、账号、时限且使用一次", async (t) => {
  const f = rig(t);
  await f.pair();
  const listing = await f.call("accounts/list", {
    url: "https://example.test/private?token=private",
  });
  assert.equal(JSON.stringify(listing).includes("must-not-leak"), false);
  const ticket = listing.data.selectionToken;
  assert.equal(
    (
      await f.call("accounts/fill", {
        url: "https://other.test",
        id: "one",
        selectionToken: ticket,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call("accounts/fill", {
        url: "https://example.test",
        id: "other",
        selectionToken: ticket,
      })
    ).status,
    403,
  );
  const fill = { url: "https://example.test", id: "one", selectionToken: ticket };
  assert.equal((await f.call("accounts/fill", fill)).data.password, "synthetic-secret");
  assert.equal((await f.call("accounts/fill", fill)).status, 403);
  const expiring = await f.call("accounts/list", { url: "https://example.test" });
  f.advance(120001);
  assert.equal(
    (await f.call("accounts/fill", { ...fill, selectionToken: expiring.data.selectionToken }))
      .status,
    403,
  );
  assert.equal((await f.call("accounts/list", { url: "http://public.example.test" })).status, 400);
});

test("Web 插件异步读取时锁库或重新配对不能返回旧凭据", async (t) => {
  let release, started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const f = rig(t, {
    accounts: {
      getForOrigin: async () => {
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
        return { username: "sample", password: "must-not-leak" };
      },
    },
  });
  await f.pair();
  const list = await f.call("accounts/list", { url: "https://example.test" });
  const request = f.call("accounts/fill", {
    url: "https://example.test",
    id: "one",
    selectionToken: list.data.selectionToken,
  });
  await waiting;
  await f.pair();
  release();
  const rejected = await request;
  assert.equal(rejected.status, 401);
  assert.equal(JSON.stringify(rejected).includes("must-not-leak"), false);
});

test("Web 插件待确认密码限时、领取一次；公开文档有大小与字段约束", async (t) => {
  const f = rig(t);
  await f.pair();
  const capture = {
    url: "https://example.test/login?token=secret",
    title: "Example",
    username: "sample",
    password: "synthetic-password",
  };
  const saved = await f.call("captures", capture);
  assert.equal(saved.status, 201);
  assert.equal(JSON.stringify(f.service.list()).includes("synthetic-password"), false);
  assert.equal(f.service.take(saved.data.id).password, "synthetic-password");
  assert.throws(() => f.service.take(saved.data.id), /过期|处理/);
  await f.call("captures", capture);
  f.advance(300001);
  assert.deepEqual(f.service.list(), []);
  const code = f.service.beginPairing().code;
  f.advance(300001);
  assert.equal((await f.call("pair", { code })).status, 401);
  assert.equal(
    (
      await f.call("documents", {
        url: "https://docs.example.test",
        title: "Sample",
        text: "公开正文",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await f.call("documents", {
        url: "https://docs.example.test",
        title: "Sample",
        text: "x".repeat(200001),
      })
    ).status,
    400,
  );
});
