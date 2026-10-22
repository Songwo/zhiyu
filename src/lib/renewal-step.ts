/**
 * 「标记已续费」：按计费周期把到期日顺延一期。只处理实际记录的到期日
 * （不处理日历里按周期推算出的日期），一次性费用或未填费用的资产需要手动编辑。
 */

export interface RenewableEntry {
  kind: "server" | "domain" | "cert" | "ai" | "service" | "phone";
  date: string;
  projected?: boolean;
  billing?: { cycle: "month" | "year" | "once" };
}

export interface RenewalStep {
  /** AI 订阅记录在 renewsAt，其他资产记录在 expiresAt。 */
  field: "expiresAt" | "renewsAt";
  next: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 日历日按月顺延；目标月份没有这一天时取当月最后一天。 */
export function addCycle(day: string, cycle: "month" | "year"): string {
  const [year, month, date] = day.split("-").map(Number);
  const index = year * 12 + (month - 1) + (cycle === "month" ? 1 : 12);
  const y = Math.floor(index / 12);
  const m = index % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${pad(m + 1)}-${pad(Math.min(date, last))}`;
}

export function renewalStep(entry: RenewableEntry): RenewalStep | null {
  if (entry.projected || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return null;
  const cycle = entry.billing?.cycle;
  if (cycle !== "month" && cycle !== "year") return null;
  if (entry.kind === "cert") return null;
  return {
    field: entry.kind === "ai" ? "renewsAt" : "expiresAt",
    next: addCycle(entry.date, cycle),
  };
}
