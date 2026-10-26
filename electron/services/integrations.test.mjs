import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Integrations } from "./integrations.mjs";
import { normalizeSnapshotImages } from "./image-data.mjs";

const secret = "fixture-sensitive-token-123456789";
const resource = {
  key: "zone:zone-1",
  type: "zone",
  remoteId: "zone-1",
  name: "example.test",
  url: "https://example.test",
  status: "active",
};
const record = {
  id: "dns-1",
  type: "A",
  name: "www.example.test",
  content: "192.0.2.1",
  ttl: 1,
  proxied: true,
};
const input = { type: "A", name: "www.example.test", content: "192.0.2.2", ttl: 1, proxied: true };
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zhiyu-integrations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = {
    snapshot: { servers: [], domains: [], services: [], links: [] },
    calls: 0,
    writes: 0,
    record: { ...record },
  };
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "os_crypt",
    encryptString: (s) => Buffer.from(s.split("").reverse().join("")),
    decryptString: (b) => b.toString().split("").reverse().join(""),
  };
  const api = {
    inventory: async () => {
      state.calls++;
      return {
        resources: [resource],
        warnings: [],
        fetchedAt: new Date().toISOString(),
        cached: false,
      };
    },
    dnsList: async () => [state.record],
    dnsGet: async () => structuredClone(state.record),
    dnsWrite: async () => {
      state.writes++;
    },
  };
  const service = new Integrations({
    file: join(dir, "integrations.json"),
    secureStorage: storage,
    cloudflareFactory: () => api,
    getSnapshot: () => state.snapshot,
    mutateAssets: async (fn) => {
      state.snapshot = fn(state.snapshot);
    },
    ...options,
  });
  return { service, state, api, dir };
}

test("接入凭据加密保存且公开配置不回传，重启可读", async (t) => {
  const { service, dir } = await setup(t);
  const connection = await service.save({
    provider: "cloudflare",
    name: "合成云账号",
    token: secret,
  });
  assert.equal(connection.hasToken, true);
  assert.equal(JSON.stringify(await service.list()).includes(secret), false);
  assert.equal((await readFile(join(dir, "integrations.json"), "utf8")).includes(secret), false);
  assert.equal((await service.save({ ...connection, token: "" })).id, connection.id);
});
test("不允许 basic_text 降级与未明确启用的 HTTP，换地址必须重新输入 token", async (t) => {
  const bad = await setup(t, {
    secureStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
    },
  });
  await assert.rejects(
    bad.service.save({ provider: "cloudflare", name: "cloud", token: secret }),
    /加密/,
  );
  const { service } = await setup(t);
  await assert.rejects(
    service.save({
      provider: "probe",
      name: "probe",
      endpoint: "http://127.0.0.1:8008",
      token: secret,
    }),
    /HTTP|明文/,
  );
  const c = await service.save({
    provider: "probe",
    name: "probe",
    endpoint: "http://127.0.0.1:8008",
    allowInsecure: true,
    token: secret,
  });
  await assert.rejects(service.save({ ...c, endpoint: "https://another.example.test" }), /重新/);
});
test("资源请求单飞并复用缓存，强制刷新一次", async (t) => {
  const { service, state } = await setup(t);
  const c = await service.save({ provider: "cloudflare", name: "cloud", token: secret });
  await Promise.all([service.inventory(c.id), service.inventory(c.id)]);
  assert.equal(state.calls, 1);
  assert.equal((await service.inventory(c.id)).cached, true);
  await service.inventory(c.id, true);
  assert.equal(state.calls, 2);
});
test("换连接后迟到的响应被拒绝，不能写回缓存", async (t) => {
  const { service, api } = await setup(t);
  const c = await service.save({ provider: "cloudflare", name: "cloud", token: secret });
  let resolve, started;
  const ready = new Promise((r) => (started = r));
  api.inventory = () => {
    started();
    return new Promise((r) => (resolve = r));
  };
  const pending = service.inventory(c.id);
  const rejected = assert.rejects(pending, /连接.*变更|连接.*变化/);
  await ready;
  await service.save({ ...c, token: secret + "new" });
  resolve({
    resources: [resource],
    warnings: [],
    fetchedAt: new Date().toISOString(),
    cached: false,
  });
  await rejected;
});
test("DNS 预览不写，确认前对照远端，票据一次性", async (t) => {
  const { service, state } = await setup(t);
  const c = await service.save({ provider: "cloudflare", name: "cloud", token: secret });
  const p = await service.dnsPreview({
    connectionId: c.id,
    zoneId: "zone-1",
    action: "update",
    recordId: "dns-1",
    record: input,
  });
  assert.equal(state.writes, 0);
  assert.equal(p.before.content, "192.0.2.1");
  await service.dnsApply(p.ticket);
  assert.equal(state.writes, 1);
  await assert.rejects(service.dnsApply(p.ticket), /失效|过期/);
  const stale = await service.dnsPreview({
    connectionId: c.id,
    zoneId: "zone-1",
    action: "update",
    recordId: "dns-1",
    record: input,
  });
  state.record.content = "192.0.2.9";
  await assert.rejects(service.dnsApply(stale.ticket), /变更|变化/);
  assert.equal(state.writes, 1);
});
test("DNS 预览过期或改连接后不能执行", async (t) => {
  let now = Date.now();
  const { service, state } = await setup(t, { now: () => now });
  const c = await service.save({ provider: "cloudflare", name: "cloud", token: secret });
  const p = await service.dnsPreview({
    connectionId: c.id,
    zoneId: "zone-1",
    action: "create",
    record: input,
  });
  now += 180000;
  await assert.rejects(service.dnsApply(p.ticket), /过期|失效/);
  const p2 = await service.dnsPreview({
    connectionId: c.id,
    zoneId: "zone-1",
    action: "create",
    record: input,
  });
  await service.save({ ...c, token: secret + "new" });
  await assert.rejects(service.dnsApply(p2.ticket), /过期|失效|变更|变化/);
  assert.equal(state.writes, 0);
});
test("远端导入幂等并保留本地名称备注，绑定到已有资产不会复制", async (t) => {
  const { service, state } = await setup(t);
  const c = await service.save({ provider: "cloudflare", name: "cloud", token: secret });
  const a = await service.bind({ connectionId: c.id, resourceKey: resource.key });
  state.snapshot.domains[0].name = "本地名字";
  state.snapshot.domains[0].notes = "本地备注";
  const b = await service.bind({ connectionId: c.id, resourceKey: resource.key });
  assert.deepEqual(a, b);
  assert.equal(state.snapshot.domains.length, 1);
  assert.equal(state.snapshot.domains[0].name, "本地名字");
  assert.equal(state.snapshot.domains[0].notes, "本地备注");
  await service.unbind(a);
  await service.bind({ connectionId: c.id, resourceKey: resource.key, assetId: a.id });
  assert.equal(state.snapshot.domains.length, 1);
  await assert.rejects(
    service.bind({ connectionId: c.id, resourceKey: resource.key, assetId: "missing" }),
    /不存在/,
  );
  assert.equal(JSON.stringify(state.snapshot).includes(secret), false);
});
test("探针请求不跟随跳转，错误不泄露 Token", async (t) => {
  let options;
  const { service } = await setup(t, {
    fetchImpl: async (_url, init) => {
      options = init;
      return new Response(secret, {
        status: 302,
        headers: { location: "https://evil.example.test" },
      });
    },
  });
  const c = await service.save({
    provider: "probe",
    name: "probe",
    endpoint: "https://probe.example.test",
    token: secret,
  });
  await assert.rejects(service.inventory(c.id), (e) => !e.message.includes(secret));
  assert.equal(options.redirect, "error");
});
test("探针 DTO 剥离秘密，服务端失败不变成空监控", async (t) => {
  const unexpected = "unexpected-field-must-not-reach-renderer";
  const { service } = await setup(t, {
    fetchImpl: async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith("/hosts")
            ? [
                {
                  id: "host-1",
                  name: "host",
                  hostname: "fixture",
                  os: "linux",
                  arch: "amd64",
                  status: "offline",
                  lastSeen: "2026-10-12T00:00:00Z",
                  latest: { at: "2026-10-12T00:00:00Z", cpu: 12, secret: unexpected },
                  secret: unexpected,
                },
              ]
            : [],
        ),
        { status: 200 },
      ),
  });
  const c = await service.save({
    provider: "probe",
    name: "probe",
    endpoint: "https://probe.example.test",
    token: secret,
  });
  const result = await service.inventory(c.id);
  assert.equal(result.resources[0].host.status, "offline");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(unexpected), false);
});
test("探针反射管理员 Token 时整份响应拒绝，错误也不回传 Token", async (t) => {
  const { service } = await setup(t, {
    fetchImpl: async () =>
      new Response(JSON.stringify([{ id: "host-1", name: secret }]), { status: 200 }),
  });
  const c = await service.save({
    provider: "probe",
    name: "probe",
    endpoint: "https://probe.example.test",
    token: secret,
  });
  await assert.rejects(
    service.inventory(c.id),
    (e) => e.message.includes("凭据") && !e.message.includes(secret),
  );
});
test("资产序列化只保留公开绑定字段", () => {
  const integration = {
    provider: "probe",
    connectionId: "c1",
    resourceType: "host",
    remoteId: "h1",
    token: secret,
  };
  const s = normalizeSnapshotImages({ servers: [{ id: "s1", integration }], domains: [] });
  assert.equal(s.servers[0].integration.token, undefined);
});
test("服务检查历史按范围缓存，拒绝非法状态且不保留未知字段", async (t) => {
  let calls = 0;
  let status = "up";
  const { service } = await setup(t, {
    fetchImpl: async () => {
      calls++;
      return new Response(
        JSON.stringify([
          {
            at: "2026-10-12T00:00:00Z",
            status,
            latencyMs: 12,
            message: "",
            privateData: "drop",
          },
        ]),
      );
    },
  });
  const c = await service.save({
    provider: "probe",
    name: "probe",
    endpoint: "https://probe.example.test",
    token: secret,
  });
  const result = await service.probeCheckHistory(c.id, "check-1", "1h");
  assert.equal(result[0].status, "up");
  assert.equal(result[0].privateData, undefined);
  await service.probeCheckHistory(c.id, "check-1", "1h");
  assert.equal(calls, 1);
  await assert.rejects(service.probeCheckHistory(c.id, "check-1", "forever"), /范围/);
  status = "unknown";
  await assert.rejects(service.probeCheckHistory(c.id, "check-1", "24h"), /格式无效/);
});

test("批量导入域名：新增资产带上 NS、到期日与自动续费，重复导入只更新不新增", async (t) => {
  const { service, state, api } = await setup(t);
  const c = await service.save({ provider: "cloudflare", name: "cloud", token: secret });
  const zone = (name, id, extra = {}) => ({
    key: `zone::${id}`,
    type: "zone",
    remoteId: id,
    name,
    url: `https://${name}/`,
    status: "active",
    zone: { nameServers: ["a.ns.cloudflare.com"], paused: false, ...extra },
  });
  const resources = [
    zone("registered.test", "z1", {
      registrar: "Cloudflare",
      expiresAt: "2099-03-08T00:00:00.000Z",
      autoRenew: true,
    }),
    zone("elsewhere.test", "z2"),
  ];
  api.inventory = async () => ({ resources, warnings: [], fetchedAt: "2026-10-26T00:00:00Z" });
  await assert.rejects(service.importZones({ connectionId: c.id, resourceKeys: [] }), /选择/);
  const first = await service.importZones({
    connectionId: c.id,
    resourceKeys: resources.map((r) => r.key),
  });
  assert.deepEqual([first.created, first.updated], [2, 0]);
  const registered = state.snapshot.domains.find((d) => d.name === "registered.test");
  assert.equal(registered.registrar, "Cloudflare");
  assert.equal(registered.expiresAt, "2099-03-08");
  assert.equal(registered.autoRenew, true);
  assert.equal(registered.status, "online");
  assert.deepEqual(registered.nameservers, ["a.ns.cloudflare.com"]);
  assert.equal(registered.dns, "Cloudflare");
  const elsewhere = state.snapshot.domains.find((d) => d.name === "elsewhere.test");
  assert.equal(elsewhere.expiresAt, "");
  assert.equal(elsewhere.status, "warning");

  // 用户改过的备注和标签，以及 WHOIS 查到的到期日，不会被没有注册信息的同步覆盖。
  state.snapshot.domains = state.snapshot.domains.map((d) =>
    d.name === "elsewhere.test" ? { ...d, notes: "mine", tags: ["x"], expiresAt: "2098-01-01" } : d,
  );
  resources[0].zone.expiresAt = "2100-01-01T00:00:00.000Z";
  resources[1].zone.nameServers = ["b.ns.cloudflare.com"];
  const sync = await service.syncZones(c.id);
  assert.equal(sync.updated, 2);
  assert.equal(state.snapshot.domains.length, 2);
  const synced = state.snapshot.domains.find((d) => d.name === "elsewhere.test");
  assert.equal(synced.notes, "mine");
  assert.deepEqual(synced.tags, ["x"]);
  assert.equal(synced.expiresAt, "2098-01-01");
  assert.deepEqual(synced.nameservers, ["b.ns.cloudflare.com"]);
  assert.equal(
    state.snapshot.domains.find((d) => d.name === "registered.test").expiresAt,
    "2100-01-01",
  );

  const again = await service.importZones({ connectionId: c.id, resourceKeys: [resources[0].key] });
  assert.deepEqual([again.created, again.updated], [0, 1]);
  assert.equal(state.snapshot.domains.length, 2);
});
test("导入域名只支持 Cloudflare 连接", async (t) => {
  const { service } = await setup(t);
  const probe = await service.save({
    provider: "probe",
    name: "probe",
    endpoint: "https://probe.example.test",
    token: secret,
  });
  await assert.rejects(
    service.importZones({ connectionId: probe.id, resourceKeys: ["x"] }),
    /类型/,
  );
  await assert.rejects(service.syncZones(probe.id), /类型/);
});
