import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore, collectUsage } from "./usage.mjs";

const subscriptionUrl = "https://airport.test/sub?token=private-subscription-token";
const nodeBody = "vless://11111111-2222-3333-4444-555555555555@node.test:443?security=tls#香港";
const headers = { "subscription-userinfo": "upload=10; download=20; total=100" };
const input = (extra = {}) => ({
  name: "测试机场",
  type: "subscription",
  url: subscriptionUrl,
  ...extra,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
async function setup(t, fetchImpl = async () => new Response(nodeBody, { headers })) {
  const dir = await mkdtemp(join(tmpdir(), "zhiyu-subscription-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = new Map();
  const vault = {
    session: 0,
    unlocked: true,
    set: async (id, value) => secrets.set(id, structuredClone(value)),
    get: async (id) => structuredClone(secrets.get(id)),
    remove: async (id) => secrets.delete(id),
  };
  const file = join(dir, "usage.json");
  return { store: new UsageStore(file, vault, fetchImpl), vault, secrets, file };
}

test("同来源轮换组织 Admin Key 后替换已有同日 Token 快照，不重复汇总", async (t) => {
  const { store } = await setup(t);
  const source = await store.add({
    name: "合成组织",
    type: "openai-api",
    apiKey: "synthetic-old-key",
  });
  const row = {
    kind: "tokens",
    key: "2026-10-10:synthetic-model",
    label: "synthetic-model",
    bucketStart: "2026-10-10T00:00:00Z",
    input: 10,
    output: 20,
  };
  await store.record(source.id, [row]);
  await store.update(source.id, {
    name: source.name,
    type: source.type,
    apiKey: "synthetic-rotated-key",
  });
  await store.record(source.id, [{ ...row, input: 15 }]);
  const records = (await store.list()).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].input + records[0].output, 35);
});

test("同次刷新同时读取用量和脱敏节点，详情只读缓存且可跨重启", async (t) => {
  let calls = 0;
  const { store, vault, file } = await setup(t, async () => {
    calls++;
    return new Response(nodeBody, { headers });
  });
  const source = await store.add(input());
  await store.refresh(source.id);
  const details = await store.subscriptionDetails(source.id);
  assert.equal(details.nodeCount, 1);
  assert.equal(details.format, "uri");
  assert.equal(details.trafficAvailable, true);
  assert.equal(details.nodes[0].host, "node.test");
  assert.equal(details.nodes[0].port, 443);
  assert.equal(details.nodes[0].name, "香港");
  assert.deepEqual(Object.keys(details.nodes[0]).sort(), [
    "host",
    "id",
    "name",
    "port",
    "protocol",
  ]);
  details.nodes[0].name = "调用方修改";
  assert.equal((await store.subscriptionDetails(source.id)).nodes[0].name, "香港");
  const publicState = await store.refresh(source.id, { force: false });
  assert.equal(publicState.sources[0].subscription.nodeCount, 1);
  assert.equal(publicState.sources[0].subscription.nodes, undefined);
  assert.equal(publicState.subscriptions, undefined);
  assert.equal(publicState.records[0].download, 20);
  assert.equal(calls, 1);
  const restarted = new UsageStore(file, vault, async () => assert.fail("详情不能访问网络"));
  assert.equal((await restarted.subscriptionDetails(source.id)).nodes.length, 1);
  const persisted = await readFile(file, "utf8");
  for (const secret of [
    "private-subscription-token",
    "11111111-2222-3333-4444-555555555555",
    "vless://",
    "subscriptionUrl",
    "rawUri",
  ])
    assert.equal(persisted.includes(secret), false, secret);
});

test("节点可用但机场未提供流量时刷新成功，不写虚构零流量", async (t) => {
  const { store } = await setup(t, async () => new Response(nodeBody));
  const source = await store.add(input());
  const state = await store.refresh(source.id);
  assert.equal(state.records.length, 0);
  assert.equal(state.sources[0].error, "");
  const details = await store.subscriptionDetails(source.id);
  assert.equal(details.trafficAvailable, false);
  assert.match(details.trafficMessage, /未提供/);
  assert.equal(details.nodes.length, 1);
  assert.deepEqual(await collectUsage(input(), async () => new Response(nodeBody)), []);
});

test("用量有效但节点正文无效时保留真实流量并解释节点不可用", async (t) => {
  const { store } = await setup(
    t,
    async () => new Response("<html>private-subscription-token</html>", { headers }),
  );
  const source = await store.add(input());
  assert.equal((await store.refresh(source.id)).records[0].download, 20);
  const details = await store.subscriptionDetails(source.id);
  assert.equal(details.nodeCount, 0);
  assert.ok(details.nodesMessage);
  assert.equal(JSON.stringify(details).includes("private-subscription-token"), false);
});

test("两种信息均不可用时明确失败并保留上次成功节点和流量", async (t) => {
  let valid = true;
  const { store } = await setup(t, async () =>
    valid
      ? new Response(nodeBody, { headers })
      : new Response("<html>private-subscription-token</html>"),
  );
  const source = await store.add(input());
  await store.refresh(source.id);
  const before = await store.subscriptionDetails(source.id);
  valid = false;
  await assert.rejects(store.refresh(source.id), /用量|节点/);
  assert.deepEqual(await store.subscriptionDetails(source.id), before);
  const state = await store.list();
  assert.equal(state.records.length, 1);
  assert.ok(state.sources[0].error);
  assert.equal(JSON.stringify(state).includes("private-subscription-token"), false);
});

test("订阅正文超过2MiB或读取失败都会取消读取且不泄露错误中的凭据", async () => {
  for (const mode of ["oversize", "read-error"]) {
    let cancelled = false;
    await assert.rejects(
      collectUsage(input(), async () => ({
        ok: true,
        headers: new Headers(headers),
        body: {
          cancel: async () => {
            cancelled = true;
          },
          getReader: () => ({
            read: async () => {
              if (mode === "read-error") throw new Error(subscriptionUrl + " " + nodeBody);
              return { done: false, value: new Uint8Array(2 * 1024 * 1024 + 1) };
            },
            cancel: async () => {
              cancelled = true;
            },
          }),
        },
      })),
      (error) => {
        assert.equal(error.message.includes("private-subscription-token"), false);
        assert.equal(error.message.includes("11111111"), false);
        if (mode === "oversize") assert.match(error.message, /2 MiB/);
        return true;
      },
    );
    assert.equal(cancelled, true);
  }
});

test("订阅URL规范化去重覆盖并发添加，名称相同的不同订阅仍独立", async (t) => {
  const { store, secrets } = await setup(t);
  const [first, duplicate] = await Promise.all([
    store.add(input({ url: "https://AIRPORT.test:443/sub?token=same#one" })),
    store.add(input({ name: "另一个名称", url: "https://airport.test/sub?token=same#two" })),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal((await store.list()).sources.length, 1);
  assert.equal(secrets.size, 1);
  const other = await store.add(input({ url: "https://airport.test/sub?token=other" }));
  assert.notEqual(other.id, first.id);
  assert.equal((await store.list()).sources.length, 2);
});

test("编辑名称和关联节点时空订阅URL保留密钥，历史名称更新且类型不可改", async (t) => {
  const { store, secrets } = await setup(t);
  const source = await store.add(input());
  await store.refresh(source.id);
  const updated = await store.update(source.id, {
    name: "新机场名",
    type: "subscription",
    url: "",
    nodeId: "asset-1",
  });
  assert.equal(updated.name, "新机场名");
  assert.equal(updated.nodeId, "asset-1");
  assert.equal(secrets.get(source.id).url, subscriptionUrl);
  assert.equal((await store.list()).records[0].sourceName, "新机场名");
  assert.equal((await store.subscriptionDetails(source.id)).nodes.length, 1);
  assert.equal(JSON.stringify(updated).includes(subscriptionUrl), false);
  await assert.rejects(store.update(source.id, { type: "openai-api", name: "错类型" }), /类型/);
});

test("换订阅URL清理节点和计数基线，保留旧历史且拒绝换成已有订阅", async (t) => {
  let upload = 10;
  const { store } = await setup(
    t,
    async () =>
      new Response(nodeBody, {
        headers: { "subscription-userinfo": `upload=${upload}; download=20` },
      }),
  );
  const first = await store.add(input());
  await store.refresh(first.id);
  const oldRevision = (await store.list()).records[0].revision ?? 0;
  const second = await store.add(input({ url: "https://airport.test/other" }));
  await assert.rejects(
    store.update(first.id, { name: "重复", url: "https://airport.test/other#hash" }),
    /已存在|重复/,
  );
  assert.equal((await store.subscriptionDetails(first.id)).nodes.length, 1);
  await store.update(first.id, { name: "换套餐", url: "https://airport.test/new" });
  const empty = await store.subscriptionDetails(first.id);
  assert.equal(empty.fetchedAt, null);
  assert.equal(empty.nodes.length, 0);
  upload = 100;
  await store.refresh(first.id, { force: false });
  const state = await store.list();
  assert.equal(state.records.length, 2);
  assert.equal(state.records[1].deltaUpload, null);
  assert.ok(state.records[1].revision > oldRevision);
  assert.equal(state.sources.find((entry) => entry.id === second.id).name, "测试机场");
});

test("编辑与删除期间的旧刷新不会覆盖新配置、复活节点或写入失败状态", async (t) => {
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  const { store } = await setup(t, async () => {
    if (++calls === 1) {
      started.resolve();
      return gate.promise;
    }
    return new Response(nodeBody, { headers });
  });
  const source = await store.add(input());
  const pending = store.refresh(source.id).catch(() => {});
  await started.promise;
  await store.update(source.id, { name: "新来源", url: "https://airport.test/new" });
  await store.refresh(source.id);
  gate.resolve(new Response("", { status: 403 }));
  await pending;
  const state = await store.list();
  assert.equal(state.sources[0].error, "");
  assert.equal(state.sources[0].name, "新来源");
  assert.equal(state.records.length, 1);
  await store.remove(source.id);
  assert.equal((await store.list()).records.length, 1);
  await assert.rejects(store.subscriptionDetails(source.id), /不存在/);
});

test("删除和锁库使进行中的刷新失效，不落盘已撤销会话的结果", async (t) => {
  for (const action of ["remove", "lock"]) {
    const gate = deferred();
    const started = deferred();
    const { store, vault, file } = await setup(t, async () => {
      started.resolve();
      return gate.promise;
    });
    const source = await store.add(input());
    const pending = store.refresh(source.id).catch(() => {});
    await started.promise;
    if (action === "remove") await store.remove(source.id);
    else {
      vault.session++;
      vault.unlocked = false;
    }
    gate.resolve(new Response(nodeBody, { headers }));
    await pending;
    assert.equal((await store.list()).records.length, 0);
    assert.equal((await readFile(file, "utf8")).includes("node.test"), false);
  }
});

test("详情查询对新订阅返回空状态，对不存在来源和其他类型给受控错误", async (t) => {
  const { store } = await setup(t);
  const source = await store.add(input());
  const details = await store.subscriptionDetails(source.id);
  assert.equal(details.fetchedAt, null);
  assert.deepEqual(details.nodes, []);
  await assert.rejects(store.subscriptionDetails("usage-missing"), /不存在/);
  const api = await store.add({ name: "API", type: "openai-api", apiKey: "test" });
  await assert.rejects(store.subscriptionDetails(api.id), /订阅/);
});

test("编辑落盘失败不能污染已缓存名称、订阅节点或密钥配置", async (t) => {
  const { store, secrets, file } = await setup(t);
  const source = await store.add(input());
  await store.refresh(source.id);
  const before = await store.list();
  const details = await store.subscriptionDetails(source.id);
  await mkdir(file + ".tmp");
  await assert.rejects(
    store.update(source.id, { name: "不应保存", url: "https://airport.test/new" }),
  );
  assert.deepEqual(await store.list(), before);
  assert.deepEqual(await store.subscriptionDetails(source.id), details);
  assert.equal(secrets.get(source.id).url, subscriptionUrl);
});

test("历史重复来源保持完整，新增只返回已有订阅不会删除历史", async (t) => {
  const { store, secrets, file } = await setup(t);
  const first = await store.add(input());
  const state = await store.list();
  state.sources.push({ ...first, id: "usage-legacy-duplicate" });
  secrets.set("usage-legacy-duplicate", structuredClone(secrets.get(first.id)));
  await writeFile(file, JSON.stringify(state));
  assert.equal((await store.add(input())).id, first.id);
  assert.equal((await store.list()).sources.length, 2);
  await store.update(first.id, { name: "历史机场改名", url: "" });
  assert.equal((await store.list()).sources[0].name, "历史机场改名");
});

test("其他来源编辑空凭据保留原配置，面板过滤条件可清空", async (t) => {
  const { store, secrets } = await setup(t);
  const panel = await store.add({
    name: "面板",
    type: "3x-ui",
    url: "https://panel.test",
    username: "admin",
    password: "private-panel-password",
    inboundId: "1",
  });
  await store.update(panel.id, {
    name: "改名面板",
    url: "",
    username: "",
    password: "",
    inboundId: "",
  });
  assert.equal(secrets.get(panel.id).password, "private-panel-password");
  assert.equal(secrets.get(panel.id).inboundId, "");
  const api = await store.add({ name: "API", type: "openai-api", apiKey: "private-api-key" });
  await store.update(api.id, { name: "改名API", apiKey: "" });
  assert.equal(secrets.get(api.id).apiKey, "private-api-key");
  const publicState = JSON.stringify(await store.list());
  assert.equal(publicState.includes("private-api-key"), false);
  assert.equal(publicState.includes("private-panel-password"), false);
});
