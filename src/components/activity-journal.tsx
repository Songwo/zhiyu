import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { useAppStore } from "@/lib/store";
import {
  activityDays,
  activityPage,
  localDateKey,
  retainActivity,
} from "@/lib/activity-history.mjs";
import { intlLocale, t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import "./activity-journal.css";

const categories = [
  ["all", "全部类别"],
  ["server", "服务器"],
  ["domain", "域名"],
  ["mail", "邮箱"],
  ["ai", "AI 订阅"],
  ["secret", "密钥库"],
  ["cert", "安全证书"],
  ["system", "其他活动"],
] as const;

const placeholderDays = Array.from({ length: 14 }, (_, index) => index);
const subscribeNothing = () => () => {};

/**
 * SSR 与 hydration 首帧为 false，此后（以及纯客户端渲染）为 true。
 *
 * 日期桶、条数和时间文字都取决于“现在”、本机时区和示例数据生成的时刻，
 * 服务端与浏览器不可能一致；跨午夜时数字不同，React 就会整页报 hydration 失败。
 */
function useMounted() {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

export function ActivityJournal() {
  const activity = useAppStore((state) => state.activity);
  const mounted = useMounted();
  const [clock, setClock] = useState(() => Date.now());
  const chartRef = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState("");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // 窄屏默认展示最近日期，横向滚动仍可查看更早的活动。
    const observer = new ResizeObserver(() => {
      chart.scrollLeft = chart.scrollWidth;
    });
    observer.observe(chart);
    return () => observer.disconnect();
  }, []);
  const view = useMemo(() => {
    // 首帧只渲染与时间无关的占位，挂载后再按浏览器时钟计算。
    if (!mounted) return null;
    const now = new Date(Math.max(clock, Date.now()));
    const records = retainActivity(activity, now);
    return {
      records,
      days: activityDays(records, now, kind),
      result: activityPage(records, { date, kind, page }),
      dates: [...new Set([localDateKey(now), ...records.map((record) => localDateKey(record.at))])]
        .sort()
        .reverse(),
    };
  }, [mounted, activity, clock, date, kind, page]);
  const days = view?.days ?? [];
  const largest = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const activeDays = days.filter((day) => day.count > 0).length;
  const changeDate = (value: string) => {
    setDate(value);
    setPage(1);
  };

  return (
    <section
      className="workspace-panel activity-journal"
      aria-label={t("每日活动")}
      aria-busy={!view}
    >
      <div className="panel-heading">
        <h2 className="flex items-center gap-2">
          <History className="size-4 text-muted" />
          {t("每日活动")}
        </h2>
        <span className="text-xs text-muted">{t("保留近 90 天，最多 3000 条")}</span>
      </div>
      <div className="activity-chart-heading">
        <p>{view ? t("近 14 天 · {0} 条活动", total) : <>&nbsp;</>}</p>
        <span>{view ? t("{0} 天有活动", activeDays) : ""}</span>
      </div>
      <div
        ref={chartRef}
        className="activity-chart-scroll"
        role="group"
        aria-label={t("近 14 天活动，点击日期筛选")}
      >
        <div className="activity-chart">
          {days.map((day) => (
            <button
              type="button"
              key={day.date}
              className="activity-day"
              aria-pressed={date === day.date}
              aria-label={t("{0}，{1} 条活动", day.date, day.count)}
              title={t("{0}，{1} 条活动", day.date, day.count)}
              onClick={() => changeDate(date === day.date ? "" : day.date)}
            >
              <span className="activity-day-count">{day.count || ""}</span>
              <span className="activity-day-track" aria-hidden="true">
                <span
                  className="activity-day-fill"
                  style={
                    {
                      "--activity-height": `${Math.max(4, (day.count / largest) * 100)}%`,
                    } as CSSProperties
                  }
                  data-empty={day.count === 0}
                />
              </span>
              <span className="activity-day-date" aria-hidden="true">
                {day.date.slice(5).replace("-", "/")}
              </span>
            </button>
          ))}
          {!view &&
            placeholderDays.map((index) => (
              <span key={index} className="activity-day" aria-hidden="true">
                <span className="activity-day-count" />
                <span className="activity-day-track">
                  <span
                    className="activity-day-fill"
                    style={{ "--activity-height": "4%" } as CSSProperties}
                    data-empty
                  />
                </span>
                <span className="activity-day-date">&nbsp;</span>
              </span>
            ))}
        </div>
      </div>
      <div className="activity-filters">
        <Select
          aria-label={t("活动日期")}
          value={date}
          onValueChange={changeDate}
          options={[
            { value: "", label: t("全部日期") },
            ...[...new Set([...(view?.dates ?? []), ...(date ? [date] : [])])]
              .sort()
              .reverse()
              .map((value) => ({ value, label: value })),
          ]}
        />
        <Select
          aria-label={t("活动类别")}
          value={kind}
          onValueChange={(value) => {
            setKind(value);
            setPage(1);
          }}
          options={categories.map(([value, label]) => ({ value, label: t(label) }))}
        />
        {(date || kind !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              changeDate("");
              setKind("all");
            }}
          >
            {t("重置筛选")}
          </Button>
        )}
      </div>
      {!view ? (
        <p className="activity-empty" aria-hidden="true">
          &nbsp;
        </p>
      ) : view.result.items.length ? (
        <ul
          key={`${date}:${kind}:${view.result.page}`}
          className="activity-entries"
          tabIndex={0}
          aria-label={t("活动明细")}
        >
          {view.result.items.map((entry) => (
            <li key={entry.id}>
              <div className="activity-entry-meta">
                <span>
                  {t(categories.find(([value]) => value === entry.kind)?.[1] ?? "其他活动")}
                </span>
                <time dateTime={entry.at}>
                  {new Date(entry.at).toLocaleString(intlLocale(), {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </time>
              </div>
              <p>{entry.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="activity-empty">
          {view.records.length
            ? t("这一天或类别下没有活动。")
            : t("暂无活动。查看资产、保存修改或手动检查后会在这里记录。")}
        </p>
      )}
      <div className="activity-pagination">
        <span aria-live="polite">
          {view ? (
            t(
              "共 {0} 条 · 第 {1} / {2} 页",
              view.result.total,
              view.result.page,
              view.result.totalPages,
            )
          ) : (
            <>&nbsp;</>
          )}
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("上一页活动")}
            disabled={!view || view.result.page <= 1}
            onClick={() => view && setPage(view.result.page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("下一页活动")}
            disabled={!view || view.result.page >= view.result.totalPages}
            onClick={() => view && setPage(view.result.page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </section>
  );
}
