import test from "node:test";
import assert from "node:assert/strict";
import {
  probeEndpoint,
  probeSample,
  probeCheckInput,
  probeRequest,
  remoteId,
} from "./probe-client.mjs";

test("探针公网强制 TLS，明文仅显式允许字面私网/本机地址", () => {
  assert.equal(probeEndpoint("https://probe.example.test/"), "https://probe.example.test");
  for (const endpoint of [
    "http://127.0.0.1:8008",
    "http://192.168.1.2:8008",
    "http://[::1]:8008",
  ]) {
    assert.throws(() => probeEndpoint(endpoint), /明文/);
    assert.equal(probeEndpoint(endpoint, true), endpoint);
  }
  for (const endpoint of [
    "http://10.evil.example.test",
    "http://192.0.2.1",
    "https://user:pass@example.test",
    "https://example.test?token=secret",
    "file:///etc/passwd",
  ])
    assert.throws(() => probeEndpoint(endpoint, true));
});
test("指标未知值/越界值保留 null，不用零冒充成功；时间标准化为 UTC", () => {
  const sample = probeSample({
    at: "2026-10-12T08:00:00+08:00",
    cpu: 101,
    memory: 0,
    disk: NaN,
    networkTx: 100,
    temperature: -5,
    token: "private",
  });
  assert.equal(sample.at, "2026-10-12T00:00:00.000Z");
  assert.equal(sample.cpu, null);
  assert.equal(sample.disk, null);
  assert.equal(sample.swap, null);
  assert.equal(sample.memory, 0);
  assert.equal(sample.token, undefined);
  assert.equal(sample.temperature, -5);
  assert.throws(() => probeSample({ at: "broken" }), /时间/);
});
test("远端标识拒绝路径注入，检查输入有时限并剥离额外字段", () => {
  for (const id of ["../host", "h?token=x", "h#x", "a\\b", "bad\nvalue"])
    assert.throws(() => remoteId(id));
  const input = {
    name: "检查",
    type: "http",
    target: "https://example.test",
    intervalSeconds: 60,
    timeoutMs: 1000,
    secret: "private",
  };
  assert.equal(probeCheckInput(input).secret, undefined);
  for (const patch of [
    { timeoutMs: 60001 },
    { intervalSeconds: 1 },
    { timeoutMs: 30000, intervalSeconds: 10 },
    { target: "https://user:pass@example.test" },
    { type: "file" },
    { type: "tcp", target: "localhost" },
  ])
    assert.throws(() => probeCheckInput({ ...input, ...patch }));
});
test("超大响应与认证失败均拒绝，错误不回传响应体", async () => {
  await assert.rejects(
    probeRequest({ endpoint: "https://probe.example.test" }, "sensitive-token-value", "/hosts", {
      fetchImpl: async () => new Response("sensitive-token-value", { status: 401 }),
    }),
    /凭据无效/,
  );
  await assert.rejects(
    probeRequest({ endpoint: "https://probe.example.test" }, "sensitive-token-value", "/hosts", {
      fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    }),
    /过大/,
  );
});
test("Unicode 转义不能绕过连接凭据反射检查", async () => {
  const token = "synthetic-token-123456789";
  const payload = '[{"name":"\\u0073ynthetic-token-123456789"}]';
  assert.equal(payload.includes(token), false);
  await assert.rejects(
    probeRequest({ endpoint: "https://probe.example.test" }, token, "/hosts", {
      fetchImpl: async () => new Response(payload),
    }),
    (e) => e.message.includes("凭据") && !e.message.includes(token),
  );
});
