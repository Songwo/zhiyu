import { useMemo, useState } from "react";
import { CalendarArrowDown, CalendarClock, X } from "lucide-react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import {
  combinedInCny,
  dueTotals,
  renewalTimeline,
  spendSummary,
  type BillingCurrency,
  type RenewalEntry,
  type RenewalKind,
} from "../../electron/services/renewals.mjs";
import { createCalendar } from "@/lib/operations";
import { formatBilling, formatMoney } from "@/lib/billing";
import { useAppStore } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { t, intlLocale } from "@/lib/i18n";
import { KIND_LABEL } from "@/lib/status";
import { cn, downloadText } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const WINDOWS = [30, 90] as const;
const CURRENCY_LABEL: Record<BillingCurrency, string> = { CNY: "人民币", USD: "美元" };

const kindLabel = (kind: RenewalKind) => t(kind === "phone" ? "号码" : KIND_LABEL[kind]);

export function RenewalsWorkspace() {
  const snapshot = useAppStore(
    useShallow((s) => ({
      servers: s.servers,
      domains: s.domains,
      services: s.services,
      phoneNumbers: s.phoneNumbers,
      aiAssets: s.aiAssets,
      certs: s.certs,
    })),
  );
  const [withinDays, setWithinDays] = useState<(typeof WINDOWS)[number]>(30);
  const summary = useMemo(() => spendSummary(snapshot), [snapshot]);
  const timeline = useMemo(() => renewalTimeline(snapshot, { withinDays }), [snapshot, withinDays]);
  return (
    <div className="overview-layout">
      <SpendPanel summary={summary} />
      <section className="workspace-panel" aria-label={t("到期时间线")}>
        <div className="panel-heading">
          <div>
            <h2>{t("到期时间线")}</h2>
            <p className="mt-1 text-sm text-muted">
              {t("未来 {0} 天内到期的资产，以及近 30 天已过期的。", withinDays)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1" role="group" aria-label={t("时间范围")}>
              {WINDOWS.map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-pressed={withinDays === days}
                  onClick={() => setWithinDays(days)}
                  className={cn(
                    "min-h-8 rounded-full px-3 text-xs transition-colors",
                    withinDays === days
                      ? "bg-ink font-semibold text-card"
                      : "text-muted hover:bg-surface hover:text-ink",
                  )}
                >
                  {t("{0} 天", days)}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!timeline.length}
              onClick={() => exportTimeline(timeline)}
            >
              <CalendarArrowDown className="size-4" />
              {t("导出日历")}
            </Button>
          </div>
        </div>
        <Timeline entries={timeline} />
      </section>
    </div>
  );
}

function SpendPanel({ summary }: { summary: ReturnType<typeof spendSummary> }) {
  const usdToCny = useSettings((s) => s.usdToCny);
  const combined = combinedInCny(summary, usdToCny);
  const currencies = (["CNY", "USD"] as const).filter((c) => summary.byCurrency[c].count > 0);
  return (
    <section className="workspace-panel" aria-label={t("费用概览")}>
      <div className="panel-heading">
        <div>
          <h2>{t("费用概览")}</h2>
          <p className="mt-1 text-sm text-muted">
            {t("年付按 12 个月摊到每月，月付乘 12 计入全年；一次性费用单列。")}
          </p>
        </div>
        <RateInput />
      </div>
      {currencies.length === 0 ? (
        <p className="workspace-empty">
          {t("还没有填写费用。编辑服务器、域名、服务资产或号码时可以填写续费金额。")}
        </p>
      ) : (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {currencies.map((currency) => {
            const totals = summary.byCurrency[currency];
            return (
              <SpendTile
                key={currency}
                title={t("{0} · {1} 项", t(CURRENCY_LABEL[currency]), totals.count)}
                monthly={formatMoney(totals.monthly, currency)}
                yearly={formatMoney(totals.yearly, currency)}
                once={totals.once > 0 ? formatMoney(totals.once, currency) : ""}
              />
            );
          })}
          {combined && usdToCny && currencies.length > 1 && (
            <SpendTile
              title={t("折合人民币（1 USD = {0} CNY）", usdToCny)}
              monthly={formatMoney(combined.monthly, "CNY")}
              yearly={formatMoney(combined.yearly, "CNY")}
              once={combined.once > 0 ? formatMoney(combined.once, "CNY") : ""}
            />
          )}
        </div>
      )}
      {summary.unpriced > 0 && (
        <p className="border-t border-line px-5 py-3 text-sm text-muted">
          {t("另有 {0} 项资产记录了到期日但没有填写费用，未计入合计。", summary.unpriced)}
        </p>
      )}
    </section>
  );
}

function SpendTile({
  title,
  monthly,
  yearly,
  once,
}: {
  title: string;
  monthly: string;
  yearly: string;
  once: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-line-strong p-4">
      <div className="text-sm text-muted">{title}</div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <div className="text-2xs text-muted">{t("每月")}</div>
          <strong className="text-2xl font-semibold tabular-nums tracking-tight">{monthly}</strong>
        </div>
        <div>
          <div className="text-2xs text-muted">{t("每年")}</div>
          <strong className="text-2xl font-semibold tabular-nums tracking-tight">{yearly}</strong>
        </div>
      </div>
      {once && (
        <div className="mt-2 text-sm text-muted">
          {t("一次性")} <span className="tabular-nums text-ink">{once}</span>
        </div>
      )}
    </div>
  );
}

function RateInput() {
  const usdToCny = useSettings((s) => s.usdToCny);
  const setUsdToCny = useSettings((s) => s.setUsdToCny);
  const [draft, setDraft] = useState(usdToCny ? String(usdToCny) : "");
  const commit = () => {
    const value = draft.trim();
    if (!value) {
      setUsdToCny(null);
      return;
    }
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0 || rate >= 1000) {
      toast.error(t("汇率需要是大于 0 的数字"));
      setDraft(usdToCny ? String(usdToCny) : "");
      return;
    }
    setUsdToCny(rate);
  };
  return (
    <form
      className="flex items-center gap-2 text-sm text-muted"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <label htmlFor="usd-to-cny">1 USD =</label>
      <Input
        id="usd-to-cny"
        inputMode="decimal"
        className="h-8 w-20 text-sm"
        placeholder={t("不换算")}
        aria-label={t("美元兑人民币汇率")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      <span>CNY</span>
      {usdToCny && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={t("清除汇率")}
          aria-label={t("清除汇率")}
          onClick={() => {
            setDraft("");
            setUsdToCny(null);
          }}
        >
          <X className="size-4" />
        </Button>
      )}
    </form>
  );
}

function Timeline({ entries }: { entries: RenewalEntry[] }) {
  if (!entries.length)
    return (
      <div className="workspace-empty">
        <CalendarClock className="mx-auto mb-3 size-6" />
        {t("这段时间没有到期的资产。")}
      </div>
    );
  const groups = groupByMonth(entries);
  const due = dueTotals(entries.filter((entry) => entry.days >= 0));
  const dueText = (["CNY", "USD"] as const)
    .filter((currency) => due[currency] > 0)
    .map((currency) => formatMoney(due[currency], currency))
    .join(" + ");
  return (
    <div>
      {dueText && (
        <p className="border-b border-line px-5 py-3 text-sm text-muted">
          {t("即将到期项目的续费金额合计：{0}", dueText)}
        </p>
      )}
      {groups.map(({ label, items }) => (
        <div key={label}>
          <h3 className="bg-canvas px-5 py-2 text-xs font-medium text-muted">{label}</h3>
          <ul className="divide-y divide-line">
            {items.map((entry) => (
              <li key={entry.key}>
                <TimelineRow entry={entry} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TimelineRow({ entry }: { entry: RenewalEntry }) {
  const tone =
    entry.days < 0 || entry.days <= 7 ? "text-crit" : entry.days <= 21 ? "text-warn" : "text-muted";
  return (
    <button
      type="button"
      className="asset-summary-row"
      onClick={(event) => {
        const state = useAppStore.getState();
        if (entry.kind === "phone") {
          state.openPhones({ id: entry.id });
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        state.setExpanded({
          kind: entry.kind,
          id: entry.id,
          origin: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        });
      }}
    >
      <span className="w-14 shrink-0 font-mono text-sm tabular-nums">{entry.date.slice(5)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{entry.name}</span>
        <span className="mt-1 block truncate text-sm text-muted">
          {kindLabel(entry.kind)}
          {entry.billing ? ` · ${formatBilling(entry.billing)}` : ""}
        </span>
      </span>
      <span className={cn("shrink-0 text-sm font-medium tabular-nums", tone)}>
        {entry.days < 0
          ? t("已过期 {0} 天", -entry.days)
          : entry.days === 0
            ? t("今天到期")
            : t("{0} 天后", entry.days)}
      </span>
    </button>
  );
}

function groupByMonth(entries: RenewalEntry[]) {
  const format = new Intl.DateTimeFormat(intlLocale(), { year: "numeric", month: "long" });
  const groups: { label: string; items: RenewalEntry[] }[] = [];
  for (const entry of entries) {
    const label =
      entry.days < 0
        ? t("已过期")
        : format.format(new Date(`${entry.date.slice(0, 7)}-01T12:00:00`));
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(entry);
    else groups.push({ label, items: [entry] });
  }
  return groups;
}

function exportTimeline(entries: RenewalEntry[]) {
  const items = entries.map((entry) => ({
    id: `renewal:${entry.key}`,
    date: entry.date,
    title: t("续费：{0}", entry.name),
    detail: [kindLabel(entry.kind), entry.billing && formatBilling(entry.billing)]
      .filter(Boolean)
      .join(" · "),
  }));
  downloadText("zhiyu-renewals.ics", createCalendar(items), "text/calendar;charset=utf-8");
  toast(t("已导出 {0} 项提醒", items.length));
}
