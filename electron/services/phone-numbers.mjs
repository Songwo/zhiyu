import { normalizeBilling } from "./renewals.mjs";
/** @param {unknown} value @param {number} limit */
function text(value, limit) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > limit)
    throw new Error("号码记录字段格式或长度无效");
  return value.trim();
}
/** @param {string} value */
function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
/** @param {unknown} input @returns {import("../../src/lib/types").PhoneNumber} */
export function normalizePhoneNumber(input) {
  if (!input || typeof input !== "object") throw new Error("号码记录无效");
  const value = /** @type {Record<string, unknown>} */ (input);
  const id = text(value.id, 256);
  const number = text(value.number, 40);
  if (
    !id ||
    !/^\+?[\d ().-]+$/.test(number) ||
    number.replace(/\D/g, "").length < 3 ||
    number.replace(/\D/g, "").length > 20
  )
    throw new Error("请输入有效号码，可包含国际区号、空格和连字符");
  const expiresAt = text(value.expiresAt, 10);
  if (expiresAt && !validDay(expiresAt)) throw new Error("请输入有效的号码到期日期");
  if (!Array.isArray(value.subscriptionIds) || value.subscriptionIds.length > 100)
    throw new Error("号码订阅关联无效");
  const subscriptionIds = [
    ...new Set(value.subscriptionIds.map((id) => text(id, 256)).filter(Boolean)),
  ];
  const createdAt = text(value.createdAt, 40);
  const updatedAt = text(value.updatedAt, 40);
  const billing = normalizeBilling(value.billing);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt)))
    throw new Error("号码记录时间无效");
  return {
    id,
    number,
    label: text(value.label, 160),
    provider: text(value.provider, 160),
    expiresAt,
    notes: text(value.notes, 10000),
    subscriptionIds,
    createdAt,
    updatedAt,
    ...(billing ? { billing } : {}),
  };
}
/** @param {unknown} value @param {boolean} [strict] @returns {import("../../src/lib/types").PhoneNumber[]} */
export function normalizePhoneNumbers(value, strict = true) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10000) {
    if (strict) throw new Error("号码列表无效或超过 10000 条");
    return [];
  }
  const out = [];
  const ids = new Set();
  for (const input of value) {
    try {
      const row = normalizePhoneNumber(input);
      if (ids.has(row.id)) throw new Error("号码记录 ID 重复");
      ids.add(row.id);
      out.push(row);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return out;
}
/**
 * 以本地日历计算到期，避免时区与夏令时把今天误判为昨天。
 * @param {string} expiresAt
 * @param {Date} [now]
 * @returns {{status: "unknown"|"expired"|"today"|"soon"|"active", days: number|null}}
 */
export function phoneExpiry(expiresAt, now = new Date()) {
  if (!validDay(expiresAt)) return { status: "unknown", days: null };
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((Date.parse(expiresAt + "T00:00:00Z") - today) / 86400000);
  return {
    status: days < 0 ? "expired" : days === 0 ? "today" : days <= 30 ? "soon" : "active",
    days,
  };
}
