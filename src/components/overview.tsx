import { hasServerObservation } from "@/lib/server-observation.mjs";
import { StatusBadge } from "./ui/status-badge";
import { combinedInCny, renewalTimeline, spendSummary } from "../../electron/services/renewals.mjs";
import { formatMoney } from "@/lib/billing";
import { useSettings } from "@/lib/settings";
import { useMemo } from "react";
import {
  ArrowUpRight,
  Server,
  Globe,
  Radio,
  Bot,
  CalendarClock,
  FileText,
  Phone,
  ChartNoAxesCombined,
  type LucideIcon,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import { attentionOf } from "@/lib/status";
import { t } from "@/lib/i18n";
import type { ViewId } from "@/lib/types";
import { ActivityJournal } from "./activity-journal";

export function Overview() {
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const costs = useAppStore(
    useShallow((s) => ({
      servers: s.servers,
      domains: s.domains,
      services: s.services,
      phoneNumbers: s.phoneNumbers,
      aiAssets: s.aiAssets,
      certs: s.certs,
    })),
  );
  const usdToCny = useSettings((s) => s.usdToCny);
  const counts = useAppStore(useShallow(attentionOf));
  const setView = useAppStore((s) => s.setView);
  const nodes = useMemo(() => servers.flatMap((server) => server.nodes ?? []), [servers]);
  const spend = useMemo(() => {
    const summary = spendSummary(costs);
    const combined = combinedInCny(summary, usdToCny);
    const parts = (["CNY", "USD"] as const)
      .filter((currency) => summary.byCurrency[currency].count > 0)
      .map((currency) => formatMoney(summary.byCurrency[currency].monthly, currency));
    return {
      value:
        combined && parts.length > 1 ? formatMoney(combined.monthly, "CNY") : parts.join(" + "),
      due: renewalTimeline(costs, { withinDays: 30 }).filter((entry) => entry.days >= 0).length,
    };
  }, [costs, usdToCny]);
  const stats: {
    label: string;
    value: number | string;
    detail: string;
    icon: LucideIcon;
    view: ViewId;
  }[] = [
    {
      label: "服务器",
      value: servers.length,
      detail: servers.some((server) => !hasServerObservation(server))
        ? t(
            "{0} 台正常 · {1} 台未采集",
            servers.filter((server) => hasServerObservation(server) && server.status === "online")
              .length,
            servers.filter((server) => !hasServerObservation(server)).length,
          )
        : t("{0} 台状态正常", servers.filter((server) => server.status === "online").length),
      icon: Server,
      view: "servers",
    },
    {
      label: "域名",
      value: domains.length,
      detail: t("{0} 项需要留意", counts.domains),
      icon: Globe,
      view: "domains",
    },
    {
      label: "自建节点",
      value: nodes.length,
      detail: nodes.length ? t("查看节点配置") : t("尚未添加节点"),
      icon: Radio,
      view: "nodes",
    },
    {
      label: "每月支出",
      value: spend.value || t("未填写费用"),
      detail: t("30 天内 {0} 项到期", spend.due),
      icon: CalendarClock,
      view: "renewals",
    },
  ];
  return (
    <div className="overview-layout">
      {counts.total > 0 && (
        <section className="workspace-panel" aria-label={t("待处理事项")}>
          <div className="panel-heading">
            <h2>{t("待处理事项")}</h2>
            <span className="text-sm text-muted">{t("点击分类查看异常资产")}</span>
          </div>
          <div className="flex flex-wrap gap-2 p-4">
            {(
              [
                ["servers", "服务器", counts.servers],
                ["services", "服务资产", counts.services],
                ["phones", "号码台账", counts.phones],
                ["domains", "域名", counts.domains],
                ["mail", "邮箱", counts.mail],
                ["ai", "AI 订阅", counts.ai],
                ["vault", "密钥库", counts.vault],
                ["certs", "安全证书", counts.certs],
              ] as const
            )
              .filter(([, , count]) => count > 0)
              .map(([view, label, count]) => (
                <button
                  type="button"
                  key={view}
                  className="attention-chip"
                  onClick={() => {
                    if (view === "phones") useAppStore.getState().openPhones({ attention: true });
                    else {
                      setView(view);
                      useAppStore.getState().setFilter("attention");
                    }
                  }}
                >
                  <span className="attention-chip-dot" aria-hidden="true" />
                  {t(label)} · {t("{0} 项需要留意", count)}
                  <ArrowUpRight className="attention-chip-arrow" />
                </button>
              ))}
          </div>
        </section>
      )}
      <section className="workspace-panel" aria-label={t("常用操作")}>
        <div className="panel-heading">
          <h2>{t("常用操作")}</h2>
        </div>
        <div className="overview-actions">
          {(
            [
              {
                view: "docs",
                label: "打开文档",
                detail: "记录图片、链接与资产说明",
                icon: FileText,
              },
              {
                view: "phones",
                label: "管理号码",
                detail: "查看到期日与关联订阅",
                icon: Phone,
              },
              {
                view: "usage",
                label: "查看用量",
                detail: "查看流量、Token 与最近采集结果",
                icon: ChartNoAxesCombined,
              },
              { view: "ai", label: "查看 AI 订阅", detail: "管理订阅与月度开支", icon: Bot },
            ] as const
          ).map(({ view, label, detail, icon: Icon }) => (
            <button type="button" key={view} onClick={() => setView(view)} className="quick-action">
              <Icon className="size-5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{t(label)}</span>
                <span className="mt-1 block text-sm text-muted">{t(detail)}</span>
              </span>
              <ArrowUpRight className="size-4 text-muted" />
            </button>
          ))}
        </div>
      </section>
      <section className="overview-stats" aria-label={t("资产摘要")}>
        {stats.map(({ label, value, detail, icon: Icon, view }) => (
          <button type="button" key={view} className="summary-tile" onClick={() => setView(view)}>
            <span className="flex items-center justify-between gap-3 text-sm text-muted">
              <span>{t(label)}</span>
              <Icon className="size-4" />
            </span>
            <strong className="mt-4 block text-3xl font-semibold tabular-nums tracking-tight">
              {value}
            </strong>
            <span className="mt-2 block text-sm text-muted">{detail}</span>
          </button>
        ))}
      </section>
      <div className={servers.length ? "overview-columns" : "grid gap-5"}>
        {servers.length > 0 && (
          <section className="workspace-panel">
            <div className="panel-heading">
              <h2>{t("服务器")}</h2>
              <button
                type="button"
                className="text-sm text-muted hover:text-ink"
                onClick={() => setView("servers")}
              >
                {t("查看全部")} <ArrowUpRight className="inline size-4" />
              </button>
            </div>
            <div className="divide-y divide-line">
              {servers.slice(0, 3).map((server) => (
                <button
                  type="button"
                  key={server.id}
                  className="asset-summary-row"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    useAppStore.getState().setExpanded({
                      kind: "server",
                      id: server.id,
                      origin: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                    });
                  }}
                >
                  <span className="asset-summary-icon">
                    <Server className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{server.name}</span>
                    <span className="mt-1 block truncate text-sm text-muted">{server.host}</span>
                  </span>
                  <StatusBadge status={server.status} pending={!hasServerObservation(server)} />
                </button>
              ))}
            </div>
          </section>
        )}
        <ActivityJournal />
      </div>
    </div>
  );
}
