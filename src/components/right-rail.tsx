import { isWeb } from "@/lib/web";
import { phoneExpiry } from "../../electron/services/phone-numbers.mjs";
import { hasServerObservation, serverNeedsAttention } from "@/lib/server-observation.mjs";
import {
  AlertTriangle,
  Bot,
  Globe,
  KeyRound,
  Mail,
  Search,
  Phone,
  Server as ServerIcon,
  Shield,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { CalendarExport } from "./operations-panel";
import { TimeAgo } from "./ui/time-ago";
import { isDesktop } from "@/lib/desktop";
import { useLive } from "@/lib/live";
import { chipClass, dotClass, KIND_LABEL, STATUS_LABEL } from "@/lib/status";
import { tagIndex } from "@/lib/tags";
import { useAppStore } from "@/lib/store";
import type { AssetKind, Status, ViewId } from "@/lib/types";
import { cn, daysUntil } from "@/lib/utils";
import { t, getLocale } from "@/lib/i18n";

const KIND_ICON: Record<AssetKind | "system" | "phone", LucideIcon> = {
  server: ServerIcon,
  domain: Globe,
  mail: Mail,
  ai: Bot,
  secret: KeyRound,
  cert: Shield,
  service: Globe,
  system: AlertTriangle,
  phone: Phone,
};

const KIND_VIEW: Record<AssetKind | "phone", ViewId> = {
  server: "servers",
  phone: "phones",
  domain: "domains",
  mail: "mail",
  ai: "ai",
  secret: "vault",
  cert: "certs",
  service: "services",
};

interface Alert {
  id: string;
  kind: AssetKind | "phone";
  status: Status;
  title: string;
  detail: string;
}

/**
 * Every attention item across the six collections, worst first.
 *
 * Derived in a memo rather than inside the store selector: the selector runs on
 * every store read, and freshly built objects never compare equal, which turns
 * a `useShallow` selector into a render loop.
 */
export function useAlerts(): Alert[] {
  const locale = getLocale();
  const phoneNumbers = useAppStore((s) => s.phoneNumbers);
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const mailboxes = useAppStore((s) => s.mailboxes);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const secrets = useAppStore((s) => s.secrets);
  const certs = useAppStore((s) => s.certs);
  const services = useAppStore((s) => s.services);

  return useMemo(() => {
    const out: Alert[] = [
      ...phoneNumbers.flatMap((record): Alert[] => {
        const expiry = phoneExpiry(record.expiresAt);
        if (expiry.days === null || expiry.days > 30) return [];
        return [
          {
            id: record.id,
            kind: "phone",
            status: expiry.days <= 0 ? "offline" : "warning",
            title: record.label || record.number,
            detail:
              expiry.days < 0
                ? t("号码已过期 {0} 天", -expiry.days)
                : expiry.days === 0
                  ? t("号码今天到期")
                  : t("号码 {0} 天后到期", expiry.days),
          },
        ];
      }),
      ...servers.filter(serverNeedsAttention).map((x) => ({
        id: x.id,
        kind: "server" as const,
        status: x.status,
        title: x.name,
        detail: x.status === "offline" ? t("主机离线") : t("CPU {0}% · 负载偏高", x.cpu),
      })),
      ...certs
        .filter((x) => x.status !== "online")
        .map((x) => ({
          id: x.id,
          kind: "cert" as const,
          status: x.status,
          title: x.cn,
          detail: expiryDetail(x.expiresAt),
        })),
      ...domains
        .filter((x) => x.status !== "online")
        .map((x) => ({
          id: x.id,
          kind: "domain" as const,
          status: x.status,
          title: x.name,
          detail: expiryDetail(x.expiresAt),
        })),
      ...aiAssets
        .filter((x) => x.status !== "online")
        .map((x) => ({
          id: x.id,
          kind: "ai" as const,
          status: x.status,
          title: x.name,
          detail: t("本月用量 {0}%", x.usagePct),
        })),
      ...mailboxes
        .filter((x) => x.status !== "online")
        .map((x) => ({
          id: x.id,
          kind: "mail" as const,
          status: x.status,
          title: x.address,
          detail: t("投递异常"),
        })),
      ...services
        .filter((x) => x.status !== "online")
        .map((x) => ({
          id: x.id,
          kind: "service" as const,
          status: x.status,
          title: x.name,
          detail: t("手动记录状态"),
        })),
      ...secrets
        .filter((x) => x.status !== "online")
        .map((x) => ({
          id: x.id,
          kind: "secret" as const,
          status: x.status,
          title: x.name,
          detail: t("建议轮换"),
        })),
    ];
    return out.sort((a, b) => rank(b.status) - rank(a.status));
  }, [servers, domains, mailboxes, aiAssets, secrets, certs, services, phoneNumbers, locale]);
}

function rank(s: Status) {
  return s === "offline" ? 2 : s === "warning" ? 1 : 0;
}

function expiryDetail(iso: string) {
  const d = daysUntil(iso);
  return d <= 0 ? t("已过期") : t("{0} 天后到期", d);
}

/**
 * The third column. Everything here is ambient — it never changes with the
 * view, so the centre column stays a single list and this stays the standing
 * picture of the estate.
 */
export function RightRail({ className }: { className?: string }) {
  const activity = useAppStore((s) => s.activity);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const alerts = useAlerts();

  return (
    <aside className={cn("w-rail shrink-0 px-5 pb-24 pt-3", className)}>
      <div className="sticky top-3 space-y-4">
        <button type="button" className="rail-search" onClick={() => setCommandOpen(true)}>
          <Search className="size-4 shrink-0" />
          <span className="flex-1 text-left">{t("搜索资产、跳转、连接")}</span>
          <kbd className="rounded-xs bg-card px-1.5 py-0.5 font-mono text-2xs text-muted">⌘K</kbd>
        </button>

        <Panel
          title={t("需要留意")}
          trailing={
            <span className="flex items-center gap-2">
              {alerts.length > 0 && (
                <span className="grid size-5 place-items-center rounded-full bg-crit text-2xs font-semibold text-card tabular-nums">
                  {alerts.length}
                </span>
              )}
              <CalendarExport />
            </span>
          }
        >
          {alerts.length === 0 ? (
            <p className="px-4 pb-4 text-meta text-muted">{t("全部资产运转正常。")}</p>
          ) : (
            <ul>
              {alerts.slice(0, 5).map((a) => (
                <AlertRow key={`${a.kind}:${a.id}`} alert={a} />
              ))}
            </ul>
          )}
        </Panel>

        <TagPanel />

        <QuickTerminal />

        <Panel title={t("最近动态")}>
          <ul className="space-y-3 px-4 pb-4">
            {activity.slice(0, 5).map((a) => {
              const Icon = KIND_ICON[a.kind] ?? AlertTriangle;
              return (
                <li key={a.id} className="flex gap-2.5">
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-subtle" strokeWidth={1.9} />
                  <div className="min-w-0">
                    <p className="text-meta leading-snug">{a.text}</p>
                    <TimeAgo iso={a.at} className="text-2xs text-subtle" />
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>

        <p className="px-1 text-2xs leading-relaxed text-subtle">
          {t("⌘K 全局搜索 · ⌘N 新建资产 · / 打开命令面板")}
          <br />
          {isDesktop()
            ? t("资产存放在本机数据文件中，凭据单独加密保存。")
            : isWeb()
              ? t("资料保存在你自己的服务器上，凭据在浏览器里加密后才上传。")
              : t("数据保存在此浏览器中，可随时导出为 JSON。")}
        </p>
      </div>
    </aside>
  );
}

function Panel({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-card">
      <header className="flex items-center justify-between px-4 pb-2 pt-3.5">
        <h2 className="font-semibold tracking-tight">{title}</h2>
        {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
      </header>
      {children}
    </section>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const setView = useAppStore((s) => s.setView);
  const setExpanded = useAppStore((s) => s.setExpanded);
  const Icon = KIND_ICON[alert.kind];

  return (
    <li>
      <button
        type="button"
        className="row-tap flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-line"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setView(KIND_VIEW[alert.kind]);
          if (alert.kind === "phone") return;
          setExpanded({
            kind: alert.kind,
            id: alert.id,
            origin: { x: r.left, y: r.top, w: r.width, h: r.height },
          });
        }}
      >
        <Icon
          className={cn("size-4 shrink-0", alert.status === "offline" ? "text-crit" : "text-warn")}
          strokeWidth={1.9}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{alert.title}</span>
          <span className="block truncate text-2xs text-muted">{alert.detail}</span>
        </span>
        <span className={chipClass(alert.status)}>{t(STATUS_LABEL[alert.status])}</span>
      </button>
    </li>
  );
}

/**
 * Tags across the whole estate, not just the list you happen to be looking at.
 *
 * This is the answer to "what is in 生产" when the answer spans a host, a
 * domain and a certificate — clicking one opens the cross-kind view.
 */
function TagPanel() {
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const mailboxes = useAppStore((s) => s.mailboxes);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const secrets = useAppStore((s) => s.secrets);
  const certs = useAppStore((s) => s.certs);
  const services = useAppStore((s) => s.services);
  const focusTag = useAppStore((s) => s.focusTag);
  const setView = useAppStore((s) => s.setView);

  const index = useMemo(
    () => tagIndex({ servers, domains, mailboxes, aiAssets, secrets, certs, services }),
    [servers, domains, mailboxes, aiAssets, secrets, certs, services],
  );
  if (index.length === 0) return null;

  return (
    <Panel title={t("分组")}>
      <div className="flex flex-wrap gap-1.5 px-4 pb-4">
        {index.slice(0, 12).map((entry) => (
          <button
            key={entry.tag}
            type="button"
            className="tag-chip"
            title={entry.byKind.map((b) => `${t(KIND_LABEL[b.kind])} ${b.count}`).join(" · ")}
            onClick={() => focusTag(entry.tag)}
          >
            {entry.tag}
            <span className="tabular-nums opacity-55">{entry.total}</span>
          </button>
        ))}
        {index.length > 12 && (
          <button type="button" className="tag-chip tag-chip-clear" onClick={() => setView("tags")}>
            {t("还有 {0} 个", index.length - 12)}
          </button>
        )}
      </div>
    </Panel>
  );
}

function QuickTerminal() {
  const servers = useAppStore((s) => s.servers);
  const openSsh = useAppStore((s) => s.openSsh);
  const cpuMap = useLive((s) => s.cpu);
  const online = servers
    .filter((s) => hasServerObservation(s) && s.status !== "offline")
    .slice(0, 3);
  if (online.length === 0) return null;

  return (
    <Panel title={t("快捷终端")}>
      <ul className="pb-2">
        {online.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="row-tap group flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-line"
              onClick={() => openSsh(s.id)}
            >
              <span className={dotClass(s.status)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-meta">
                  {s.username}@{s.name}
                </span>
              </span>
              <span className="text-2xs tabular-nums text-subtle">{cpuMap[s.id] ?? s.cpu}%</span>
              <SquareTerminal className="size-4 shrink-0 text-subtle" strokeWidth={1.9} />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
