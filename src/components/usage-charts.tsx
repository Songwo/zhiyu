import { useId, useMemo, useState } from "react";
import { BarChart3, ChevronDown } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Rectangle,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageRecord } from "@/lib/usage";
import { usageBytes } from "@/lib/usage";
import {
  buildQuotaChart,
  buildUsageChart,
  chartMetric,
  smallUsagePoints,
  todayUsagePoint,
} from "@/lib/usage-charts.mjs";
import { intlLocale, t } from "@/lib/i18n";
import { Select } from "./ui/select";
import "./usage-charts.css";

type Metric = "api" | "local" | "traffic" | "quota";
const metricKeys = {
  api: "API Token",
  local: "本机 Token",
  traffic: "流量增量",
  quota: "订阅额度",
};
const compact = (value: number) =>
  new Intl.NumberFormat(intlLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
const shortened = (name: string) => (name.length > 18 ? `${name.slice(0, 17)}…` : name);

type BarShapeProps = Record<string, unknown> & { index?: number };

/**
 * 柱子从基线依次长出：每根柱子包一层只做 CSS 动画的 <g>，按序号错开起点。
 * 动画只在挂载时播放一次，采集更新数值时柱高直接变化，不会反复闪动。
 */
function RiseBar({ index = 0, delay = 0, axis = "y", ...props }: BarShapeProps & { delay?: number; axis?: "x" | "y" }) {
  return (
    <g
      className={axis === "y" ? "usage-bar-rise" : "usage-bar-grow"}
      style={{ animationDelay: `${delay + index * 28}ms` }}
    >
      <Rectangle {...props} />
    </g>
  );
}

function EmptyChart({ unknown = false, quota = false }: { unknown?: boolean; quota?: boolean }) {
  return (
    <div className="usage-chart-empty">
      <BarChart3 size={24} />
      <strong>
        {t(unknown ? "尚无可确认的数值" : quota ? "订阅账号还没有返回额度" : "当前范围暂无图表数据")}
      </strong>
      <p>
        {t(
          unknown
            ? "首次采集、计数重置或未提供百分比的记录不会画成零。"
            : quota
              ? "在「订阅与来源」查看每个账号的采集状态；部分套餐不提供额度查询。"
              : "调整筛选范围，或完成采集后查看真实用量。",
        )}
      </p>
    </div>
  );
}

type TipEntry = {
  name?: string;
  value?: number | string | readonly (number | string)[];
  color?: string;
  payload?: { day?: string; name?: string; unknown?: number; checkedAt?: string };
};
function ChartTooltip({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: TipEntry[];
  label?: string | number;
  format: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const item = payload[0]?.payload;
  return (
    <div className="usage-chart-tooltip">
      <strong>{item?.name ?? item?.day ?? label}</strong>
      {payload
        .filter((entry) => typeof entry.value === "number")
        .map((entry, index) => (
          <div key={`${entry.name}:${index}`}>
            <span>
              <i style={{ background: entry.color }} />
              {entry.name}
            </span>
            <b>{format(Number(entry.value))}</b>
          </div>
        ))}
      {item?.unknown ? <p>{t("另有 {0} 条未知记录未计入", item.unknown)}</p> : null}
      {item?.checkedAt && <p>{new Date(item.checkedAt).toLocaleString(intlLocale())}</p>}
    </div>
  );
}

export function UsageCharts({
  rows,
  category,
  now = Date.now(),
}: {
  rows: UsageRecord[];
  category: string;
  now?: number;
}) {
  const [metric, setMetric] = useState<Metric | null>(null);
  const [group, setGroup] = useState<"source" | "model">("source");
  const [quotaId, setQuotaId] = useState("");
  const headingId = useId();
  const defaultMetric =
    (["api", "local", "traffic", "quota"] as const).find((kind) =>
      rows.some((row) => chartMetric(row) === kind),
    ) ?? "api";
  const current = category === "all" ? (metric ?? defaultMetric) : (category as Metric);
  const quota = current === "quota";
  const traffic = current === "traffic";
  const chart = useMemo(
    () => buildUsageChart(rows, quota ? "api" : current, group),
    [rows, current, group, quota],
  );
  const quotas = useMemo(() => buildQuotaChart(rows), [rows]);
  const selectedQuota = quotas.find((item) => item.id === quotaId) ?? quotas[0];
  const quotaDaily = selectedQuota?.daily ?? [];
  const smallPoints = quota ? [] : smallUsagePoints(chart.daily);
  const today = quota ? undefined : todayUsagePoint(chart.daily, now);
  const firstLabel = t(traffic ? "上传" : "输入 Token");
  const secondLabel = t(traffic ? "下载" : "输出 Token");
  const format = (value: number) =>
    quota
      ? `${value.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })}%`
      : traffic
        ? usageBytes(value)
        : `${value.toLocaleString(intlLocale())} Token`;
  const axisFormat = (value: number) =>
    quota ? `${value}%` : traffic ? usageBytes(value).replace(/\.00 /, " ") : compact(value);
  const composition = quota
    ? quotas
    : chart.composition.map((item) => ({ ...item, name: item.name || t("未提供模型") }));
  const hasTrend = quota ? quotaDaily.some((item) => item.value != null) : chart.samples > 0;
  const hasComposition = composition.some((item) => item.value != null);
  const visibleComposition = composition.slice(0, 6).map((item) => ({
    ...item,
    axisName: item.value == null ? `${t("未知")} · ${item.name}` : item.name,
  }));
  const quotaDomain: [number, number | "auto"] = [
    0,
    Math.max(
      100,
      ...quotaDaily.map((item) => item.value ?? 0),
      ...quotas.map((item) => item.value ?? 0),
    ),
  ];
  const tick = { fill: "var(--color-muted)", fontSize: 10 };
  const gradient = `usage-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <section className="usage-charts" aria-labelledby={headingId} data-metric={current}>
      <div className="usage-charts-heading">
        <div>
          <h3 id={headingId}>{t("用量图表")}</h3>
          <p>
            {category === "all"
              ? t("当前图表仅展示所选指标，API 与本机用量分别统计。")
              : t("图表与明细共用上方筛选。")}
          </p>
        </div>
        {category === "all" && (
          <div className="usage-chart-metric-select">
            <Select
              aria-label={t("图表指标")}
              value={current}
              onValueChange={(value) => setMetric(value as Metric)}
              options={Object.entries(metricKeys).map(([value, label]) => ({
                value,
                label: t(label),
              }))}
            />
          </div>
        )}
      </div>
      <div className="usage-chart-grid">
        <article className="usage-chart-card" aria-label={t("每日趋势")}>
          <header className="usage-chart-card-heading">
            <div>
              <span className="usage-chart-eyebrow">{t(metricKeys[current])}</span>
              <h4>{t(quota ? "额度变化" : "每日趋势")}</h4>
            </div>
            <div className="usage-chart-total">
              <strong>
                {quota
                  ? selectedQuota?.value == null
                    ? "—"
                    : format(selectedQuota.value)
                  : chart.samples
                    ? format(chart.total)
                    : "—"}
              </strong>
              <small>{t(quota ? "所选窗口最新快照" : "当前范围合计")}</small>
            </div>
          </header>
          <div className="usage-chart-controls">
            {quota ? (
              <Select
                aria-label={t("额度窗口")}
                value={selectedQuota?.id ?? ""}
                disabled={!quotas.length}
                onValueChange={setQuotaId}
                options={quotas.map((item) => ({ value: item.id, label: item.name }))}
                placeholder={t("暂无额度窗口")}
              />
            ) : (
              <div className="usage-chart-legend">
                <span>
                  <i className="usage-chart-color-primary" />
                  {firstLabel}
                  <b>{chart.samples ? format(chart.first) : "—"}</b>
                </span>
                <span>
                  <i className="usage-chart-color-secondary" />
                  {secondLabel}
                  <b>{chart.samples ? format(chart.second) : "—"}</b>
                </span>
              </div>
            )}
          </div>
          {hasTrend ? (
            <div
              className="usage-chart-canvas"
              role="img"
              aria-label={t("{0}，完整数值见下方数据表", t(quota ? "额度变化" : "每日趋势"))}
            >
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart
                  key={`${current}:${selectedQuota?.id ?? ""}`}
                  data={quota ? quotaDaily : chart.daily}
                  margin={{ top: 12, right: 8, left: -12, bottom: 0 }}
                  accessibilityLayer
                >
                  <defs>
                    <linearGradient id={`${gradient}-a`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" style={{ stopColor: "var(--usage-chart-primary)" }} />
                      <stop
                        offset="100%"
                        style={{ stopColor: "var(--usage-chart-primary)", stopOpacity: 0.62 }}
                      />
                    </linearGradient>
                    <linearGradient id={`${gradient}-b`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" style={{ stopColor: "var(--usage-chart-secondary)" }} />
                      <stop
                        offset="100%"
                        style={{ stopColor: "var(--usage-chart-secondary)", stopOpacity: 0.7 }}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--color-line)"
                    strokeDasharray="3 4"
                  />
                  <XAxis
                    dataKey="day"
                    tick={tick}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                    tickFormatter={(value: string) => value.slice(5).replace("-", "/")}
                  />
                  <YAxis
                    tick={tick}
                    tickLine={false}
                    axisLine={false}
                    width={68}
                    tickFormatter={axisFormat}
                    domain={quota ? quotaDomain : [0, "auto"]}
                    allowDecimals={quota}
                  />
                  <Tooltip
                    content={<ChartTooltip format={format} />}
                    cursor={{ fill: "var(--usage-chart-cursor)" }}
                  />
                  {/* Recharts 2 在 React 19 下依赖直接子项识别序列，不包入 Fragment。 */}
                  <Bar
                    dataKey={quota ? "value" : "first"}
                    name={quota ? t("使用比例") : firstLabel}
                    stackId={quota ? undefined : "usage"}
                    fill={`url(#${gradient}-a)`}
                    maxBarSize={28}
                    radius={quota ? [5, 5, 0, 0] : undefined}
                    isAnimationActive={false}
                    shape={(props: unknown) => <RiseBar {...(props as BarShapeProps)} />}
                  />
                  {!quota && (
                    <Bar
                      dataKey="second"
                      name={secondLabel}
                      stackId="usage"
                      fill={`url(#${gradient}-b)`}
                      maxBarSize={28}
                      radius={[5, 5, 0, 0]}
                      isAnimationActive={false}
                      shape={(props: unknown) => (
                        <RiseBar {...(props as BarShapeProps)} delay={160} />
                      )}
                    />
                  )}
                  {smallPoints.map((point) => (
                    <ReferenceDot
                      key={point.day}
                      x={point.day}
                      y={point.total!}
                      r={3}
                      fill="var(--usage-chart-primary)"
                      stroke="var(--color-card)"
                      strokeWidth={1}
                      isFront
                      className="usage-chart-small-value"
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart
              quota={quota}
              unknown={quota ? quotaDaily.length > 0 : chart.unknown > 0}
            />
          )}
          {today && today.total != null && (
            <div
              className="usage-chart-today"
              aria-label={t("今日用量")}
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="usage-chart-today-label">
                {t("今天")} <time dateTime={today.day}>{today.day.slice(5).replace("-", "/")}</time>
              </span>
              <span>
                {firstLabel}
                <strong>{format(today.first ?? 0)}</strong>
              </span>
              <span>
                {secondLabel}
                <strong>{format(today.second ?? 0)}</strong>
              </span>
            </div>
          )}
          <p className="usage-chart-footnote">
            {t(
              quota
                ? "每天保留该窗口最后一次采集的百分比，窗口之间不相加。"
                : traffic
                  ? "仅统计已确认增量，归入本次采集日，不代表精确的每日消耗。"
                  : "输入已包含缓存读取和写入，不再重复累加。",
            )}{" "}
            {t("仅显示有记录的日期，缺失日期不补零。")}
            {smallPoints.length > 0 && (
              <> {t("圆点标记小额非零用量，柱高与提示数值保持原始比例。")}</>
            )}
          </p>
          {!quota && chart.unknown > 0 && (
            <p className="usage-chart-footnote">{t("另有 {0} 条未知记录未计入", chart.unknown)}</p>
          )}
        </article>
        <article className="usage-chart-card" aria-label={t(quota ? "窗口最新快照" : "用量构成")}>
          <header className="usage-chart-card-heading">
            <div>
              <span className="usage-chart-eyebrow">
                {t(quota ? "独立窗口 · 不相加" : "当前筛选范围")}
              </span>
              <h4>{t(quota ? "窗口最新快照" : "用量构成")}</h4>
            </div>
            <span className="usage-chart-count">{t("{0} 项", composition.length)}</span>
          </header>
          <div className="usage-chart-controls">
            {!quota && !traffic ? (
              <Select
                aria-label={t("构成维度")}
                value={group}
                onValueChange={(value) => setGroup(value as "source" | "model")}
                options={[
                  { value: "source", label: t("按来源") },
                  { value: "model", label: t("按模型") },
                ]}
              />
            ) : (
              <span className="usage-chart-dimension">
                {t(quota ? "每个账号、窗口各取最新记录" : "按来源")}
              </span>
            )}
          </div>
          {hasComposition ? (
            <div
              className="usage-chart-canvas"
              role="img"
              aria-label={t("{0}，完整数值见下方数据表", t(quota ? "窗口最新快照" : "用量构成"))}
            >
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart
                  key={`${current}:${group}`}
                  layout="vertical"
                  data={visibleComposition}
                  margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                  accessibilityLayer
                >
                  <CartesianGrid
                    horizontal={false}
                    stroke="var(--color-line)"
                    strokeDasharray="3 4"
                  />
                  <XAxis
                    type="number"
                    tick={tick}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={axisFormat}
                    domain={quota ? quotaDomain : [0, "auto"]}
                    allowDecimals={quota}
                    minTickGap={20}
                  />
                  <YAxis
                    type="category"
                    dataKey="axisName"
                    tick={tick}
                    tickLine={false}
                    axisLine={false}
                    width={110}
                    tickFormatter={shortened}
                    interval={0}
                  />
                  <Tooltip
                    content={<ChartTooltip format={format} />}
                    cursor={{ fill: "var(--usage-chart-cursor)" }}
                  />
                  <Bar
                    dataKey="value"
                    name={t(quota ? "使用比例" : "合计")}
                    fill="var(--usage-chart-primary)"
                    maxBarSize={18}
                    radius={[0, 6, 6, 0]}
                    isAnimationActive={false}
                    shape={(props: unknown) => (
                      <RiseBar {...(props as BarShapeProps)} axis="x" delay={80} />
                    )}
                  >
                    {visibleComposition.map((item, index) => (
                      <Cell key={item.axisName} fill={`var(--usage-series-${(index % 6) + 1})`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart quota={quota} unknown={quota ? quotas.length > 0 : chart.unknown > 0} />
          )}
          <p className="usage-chart-footnote">
            {t(
              quota
                ? "百分比仅供各窗口独立比较，不换算为 Token。"
                : traffic
                  ? "来源构成使用上传与下载增量之和。"
                  : "只统计当前指标，不合并 API 账单与本机日志。",
            )}
            {composition.length > 6 ? ` ${t("展示前 {0} 项；完整数值见数据表。", 6)}` : ""}
          </p>
        </article>
      </div>
      <details className="usage-chart-data">
        <summary>
          <BarChart3 size={14} />
          {t("查看图表数据表")}
          <ChevronDown size={14} />
        </summary>
        <div className="usage-chart-tables">
          <div className="usage-chart-table-wrap">
            <table>
              <caption>
                {t(quota ? "额度变化" : "每日趋势")}
                {quota && selectedQuota ? ` · ${selectedQuota.name}` : ""}
              </caption>
              <thead>
                <tr>
                  <th>{t("日期")}</th>
                  {quota ? (
                    <th>{t("使用比例")}</th>
                  ) : (
                    <>
                      <th>{firstLabel}</th>
                      <th>{secondLabel}</th>
                      <th>{t("未知记录")}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {quota
                  ? quotaDaily.map((item) => (
                      <tr key={item.day}>
                        <td>{item.day}</td>
                        <td>{item.value == null ? t("未知") : format(item.value)}</td>
                      </tr>
                    ))
                  : chart.daily.map((item) => (
                      <tr key={item.day}>
                        <td>{item.day}</td>
                        <td>{item.first == null ? t("未知") : format(item.first)}</td>
                        <td>{item.second == null ? t("未知") : format(item.second)}</td>
                        <td>{item.unknown}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
            {!(quota ? quotaDaily.length : chart.daily.length) && (
              <p>{t("当前范围暂无图表数据")}</p>
            )}
          </div>
          <div className="usage-chart-table-wrap">
            <table>
              <caption>{t(quota ? "窗口最新快照" : "用量构成")}</caption>
              <thead>
                <tr>
                  <th>{t(quota ? "额度窗口" : !traffic && group === "model" ? "模型" : "来源")}</th>
                  <th>{t(quota ? "使用比例" : "合计")}</th>
                </tr>
              </thead>
              <tbody>
                {composition.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.value == null ? t("未知") : format(item.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!composition.length && <p>{t("当前范围暂无图表数据")}</p>}
          </div>
        </div>
      </details>
    </section>
  );
}
