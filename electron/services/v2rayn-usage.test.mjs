import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { V2raynUsage, discoverV2raynDirectories } from "./v2rayn-usage.mjs";

const NOW = new Date(2026, 9, 10, 15).getTime();
const TICKS = 621355968000000000n + BigInt(Date.UTC(2026, 9, 10)) * 10000n;

test("默认发现脚本由应用读取后编码执行，不要求 PowerShell 访问 ASAR 内路径", async () => {
  const bundledScript = "\uFEFF# 中文脚本\nConvertTo-Json -InputObject @() -Compress\n";
  let read = false,
    invoked = false;
  const discovered = await discoverV2raynDirectories({
    platform: "win32",
    readFile: async (path, encoding) => {
      assert.match(path, /v2rayn-discover\.ps1$/);
      assert.equal(encoding, "utf8");
      read = true;
      return bundledScript;
    },
    execFile: async (executable, args, options) => {
      assert.equal(read, true);
      assert.equal(executable, "powershell.exe");
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      assert.equal(args.length, 4);
      assert.equal(Buffer.from(args[3], "base64").toString("utf16le"), bundledScript.slice(1));
      assert.equal(args.includes("-File"), false);
      assert.equal(args.includes("-ExecutionPolicy"), false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 6000);
      assert.equal(options.maxBuffer, 128 * 1024);
      invoked = true;
      return { stdout: "[]" };
    },
  });
  assert.equal(invoked, true);
  assert.deepEqual(discovered, []);
});
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "v2rayn-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "guiConfigs"));
  await mkdir(join(root, "binConfigs"));
  const file = join(root, "guiConfigs", "guiNDB.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ProfileItem (IndexId TEXT PRIMARY KEY, Subid TEXT, Remarks TEXT, Address TEXT, Port INTEGER, ConfigType INTEGER, CoreType INTEGER, Id TEXT, Password TEXT);
    CREATE TABLE SubItem (Id TEXT PRIMARY KEY, Remarks TEXT, Enabled INTEGER, Url TEXT);
    CREATE TABLE ServerStatItem (IndexId TEXT PRIMARY KEY, TotalUp INTEGER, TotalDown INTEGER, TodayUp INTEGER, TodayDown INTEGER, DateNow INTEGER);`);
  db.prepare("INSERT INTO SubItem VALUES (?,?,?,?)").run(
    "sub1",
    "演示机场",
    1,
    "PRIVATE_SUBSCRIPTION_URL",
  );
  const insert = db.prepare("INSERT INTO ProfileItem VALUES (?,?,?,?,?,?,?,?,?)");
  insert.run(
    "node-a",
    "sub1",
    "合成节点 A",
    "a.example.test",
    443,
    5,
    1,
    "PRIVATE_OLD_PASSWORD",
    "PRIVATE_PASSWORD",
  );
  insert.run(
    "node-b",
    "sub1",
    "合成节点 B",
    "b.example.test",
    8443,
    5,
    1,
    "PRIVATE_OLD_PASSWORD",
    "PRIVATE_PASSWORD",
  );
  db.prepare("INSERT INTO ServerStatItem VALUES (?,?,?,?,?,?)").run(
    "node-a",
    1024,
    2048,
    100,
    200,
    TICKS,
  );
  db.close();
  const gui = {
    IndexId: "node-a",
    GuiItem: { EnableStatistics: true },
    WebDavItem: { Password: "PRIVATE_WEBDAV" },
  };
  const core = {
    metrics: { listen: "127.0.0.1:1" },
    policy: { system: { statsOutboundUplink: true, statsOutboundDownlink: true } },
    outbounds: [
      {
        tag: "proxy",
        protocol: "vless",
        settings: { address: "a.example.test", port: 443, id: "PRIVATE_UUID" },
      },
      { tag: "direct", protocol: "freedom", settings: {} },
    ],
  };
  const save = async () => {
    await writeFile(join(root, "guiConfigs", "guiNConfig.json"), JSON.stringify(gui));
    await writeFile(join(root, "binConfigs", "config.json"), JSON.stringify(core));
  };
  await save();
  let now = NOW,
    databaseReads = 0,
    discoveries = 0;
  const service = new V2raynUsage({
    configFile: join(root, "selected.json"),
    discoverDirectories: async () => {
      discoveries++;
      return [root];
    },
    now: () => now,
    requestTimeoutMs: 100,
    openDatabase: (path) => {
      databaseReads++;
      return new DatabaseSync(path, { readOnly: true });
    },
    ...options,
  });
  return {
    root,
    file,
    gui,
    core,
    save,
    service,
    advance: (ms) => {
      now += ms;
    },
    reads: () => databaseReads,
    discoveries: () => discoveries,
  };
}
async function metrics(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `127.0.0.1:${server.address().port}`;
}
const counters = (up, down, extra = {}) =>
  JSON.stringify({
    stats: { outbound: { proxy: { uplink: up, downlink: down }, ...extra } },
    cmdline: ["PRIVATE_CORE_ARGUMENT"],
  });

test("只读保存口径保留 KB、BigInt 日期、缺失值，不暴露订阅和密码", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.file);
  const state = await f.service.status();
  assert.equal(state.available, true);
  assert.equal(state.statisticsEnabled, true);
  assert.equal(state.nodes[0].savedUploadKb, 1024);
  assert.equal(state.nodes[0].savedDownloadKb, 2048);
  assert.equal(state.nodes[0].todayUploadKb, 100);
  assert.equal(state.nodes[0].statDate, "2026-10-10");
  assert.equal(state.nodes[0].protocol, "vless");
  assert.equal(state.nodes[1].savedUploadKb, null);
  assert.equal(JSON.stringify(state).includes("PRIVATE_"), false);
  assert.deepEqual(await readFile(f.file), original);
  f.advance(86400000);
  const next = await f.service.status();
  assert.equal(next.nodes[0].todayUploadKb, null);
  assert.equal(next.nodes[0].todayDownloadKb, null);
  assert.equal(next.nodes[0].savedUploadKb, 1024);
  assert.equal(f.reads(), 1);
});

test("缓存和并发合并避免重复扫描，未变数据库被独占锁时仍可读快照", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.service.status(), f.service.status(), f.service.status({ force: true })]);
  assert.equal(f.reads(), 1);
  const lock = new DatabaseSync(f.file);
  try {
    lock.exec("BEGIN EXCLUSIVE");
    f.advance(6000);
    assert.equal((await f.service.status()).available, true);
    assert.equal(f.reads(), 1);
    assert.equal(f.discoveries(), 1);
    lock.exec("ROLLBACK");
  } finally {
    lock.close();
  }
});

test("核心计数与监测增量独立；计数回退、切换节点重建基线", async (t) => {
  let up = 4000,
    down = 9000;
  const address = await metrics(t, (_req, res) => res.end(counters(up, down)));
  const f = await fixture(t);
  f.core.metrics.listen = address;
  await f.save();
  const first = await f.service.status();
  assert.equal(first.live.available, true);
  assert.equal(first.live.nodeId, "node-a");
  assert.equal(first.live.upload, 4000);
  assert.equal(first.live.observedUpload, 0);
  up += 120;
  down += 800;
  f.advance(6000);
  const second = await f.service.status();
  assert.equal(second.live.observedUpload, 120);
  assert.equal(second.live.observedDownload, 800);
  up = 30;
  down = 80;
  f.advance(6000);
  const reset = await f.service.status();
  assert.equal(reset.live.reset, true);
  assert.equal(reset.live.observedUpload, 0);
  f.gui.IndexId = "node-b";
  f.core.outbounds[0].settings.address = "b.example.test";
  f.core.outbounds[0].settings.port = 8443;
  await f.save();
  up += 10;
  down += 20;
  const switched = await f.service.status({ force: true });
  assert.equal(switched.live.nodeId, "node-b");
  assert.equal(switched.live.observedUpload, 0);
  assert.equal(switched.nodes[1].savedUploadKb, null);
});

test("核心目标不匹配或多代理出口时不把流量分配给节点", async (t) => {
  const address = await metrics(t, (_req, res) => res.end(counters(500, 800)));
  const f = await fixture(t);
  f.core.metrics.listen = address;
  f.core.outbounds[0].settings.address = "different.example.test";
  await f.save();
  assert.equal((await f.service.status()).live.nodeId, undefined);
  f.core.outbounds[0].settings.address = "a.example.test";
  f.core.outbounds.push({
    tag: "proxy2",
    protocol: "vmess",
    settings: { vnext: [{ address: "other.test", port: 443 }] },
  });
  await f.save();
  const state = await f.service.status({ force: true });
  assert.equal(state.live.nodeId, undefined);
  assert.equal(state.live.available, true);
});

test("拒绝非回环监听地址和重定向，响应字节数与超时有界", async (t) => {
  let mode = "redirect";
  let requests = 0;
  const address = await metrics(t, (_req, res) => {
    requests++;
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://192.0.2.1/private" });
      res.end();
    } else if (mode === "large") res.end("x".repeat(4096));
    else if (mode === "slow") {
      const timer = setTimeout(() => res.end(counters(1, 2)), 300);
      timer.unref();
    }
  });
  const f = await fixture(t, { maxResponseBytes: 1024, requestTimeoutMs: 50 });
  for (const listen of [
    "0.0.0.0:80",
    "localhost:80",
    "127.0.0.1.evil.test:80",
    "192.168.1.1:80",
    "127.1:80",
    "127.0.0.1:80@192.0.2.1:80",
  ]) {
    f.core.metrics.listen = listen;
    await f.save();
    assert.equal((await f.service.status({ force: true })).live.available, false);
  }
  assert.equal(requests, 0);
  f.core.metrics.listen = address;
  await f.save();
  assert.equal((await f.service.status({ force: true })).live.available, false);
  assert.equal(requests, 1);
  mode = "large";
  assert.equal((await f.service.status({ force: true })).live.available, false);
  mode = "slow";
  assert.equal((await f.service.status({ force: true })).live.available, false);
});

test("数据库更新后重读，损坏时保留成功快照并标示过期", async (t) => {
  const f = await fixture(t);
  await f.service.status();
  const db = new DatabaseSync(f.file);
  db.prepare("UPDATE ServerStatItem SET TotalUp=? WHERE IndexId=?").run(9999, "node-a");
  db.close();
  assert.equal((await f.service.status({ force: true })).nodes[0].savedUploadKb, 9999);
  await writeFile(f.file, "PRIVATE_CORRUPTION_MARKER");
  const stale = await f.service.status({ force: true });
  assert.equal(stale.nodes[0].savedUploadKb, 9999);
  assert.equal(stale.stale, true);
  assert.match(stale.message, /上次|过期/);
  assert.equal(JSON.stringify(stale).includes("PRIVATE_"), false);
});

test("WAL 变动触发重读，即使主数据库文件未变", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.file);
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    await f.service.status();
    db.prepare("UPDATE ServerStatItem SET TotalDown=? WHERE IndexId=?").run(8123, "node-a");
    const changed = await f.service.status({ force: true });
    assert.equal(changed.nodes[0].savedDownloadKb, 8123);
    assert.equal(f.reads(), 2);
  } finally {
    db.close();
  }
});

test("旧版 vnext 格式及等价 IPv6 目标可归属，混合目标不可归属", async (t) => {
  const address = await metrics(t, (_req, res) => res.end(counters(10, 20)));
  const f = await fixture(t);
  const db = new DatabaseSync(f.file);
  db.prepare("UPDATE ProfileItem SET Address=? WHERE IndexId=?").run(
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "node-a",
  );
  db.close();
  f.core.metrics.listen = address;
  f.core.outbounds[0].settings = { vnext: [{ address: "2001:db8::1", port: 443 }] };
  await f.save();
  assert.equal((await f.service.status()).live.nodeId, "node-a");
  f.core.outbounds[0].settings.vnext.push({ address: "another.test", port: 443 });
  await f.save();
  assert.equal((await f.service.status({ force: true })).live.nodeId, undefined);
});

test("选择目录只保存本机路径，重启使用选择且不进行自动探测", async (t) => {
  const f = await fixture(t);
  const state = await f.service.selectDirectory(f.root);
  assert.equal(state.available, true);
  const configFile = join(f.root, "selected.json");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(configFile, "utf8"))), ["directory"]);
  const resumed = new V2raynUsage({
    configFile,
    discoverDirectories: () => {
      throw new Error("不应探测");
    },
    now: () => NOW,
  });
  assert.equal((await resumed.status()).available, true);
});

test("v2rayN 7.25.5 的 HTTP 枚举为 10，自定义复杂配置保持未知", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.file);
  try {
    db.prepare("UPDATE ProfileItem SET ConfigType=? WHERE IndexId=?").run(10, "node-a");
    db.prepare("UPDATE ProfileItem SET ConfigType=? WHERE IndexId=?").run(13, "node-b");
  } finally {
    db.close();
  }
  const state = await f.service.status();
  assert.equal(state.nodes[0].protocol, "http");
  assert.equal(state.nodes[1].protocol, "unknown");
});
