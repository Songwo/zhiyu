import assert from "node:assert/strict";
import test from "node:test";
import {
  canProbeServer,
  isCollectionPaused,
  hasServerObservation,
  hasServerMetrics,
  serverNeedsAttention,
} from "../src/lib/server-observation.mjs";

test("关闭自动采集后不探测、不告警，重新打开恢复原状态", () => {
  const server = {
    status: "offline",
    lastSeen: "2026-09-29",
    probedAt: "2026-09-30",
    probeError: "connection timed out",
    collect: false,
  };
  assert.equal(isCollectionPaused(server), true);
  assert.equal(canProbeServer(server), false);
  assert.equal(hasServerObservation(server), false);
  assert.equal(serverNeedsAttention(server), false);
  assert.equal(hasServerMetrics(server), true);
  const resumed = { ...server, collect: undefined };
  assert.equal(canProbeServer(resumed), true);
  assert.equal(serverNeedsAttention(resumed), true);
  assert.equal(canProbeServer({ sshConfigured: false }), false);
  assert.equal(canProbeServer({ collect: true }), true);
});
test("仅记录主机没有监控数据，也不会产生故障告警", () => {
  const server = { status: "warning", lastSeen: "" };
  assert.equal(hasServerObservation(server), false);
  assert.equal(hasServerMetrics(server), false);
  assert.equal(serverNeedsAttention(server), false);
});
test("首次采集失败可以告警，但仍不能把初始零值当成指标", () => {
  const server = {
    status: "offline",
    lastSeen: "",
    probedAt: "2026-09-30T00:00:00.000Z",
    probeError: "connection failed",
  };
  assert.equal(hasServerObservation(server), true);
  assert.equal(hasServerMetrics(server), false);
  assert.equal(serverNeedsAttention(server), true);
});
test("已有采集数据失败后仍保留上次指标与告警", () => {
  const server = {
    status: "offline",
    lastSeen: "2026-09-29",
    probedAt: "2026-09-30",
    probeError: "connection failed",
  };
  assert.equal(hasServerObservation(server), true);
  assert.equal(hasServerMetrics(server), true);
  assert.equal(serverNeedsAttention(server), true);
});
test("旧记录未提供时间字段时保留历史展示语义", () => {
  assert.equal(hasServerObservation({ status: "online" }), true);
  assert.equal(hasServerMetrics({ status: "online" }), true);
  assert.equal(serverNeedsAttention({ status: "warning" }), true);
});

test("仅记录主机不进行 SSH 探测，旧主机和显式配置主机继续可用", () => {
  assert.equal(canProbeServer({ sshConfigured: false }), false);
  assert.equal(canProbeServer({ sshConfigured: true }), true);
  assert.equal(canProbeServer({}), true);
});
