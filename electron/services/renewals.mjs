// 费用与续费的纯计算：渲染进程的续费视图、托盘通知和 ICS 导出共用这一份口径。

export const BILLING_CURRENCIES = /** @type {const} */ (["CNY", "USD"]);
export const BILLING_CYCLES = /** @type {const} */ (["month", "year", "once"]);
/** 已过期多久之内仍列在时间线上；更早的大多已经弃用，不再打扰。 */
export const OVERDUE_DAYS = 30;

/**
 * @typedef {"CNY" | "USD"} BillingCurrency
 * @typedef {"month" | "year" | "once"} BillingCycle
 * @typedef {{ amount: number, currency: BillingCurrency, cycle: BillingCycle }} Billing
 * @typedef {"server" | "domain" | "cert" | "ai" | "service" | "phone"} RenewalKind
 * @typedef {{ key: string, kind: RenewalKind, id: string, name: string, date: string, days: number, billing?: Billing, demo?: boolean }} RenewalEntry
 * @typedef {{ kind: RenewalKind, id: string, name: string, billing: Billing }} BilledItem
 * @typedef {{ monthly: number, yearly: number, once: number, count: number }} CurrencyTotals
 * @typedef {{ byCurrency: Record<BillingCurrency, CurrencyTotals>, unpriced: number }} SpendSummary
 */

/**
 * 旧数据没有费用字段，导入的数据也可能残缺；不合法时视为未填写，而不是报错丢弃整条资产。
 * @param {unknown} value
 * @returns {Billing | undefined}
 */
export function normalizeBilling(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = /** @type {Record<string, unknown>} */ (value);
  const amount = typeof item.amount === "string" ? Number(item.amount) : item.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e9)
    return undefined;
  const currency = BILLING_CURRENCIES.find((x) => x === item.currency);
  const cycle = BILLING_CYCLES.find((x) => x === item.cycle);
  if (!currency || !cycle) return undefined;
  return { amount: Math.round(amount * 100) / 100, currency, cycle };
}

/**
 * 表单里的三个字段转成费用；金额留空表示不记录费用。
 * @param {{ amount?: string, currency?: string, cycle?: string }} form
 * @returns {Billing | undefined}
 */
export function billingFromForm(form) {
  const raw = (form.amount ?? "").trim().replace(/[,，]/g, "");
  if (!raw) return undefined;
  const billing = normalizeBilling({
    amount: Number(raw),
    currency: form.currency || "CNY",
    cycle: form.cycle || "year",
  });
  if (!billing) throw new Error("费用金额无效，请输入不小于 0 的数字");
  return billing;
}

/**
 * 统一成本地日历日期。纯日期按字面取，带时间的按本地时区换算，避免跨日。
 * @param {unknown} value
 * @returns {string}
 */
export function calendarDay(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const time = Date.parse(text + "T00:00:00Z");
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? text : "";
  }
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * 距离某个日历日还有几天；今天为 0，已过期为负数。
 * @param {string} day
 * @param {Date} [now]
 */
export function daysUntilDay(day, now = new Date()) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.parse(day + "T00:00:00Z") - today) / 86_400_000);
}

/**
 * AI 订阅只有美元月费；未知月费（OAuth 平台没给）不算作 0。
 * @param {{ monthlyUsd?: number, monthlyUsdKnown?: boolean }} asset
 * @returns {Billing | undefined}
 */
function aiBilling(asset) {
  if (asset.monthlyUsdKnown === false) return undefined;
  if (typeof asset.monthlyUsd !== "number" || !(asset.monthlyUsd > 0)) return undefined;
  return normalizeBilling({ amount: asset.monthlyUsd, currency: "USD", cycle: "month" });
}

/**
 * 所有带续费或到期日期的资产，以及它们的费用（如果填写了）。
 * @param {any} snapshot
 * @returns {{ kind: RenewalKind, id: string, name: string, date: string, billing?: Billing, demo?: boolean }[]}
 */
function renewableAssets(snapshot) {
  /** @type {{ kind: RenewalKind, id: string, name: string, date: string, billing?: Billing, demo?: boolean }[]} */
  const out = [];
  /** @param {RenewalKind} kind @param {any} x @param {string} name @param {unknown} date @param {Billing | undefined} billing */
  const add = (kind, x, name, date, billing) => {
    if (!x || typeof x.id !== "string") return;
    out.push({
      kind,
      id: x.id,
      name: name || x.id,
      date: calendarDay(date),
      ...(billing ? { billing } : {}),
      ...(x.demo ? { demo: true } : {}),
    });
  };
  for (const x of snapshot.servers ?? [])
    add("server", x, x.name, x.expiresAt, normalizeBilling(x.billing));
  for (const x of snapshot.domains ?? [])
    add("domain", x, x.name, x.expiresAt, normalizeBilling(x.billing));
  for (const x of snapshot.services ?? [])
    add("service", x, x.name, x.expiresAt, normalizeBilling(x.billing));
  for (const x of snapshot.phoneNumbers ?? [])
    add(
      "phone",
      x,
      x.label ||
        "••••" +
          String(x.number ?? "")
            .replace(/\D/g, "")
            .slice(-4),
      x.expiresAt,
      normalizeBilling(x.billing),
    );
  for (const x of snapshot.aiAssets ?? [])
    add("ai", x, x.name, x.oauthAccountId ? x.subscriptionExpiresAt : x.renewsAt, aiBilling(x));
  for (const x of snapshot.certs ?? []) add("cert", x, x.cn, x.expiresAt, undefined);
  return out;
}

/**
 * 时间线：从 `OVERDUE_DAYS` 天前到未来 `withinDays` 天内到期的资产，按日期排序。
 * @param {any} snapshot
 * @param {{ withinDays?: number, now?: Date }} [options]
 * @returns {RenewalEntry[]}
 */
export function renewalTimeline(snapshot, { withinDays = 90, now = new Date() } = {}) {
  return renewableAssets(snapshot)
    .filter((x) => x.date)
    .map((x) => ({ ...x, key: `${x.kind}:${x.id}`, days: daysUntilDay(x.date, now) }))
    .filter((x) => x.days >= -OVERDUE_DAYS && x.days <= withinDays)
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/**
 * 续费日历：每项资产在 `from`–`to`（含）之间的续费日。到期日本身照常列出；
 * 月付、年付再按周期向后推算之后的续费日，标记为 `projected`。一次性费用和未填费用只列到期日。
 * @param {any} snapshot
 * @param {{ from: string, to: string, now?: Date }} range 日历日 YYYY-MM-DD
 * @returns {(RenewalEntry & { projected: boolean })[]}
 */
export function renewalCalendar(snapshot, { from, to, now = new Date() }) {
  /** @type {(RenewalEntry & { projected: boolean })[]} */
  const out = [];
  for (const x of renewableAssets(snapshot)) {
    if (!x.date) continue;
    const step = x.billing?.cycle === "month" ? 1 : x.billing?.cycle === "year" ? 12 : 0;
    // 最多推算 50 年，避免很早以前的到期日在长区间里空转。
    for (let n = 0; n <= 600; n++) {
      const date = n === 0 ? x.date : addMonths(x.date, step * n);
      if (date > to) break;
      if (date >= from)
        out.push({
          ...x,
          key: `${x.kind}:${x.id}:${date}`,
          date,
          days: daysUntilDay(date, now),
          projected: n > 0,
        });
      if (!step) break;
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/**
 * 按月推算日历日；目标月份没有这一天时取当月最后一天（1 月 31 日 → 2 月 28/29 日）。
 * @param {string} day
 * @param {number} months
 */
function addMonths(day, months) {
  const [year, month, date] = day.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = index % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return [y, String(m + 1).padStart(2, "0"), String(Math.min(date, last)).padStart(2, "0")].join(
    "-",
  );
}

/**
 * 填写了费用的资产，不论有没有日期。
 * @param {any} snapshot
 * @returns {BilledItem[]}
 */
export function billedItems(snapshot) {
  return renewableAssets(snapshot).flatMap((x) =>
    x.billing ? [{ kind: x.kind, id: x.id, name: x.name, billing: x.billing }] : [],
  );
}

const emptyTotals = () => ({ monthly: 0, yearly: 0, once: 0, count: 0 });
const cents = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * 按币种折算月度与年度支出：年付摊到每月，月付乘 12 计入全年；一次性费用单列，不计入周期支出。
 * 不做汇率换算，人民币和美元分开合计。
 * @param {any} snapshot
 * @returns {SpendSummary}
 */
export function spendSummary(snapshot) {
  /** @type {Record<BillingCurrency, CurrencyTotals>} */
  const byCurrency = { CNY: emptyTotals(), USD: emptyTotals() };
  let unpriced = 0;
  for (const x of renewableAssets(snapshot)) {
    if (!x.billing) {
      // 证书大多免费，不算“漏填费用”。
      if (x.kind !== "cert" && x.date) unpriced += 1;
      continue;
    }
    const totals = byCurrency[x.billing.currency];
    totals.count += 1;
    if (x.billing.cycle === "month") {
      totals.monthly += x.billing.amount;
      totals.yearly += x.billing.amount * 12;
    } else if (x.billing.cycle === "year") {
      totals.monthly += x.billing.amount / 12;
      totals.yearly += x.billing.amount;
    } else totals.once += x.billing.amount;
  }
  for (const totals of Object.values(byCurrency)) {
    totals.monthly = cents(totals.monthly);
    totals.yearly = cents(totals.yearly);
    totals.once = cents(totals.once);
  }
  return { byCurrency, unpriced };
}

/**
 * 只有用户设置了汇率（1 美元兑多少人民币）时才合并成人民币总额。
 * @param {SpendSummary} summary
 * @param {unknown} usdToCny
 * @returns {{ monthly: number, yearly: number, once: number } | null}
 */
export function combinedInCny(summary, usdToCny) {
  if (typeof usdToCny !== "number" || !Number.isFinite(usdToCny) || usdToCny <= 0) return null;
  const { CNY, USD } = summary.byCurrency;
  return {
    monthly: cents(CNY.monthly + USD.monthly * usdToCny),
    yearly: cents(CNY.yearly + USD.yearly * usdToCny),
    once: cents(CNY.once + USD.once * usdToCny),
  };
}

/**
 * 时间线窗口内到期项目的费用合计（每项按一次续费计），分币种。
 * @param {RenewalEntry[]} entries
 * @returns {Record<BillingCurrency, number>}
 */
export function dueTotals(entries) {
  /** @type {Record<BillingCurrency, number>} */
  const out = { CNY: 0, USD: 0 };
  for (const x of entries) if (x.billing) out[x.billing.currency] += x.billing.amount;
  return { CNY: cents(out.CNY), USD: cents(out.USD) };
}

/**
 * 托盘通知用：服务器和服务资产新增的到期日（域名、证书、AI、号码沿用原有规则）。
 * @param {any} snapshot
 * @param {Date} [now]
 * @param {number} [withinDays]
 */
export function extraExpiryCandidates(snapshot, now = new Date(), withinDays = 21) {
  return renewableAssets(snapshot)
    .filter((x) => (x.kind === "server" || x.kind === "service") && x.date && !x.demo)
    .map((x) => ({ ...x, days: daysUntilDay(x.date, now) }))
    .filter((x) => x.days <= withinDays);
}
