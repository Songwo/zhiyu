import test from "node:test";
import assert from "node:assert/strict";
import {
  containerIssues,
  containerAlertEntries,
  containerAlertRule,
  reconcileContainerAlertConfig,
} from "./service-monitor.mjs";
import { notificationCandidates, NotificationTracker } from "./notifications.mjs";

const now = Date.parse("2026-11-05T08:00:00Z");
const container = (extra = {}) => ({
  id: "a",
  name: "web",
  state: "running",
  restartCount: 7,
  startedAt: "2026-11-05T07:00:00Z",
  ...extra,
});
const scan = (...containers) => ({
  collectedAt: new Date(now).toISOString(),
  ports: [],
  docker: { available: true, containers },
});
const acknowledge = (s, config = {}) => ({
  ...config,
  acknowledged: Object.fromEntries(
    containerAlertEntries(s, config, now).map((e) => [e.issue.container, e.signature]),
  ),
});

test("容器阈值可按主机和名称覆盖；非法参数安全回退，特殊名称不读原型", () => {
  const s = scan(container(), container({ id: "b", name: "worker" }));
  const config = { restartThreshold: 10, overrides: { worker: { restartThreshold: 3 } } };
  assert.deepEqual(
    containerIssues(s, config, now).map((i) => i.container),
    ["worker"],
  );
  assert.equal(containerAlertRule({ restartThreshold: 0 }).restartThreshold, 5);
  assert.equal(containerAlertRule({ startupGraceSeconds: Infinity }).startupGraceSeconds, 120);
  assert.equal(containerAlertRule(config, "__proto__").restartThreshold, 10);
  assert.equal(
    containerAlertRule({ overrides: { web: { startupGraceSeconds: 0 } } }, "web")
      .startupGraceSeconds,
    0,
  );
});

test("启动宽限到期恢复告警；未来或无效时间不隐藏故障；退出、OOM和重启循环立即提醒", () => {
  const s = scan(
    container({ startedAt: new Date(now - 30000).toISOString(), health: "unhealthy" }),
  );
  assert.equal(containerAlertEntries(s, {}, now)[0].state, "grace");
  assert.equal(containerIssues(s, {}, now + 90000).length, 1);
  assert.equal(containerIssues(s, { startupGraceSeconds: 0 }, now).length, 1);
  for (const startedAt of ["bad", new Date(now + 1000).toISOString()])
    assert.equal(containerIssues(scan(container({ startedAt })), {}, now).length, 1);
  for (const c of [
    container({ state: "restarting" }),
    container({ state: "exited", exitCode: 1 }),
    container({ state: "exited", oomKilled: true }),
  ]) {
    assert.equal(
      containerIssues(scan({ ...c, startedAt: new Date(now).toISOString() }), {}, now).length,
      1,
    );
  }
});

test("确认只覆盖当前事件，重启增加/容器重建/健康恶化重新提醒；恢复后同类故障不沿用确认", () => {
  const s = scan(container()),
    config = acknowledge(s);
  assert.equal(containerIssues(s, config, now).length, 0);
  for (const extra of [
    { restartCount: 8 },
    { id: "new" },
    { health: "unhealthy" },
    { state: "restarting" },
    { startedAt: "2026-11-05T07:30:00Z" },
  ])
    assert.equal(containerIssues(scan(container(extra)), config, now).length, 1);
  const unhealthy = scan(container({ restartCount: 0, health: "unhealthy" }));
  const confirmed = acknowledge(unhealthy);
  const recovered = reconcileContainerAlertConfig(
    confirmed,
    scan(container({ restartCount: 0, health: "healthy" })),
  );
  assert.equal(containerIssues(unhealthy, recovered, now).length, 1);
  assert.deepEqual(
    reconcileContainerAlertConfig(config, { docker: { available: false, containers: [] } }),
    config,
  );
});

test("维护静音有明确期限且保留真实异常，不影响其他容器；到期或撤销重新告警", () => {
  const s = scan(
    container(),
    container({ id: "db", name: "db", state: "exited", oomKilled: true }),
  );
  const config = { mutedUntil: { web: now + 60000 } };
  assert.deepEqual(
    containerIssues(s, config, now).map((i) => i.container),
    ["db"],
  );
  assert.equal(containerAlertEntries(s, config, now)[0].issue.kind, "flapping");
  assert.equal(containerAlertEntries(s, config, now)[0].state, "muted");
  assert.equal(containerIssues(s, config, now + 60000).length, 2);
  assert.equal(containerIssues(s, { mutedUntil: {} }, now).length, 2);
});

test("桌面与浏览器通知遵循相同规则，新事件不会被24小时去重吞掉", () => {
  const server = { id: "s", name: "server", status: "online", serviceScan: scan(container()) };
  const candidates = (config, s = server.serviceScan) =>
    notificationCandidates(
      { servers: [{ ...server, serviceScan: s, containerAlerts: config }] },
      now,
    );
  const tracker = new NotificationTracker();
  assert.equal(tracker.take(candidates({}), now).length, 1);
  assert.equal(tracker.take(candidates({}), now).length, 0);
  assert.equal(tracker.take(candidates({}, scan(container({ restartCount: 8 }))), now).length, 1);
  assert.equal(candidates(acknowledge(server.serviceScan)).length, 0);
  assert.equal(candidates({ mutedUntil: { web: now + 60000 } }).length, 0);
});
