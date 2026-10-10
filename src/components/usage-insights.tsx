import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Download,
  Layers,
  Monitor,
} from "lucide-react";
import type { UsageState } from "@/lib/usage";
import { usageBytes } from "@/lib/usage";
import {
  exportUsage,
  filterUsage,
  normalizeUsageFilters,
  summarizeUsage,
  usageDay,
  usageFilterOptions,
} from "@/lib/usage-insights.mjs";
import { downloadJson } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { UsageCharts } from "./usage-charts";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import "./usage-insights.css";

const categories = [
  { value: "traffic", label: "流量增量", detail: "只累计两次采集间的有效增量", icon: ArrowDownUp },
  { value: "api", label: "API Token", detail: "服务商组织用量 · 按统计日更新", icon: Cpu },
  {
    value: "local",
    label: "本机 Token",
    detail: "客户端日志 · 与 API 账单分别统计",
    icon: Monitor,
  },
  { value: "quota", label: "订阅额度", detail: "账号额度快照 · 保留原始百分比", icon: Layers },
];
const number = (value: number) => value.toLocaleString();

function localDayStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function UsageInsights({
  data,
  localHistoryRequest = 0,
  active = true,
}: {
  data: UsageState;
  localHistoryRequest?: number;
  active?: boolean;
}) {
  const [filters, setFilters] = useState({
    category: "all",
    source: "all",
    period: "30",
    model: "all",
  });
  const { category, source, period, model } = useMemo(
    () => normalizeUsageFilters(data, filters),
    [data, filters],
  );
  const [page, setPage] = useState(0);
  const [dayStart, setDayStart] = useState(localDayStart);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const updateDay = () => {
      clearTimeout(timer);
      setDayStart(localDayStart());
      const nextDay = new Date();
      // 按日历推进，避免夏令时切换时把一天固定当作 24 小时。
      nextDay.setHours(24, 0, 0, 0);
      timer = setTimeout(updateDay, Math.max(1, nextDay.getTime() - Date.now()));
    };
    const resume = () => {
      if (document.visibilityState === "visible") updateDay();
    };
    updateDay();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, []);
  useEffect(() => {
    if (!localHistoryRequest) return;
    setFilters({ category: "local", source: "all", period: "all", model: "all" });
    setPage(0);
  }, [localHistoryRequest]);
  const base = useMemo(
    () => filterUsage(data.records, { source, period, model }, dayStart),
    [data.records, source, period, model, dayStart],
  );
  const summary = summarizeUsage(base);
  const rows = useMemo(() => filterUsage(base, { category, period: "all" }), [base, category]);
  const lastPage = Math.max(0, Math.ceil(rows.length / 20) - 1);
  const currentPage = Math.min(page, lastPage);
  const { sources, models } = useMemo(
    () => usageFilterOptions(data, { category, source }),
    [data, category, source],
  );
  const sourceLabels = new Map(
    sources.map((item) => [
      item.id,
      `${item.name}${item.duplicate ? ` · ${item.type} · ${item.id.slice(-8)}` : ""}${item.removed ? ` · ${t("已移除")}` : ""}`,
    ]),
  );
  function select(key: keyof typeof filters, value: string) {
    setFilters(normalizeUsageFilters(data, { category, source, period, model, [key]: value }));
    setPage(0);
  }
  const values = [
    summary.trafficSamples ? usageBytes(summary.upload + summary.download) : "—",
    number(summary.api),
    number(summary.local),
    t("{0} 个账号", summary.quota),
  ];
  return (
    <section className="usage-insights" aria-label={t("用量分析")}>
      <div className="usage-filter-panel">
        <div className="usage-filter-heading">
          <strong>{t("统计范围")}</strong>
          <span>{t("日期与来源应用于统计、图表和明细；模型仅筛选 Token，不影响流量与额度。")}</span>
        </div>
        <div className="usage-filters">
          <Select
            aria-label="用量类型"
            value={category}
            onValueChange={(value) => select("category", value)}
            options={[
              { value: "all", label: t("全部类型") },
              ...categories.map((item) => ({ value: item.value, label: t(item.label) })),
            ]}
          />
          <Select
            aria-label="来源筛选"
            value={source}
            onValueChange={(value) => select("source", value)}
            options={[
              { value: "all", label: t("全部来源") },
              ...sources.map((item) => ({ value: item.id, label: sourceLabels.get(item.id)! })),
            ]}
          />
          <Select
            aria-label="时间范围"
            value={period}
            onValueChange={(value) => select("period", value)}
            options={[
              { value: "1", label: t("今天") },
              { value: "7", label: t("最近 7 天") },
              { value: "30", label: t("最近 30 天") },
              { value: "all", label: t("全部历史") },
            ]}
          />
          <Select
            aria-label="模型筛选"
            value={model}
            onValueChange={(value) => select("model", value)}
            disabled={!models.length}
            options={[
              { value: "all", label: models.length ? t("全部模型") : t("此类型无模型筛选") },
              ...models.map((value) => ({ value, label: value })),
            ]}
          />
        </div>
      </div>
      <div className="usage-metrics">
        {categories.map((item, index) => (
          <button
            key={item.value}
            type="button"
            className="usage-metric"
            aria-pressed={category === item.value}
            onClick={() => select("category", category === item.value ? "all" : item.value)}
          >
            <span className="usage-metric-label">
              <item.icon className="size-4" />
              {t(item.label)}
              <span className="usage-selection-dot" />
            </span>
            <strong>{values[index]}</strong>
            <span className="usage-metric-description">{t(item.detail)}</span>
          </button>
        ))}
      </div>
      {active && <UsageCharts rows={base} category={category} now={dayStart} />}
      <div className="usage-history">
        <div className="usage-history-heading">
          <div>
            <h3 className="font-semibold">
              用量明细 <span className="ml-2 text-sm font-normal text-muted">{rows.length} 条</span>
            </h3>
            <p className="mt-1 text-xs text-muted">选择统计范围，展开一条记录查看完整明细。</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!rows.length}
            onClick={() => downloadJson("用量明细.json", exportUsage(rows))}
          >
            <Download />
            导出当前筛选
          </Button>
        </div>
        {summary.unknownTraffic > 0 && (
          <p className="usage-history-note">
            {summary.unknownTraffic}{" "}
            条流量记录为首次采集或计数重置，未计入增量。已知增量归入本次采集时间，不能精确拆分到每日。
          </p>
        )}
        <div
          className="usage-records"
          key={`${category}:${source}:${period}:${model}:${currentPage}`}
        >
          {rows.slice(currentPage * 20, (currentPage + 1) * 20).map((row) => {
            const Icon =
              row.kind === "traffic"
                ? ArrowDownUp
                : row.kind === "quota"
                  ? Layers
                  : row.origin === "local"
                    ? Monitor
                    : Cpu;
            return (
              <details
                className="usage-record"
                key={
                  row.kind === "tokens"
                    ? `${row.sourceId}:${row.key}`
                    : `${row.sourceId}:${row.key}:${row.checkedAt}`
                }
              >
                <summary>
                  <span className="usage-record-icon">
                    <Icon className="size-4" />
                  </span>
                  <span className="usage-record-name">
                    <strong>{sourceLabels.get(row.sourceId) ?? row.sourceName}</strong>
                    <small>
                      {row.model ?? row.label} ·{" "}
                      {row.kind === "tokens"
                        ? row.origin === "local"
                          ? "本机日志"
                          : "组织 API"
                        : row.kind === "traffic"
                          ? "流量快照"
                          : "订阅额度"}
                    </small>
                  </span>
                  <span className="usage-record-amount">
                    <strong>
                      {row.kind === "tokens"
                        ? `${number((row.input ?? 0) + (row.output ?? 0))} Token`
                        : row.kind === "traffic"
                          ? usageBytes((row.upload ?? 0) + (row.download ?? 0))
                          : row.usedPercent == null
                            ? "未提供百分比"
                            : `${row.usedPercent.toFixed(1)}%`}
                    </strong>
                    <small>{usageDay(row) || new Date(row.checkedAt).toLocaleString()}</small>
                  </span>
                  <ChevronDown className="usage-record-chevron size-4" />
                </summary>
                <div className="usage-record-detail">
                  {row.kind === "tokens" ? (
                    <>
                      <div>
                        <span>输入 Token</span>
                        <strong>{number(row.input ?? 0)}</strong>
                      </div>
                      <div>
                        <span>输出 Token</span>
                        <strong>{number(row.output ?? 0)}</strong>
                      </div>
                      <div>
                        <span>缓存读取（已计入输入）</span>
                        <strong>{number(row.cached ?? 0)}</strong>
                      </div>
                      <div>
                        <span>缓存写入（已计入输入）</span>
                        <strong>{number(row.cacheWrite ?? 0)}</strong>
                      </div>
                    </>
                  ) : row.kind === "traffic" ? (
                    <>
                      <div>
                        <span>累计上传 / 下载</span>
                        <strong>
                          {usageBytes(row.upload)} / {usageBytes(row.download)}
                        </strong>
                      </div>
                      <div>
                        <span>较上次增加</span>
                        <strong>
                          {row.counterReset
                            ? "计数重置，无法计算"
                            : row.deltaUpload == null || row.deltaDownload == null
                              ? "首次采集，尚无增量"
                              : `${usageBytes(row.deltaUpload)} / ${usageBytes(row.deltaDownload)}`}
                        </strong>
                      </div>
                      <div>
                        <span>总额度</span>
                        <strong>{row.total === 0 ? "不限额" : usageBytes(row.total)}</strong>
                      </div>
                      <div>
                        <span>到期时间</span>
                        <strong>
                          {row.expiresAt ? new Date(row.expiresAt).toLocaleDateString() : "未提供"}
                        </strong>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <span>使用比例</span>
                        <strong>
                          {row.usedPercent == null ? "未提供" : `${row.usedPercent.toFixed(1)}%`}
                        </strong>
                      </div>
                      <div>
                        <span>统计范围</span>
                        <strong>{row.scope ?? row.label}</strong>
                      </div>
                      <div>
                        <span>下次重置</span>
                        <strong>
                          {row.resetsAt ? new Date(row.resetsAt).toLocaleString() : "未提供"}
                        </strong>
                      </div>
                      <div>
                        <span>原始用量 / 额度</span>
                        <strong>
                          {row.used ?? "—"} / {row.limit ?? "—"} {row.unit}
                        </strong>
                      </div>
                    </>
                  )}
                  <p>
                    最后采集：{new Date(row.checkedAt).toLocaleString()}
                    {row.kind === "quota"
                      ? " · 额度百分比不换算为 Token"
                      : row.origin === "local"
                        ? " · 基于客户端已写入的日志，可能与组织账单重叠"
                        : ""}
                  </p>
                </div>
              </details>
            );
          })}
          {!rows.length && (
            <div className="usage-empty">
              <Layers className="size-6" />
              <strong>当前筛选没有记录</strong>
              <p>连接用量来源或开启本机监控后，采集到的记录会出现在这里。</p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilters({ category: "all", source: "all", period: "all", model: "all" });
                  setPage(0);
                }}
              >
                重置筛选
              </Button>
            </div>
          )}
        </div>
        <div className="usage-history-footer">
          <span>流量、额度不累加；本机 Token 与 API Token 分别统计。</span>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="上一页用量"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">
              {currentPage + 1} / {lastPage + 1}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="下一页用量"
              disabled={currentPage === lastPage}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
