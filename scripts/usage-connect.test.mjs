import assert from "node:assert/strict";
import test from "node:test";
import { saveAndVerifyUsageSource } from "../src/lib/usage-connect.mjs";
import * as connection from "../src/lib/usage-connect.mjs";

test("保存来源后验证一次，使用后端返回的来源 ID", async () => {
  const calls = [];
  const input = { name: "我的面板", type: "3x-ui" };
  const api = {
    async add(value) {
      calls.push(["add", value]);
      return { id: "usage-created", name: value.name };
    },
    async refresh(id) {
      calls.push(["refresh", id]);
      return { sources: [], records: [] };
    },
  };
  const result = await saveAndVerifyUsageSource(api, input);
  assert.deepEqual(calls, [
    ["add", input],
    ["refresh", "usage-created"],
  ]);
  assert.equal(result.verified, true);
});

test("验证失败保留已保存来源，后续重试不需要重复录入", async () => {
  const sources = [];
  const api = {
    async add(value) {
      const source = { id: "usage-kept", name: value.name };
      sources.push(source);
      return source;
    },
    async refresh() {
      throw new Error("3x-ui HTTP 403：面板凭据无效");
    },
  };
  const result = await saveAndVerifyUsageSource(api, { name: "面板" });
  assert.equal(result.verified, false);
  assert.equal(result.source.id, "usage-kept");
  assert.match(result.error, /3x-ui HTTP 403/);
  assert.equal(sources.length, 1);
});

test("保存失败不发起采集，也不宣称来源已保存", async () => {
  let refreshed = false;
  const api = {
    async add() {
      throw new Error("密钥库已锁定");
    },
    async refresh() {
      refreshed = true;
    },
  };
  await assert.rejects(saveAndVerifyUsageSource(api, {}), /密钥库已锁定/);
  assert.equal(refreshed, false);
});

test("编辑既有来源使用更新接口，验证失败仍保留同一来源", async () => {
  const sources = new Map([["existing", { id: "existing", name: "旧名" }]]);
  const api = {
    async add() {
      throw new Error("不应新增来源");
    },
    async update(id, input) {
      const updated = { ...sources.get(id), name: input.name };
      sources.set(id, updated);
      return updated;
    },
    async refresh() {
      throw new Error("订阅服务暂不可用");
    },
  };
  const result = await saveAndVerifyUsageSource(api, { name: "新名", url: "" }, "existing");
  assert.equal(sources.size, 1);
  assert.equal(sources.get("existing").name, "新名");
  assert.equal(result.source.id, "existing");
  assert.equal(result.verified, false);
  assert.match(result.error, /暂不可用/);
});

test("节点详情按成功采样时间缓存，失败尝试不使缓存失效", async () => {
  let reads = 0;
  const cache = connection.createSubscriptionDetailsCache(async (id) => ({
    sourceId: id,
    nodes: [],
    reads: ++reads,
  }));
  assert.equal(reads, 0);
  const source = { id: "airport", checkedAt: "2026-10-10T01:00:00Z" };
  const first = await cache.read(source);
  assert.equal(await cache.read({ ...source, attemptedAt: "2026-10-10T01:01:00Z" }), first);
  assert.equal(reads, 1);
  assert.notEqual(await cache.read({ ...source, checkedAt: "2026-10-10T01:02:00Z" }), first);
  assert.equal(reads, 2);
});

test("节点详情读取失败可再次读取，不永久缓存错误", async () => {
  let fail = true;
  const cache = connection.createSubscriptionDetailsCache(async () => {
    if (fail) throw new Error("读取失败");
    return { nodes: [] };
  });
  await assert.rejects(cache.read({ id: "airport" }), /读取失败/);
  fail = false;
  assert.deepEqual(await cache.read({ id: "airport" }), { nodes: [] });
});
