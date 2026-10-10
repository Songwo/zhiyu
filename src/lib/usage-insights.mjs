/** @typedef {import('./usage').UsageRecord} UsageRecord */

/** @param {UsageRecord} row */
export function usageDay(row) {
  if (!row.bucketStart) return "";
  if (row.origin !== "local") return row.bucketStart.slice(0, 10);
  const day = new Date(row.bucketStart);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** 按来源范围筛选，组织账单与本机日志始终独立。日桶按其统计日筛选。
 * @param {UsageRecord[]} rows
 * @param {{category?:string, source?:string, period?:string, model?:string}} filters
 * @param {number} now
 */
export function filterUsage(rows, filters = {}, now = Date.now()) {
  const { category = "all", source = "all", period = "30", model = "all" } = filters;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period !== "all") start.setDate(start.getDate() - Math.max(0, Number(period) - 1));
  const startDay = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  return rows
    .filter((row) => {
      const rowCategory =
        row.kind === "tokens" ? (row.origin === "local" ? "local" : "api") : row.kind;
      const inPeriod =
        period === "all" ||
        (row.bucketStart
          ? usageDay(row) >= startDay
          : Date.parse(row.checkedAt) >= start.getTime());
      return (
        (category === "all" || category === rowCategory) &&
        (source === "all" || row.sourceId === source) &&
        (model === "all" || row.kind !== "tokens" || row.model === model) &&
        inPeriod
      );
    })
    .sort((a, b) => (b.bucketStart ?? b.checkedAt).localeCompare(a.bucketStart ?? a.checkedAt));
}

/** @param {UsageRecord} row */
function recordCategory(row) {
  return row.kind === "tokens" ? (row.origin === "local" ? "local" : "api") : row.kind;
}

/** @param {string} type */
function sourceCategory(type) {
  if (type.startsWith("local-")) return "local";
  if (type.endsWith("-api") || type === "api") return "api";
  if (type === "oauth") return "quota";
  if (type === "subscription" || type === "3x-ui" || type === "traffic") return "traffic";
  return type;
}

/** 来源身份按 ID 保留；公开名称优先于历史记录中的旧名称。
 * @param {import('./usage').UsageState} data
 * @param {{category?: string, source?: string}} filters
 */
export function usageFilterOptions(data, { category = "all", source = "all" } = {}) {
  const entries = new Map(
    data.sources.map((item) => [
      item.id,
      {
        id: item.id,
        name: item.name,
        type: item.type,
        removed: false,
        categories: new Set([sourceCategory(item.type)]),
      },
    ]),
  );
  for (const row of data.records) {
    const kind = recordCategory(row);
    const entry = entries.get(row.sourceId);
    if (entry) entry.categories.add(kind);
    else
      entries.set(row.sourceId, {
        id: row.sourceId,
        name: row.sourceName,
        type: kind === "local" ? "local-log" : kind === "quota" ? "oauth" : kind,
        removed: true,
        categories: new Set([kind]),
      });
  }
  const nameCounts = new Map();
  for (const item of entries.values())
    nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
  const sources = [...entries.values()]
    .filter((item) => category === "all" || item.categories.has(category))
    .map(({ categories: _, ...item }) => ({ ...item, duplicate: nameCounts.get(item.name) > 1 }));
  const models = [
    ...new Set(
      data.records
        .filter(
          (row) =>
            row.kind === "tokens" &&
            (category === "all" || recordCategory(row) === category) &&
            (source === "all" || row.sourceId === source),
        )
        .map((row) => row.model)
        .filter((value) => typeof value === "string")
        .filter((value) => value.length > 0),
    ),
  ].sort();
  return { sources, models };
}

/** 切换类型、来源或收到来源变更时，清理不可用的筛选条件。
 * @param {import('./usage').UsageState} data
 * @param {{category?: string, source?: string, period?: string, model?: string}} filters
 */
export function normalizeUsageFilters(data, filters) {
  const next = { category: "all", source: "all", period: "30", model: "all", ...filters };
  let options = usageFilterOptions(data, next);
  if (next.source !== "all" && !options.sources.some((item) => item.id === next.source)) {
    next.source = "all";
    options = usageFilterOptions(data, next);
  }
  if (next.model !== "all" && !options.models.includes(next.model)) next.model = "all";
  return next;
}

/** 机场累计额度只展示供应商计数，与本机客户端统计独立。
 * @param {UsageRecord | undefined} row
 * @param {number} now
 */
export function subscriptionTrafficSummary(row, now = Date.now()) {
  const used = row ? (row.upload ?? 0) + (row.download ?? 0) : null;
  const total = row?.total ?? null;
  const limited = total != null && total > 0;
  return {
    used,
    total,
    unlimited: total === 0,
    remaining: limited && used != null ? Math.max(total - used, 0) : null,
    percent: limited && used != null ? Math.min(100, Math.max(0, (used / total) * 100)) : null,
    exceeded: limited && used != null && used > total,
    exhausted: limited && used != null && used >= total,
    expired: Boolean(row?.expiresAt && Date.parse(row.expiresAt) <= now),
  };
}

/** 连接信息变更后，历史流量不能作为新订阅当前套餐展示。
 * @param {UsageRecord[]} rows
 * @param {Pick<import('./usage').UsageSource, 'id' | 'revision'>} source
 */
export function latestSubscriptionRecord(rows, source) {
  return rows
    .filter(
      (row) =>
        row.sourceId === source.id &&
        row.kind === "traffic" &&
        (row.revision ?? 0) === (source.revision ?? 0),
    )
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
}

/** @param {UsageRecord[]} rows */
export function summarizeUsage(rows) {
  const result = {
    api: 0,
    local: 0,
    upload: 0,
    download: 0,
    trafficSamples: 0,
    unknownTraffic: 0,
    quota: 0,
  };
  const quotas = new Set();
  for (const row of rows) {
    if (row.kind === "tokens")
      result[row.origin === "local" ? "local" : "api"] += (row.input ?? 0) + (row.output ?? 0);
    if (row.kind === "traffic") {
      if (!row.counterReset && row.deltaUpload != null && row.deltaDownload != null) {
        result.upload += row.deltaUpload;
        result.download += row.deltaDownload;
        result.trafficSamples++;
      } else result.unknownTraffic++;
    }
    if (row.kind === "quota") quotas.add(row.sourceId);
  }
  result.quota = quotas.size;
  return result;
}

/** 只导出允许的统计字段；不透传扩展字段、凭据或内部文件信息。
 * @param {UsageRecord[]} rows
 */
export function exportUsage(rows) {
  const fields = /** @type {const} */ ([
    "sourceName",
    "kind",
    "origin",
    "model",
    "label",
    "checkedAt",
    "bucketStart",
    "sampleAt",
    "scope",
    "input",
    "output",
    "cached",
    "cacheWrite",
    "upload",
    "download",
    "total",
    "deltaUpload",
    "deltaDownload",
    "counterReset",
    "usedPercent",
    "used",
    "limit",
    "unit",
    "resetsAt",
    "expiresAt",
  ]);
  return rows.map((row) =>
    Object.fromEntries(
      fields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
    ),
  );
}
