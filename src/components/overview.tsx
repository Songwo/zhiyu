import { hasServerObservation } from "@/lib/server-observation.mjs";
import { StatusBadge } from "./ui/status-badge";
import { combinedInCny, renewalTimeline, spendSummary } from "../../electron/services/renewals.mjs";
import { formatMoney } from "@/lib/billing";
import { useSettings } from "@/lib/settings";
import { useMemo } from "react";
import {
  ArrowUpRight,
  Plus,
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
import { QuickStart, UpcomingRenewals } from "./overview-guides";
import { Button } from "./ui/button";
import { DepthHero, PageSection, RowButton } from "./ui/page";
import { createAsset } from "@/lib/create-asset";

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
  const attention = (
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
  ).filter(([, , count]) => count > 0);
  const assetTotal =
    servers.length +
    domains.length +
    costs.services.length +
    costs.aiAssets.length +
    costs.certs.length;
  return (
    <div className="overview-layout page-stagger">
      <DepthHero
        eyebrow={t("资产总览")}
        title={
          assetTotal
            ? counts.total
              ? t("{0} 项资产，{1} 项需要留意", assetTotal, counts.total)
              : t("{0} 项资产，一切正常", assetTotal)
            : t("从添加第一项资产开始")
        }
        description={t("集中管理资产，快速找到需要处理的事项。")}
        actions={
          <Button onClick={() => void createAsset()}>
            <Plus />
            {t("添加资产")}
          </Button>
        }
      >
        <h2 className="sr-only">{t("常用操作")}</h2>
        <div className="hero-actions" aria-label={t("常用操作")}>
          {(
            [
              {
                view: "docs",
                label: "打开文档",
                detail: "记录图片、链接与资产说明",
                icon: FileText,
              },
              { view: "phones", label: "管理号码", detail: "查看到期日与关联订阅", icon: Phone },
              {
                view: "usage",
                label: "查看用量",
                detail: "查看流量、Token 与最近采集结果",
                icon: ChartNoAxesCombined,
              },
              { view: "ai", label: "查看 AI 订阅", detail: "管理订阅与月度开支", icon: Bot },
            ] as const
          ).map(({ view, label, detail, icon: Icon }) => (
            <button type="button" key={view} onClick={() => setView(view)} className="hero-action">
              <span className="quick-tile-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="min-w-0">
                <span className="quick-tile-title">{t(label)}</span>
                <span className="quick-tile-detail">{t(detail)}</span>
              </span>
              <ArrowUpRight className="quick-tile-arrow" aria-hidden="true" />
            </button>
          ))}
        </div>
      </DepthHero>

      <section className="stat-strip" aria-label={t("资产摘要")}>
        {stats.map(({ label, value, detail, icon: Icon, view }) => (
          <button type="button" key={view} className="hero-stat" onClick={() => setView(view)}>
            <span className="hero-stat-label">
              <Icon aria-hidden="true" />
              {t(label)}
            </span>
            <strong className="hero-stat-value">{value}</strong>
            <span className="hero-stat-detail">{detail}</span>
          </button>
        ))}
      </section>

      <QuickStart />
      <UpcomingRenewals />

      {attention.length > 0 && (
        <PageSection
          title={t("待处理事项")}
          description={t("点击分类查看异常资产")}
          aria-label={t("待处理事项")}
        >
          <div className="row-grid">
            {attention.map(([view, label, count]) => (
              <RowButton
                key={view}
                className="attention-row"
                title={
                  <>
                    <span className="attention-chip-dot" aria-hidden="true" />
                    {t(label)} · {t("{0} 项需要留意", count)}
                  </>
                }
                onClick={() => {
                  if (view === "phones") useAppStore.getState().openPhones({ attention: true });
                  else {
                    setView(view);
                    useAppStore.getState().setFilter("attention");
                  }
                }}
              />
            ))}
          </div>
        </PageSection>
      )}

      <div className={servers.length ? "overview-columns" : "grid gap-8"}>
        {servers.length > 0 && (
          <PageSection
            title={t("服务器")}
            action={
              <button type="button" className="section-link" onClick={() => setView("servers")}>
                {t("查看全部")}
                <ArrowUpRight aria-hidden="true" />
              </button>
            }
          >
            <div className="row-list">
              {servers.slice(0, 4).map((server) => (
                <RowButton
                  key={server.id}
                  className="asset-summary-row"
                  icon={Server}
                  title={server.name}
                  detail={server.host}
                  arrow={false}
                  trailing={
                    <StatusBadge status={server.status} pending={!hasServerObservation(server)} />
                  }
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    useAppStore.getState().setExpanded({
                      kind: "server",
                      id: server.id,
                      origin: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                    });
                  }}
                />
              ))}
            </div>
          </PageSection>
        )}
        <ActivityJournal />
      </div>
    </div>
  );
}
