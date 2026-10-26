import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsStore, pruneSamples } from "./metrics.mjs";
import { notificationCandidates, NotificationTracker } from "./notifications.mjs";

test("指标并发写入不丢失，重建对象后从磁盘读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanpad-metrics-"));
  try {
    const file = join(dir, "metrics.json");
    const store = new MetricsStore(file);
    const now = Date.now();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.record("host", { at: new Date(now - i * 1000).toISOString(), cpu: i, memory: 30 }),
      ),
    );
    const rows = await new MetricsStore(file).list("host");
    assert.equal(rows.length, 12);
    assert.ok(JSON.parse(await readFile(file, "utf8")).host);
    assert.deepEqual(await store.list("missing"), []);
    assert.equal((await store.list("host", now - 2500)).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("无效、未来、过期样本被剔除，缺失指标不会补假零", () => {
  const now = Date.now();
  const at = new Date(now).toISOString();
  assert.deepEqual(
    pruneSamples(
      [
        { at, cpu: 101, memory: 20 },
        { at: "invalid", cpu: 5 },
        { at: new Date(now - 31 * 86400000).toISOString(), cpu: 4 },
        { at: new Date(now + 86400000).toISOString(), cpu: 4 },
      ],
      now,
    ),
    [{ at, memory: 20 }],
  );
});
test("通知覆盖到期且不把高负载当成断线", () => {
  const now = Date.parse("2026-09-07");
  const items = notificationCandidates(
    {
      servers: [
        { id: "hot", name: "hot", status: "offline", cpu: 99 },
        { id: "down", name: "down", status: "offline", probeError: "ECONNREFUSED" },
      ],
      domains: [
        { id: "d", name: "site", expiresAt: "2026-09-08" },
        { id: "bad", name: "bad", expiresAt: "invalid" },
      ],
    },
    now,
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "down");
  assert.equal(items[1].days, 1);
});
test("关闭自动采集的主机不再提示断线", () => {
  const items = notificationCandidates(
    {
      servers: [
        { id: "proxy", name: "proxy", status: "offline", probeError: "timeout", collect: false },
      ],
    },
    Date.parse("2026-09-07"),
  );
  assert.deepEqual(items, []);
});
test("同一通知每天至多一次，恢复后再次故障可以提醒", () => {
  const tracker = new NotificationTracker();
  const items = [{ key: "host", id: "host" }];
  assert.equal(tracker.take(items, 0).length, 1);
  assert.equal(tracker.take(items, 1000).length, 0);
  assert.equal(tracker.take(items, 86400000).length, 1);
  tracker.take([], 86401000);
  assert.equal(tracker.take(items, 86402000).length, 1);
});
