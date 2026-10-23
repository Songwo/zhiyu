/**
 * 备忘提醒：自己写的事项与日期（续费、证件、保修、交费……），可重复，按「提前几天」提醒。
 * 只是普通资料，和资产一起保存、备份；不保存任何凭据。
 */
import { calendarDay } from "./renewals.mjs";

export const REPEATS = ["none", "week", "month", "year"];
export const MAX_REMINDERS = 500;
const KINDS = new Set(["server", "domain", "mail", "ai", "secret", "cert", "service"]);
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** @param {unknown} value @param {number} max @param {string} message */
const text = (value, max, message) => {
  const result = value ?? "";
  if (typeof result !== "string" || result.length > max) throw new Error(message);
  return result.trim();
};

/** @param {unknown} value @returns {import('../../src/lib/types').Reminder} */
export function normalizeReminder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("提醒无效。");
  const item = /** @type {Record<string, unknown>} */ (value);
  const id = text(item.id, 200, "提醒标识无效。");
  const title = text(item.title, 80, "提醒标题过长或格式不正确。");
  if (!id || FORBIDDEN.has(id) || !title) throw new Error("请填写提醒内容。");
  const dueAt = calendarDay(item.dueAt);
  if (!dueAt) throw new Error("请填写提醒日期。");
  const repeat = REPEATS.includes(/** @type {string} */ (item.repeat))
    ? /** @type {"none"} */ (item.repeat)
    : "none";
  const lead = item.leadDays ?? 3;
  if (
    !Number.isInteger(lead) ||
    /** @type {number} */ (lead) < 0 ||
    /** @type {number} */ (lead) > 90
  )
    throw new Error("提前提醒天数需为 0 到 90。");
  let asset;
  if (item.asset != null) {
    const ref = /** @type {Record<string, unknown>} */ (item.asset);
    if (
      typeof ref !== "object" ||
      !KINDS.has(/** @type {string} */ (ref.kind)) ||
      typeof ref.id !== "string" ||
      !ref.id ||
      ref.id.length > 200
    )
      throw new Error("提醒关联的资产无效。");
    asset = { kind: /** @type {import('../../src/lib/types').AssetKind} */ (ref.kind), id: ref.id };
  }
  const doneAt = item.done === true ? calendarDay(item.doneAt) : undefined;
  return {
    id,
    title,
    note: text(item.note, 1000, "提醒备注过长。"),
    dueAt,
    repeat,
    leadDays: /** @type {number} */ (lead),
    ...(item.done === true ? { done: true } : {}),
    ...(doneAt ? { doneAt } : {}),
    ...(asset ? { asset } : {}),
  };
}

/** @param {unknown} value @param {boolean} [strict] @returns {import('../../src/lib/types').Reminder[]} */
export function normalizeReminders(value, strict = true) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REMINDERS) {
    if (strict) throw new Error(`提醒列表无效或超过 ${MAX_REMINDERS} 条。`);
    return [];
  }
  const result = [],
    ids = new Set();
  for (const entry of value) {
    try {
      const item = normalizeReminder(entry);
      if (ids.has(item.id)) throw new Error("提醒标识重复。");
      ids.add(item.id);
      result.push(item);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return result;
}

/** @param {number} n */
const pad = (n) => String(n).padStart(2, "0");
/** 本地日历日 YYYY-MM-DD。 @param {Date} date */
export const localDay = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 顺延一期；月底取较短月份的最后一天。 @param {string} day @param {string} repeat */
export function shiftDay(day, repeat) {
  const [y, m, d] = day.split("-").map(Number);
  if (repeat === "week") {
    const date = new Date(Date.UTC(y, m - 1, d + 7));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  const months = repeat === "year" ? 12 : 1;
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12),
    nm = index % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

/** 距离到期还有几天（本地日历日，今天为 0，过期为负）。 @param {string} dueAt @param {Date} [now] */
export function daysUntil(dueAt, now = new Date()) {
  const [y, m, d] = dueAt.split("-").map(Number);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
}

/**
 * 完成一次：不重复的标为已完成；重复的顺延到今天之后的下一期，保持未完成。
 * @param {import('../../src/lib/types').Reminder} reminder @param {Date} [now]
 */
export function completeReminder(reminder, now = new Date()) {
  const today = localDay(now);
  if (reminder.repeat === "none") return { ...reminder, done: true, doneAt: today };
  let next = shiftDay(reminder.dueAt, reminder.repeat);
  for (let i = 0; i < 1000 && next <= today; i++) next = shiftDay(next, reminder.repeat);
  const { done: _done, doneAt: _doneAt, ...rest } = reminder;
  return { ...rest, dueAt: next };
}

/** 进入提醒窗口的未完成提醒（今天起 leadDays 天内或已过期），按日期排序。 @param {import('../../src/lib/types').Reminder[]} list @param {Date} [now] */
export function dueReminders(list, now = new Date()) {
  return (list ?? [])
    .filter((r) => !r.done)
    .map((r) => ({ reminder: r, days: daysUntil(r.dueAt, now) }))
    .filter(({ reminder, days }) => days <= reminder.leadDays)
    .sort((a, b) => a.days - b.days);
}
