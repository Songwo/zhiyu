import { renewableAssets, daysUntilDay } from "./renewals.mjs";

/** @param {unknown} value @param {boolean} [strict]
 * @returns {import('../../src/lib/types').ExpiryReminder | undefined} */
export function normalizeExpiryReminder(value, strict = true) {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = /** @type {Record<string, unknown>} */ (value);
    if (
      typeof item.enabled === "boolean" &&
      Number.isInteger(item.leadDays) &&
      Number(item.leadDays) >= 0 &&
      Number(item.leadDays) <= 90
    )
      return { enabled: item.enabled, leadDays: Number(item.leadDays) };
  }
  if (strict) throw new Error("到期提醒设置无效，提前天数需为 0 到 90。");
  // Damaged explicit settings must not silently re-enable legacy notifications.
  return { enabled: false, leadDays: 3 };
}

/** Derived rows are never stored in the manual reminders collection.
 * @param {any} snapshot @param {Date} [now] */
export function assetExpiryReminders(snapshot, now = new Date()) {
  return renewableAssets(snapshot)
    .filter((asset) => asset.date && !asset.demo)
    .map((asset) => ({
      ...asset,
      key: `asset-expiry:${asset.kind}:${asset.id}`,
      source: /** @type {const} */ ("asset"),
      expiryReminder: normalizeExpiryReminder(asset.expiryReminder, false),
      days: daysUntilDay(asset.date, now),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** @param {{ expiryReminder?: import('../../src/lib/types').ExpiryReminder } | null | undefined} asset
 * @param {boolean} [isNew] */
export function expiryReminderFormValues(asset, isNew = false) {
  const setting = normalizeExpiryReminder(asset?.expiryReminder, false);
  return {
    expiryReminderMode: setting ? (setting.enabled ? "on" : "off") : isNew ? "on" : "legacy",
    expiryReminderDays: String(setting?.leadDays ?? 3),
  };
}

/** @param {{ expiryReminderMode?: string, expiryReminderDays?: string }} form */
export function expiryReminderFromForm(form) {
  if (!form.expiryReminderMode || form.expiryReminderMode === "legacy") return undefined;
  return normalizeExpiryReminder({
    enabled: form.expiryReminderMode === "on",
    leadDays: Number(form.expiryReminderDays ?? 3),
  });
}
