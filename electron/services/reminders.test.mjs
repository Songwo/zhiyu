import test from "node:test";
import assert from "node:assert/strict";
import {
  completeReminder,
  daysUntil,
  dueReminders,
  normalizeReminder,
  normalizeReminders,
  shiftDay,
} from "./reminders.mjs";
import { attentionLine, notificationCandidates } from "./notifications.mjs";
import { normalizeSnapshotImages } from "./image-data.mjs";

const base = (patch = {}) => ({
  id: "rem-1",
  title: " 宽带续费 ",
  note: "",
  dueAt: "2026-11-01",
  repeat: "year",
  leadDays: 7,
  ...patch,
});
const at = (day) => new Date(`${day}T10:00:00`);

test("提醒：清理标题，拒绝空标题、坏日期和越界的提前天数", () => {
  const r = normalizeReminder(base());
  assert.equal(r.title, "宽带续费");
  assert.equal(r.repeat, "year");
  assert.equal(normalizeReminder(base({ repeat: "weird" })).repeat, "none");
  assert.throws(() => normalizeReminder(base({ title: " " })), /提醒内容/);
  assert.throws(() => normalizeReminder(base({ dueAt: "2026-02-30" })), /日期/);
  assert.throws(() => normalizeReminder(base({ leadDays: 91 })));
  assert.throws(() => normalizeReminder(base({ id: "__proto__" })));
  assert.throws(() => normalizeReminder(base({ asset: { kind: "nope", id: "x" } })));
  assert.deepEqual(normalizeReminder(base({ asset: { kind: "server", id: "s1" } })).asset, {
    kind: "server",
    id: "s1",
  });
});

test("提醒列表：宽松模式丢坏数据，严格模式报错，标识不能重复", () => {
  assert.equal(normalizeReminders([base(), { id: "x" }], false).length, 1);
  assert.throws(() => normalizeReminders([base(), base()]));
  assert.deepEqual(normalizeReminders(undefined), []);
  const snap = normalizeSnapshotImages({ reminders: [base()] });
  assert.equal(snap.reminders[0].title, "宽带续费");
});

test("顺延：每周、每月月底收短、每年闰日", () => {
  assert.equal(shiftDay("2026-12-29", "week"), "2027-01-05");
  assert.equal(shiftDay("2027-01-31", "month"), "2027-02-28");
  assert.equal(shiftDay("2028-02-29", "year"), "2029-02-28");
});

test("完成：不重复的标为完成，重复的跳到今天之后的下一期", () => {
  const once = completeReminder(normalizeReminder(base({ repeat: "none" })), at("2026-10-23"));
  assert.equal(once.done, true);
  assert.equal(once.doneAt, "2026-10-23");
  const monthly = completeReminder(
    normalizeReminder(base({ repeat: "month", dueAt: "2026-08-15" })),
    at("2026-10-23"),
  );
  assert.equal(monthly.dueAt, "2026-11-15");
  assert.equal(monthly.done, undefined);
});

test("倒计时与提醒窗口：按本地日历日，提前天数内和已过期的才提醒", () => {
  const now = at("2026-10-25");
  assert.equal(daysUntil("2026-11-01", now), 7);
  assert.equal(daysUntil("2026-10-24", now), -1);
  const list = normalizeReminders([
    base({ id: "a", dueAt: "2026-11-01", leadDays: 7 }),
    base({ id: "b", dueAt: "2026-11-02", leadDays: 7 }),
    base({ id: "c", dueAt: "2026-10-20", leadDays: 0 }),
    base({ id: "d", dueAt: "2026-10-26", done: true, doneAt: "2026-10-24" }),
  ]);
  assert.deepEqual(
    dueReminders(list, now).map((x) => x.reminder.id),
    ["c", "a"],
  );
});

test("通知候选：提醒进入候选，资产提前天数可调", () => {
  const now = at("2026-10-25").getTime();
  const snapshot = {
    reminders: normalizeReminders([base({ dueAt: "2026-10-27", leadDays: 3 })]),
    domains: [{ id: "d1", name: "example.com", expiresAt: "2026-11-20" }],
  };
  const items = notificationCandidates(snapshot, now);
  assert.equal(items.find((x) => x.reason === "reminder")?.days, 2);
  assert.equal(
    items.some((x) => x.kind === "domain"),
    false,
  );
  assert.equal(
    notificationCandidates(snapshot, now, { leadDays: 30 }).some((x) => x.kind === "domain"),
    true,
  );
  assert.equal(attentionLine(items[0]), "宽带续费: 2 天后");
  assert.equal(attentionLine({ ...items[0], days: -3 }), "宽带续费: 已过期 3 天");
});
