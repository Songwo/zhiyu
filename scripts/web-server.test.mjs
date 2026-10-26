import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../selfhost/server.mjs";
import { createBackup } from "../electron/services/backup.mjs";

const quiet = { log() {}, error() {} };

async function rig(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-web-"));
  const staticDir = await mkdtemp(join(tmpdir(), "zhiyu-web-static-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>知屿</title>");
  const web = await createWebServer({ root, staticDir, log: quiet, ...options });
  await new Promise((r) => web.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${web.server.address().port}`;
  t.after(async () => {
    web.server.close();
    await rm(root, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  });
  let cookie = "";
  const call = async (path, { method = "GET", body, headers = {}, raw = false } = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { "content-type": "application/json", "x-zhiyu": "1" }),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return res;
  };
  return { web, root, base, call, setCookie: (v) => (cookie = v), getCookie: () => cookie };
}

const account = { username: "song", password: "home-and-office-2026" };

test("首次设置：需要服务器日志里的设置口令，创建后口令失效", async (t) => {
  const { web, call } = await rig(t);
  assert.equal((await (await call("/api/web/state")).json()).setup, true);
  const token = web.setupToken;
  assert.match(token, /^[a-f0-9]{24}$/);
  assert.equal(
    (await call("/api/web/setup", { method: "POST", body: { ...account, token: "wrong" } })).status,
    403,
  );
  assert.equal(
    (
      await call("/api/web/setup", {
        method: "POST",
        body: { ...account, token, password: "short" },
      })
    ).status,
    400,
  );
  const ok = await call("/api/web/setup", { method: "POST", body: { ...account, token } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal(
    (await call("/api/web/setup", { method: "POST", body: { ...account, token } })).status,
    409,
  );
  assert.equal(web.setupToken, undefined);
});

test("整站需要登录；改动类请求必须带自定义头且同源", async (t) => {
  const { web, call, setCookie } = await rig(t);
  await call("/api/web/setup", { method: "POST", body: { ...account, token: web.setupToken } });
  const signedIn = (await call("/api/web/session")).status;
  assert.equal(signedIn, 200);
  assert.equal((await call("/", {})).status, 200);
  assert.match((await call("/")).headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(
    (
      await call("/api/web/store", {
        method: "PUT",
        body: { revision: null, data: {} },
        headers: { "x-zhiyu": "" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/api/web/store", {
        method: "PUT",
        body: { revision: null, data: {} },
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  setCookie("");
  assert.equal((await call("/api/web/session")).status, 401);
  const page = await call("/");
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login");
  assert.equal((await call("/api/web/documents")).status, 401);
});

test("登录：密码错误计数，超过次数后限制 15 分钟", async (t) => {
  const { web, call, setCookie } = await rig(t);
  await call("/api/web/setup", { method: "POST", body: { ...account, token: web.setupToken } });
  setCookie("");
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await call("/api/web/login", {
          method: "POST",
          body: { ...account, password: "wrong-password-x" },
        })
      ).status,
      401,
    );
  assert.equal((await call("/api/web/login", { method: "POST", body: account })).status, 429);
});

test("资料：带版本号保存，别的设备先写过时返回冲突", async (t) => {
  const { web, call } = await rig(t);
  await call("/api/web/setup", { method: "POST", body: { ...account, token: web.setupToken } });
  const empty = await (await call("/api/web/store")).json();
  assert.deepEqual(empty, { revision: null, data: null });
  const data = {
    state: {
      servers: [],
      domains: [],
      mailboxes: [],
      aiAssets: [],
      secrets: [],
      certs: [],
      reminders: [
        { id: "r1", title: "宽带续费", note: "", dueAt: "2026-11-01", repeat: "year", leadDays: 7 },
      ],
    },
    version: 0,
  };
  const first = await (
    await call("/api/web/store", { method: "PUT", body: { revision: null, data } })
  ).json();
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(
    (await call("/api/web/store", { method: "PUT", body: { revision: null, data } })).status,
    409,
  );
  const loaded = await (await call("/api/web/store")).json();
  assert.equal(loaded.revision, first.revision);
  assert.equal(loaded.data.state.reminders[0].title, "宽带续费");
  const bad = await call("/api/web/store", {
    method: "PUT",
    body: { revision: first.revision, data: { state: { reminders: [{ id: "x" }] } } },
  });
  assert.equal(bad.status, 400);
});

test("文档与密钥库密文：文档增删改查，密钥库只校验格式", async (t) => {
  const { web, call } = await rig(t);
  await call("/api/web/setup", { method: "POST", body: { ...account, token: web.setupToken } });
  const now = new Date().toISOString();
  const doc = {
    id: "doc-web-1",
    title: "部署记录",
    markdown: "# 部署\n\n步骤",
    bindings: [],
    createdAt: now,
    updatedAt: now,
  };
  const saved = await (
    await call("/api/web/documents/doc-web-1", { method: "PUT", body: doc })
  ).json();
  assert.equal(saved.title, "部署记录");
  assert.equal((await (await call("/api/web/documents")).json()).length, 1);
  assert.equal((await (await call("/api/web/documents/doc-web-1")).json()).id, "doc-web-1");
  assert.equal(
    (await call("/api/web/documents/doc-web-1", { method: "DELETE", body: {} })).status,
    200,
  );
  assert.equal((await (await call("/api/web/documents")).json()).length, 0);
  assert.equal((await call("/api/web/documents/..%2Fescape", {})).status, 400);

  const sealed = { iv: "AAAA", tag: "AAAA", data: "AAAA" };
  const vault = {
    v: 2,
    salt: "c2FsdA==",
    kdf: { N: 2 ** 17, r: 8, p: 1 },
    check: sealed,
    records: { "account:x": sealed },
  };
  assert.equal(
    (
      await call("/api/web/vault", {
        method: "PUT",
        body: { revision: null, doc: { ...vault, records: [] } },
      })
    ).status,
    400,
  );
  const put = await (
    await call("/api/web/vault", { method: "PUT", body: { revision: null, doc: vault } })
  ).json();
  assert.equal(
    (await call("/api/web/vault", { method: "PUT", body: { revision: null, doc: vault } })).status,
    409,
  );
  const got = await (await call("/api/web/vault")).json();
  assert.equal(got.revision, put.revision);
  assert.deepEqual(got.doc.records["account:x"], sealed);
});

test("备份与恢复：下载的备份能恢复，桌面版备份也能直接恢复；登录账号不受影响", async (t) => {
  const { web, root, call } = await rig(t);
  await call("/api/web/setup", { method: "POST", body: { ...account, token: web.setupToken } });
  const data = {
    state: {
      servers: [],
      domains: [],
      mailboxes: [],
      aiAssets: [],
      secrets: [],
      certs: [],
      reminders: [],
    },
    version: 0,
  };
  await call("/api/web/store", { method: "PUT", body: { revision: null, data } });
  const download = await call("/api/web/backup", {
    method: "POST",
    body: { password: "backup-pass-123" },
  });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /zhiyu-web-\d{8}-\d{6}\.zhiyu-backup/);
  assert.ok((await download.arrayBuffer()).byteLength > 100);

  // 模拟桌面版：另一个资料目录做出的备份
  const desktopRoot = await mkdtemp(join(tmpdir(), "zhiyu-desktop-"));
  t.after(() => rm(desktopRoot, { recursive: true, force: true }));
  await writeFile(
    join(desktopRoot, "assets.json"),
    JSON.stringify({
      state: {
        ...data.state,
        reminders: [
          {
            id: "r9",
            title: "车险续保",
            note: "",
            dueAt: "2026-12-01",
            repeat: "year",
            leadDays: 14,
          },
        ],
      },
      version: 0,
    }),
  );
  const { data: backup } = await createBackup({ root: desktopRoot, password: "desktop-pass-123" });
  const header = (password) => ({
    "content-type": "application/octet-stream",
    "x-zhiyu-backup-password": Buffer.from(password).toString("base64"),
  });
  assert.equal(
    (
      await call("/api/web/restore", {
        method: "POST",
        raw: true,
        body: backup,
        headers: header("wrong-pass-123"),
      })
    ).status,
    400,
  );
  const restored = await call("/api/web/restore", {
    method: "POST",
    raw: true,
    body: backup,
    headers: header("desktop-pass-123"),
  });
  assert.equal(restored.status, 200);
  const after = await (await call("/api/web/store")).json();
  assert.equal(after.data.state.reminders[0].title, "车险续保");
  assert.ok(
    JSON.parse(await readFile(join(root, "server", "account.json"), "utf8")).username === "song",
  );
  assert.equal((await call("/api/web/session")).status, 200);
});

test("改登录密码：旧会话全部失效，只保留当前这一个", async (t) => {
  const { web, call, setCookie, getCookie } = await rig(t);
  await call("/api/web/setup", { method: "POST", body: { ...account, token: web.setupToken } });
  const first = getCookie();
  await call("/api/web/login", { method: "POST", body: account });
  const second = getCookie();
  assert.notEqual(first, second);
  assert.equal(
    (
      await call("/api/web/password", {
        method: "POST",
        body: { current: "nope-nope-nope", next: "x".repeat(12) },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/api/web/password", {
        method: "POST",
        body: { current: account.password, next: "a-brand-new-pass" },
      })
    ).status,
    200,
  );
  setCookie(first);
  assert.equal((await call("/api/web/session")).status, 401);
  setCookie(second);
  assert.equal((await call("/api/web/session")).status, 200);
});

test("提醒推送：服务器端保存渠道（不回传凭据），按天去重推送续费与备忘提醒", async (t) => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const { web, root, call } = await rig(t, { fetchImpl, schedulePush: false });
  assert.equal((await call("/api/web/push")).status, 401);
  await call("/api/web/setup", { method: "POST", body: { ...account, token: web.setupToken } });
  const empty = await (await call("/api/web/push")).json();
  assert.deepEqual(empty, {
    enabled: false,
    provider: "telegram",
    destination: "",
    hasToken: false,
    leadDays: 21,
  });
  const token = "123456789:" + "A".repeat(35);
  const bad = await call("/api/web/push", {
    method: "PUT",
    body: { enabled: true, provider: "telegram", destination: "", token, leadDays: 7 },
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /接收目标/);
  const saved = await (
    await call("/api/web/push", {
      method: "PUT",
      body: { enabled: true, provider: "telegram", destination: "42", token, leadDays: 7 },
    })
  ).json();
  assert.equal(saved.hasToken, true);
  assert.equal(JSON.stringify(saved).includes(token), false);
  const kept = await (
    await call("/api/web/push", {
      method: "PUT",
      body: { enabled: true, provider: "telegram", destination: "42", leadDays: 7 },
    })
  ).json();
  assert.equal(kept.hasToken, true);

  assert.equal((await call("/api/web/push/test", { method: "POST", body: {} })).status, 200);
  assert.match(sent.at(-1).url, /api\.telegram\.org\/bot123456789:/);
  assert.match(sent.at(-1).body.text, /测试/);

  const now = Date.parse("2026-10-20T09:00:00Z");
  const day = (offset) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
  await writeFile(
    join(root, "workspace", "assets.json"),
    JSON.stringify({
      state: {
        domains: [
          { id: "d1", name: "example.com", expiresAt: day(5) },
          { id: "d2", name: "later.com", expiresAt: day(40) },
        ],
        servers: [{ id: "s", name: "down", status: "offline", probeError: "timeout" }],
        reminders: [{ id: "r", title: "宽带续费", dueAt: day(2), repeat: "none", leadDays: 3 }],
      },
      version: 0,
    }),
  );
  sent.length = 0;
  assert.deepEqual(await web.push.tick(now), { sent: 2 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /example\.com: 5 天后到期/);
  assert.match(sent[0].body.text, /宽带续费/);
  assert.doesNotMatch(sent[0].body.text, /later\.com|down/);
  assert.deepEqual(await web.push.tick(now + 3_600_000), { sent: 0 });
  assert.equal(sent.length, 1);
  assert.equal((await web.push.tick(now + 86_400_000)).sent, 2);
  const stored = await readFile(join(root, "server", "push.json"), "utf8");
  assert.match(stored, /123456789:/);
});
