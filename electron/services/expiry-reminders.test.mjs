import assert from "node:assert/strict";
import test from "node:test";
import {
  assetExpiryReminders,
  normalizeExpiryReminder,
  expiryReminderFormValues,
  expiryReminderFromForm,
} from "./expiry-reminders.mjs";
import { notificationCandidates, NotificationTracker } from "./notifications.mjs";
import { renewalCalendar } from "./renewals.mjs";
import { normalizeSnapshotImages } from "./image-data.mjs";
import { bindResource, syncZoneFields } from "./integration-assets.mjs";

const now = new Date(2026, 10, 28, 12);
const on = { enabled: true, leadDays: 3 };
const off = { enabled: false, leadDays: 3 };
function fixture(setting = on, date = "2026-12-01") {
  const base = { id: "same-id", name: "资产", expiresAt: date, expiryReminder: setting, tags: [] };
  return {
    servers: [{ ...base }],
    domains: [{ ...base }],
    certs: [{ ...base, cn: "example.com" }],
    aiAssets: [{ ...base, renewsAt: date }],
    services: [{ ...base, category: "custom", status: "online" }],
    phoneNumbers: [
      {
        ...base,
        number: "+8613800000000",
        label: "号码",
        subscriptionIds: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  };
}
const expiry = (snapshot, at = now, options) =>
  notificationCandidates(snapshot, +at, options).filter((x) => x.reason === "expiry");

test("六类资产各生成一条关联提醒，不受同名 ID 或全局提前天数干扰", () => {
  const snapshot = fixture();
  assert.equal(assetExpiryReminders(snapshot).length, 6);
  assert.equal(new Set(assetExpiryReminders(snapshot).map((r) => r.key)).size, 6);
  for (const leadDays of [0, 21, 60]) assert.equal(expiry(snapshot, now, { leadDays }).length, 6);
  assert.equal(expiry(fixture(on, "2026-12-02")).length, 0);
  assert.equal(expiry(fixture(off)).length, 0);
  assert.equal(assetExpiryReminders(fixture(off)).length, 6);
});

test("关闭提醒仍保留日历，推算续费日期不会增加通知", () => {
  const snapshot = fixture(off);
  snapshot.servers[0].billing = { amount: 45, currency: "USD", cycle: "month" };
  const rows = renewalCalendar(snapshot, { from: "2026-12-01", to: "2027-02-01" });
  assert.equal(rows.filter((r) => r.kind === "server").length, 3);
  assert.ok(rows.every((r) => r.expiryReminder.enabled === false));
  assert.equal(expiry(snapshot).length, 0);
});

test("日期、名称和金额始终来自资产；续费与撤销不新增关联记录", () => {
  const snapshot = fixture();
  const asset = snapshot.servers[0];
  const key = assetExpiryReminders(snapshot).find((r) => r.kind === "server").key;
  asset.name = "新名称";
  asset.billing = { amount: 45, currency: "USD", cycle: "year" };
  asset.expiresAt = "2027-12-01";
  const row = assetExpiryReminders(snapshot).find((r) => r.key === key);
  assert.equal(row.name, "新名称");
  assert.equal(row.billing.amount, 45);
  assert.equal(row.date, "2027-12-01");
  assert.equal(expiry(snapshot).length, 5);
  asset.expiresAt = "2026-12-01";
  assert.equal(expiry(snapshot).length, 6);
  asset.expiresAt = "";
  assert.equal(assetExpiryReminders(snapshot).length, 5);
  snapshot.servers = [];
  assert.equal(assetExpiryReminders(snapshot).length, 5);
});

test("旧资产沿用全局规则和号码至少 30 天规则，普通提醒保持独立", () => {
  const snapshot = fixture();
  for (const list of Object.values(snapshot)) for (const asset of list) delete asset.expiryReminder;
  snapshot.reminders = [
    {
      id: "manual",
      title: "手动",
      dueAt: "2026-12-01",
      leadDays: 3,
      repeat: "none",
      asset: { kind: "server", id: "same-id" },
    },
  ];
  assert.equal(expiry(snapshot, now, { leadDays: 0 }).length, 1);
  assert.equal(expiry(snapshot, now, { leadDays: 21 }).length, 6);
  assert.equal(
    notificationCandidates(snapshot, +now).filter((x) => x.reason === "reminder").length,
    1,
  );
  assert.equal(
    assetExpiryReminders(snapshot).filter((r) => r.expiryReminder === undefined).length,
    6,
  );
});

test("通知按稳定资产和日期去重，过期持续提醒；关闭不影响故障告警", () => {
  const snapshot = fixture(on, "2026-11-28");
  const tracker = new NotificationTracker();
  assert.equal(tracker.take(expiry(snapshot), +now).length, 6);
  assert.equal(tracker.take(expiry(snapshot), +now + 1000).length, 0);
  const tomorrow = new Date(2026, 10, 29, 12);
  assert.equal(tracker.take(expiry(snapshot, tomorrow), +tomorrow).length, 6);
  snapshot.servers[0] = {
    ...snapshot.servers[0],
    expiryReminder: off,
    status: "offline",
    probeError: "unreachable",
  };
  assert.ok(notificationCandidates(snapshot, +now).some((x) => x.reason === "offline"));
  assert.equal(expiry(snapshot).length, 5);
});

test("当天提醒与跨月闰日使用本地日历日期", () => {
  const setting = { enabled: true, leadDays: 0 };
  assert.equal(expiry(fixture(setting, "2026-11-28")).length, 6);
  assert.equal(expiry(fixture(setting, "2026-11-29")).length, 0);
  assert.equal(expiry(fixture(on, "2028-03-01"), new Date(2028, 1, 27, 23)).length, 6);
  assert.equal(expiry(fixture(on, "2026-02-30")).length, 0);
});

test("AI 授权订阅使用服务商日期，域名同步保留用户提醒设置", () => {
  const snapshot = fixture();
  snapshot.aiAssets[0].oauthAccountId = "oauth";
  snapshot.aiAssets[0].subscriptionExpiresAt = "2027-01-01";
  assert.equal(expiry(snapshot).length, 5);
  snapshot.aiAssets[0].subscriptionExpiresAt = "2026-12-01";
  assert.equal(expiry(snapshot).length, 6);
  const synced = syncZoneFields(
    { ...snapshot.domains[0], expiryReminder: off },
    { zone: { expiresAt: "2027-01-01" } },
    +now,
  );
  assert.deepEqual(synced.expiryReminder, off);
});

test("快照规范化及 JSON 备份往返保留六类设置，非法值严格拒绝、恢复时关闭", () => {
  const snapshot = fixture(off);
  const restored = normalizeSnapshotImages(JSON.parse(JSON.stringify(snapshot)));
  for (const list of Object.values(restored)) assert.deepEqual(list[0].expiryReminder, off);
  assert.equal(expiry(restored).length, 0);
  for (const key of Object.keys(snapshot)) {
    const bad = fixture();
    bad[key][0].expiryReminder = { enabled: "false", leadDays: -1 };
    assert.throws(() => normalizeSnapshotImages(bad));
    assert.deepEqual(normalizeSnapshotImages(bad, { strict: false })[key][0].expiryReminder, off);
  }
});

test("新建默认提前三天；旧表单往返不改变继承规则，关闭和自定义天数可往返", () => {
  assert.deepEqual(expiryReminderFromForm(expiryReminderFormValues(null, true)), on);
  assert.equal(expiryReminderFromForm(expiryReminderFormValues({})), undefined);
  for (const setting of [off, { enabled: true, leadDays: 21 }, { enabled: true, leadDays: 0 }])
    assert.deepEqual(
      expiryReminderFromForm(expiryReminderFormValues({ expiryReminder: setting })),
      setting,
    );
  for (const value of [
    null,
    [],
    false,
    { enabled: true, leadDays: 91 },
    { enabled: true, leadDays: 1.5 },
  ])
    assert.throws(() => normalizeExpiryReminder(value));
});

test("没有日期和演示资产不产生关联提醒及通知", () => {
  assert.equal(assetExpiryReminders(fixture(on, "")).length, 0);
  const snapshot = fixture();
  for (const list of Object.values(snapshot)) list[0].demo = true;
  assert.equal(assetExpiryReminders(snapshot).length, 0);
  assert.equal(expiry(snapshot).length, 0);
});

test("外部绑定新建资产默认开启，重新绑定保留已有关闭设置或继承状态", () => {
  for (const [provider, type, collection] of [
    ["cloudflare", "zone", "domains"],
    ["probe", "host", "servers"],
    ["cloudflare", "worker", "services"],
  ]) {
    const connection = { provider, id: "connection" };
    const resource = { type, remoteId: "remote", name: "example.com", url: "https://example.com" };
    const { snapshot } = bindResource({}, connection, resource);
    assert.deepEqual(snapshot[collection][0].expiryReminder, on);
    snapshot[collection][0].expiryReminder = off;
    assert.deepEqual(
      bindResource(snapshot, connection, resource).snapshot[collection][0].expiryReminder,
      off,
    );
    delete snapshot[collection][0].expiryReminder;
    assert.equal(
      bindResource(snapshot, connection, resource).snapshot[collection][0].expiryReminder,
      undefined,
    );
  }
});
