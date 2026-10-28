import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../selfhost/server.mjs";
import { SyncClient } from "../electron/services/sync-client.mjs";
import { DocumentsStore } from "../electron/services/documents.mjs";
import { Vault } from "../electron/services/vault.mjs";
import {
  b64u,
  importIdentity,
  sessionClientFinish,
  sessionClientStart,
  unb64u,
} from "../electron/services/sync-crypto.mjs";

const quiet = { log() {}, error() {} };
const secureStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "os_crypt",
  encryptString: (text) => Buffer.from([...text].reverse().join("")),
  decryptString: (buffer) => [...buffer.toString()].reverse().join(""),
};
const owner = { username: "song", password: "home-and-office-2026" };
const server = (id, name, extra = {}) => ({
  id,
  name,
  label: "",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  os: "Linux",
  region: "Tokyo",
  cpu: 0,
  memory: 0,
  disk: 0,
  uptime: "",
  lastSeen: "",
  notes: "",
  tags: [],
  status: "online",
  ...extra,
});
const markdown = (id, title, text, extra = {}) => ({
  id,
  title,
  markdown: text,
  bindings: [],
  ...extra,
});

/** 起一个真实的网页版服务器（可在同一目录上重启）和一个带内存适配器的桌面客户端。 */
async function rig(t, { vault = false, syncLimits } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-sync-web-"));
  const desktop = await mkdtemp(join(tmpdir(), "zhiyu-sync-desktop-"));
  const staticDir = await mkdtemp(join(tmpdir(), "zhiyu-sync-static-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html>");
  let web;
  let base;
  let port = 0;
  let cookie = "";
  const boot = async () => {
    web = await createWebServer({
      root,
      staticDir,
      log: quiet,
      schedulePush: false,
      sampleHost: false,
      syncLimits,
    });
    await new Promise((resolve) => web.server.listen(port, "127.0.0.1", resolve));
    port = web.server.address().port;
    base = `http://127.0.0.1:${port}`;
  };
  await boot();
  t.after(async () => {
    web.server.close();
    for (const dir of [root, desktop, staticDir]) await rm(dir, { recursive: true, force: true });
  });
  const call = async (path, { method = "GET", body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { "content-type": "application/json", "x-zhiyu": "1" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return res;
  };
  await call("/api/web/setup", { method: "POST", body: { ...owner, token: web.setupToken } });

  const local = { state: { servers: [], domains: [] }, mtimeMs: 1 };
  const documents = new DocumentsStore(join(desktop, "documents"));
  const vaultFile = new Vault(join(desktop, "vault.enc"));
  if (vault) await vaultFile.create("master-password-2026");
  const requests = [];
  const client = new SyncClient({
    directory: join(desktop, "sync"),
    secureStorage,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return fetch(url, init);
    },
    adapters: {
      assets: {
        read: async () => ({ state: structuredClone(local.state), mtimeMs: local.mtimeMs }),
        apply: async (fn) => {
          local.state = fn(structuredClone(local.state));
          local.mtimeMs = Date.now();
        },
      },
      documents,
      vault: vaultFile,
    },
  });
  const newCode = async () =>
    (await (await call("/api/web/sync/pairing", { method: "POST" })).json()).code;
  const pair = async () => client.pair({ url: base, code: await newCode(), name: "我的桌面" });
  const serverAssets = async () =>
    JSON.parse(await readFile(join(root, "workspace", "assets.json"), "utf8").catch(() => "null"));
  /** 模拟浏览器保存资料（网页版自己的编辑路径，带修订号）。 */
  const webSaveAssets = async (mutate) => {
    const current = await (await call("/api/web/store")).json();
    const state = structuredClone(current.data?.state ?? {});
    mutate(state);
    const res = await call("/api/web/store", {
      method: "PUT",
      body: { revision: current.revision, data: { state, version: 0 } },
    });
    assert.equal(res.status, 200);
  };
  return {
    get web() {
      return web;
    },
    root,
    desktop,
    local,
    documents,
    vault: vaultFile,
    client,
    call,
    requests,
    newCode,
    pair,
    serverAssets,
    webSaveAssets,
    base: () => base,
    restart: async () => {
      web.server.closeAllConnections();
      await new Promise((resolve) => web.server.close(resolve));
      await boot();
    },
  };
}

test("配对：错误的码被拒绝并计数，3 次后作废；正确的码只能用一次", async (t) => {
  const r = await rig(t);
  const code = await r.newCode();
  const wrong = code.startsWith("0") ? "1" + code.slice(1) : "0" + code.slice(1);
  for (let i = 0; i < 2; i += 1)
    await assert.rejects(r.client.pair({ url: r.base(), code: wrong, name: "x" }), /配对码不正确/);
  assert.equal((await r.client.status()).paired, false);
  await assert.rejects(r.client.pair({ url: r.base(), code: wrong, name: "x" }), /配对码不正确/);
  // 第 3 次失败后这个码已经作废，哪怕现在输对也不行。
  await assert.rejects(r.client.pair({ url: r.base(), code, name: "x" }), /没有可用的配对码/);

  const fresh = await r.newCode();
  const status = await r.client.pair({ url: r.base(), code: fresh, name: "我的桌面" });
  assert.equal(status.paired, true);
  const info = await (await r.call("/api/web/sync")).json();
  assert.equal(info.fingerprint, status.server.fingerprint, "两边显示同一个服务器指纹");
  assert.equal(info.devices.length, 1);
  assert.equal(info.devices[0].name, "我的桌面");
  assert.equal(info.pairing, null, "配对成功后码立即作废");
  const reuse = await rig(t);
  await assert.rejects(
    reuse.client.pair({ url: reuse.base(), code: fresh, name: "x" }),
    /没有可用的配对码/,
  );
});

test("配对码格式不对或没有生成配对码时，不会向服务器泄露任何东西", async (t) => {
  const r = await rig(t);
  await assert.rejects(
    r.client.pair({ url: r.base(), code: "ABC", name: "x" }),
    /没有可用的配对码/,
  );
  await r.newCode();
  await assert.rejects(r.client.pair({ url: r.base(), code: "ABC", name: "x" }), /格式不正确/);
  await assert.rejects(r.client.pair({ url: "ftp://x", code: "ABCDE-FGHJK", name: "x" }), /http/);
  await assert.rejects(
    r.client.pair({ url: "https://u:p@example.com", code: "ABCDE-FGHJK", name: "x" }),
    /用户名/,
  );
});

test("首次同步：桌面的资产与文档推到网页版，再由网页版的改动拉回桌面", async (t) => {
  const r = await rig(t);
  await r.pair();
  r.local.state = { servers: [server("s1", "东京主机")], domains: [] };
  await r.documents.save(markdown("doc-1", "部署笔记", "# 部署\n\n步骤一"));
  const first = await r.client.syncNow();
  assert.equal(first.lastResult.ok, true);
  const onServer = await r.serverAssets();
  assert.deepEqual(
    onServer.state.servers.map((s) => s.name),
    ["东京主机"],
  );
  const docs = await (await r.call("/api/web/documents")).json();
  assert.deepEqual(
    docs.map((d) => d.title),
    ["部署笔记"],
  );

  await r.webSaveAssets((state) => state.servers.push(server("s2", "网页新增")));
  await r.client.syncNow();
  assert.deepEqual(r.local.state.servers.map((s) => s.id).sort(), ["s1", "s2"]);

  // 稳定后再同步一次应当什么都不做。
  const quietRound = await r.client.syncNow();
  assert.equal(
    quietRound.lastResult.pulled + quietRound.lastResult.pushed + quietRound.lastResult.merged,
    0,
  );
});

test("两边同时改动：不同记录与字段合并，同一字段取较新的一边，删除不覆盖修改", async (t) => {
  const r = await rig(t);
  await r.pair();
  r.local.state = {
    servers: [server("s1", "A", { region: "东京" }), server("s2", "B"), server("s3", "C")],
    domains: [],
  };
  await r.client.syncNow();

  // 桌面：改 s1 的地区、删 s2、改 s3 的名字；网页：改 s1 的备注、改 s2 的名字、删 s3。
  r.local.state = {
    servers: [server("s1", "A", { region: "大阪" }), server("s3", "C桌面改")],
    domains: [],
  };
  r.local.mtimeMs = Date.now() - 60_000; // 网页版的改动更新
  await r.webSaveAssets((state) => {
    state.servers = [
      server("s1", "A", { region: "东京", notes: "网页备注" }),
      server("s2", "B网页改"),
    ];
  });
  const result = await r.client.syncNow();
  assert.equal(result.lastResult.ok, true);
  const byId = Object.fromEntries(r.local.state.servers.map((s) => [s.id, s]));
  assert.equal(byId.s1.region, "大阪", "桌面改的字段");
  assert.equal(byId.s1.notes, "网页备注", "网页改的字段");
  assert.equal(byId.s2.name, "B网页改", "桌面删除、网页修改：保留修改");
  assert.equal(byId.s3.name, "C桌面改", "网页删除、桌面修改：保留修改");
  const onServer = await r.serverAssets();
  assert.deepEqual(
    onServer.state.servers.map((s) => s.id).sort(),
    ["s1", "s2", "s3"],
    "合并结果也写回了网页版",
  );
  assert.deepEqual(result.lastResult.warnings, []);
});

test("同一字段两边都改：保留较新的一边并在结果里提示", async (t) => {
  const r = await rig(t);
  await r.pair();
  r.local.state = { servers: [server("s1", "原名")], domains: [] };
  await r.client.syncNow();
  r.local.state = { servers: [server("s1", "桌面名")], domains: [] };
  r.local.mtimeMs = Date.now() + 60_000; // 桌面更新
  await r.webSaveAssets((state) => (state.servers = [server("s1", "网页名")]));
  const result = await r.client.syncNow();
  assert.equal(r.local.state.servers[0].name, "桌面名");
  assert.equal((await r.serverAssets()).state.servers[0].name, "桌面名");
  assert.match(result.lastResult.warnings[0], /servers\.s1\.name.*桌面版/);
});

test("文档：单边修改与删除会传播，两边都改时另存冲突副本且不丢内容", async (t) => {
  const r = await rig(t);
  await r.pair();
  await r.documents.save(markdown("doc-a", "文档 A", "原文 A"));
  await r.documents.save(markdown("doc-b", "文档 B", "原文 B"));
  await r.client.syncNow();

  await r.documents.save(markdown("doc-a", "文档 A", "桌面改过的 A"));
  await r.documents.remove("doc-b");
  await r.client.syncNow();
  const onWeb = await (await r.call("/api/web/documents/doc-a")).json();
  assert.match(onWeb.markdown, /桌面改过的 A/);
  assert.equal((await r.call("/api/web/documents/doc-b")).status, 500, "网页版里 doc-b 也被删除");

  // 两边同时改 doc-a。
  await r.documents.save(markdown("doc-a", "文档 A", "桌面版第二次修改"));
  await r.call("/api/web/documents/doc-a", {
    method: "PUT",
    body: { ...markdown("doc-a", "文档 A", "网页版第二次修改") },
  });
  const result = await r.client.syncNow();
  const titles = (await r.documents.list()).map((d) => d.title).sort();
  assert.equal(titles.length, 2, "原文和一份冲突副本");
  assert.ok(titles.some((title) => title.endsWith("（冲突副本）")));
  const all = await Promise.all((await r.documents.list()).map((d) => r.documents.get(d.id)));
  const texts = all.map((d) => d.markdown ?? JSON.stringify(d.content)).join("\n");
  assert.match(texts, /桌面版第二次修改/);
  assert.match(texts, /网页版第二次修改/);
  assert.ok(result.lastResult.warnings.some((w) => /冲突副本/.test(w)));
  const webDocs = await (await r.call("/api/web/documents")).json();
  assert.equal(webDocs.length, 2, "两边的文档一致");
});

test("密钥库同步默认关闭；开启后只同步密文，网页版那边新增的记录可在桌面用同一个主密码读出", async (t) => {
  const r = await rig(t, { vault: true });
  await r.pair();
  await r.vault.unlock("master-password-2026");
  await r.vault.set("account:site", { u: "me", p: "pw-desktop" });
  await r.client.syncNow();
  assert.equal(
    await readFile(join(r.root, "workspace", "vault.enc")).catch(() => null),
    null,
    "默认不同步密钥库",
  );

  await r.client.setScope({ vault: true });
  await r.client.syncNow();
  const serverVault = JSON.parse(await readFile(join(r.root, "workspace", "vault.enc"), "utf8"));
  assert.equal(Object.keys(serverVault.records).length, 1);
  assert.ok(!JSON.stringify(serverVault).includes("pw-desktop"), "服务器上没有明文");

  // 浏览器端用同一个主密码新增一条（这里用另一个 Vault 实例代替）。
  const webCopy = join(r.root, "web-vault-copy.enc");
  await cp(join(r.root, "workspace", "vault.enc"), webCopy);
  const webVault = new Vault(webCopy);
  await webVault.unlock("master-password-2026");
  await webVault.set("account:web", { u: "web", p: "pw-web" });
  const current = await (await r.call("/api/web/vault")).json();
  const put = await r.call("/api/web/vault", {
    method: "PUT",
    body: { revision: current.revision, doc: JSON.parse(await readFile(webCopy, "utf8")) },
  });
  assert.equal(put.status, 200);

  await r.vault.set("account:desktop", { u: "d", p: "pw-d2" });
  await r.client.syncNow();
  assert.deepEqual((await r.vault.list()).sort(), [
    "account:desktop",
    "account:site",
    "account:web",
  ]);
  assert.deepEqual(await r.vault.get("account:web"), { u: "web", p: "pw-web" });
  const merged = JSON.parse(await readFile(join(r.root, "workspace", "vault.enc"), "utf8"));
  assert.equal(Object.keys(merged.records).length, 3);
});

test("两边主密码不同的密钥库不会自动覆盖，需要用户选择以哪一边为准", async (t) => {
  const r = await rig(t, { vault: true });
  await r.pair();
  // 网页版先有一份用另一个主密码创建的密钥库。
  const other = new Vault(join(r.root, "workspace", "vault.enc"));
  await other.create("another-master-password");
  await r.client.setScope({ vault: true, assets: false, documents: false });
  const result = await r.client.syncNow();
  assert.equal(result.attention.kind, "vault-conflict");
  const before = JSON.parse(await readFile(join(r.root, "workspace", "vault.enc"), "utf8"));
  const desktopBefore = JSON.parse(await readFile(join(r.desktop, "vault.enc"), "utf8"));
  assert.notEqual(before.salt, desktopBefore.salt, "两边都没有被改动");
  const resolved = await r.client.resolveVault("local");
  assert.equal(resolved.attention, null);
  const after = JSON.parse(await readFile(join(r.root, "workspace", "vault.enc"), "utf8"));
  assert.equal(after.salt, desktopBefore.salt);
});

test("撤销设备后立即无法同步，并提示重新配对", async (t) => {
  const r = await rig(t);
  await r.pair();
  await r.client.syncNow();
  const info = await (await r.call("/api/web/sync")).json();
  assert.equal(
    (await r.call("/api/web/sync/revoke", { method: "POST", body: { id: info.devices[0].id } }))
      .status,
    200,
  );
  await assert.rejects(r.client.syncNow(), /撤销|没有配对/);
  const status = await r.client.status();
  assert.equal(status.attention.kind, "revoked");
  assert.equal(status.lastResult.ok, false);
});

test("主动解除配对：服务器上的设备被移除，本机状态清空，可以重新配对", async (t) => {
  const r = await rig(t);
  await r.pair();
  await r.client.unpair();
  assert.equal((await r.client.status()).paired, false);
  assert.equal((await (await r.call("/api/web/sync")).json()).devices.length, 0);
  assert.equal((await r.pair()).paired, true);
});

test("服务器被恢复成旧状态（序号倒退）时拒绝同步，确认后才重新对照且不删除任何数据", async (t) => {
  const r = await rig(t);
  await r.pair();
  r.local.state = { servers: [server("s1", "A")], domains: [] };
  await r.client.syncNow();
  await r.webSaveAssets((state) => state.servers.push(server("s2", "B")));
  await r.client.syncNow();

  // 把服务器的序号记录改回很早的状态，等同于恢复了旧备份。
  const stateFile = join(r.root, "server", "sync-state.json");
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.ok(saved.seq >= 2);
  await writeFile(stateFile, JSON.stringify({ ...saved, seq: 1, digest: "" }));
  await r.restart();
  await assert.rejects(r.client.syncNow(), /更旧|分叉/);
  const blocked = await r.client.status();
  assert.equal(blocked.attention.kind, "rollback");
  // 被拒绝时本机资料原样保留。
  assert.deepEqual(r.local.state.servers.map((s) => s.id).sort(), ["s1", "s2"]);

  const accepted = await r.client.acceptServerState();
  assert.equal(accepted.attention, null);
  assert.deepEqual(r.local.state.servers.map((s) => s.id).sort(), ["s1", "s2"]);
});

test("服务器身份变了（重装或被冒充）时桌面端拒绝连接", async (t) => {
  const r = await rig(t);
  await r.pair();
  await r.client.syncNow();
  await rm(join(r.root, "server", "sync-identity.json"));
  await r.restart();
  await assert.rejects(r.client.syncNow(), /身份.*不一致/);
});

test("会话消息被重放时服务器拒绝并销毁会话", async (t) => {
  const r = await rig(t);
  await r.pair();
  await r.client.syncNow();
  const messages = r.requests.filter((entry) => entry.url.endsWith("/api/sync/session/message"));
  assert.ok(messages.length > 2);
  const replay = await fetch(messages[1].url, messages[1].init);
  assert.equal(replay.status, 400);
  assert.equal(r.web.sync.sessionCount, 0, "出错的会话已销毁");
});

async function rawSession(r) {
  const state = JSON.parse(await readFile(join(r.desktop, "sync", "sync.json"), "utf8"));
  const identity = importIdentity(
    Buffer.from(secureStorage.decryptString(Buffer.from(state.device.key, "base64")), "base64"),
  );
  const post = async (path, body) => {
    const res = await fetch(state.server.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zhiyu": "1" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const start = sessionClientStart(state.device.id);
  const reply = (await post("/api/sync/session/start", start.message)).body;
  const { channel, auth } = sessionClientFinish({
    start,
    reply,
    serverPublicKey: unb64u(state.server.publicKey, 32),
    deviceIdentity: identity,
  });
  await post("/api/sync/session/auth", {
    sid: reply.sid,
    counter: auth.counter,
    data: b64u(auth.data),
  });
  return async (request) => {
    const sealed = channel.seal(Buffer.from(JSON.stringify(request)));
    const response = await post("/api/sync/session/message", {
      sid: reply.sid,
      counter: sealed.counter,
      data: b64u(sealed.data),
    });
    return JSON.parse(channel.open(response.body.counter, unb64u(response.body.data)).toString());
  };
}

test("已配对设备也只能读写同步范围内的文件，凭据文件与越界路径一律拒绝", async (t) => {
  const r = await rig(t);
  await r.pair();
  await writeFile(
    join(r.root, "workspace", "integrations.json"),
    JSON.stringify({ secret: "token" }),
  );
  const call = await rawSession(r);
  for (const path of [
    "integrations.json",
    "agent-config.json",
    "../server/account.json",
    "documents/../assets.json",
    "documents/x.json",
    "image-bed.json",
  ]) {
    const result = await call({ op: "read", path });
    assert.equal(result.ok, false, path);
    assert.equal(result.code, "path", path);
  }
  assert.equal(
    (await call({ op: "writeBegin", path: "integrations.json", size: 1, sha: "x" })).ok,
    false,
  );
  assert.equal((await call({ op: "remove", path: "assets.json", expect: null })).ok, false);
  assert.equal((await call({ op: "nope" })).ok, false);
  const ok = await call({ op: "manifest" });
  assert.equal(ok.ok, true);
  assert.ok(!Object.keys(ok.files).includes("integrations.json"));
});

test("写入前检查期望哈希：网页版在此期间改过时拒绝覆盖", async (t) => {
  const r = await rig(t);
  await r.pair();
  r.local.state = { servers: [server("s1", "A")], domains: [] };
  await r.client.syncNow();
  const call = await rawSession(r);
  const body = Buffer.from(JSON.stringify({ state: { servers: [] }, version: 0 }));
  const { createHash } = await import("node:crypto");
  await call({
    op: "writeBegin",
    path: "assets.json",
    expect: "stale-hash",
    size: body.length,
    sha: createHash("sha256").update(body).digest("hex"),
  });
  await call({ op: "writeChunk", data: b64u(body) });
  const commit = await call({ op: "writeCommit" });
  assert.equal(commit.ok, false);
  assert.equal(commit.code, "conflict");
  assert.equal((await r.serverAssets()).state.servers.length, 1, "服务器上的资料没有被覆盖");
  // 校验和不符同样被拒绝。
  await call({
    op: "writeBegin",
    path: "assets.json",
    expect: null,
    size: body.length,
    sha: "0".repeat(64),
  });
  await call({ op: "writeChunk", data: b64u(body) });
  assert.equal((await call({ op: "writeCommit" })).code, "checksum");
});

test("配对时中间人篡改服务器回包：桌面端放弃，不会固定任何公钥", async (t) => {
  const r = await rig(t);
  const code = await r.newCode();
  const tampering = new SyncClient({
    directory: join(r.desktop, "sync-mitm"),
    secureStorage,
    adapters: {},
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (!url.endsWith("/api/sync/pair/finish")) return response;
      const data = await response.json();
      const bytes = unb64u(data.data);
      bytes[0] ^= 1;
      return new Response(JSON.stringify({ ...data, data: b64u(bytes) }), {
        status: response.status,
      });
    },
  });
  await assert.rejects(tampering.pair({ url: r.base(), code, name: "x" }), /服务器身份无法验证/);
  assert.equal((await tampering.status()).paired, false);
});

test("不断发起密钥交换来猜配对码：超过次数上限后配对码作废，连正确的码也用不了", async (t) => {
  const r = await rig(t, { syncLimits: { pairSessions: 100 } });
  const code = await r.newCode();
  const { pairInitiate } = await import("../electron/services/sync-crypto.mjs");
  const post = async (path, body) => {
    const res = await fetch(r.base() + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zhiyu": "1" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  let exhausted = null;
  for (let i = 0; i < 12 && !exhausted; i += 1) {
    const start = await post("/api/sync/pair/start", {});
    if (start.status !== 200) {
      exhausted = start;
      break;
    }
    const guess = pairInitiate(
      "0123456789".slice(0, 10).replace(/./g, () => "7"),
      unb64u(start.body.sid, 16),
    );
    const exchange = await post("/api/sync/pair/exchange", {
      sid: start.body.sid,
      Ya: b64u(guess.Ya),
    });
    if (exchange.status === 403) exhausted = exchange;
  }
  assert.ok(exhausted, "达到上限后被拒绝");
  await assert.rejects(r.client.pair({ url: r.base(), code, name: "x" }), /没有可用的配对码/);
});
