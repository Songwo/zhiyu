import { phoneExpiry } from "./phone-numbers.mjs";
import { extraExpiryCandidates } from "./renewals.mjs";
import { dueReminders } from "./reminders.mjs";

/** @typedef {{ key: string, kind: string, id: string, name: string, reason: "offline" | "expiry" | "reminder", days?: number }} AttentionItem */

/**
 * leadDays：资产到期前多少天开始提醒（号码至少 30 天）。
 * @param {any} snapshot @param {number} [now] @param {{ leadDays?: number }} [options]
 * @returns {AttentionItem[]}
 */
export function notificationCandidates(snapshot, now = Date.now(), { leadDays = 21 } = {}) {
  /** @type {AttentionItem[]} */
  const out = [];
  for (const s of snapshot.servers ?? []) {
    if (s.demo) continue;
    if (s.status === "offline" && s.probeError && s.collect !== false)
      out.push({
        key: `server:${s.id}`,
        kind: "server",
        id: s.id,
        name: s.name,
        reason: "offline",
      });
  }
  for (const [kind, list] of [
    ["domain", snapshot.domains],
    ["cert", snapshot.certs],
    ["ai", snapshot.aiAssets],
  ]) {
    for (const x of list ?? []) {
      if (x.demo) continue;
      const date = kind === "ai" ? x.renewsAt : x.expiresAt;
      const days = Math.ceil((Date.parse(date) - now) / 86_400_000);
      if (!Number.isFinite(days) || days > leadDays) continue;
      out.push({
        key: `${kind}:${x.id}:${date}:${days <= 0 ? "expired" : days <= 7 ? "week" : "soon"}`,
        kind,
        id: x.id,
        name: x.name ?? x.cn,
        reason: "expiry",
        days,
      });
    }
  }
  // 服务器（VPS）和服务资产的到期日是可选字段，只在填写后提醒。
  for (const x of extraExpiryCandidates(snapshot, new Date(now), leadDays)) {
    out.push({
      key: `${x.kind}:${x.id}:expiry:${x.date}:${x.days <= 0 ? "expired" : x.days <= 7 ? "week" : "soon"}`,
      kind: x.kind,
      id: x.id,
      name: x.name,
      reason: "expiry",
      days: x.days,
    });
  }
  for (const phone of snapshot.phoneNumbers ?? []) {
    const { days, status } = phoneExpiry(phone.expiresAt, new Date(now));
    if (days === null || days > Math.max(30, leadDays)) continue;
    out.push({
      key: `phone:${phone.id}:${phone.expiresAt}:${status}:${days <= 7 ? "week" : "soon"}`,
      kind: "phone",
      id: phone.id,
      name: phone.label || "••••" + phone.number.replace(/\D/g, "").slice(-4),
      reason: "expiry",
      days,
    });
  }
  for (const { reminder, days } of dueReminders(snapshot.reminders, new Date(now))) {
    out.push({
      key: `reminder:${reminder.id}:${reminder.dueAt}:${days < 0 ? "overdue" : days === 0 ? "today" : days === 1 ? "tomorrow" : "soon"}`,
      kind: "reminder",
      id: reminder.id,
      name: reminder.title,
      reason: "reminder",
      days,
    });
  }
  return out;
}

/** 通知与推送共用的一行文字。 @param {AttentionItem} item @param {boolean} [en] */
export function attentionLine(item, en = false) {
  if (item.reason === "offline") return `${item.name}: ${en ? "Connection failed" : "连接失败"}`;
  const days = item.days ?? 0;
  if (item.reason === "reminder")
    return `${item.name}: ${days < 0 ? (en ? `${-days} days overdue` : `已过期 ${-days} 天`) : days === 0 ? (en ? "today" : "今天") : en ? `in ${days} days` : `${days} 天后`}`;
  return `${item.name}: ${days <= 0 ? (en ? "Expired" : "已到期") : en ? `Expires in ${days} days` : `${days} 天后到期`}`;
}

export class NotificationTracker {
  #seen = new Map();
  /** @param {AttentionItem[]} candidates @param {number} [now] */
  take(candidates, now = Date.now()) {
    const current = new Set(candidates.map((x) => x.key));
    for (const key of this.#seen.keys()) if (!current.has(key)) this.#seen.delete(key);
    return candidates.filter((x) => {
      const last = this.#seen.get(x.key);
      if (last !== undefined && now - last < 86_400_000) return false;
      this.#seen.set(x.key, now);
      return true;
    });
  }
}
