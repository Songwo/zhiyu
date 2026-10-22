import { useEffect, useMemo } from "react";
import { ArrowUpRight, CalendarDays, Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { renewalCalendar } from "../../electron/services/renewals.mjs";
import { formatBilling } from "@/lib/billing";
import { createAsset } from "@/lib/create-asset";
import { useDocuments } from "@/lib/documents";
import { t } from "@/lib/i18n";
import { quickStartSteps, type QuickStartStepId } from "@/lib/quick-start";
import { useSettings } from "@/lib/settings";
import { KIND_LABEL } from "@/lib/status";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PageSection } from "./ui/page";
import { MarkRenewedButton } from "./mark-renewed";

/** 首页「快速开始」：五步清单，按已有资料自动打勾；全部完成或收起后不再显示。 */
export function QuickStart() {
  // 收起状态存在本机，服务端不知道；资料载入后再渲染，避免首帧与服务端不一致。
  const hydrated = useAppStore((s) => s.hydrated);
  const hidden = useSettings((s) => s.quickStartHidden);
  const setHidden = useSettings((s) => s.setQuickStartHidden);
  const data = useAppStore(
    useShallow((s) => ({
      servers: s.servers,
      domains: s.domains,
      services: s.services,
      phoneNumbers: s.phoneNumbers,
      aiAssets: s.aiAssets,
      certs: s.certs,
      mailboxes: s.mailboxes,
      secrets: s.secrets,
      links: s.links,
    })),
  );
  const documentCount = useDocuments((s) => (s.loaded ? s.list.length : null));
  useEffect(() => {
    if (!hidden)
      void useDocuments
        .getState()
        .load()
        .catch(() => {});
  }, [hidden]);
  const steps = useMemo(() => quickStartSteps({ ...data, documentCount }), [data, documentCount]);
  const done = steps.filter((step) => step.done).length;
  if (!hydrated || hidden || done === steps.length) return null;

  const run = (id: QuickStartStepId) => {
    const state = useAppStore.getState();
    if (id === "asset") void createAsset();
    // 费用一步直接给出订阅模板：选一个就带好金额、周期和下次续费日。
    else if (id === "billing") state.setCreatePickerOpen(true);
    else if (id === "document") state.setView("docs");
    else if (id === "link") state.setView("relations");
    else state.setView("tags");
  };

  return (
    <PageSection
      title={t("快速开始")}
      description={t(
        "完成这几步，续费、关联和资料都会替你记着。已完成 {0} / {1}",
        done,
        steps.length,
      )}
      aria-label={t("快速开始")}
      action={
        <button type="button" className="section-link" onClick={() => setHidden(true)}>
          {t("不再显示")}
        </button>
      }
    >
      <div className="quick-start">
        <div
          className="quick-start-progress"
          role="progressbar"
          aria-label={t("快速开始进度")}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
        >
          <span style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
        <ol className="quick-start-steps">
          {steps.map((step, index) => (
            <li key={step.id}>
              <button
                type="button"
                className="quick-start-step"
                data-done={step.done}
                onClick={() => run(step.id)}
              >
                <span className="quick-start-check" aria-hidden="true">
                  {step.done ? <Check /> : index + 1}
                </span>
                <span className="min-w-0">
                  <span className="quick-start-title">
                    {t(step.title)}
                    {step.done && <span className="sr-only">{t("（已完成）")}</span>}
                  </span>
                  <span className="quick-start-detail">{t(step.detail)}</span>
                </span>
                {!step.done && <ArrowUpRight className="quick-start-arrow" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </PageSection>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 首页「近期续费」：未来 14 天的到期与按周期推算的续费，点进资产详情或续费日历。 */
export function UpcomingRenewals() {
  // 「今天」取浏览器时钟，与服务端可能不是同一天；资料载入后再渲染。
  const hydrated = useAppStore((s) => s.hydrated);
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
  const entries = useMemo(() => {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 14);
    return renewalCalendar(snapshot, { from: dayKey(today), to: dayKey(end) });
  }, [snapshot]);
  if (!hydrated || !entries.length) return null;
  const state = useAppStore.getState();
  return (
    <PageSection
      title={t("近期续费")}
      description={t("未来 14 天内到期或按周期续费的 {0} 项", entries.length)}
      aria-label={t("近期续费")}
      action={
        <button type="button" className="section-link" onClick={() => state.setView("renewals")}>
          <CalendarDays aria-hidden="true" />
          {t("续费日历")}
        </button>
      }
    >
      <div className="upcoming-list">
        {entries.slice(0, 5).map((entry) => (
          <div key={entry.key} className="renewal-row">
            <button
              type="button"
              className="upcoming-row"
              data-kind={entry.kind}
              onClick={(event) => {
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
              <span className="date-block" aria-label={entry.date}>
                <span className="date-block-month">{entry.date.slice(5, 7)}</span>
                <span className="date-block-day">{entry.date.slice(8, 10)}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="upcoming-name">{entry.name}</span>
                <span className="upcoming-meta">
                  <i aria-hidden="true" />
                  {t(entry.kind === "phone" ? "号码" : KIND_LABEL[entry.kind])}
                  {entry.billing ? ` · ${formatBilling(entry.billing)}` : ""}
                  {entry.projected ? ` · ${t("按周期推算")}` : ""}
                </span>
              </span>
              <span
                className={cn(
                  "due-pill",
                  entry.days <= 3 ? "text-crit" : entry.days <= 7 ? "text-warn" : "text-muted",
                )}
              >
                {entry.days === 0 ? t("今天") : t("{0} 天后", entry.days)}
              </span>
            </button>
            <MarkRenewedButton entry={entry} projected={entry.projected} />
          </div>
        ))}
      </div>
    </PageSection>
  );
}
