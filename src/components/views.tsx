import { isWeb } from "@/lib/web";
import { hasServerMetrics, hasServerObservation } from "@/lib/server-observation.mjs";
import { subscriptionCost } from "@/lib/subscription-cost";
const DocumentsWorkspace = lazy(() =>
  import("./documents-workspace").then((m) => ({ default: m.DocumentsWorkspace })),
);
const PhoneWorkspace = lazy(() =>
  import("./phone-workspace").then((module) => ({ default: module.PhoneWorkspace })),
);
const RenewalsWorkspace = lazy(() =>
  import("./renewals-workspace").then((m) => ({ default: m.RenewalsWorkspace })),
);
const HostMonitorView = lazy(() =>
  import("./host-monitor").then((m) => ({ default: m.HostMonitorView })),
);
const UsageWorkspace = lazy(() =>
  import("./usage-workspace").then((m) => ({ default: m.UsageWorkspace })),
);
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search, SquareTerminal, X, LayoutGrid, Table2, Network, Plus } from "lucide-react";
const AssetWorkspace = lazy(() =>
  import("./asset-workspace").then((module) => ({ default: module.AssetWorkspace })),
);
import { IntegrationsEntry } from "./integrations/entry";
import { DomainsCloudflareEntry } from "./integrations/domain-cloudflare";
import { ServiceCard } from "./service-card";
import { AssetTypeManagerButton } from "./asset-type-manager";
import { Overview } from "./overview";
import { NAV_ALL as NAV } from "./web-nav";
import { AssetOrganizer } from "./asset-organizer";
const MailWorkspace = lazy(() =>
  import("./mail-workspace").then((module) => ({ default: module.MailWorkspace })),
);
const VaultWorkspace = lazy(() =>
  import("./vault-workspace").then((module) => ({ default: module.VaultWorkspace })),
);
import { useSettings } from "@/lib/settings";
import { AiCard, CertCard, DomainCard, MailCard, SecretCard, ServerCard } from "./asset-card";
const AgentView = lazy(() =>
  import("./agent-view").then((module) => ({ default: module.AgentView })),
);
import { GroupHeading, TagBar } from "./tag-bar";
import { RefreshAllButton } from "./refresh-button";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { CountUp } from "./ui/time-ago";
import { isDesktop } from "@/lib/desktop";
import { useLive } from "@/lib/live";
import { GlobalNodesHub } from "./ui/global-nodes-hub";
import { type ProbeKind } from "@/lib/probes";
import { attentionOf, dotClass, KIND_LABEL } from "@/lib/status";
import { useAppStore } from "@/lib/store";
import { groupByTag, matchesTags, tagIndex, tagsOf } from "@/lib/tags";
import type { AssetKind, Status, Taggable, ViewId } from "@/lib/types";
import { cn, formatUsd } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { CREATE_LABELS } from "@/lib/create-asset";

export function MainView() {
  const view = useAppStore((s) => s.view);
  // Re-keying replays the entrance, so switching views reads as a change of
  // place rather than a silent content swap.
  return (
    <div
      key={view}
      className={cn(
        view === "docs" ? "documents-view" : "view-in",
        view === "agent" && "agent-view-frame",
      )}
    >
      <Suspense
        fallback={
          <div className="p-6 text-sm text-muted" role="status">
            {t("正在加载…")}
          </div>
        }
      >
        {view === "services" && <IntegrationsEntry />}
        {view === "domains" && <DomainsCloudflareEntry />}
        <ViewBody />
      </Suspense>
    </div>
  );
}

function ViewBody() {
  const view = useAppStore((s) => s.view);
  const layout = useSettings((s) => s.assetLayout);
  const hydrated = useAppStore((s) => s.hydrated);
  if (view === "mail") return <MailWorkspace />;
  if (
    hydrated &&
    ["servers", "services", "domains", "ai", "certs", "tags"].includes(view) &&
    layout !== "cards"
  )
    return <AssetWorkspace />;
  switch (view) {
    case "relations":
      return <AssetWorkspace />;
    case "docs":
      return <DocumentsWorkspace />;
    case "usage":
      return <UsageWorkspace />;
    case "phones":
      return <PhoneWorkspace />;
    case "renewals":
      return <RenewalsWorkspace />;
    case "overview":
      return <Overview />;
    case "nodes":
      return <NodesView />;
    case "servers":
      return <ServersView />;
    case "services":
      return <ServicesView />;
    case "domains":
      return <DomainsView />;
    case "ai":
      return <AiView />;
    case "vault":
      return <VaultWorkspace />;
    case "certs":
      return <CertsView />;
    case "tags":
      return <TagsView />;
    case "agent":
      return <AgentView />;
    case "terminal":
      return <TerminalView />;
    case "host":
      return <HostMonitorView />;
  }
}

function NodesView() {
  return (
    <div className="mx-4 mt-1 space-y-5 pb-24">
      <GlobalNodesHub />
    </div>
  );
}

/** 每个页面标题下的一句说明。 */
const PAGE_DESC: Partial<Record<ViewId, string>> = {
  overview: "集中管理资产，快速找到需要处理的事项。",
  renewals: "按到期时间查看续费，按月、按年折算支出。",
  agent: "接上你自己的模型，直接询问自己的资产。",
  servers: "主机状态、指标采样与 SSH 终端。",
  nodes: "自建节点的状态、流量与订阅来源。",
  domains: "域名注册信息、DNS 与到期时间。",
  certs: "TLS 证书检查与到期提醒。",
  services: "在线服务与云资源的台账。",
  ai: "AI 订阅的额度、用量与月度开支。",
  usage: "按来源、日期与模型查看用量。机场总用量、本机客户端流量和 AI Token 分别统计。",
  mail: "邮箱文件夹、阅读与新邮件提醒。",
  vault: "加密保存的账号、密码与密钥。",
  tags: "按标签跨类别整理资产。",
  relations: "资产与文档之间的真实关联。",
  terminal: "已打开的 SSH 会话。",
  host: "网页版所在主机的 CPU、内存、磁盘、网络与进程，每 5 秒刷新。",
};

const LIST_VIEWS: ViewId[] = [
  "servers",
  "services",
  "domains",
  "ai",
  "certs",
  "tags",
  "vault",
  "mail",
];

export function TopTabs() {
  const view = useAppStore((s) => s.view);
  const item = NAV.find((entry) => entry.id === view);
  const openComposer = useAppStore((s) => s.openComposer);
  // 文档有自己的标题栏；总览的标题在景深头图里。
  if (view === "docs" || view === "overview" || view === "renewals") return null;
  const desc = PAGE_DESC[view];
  const meta = LIST_VIEWS.includes(view) ? <PageMeta view={view} /> : null;
  return (
    <>
      <div className="page-view-heading">
        <div className="min-w-0">
          <h1 className="page-title">
            {t(item?.label ?? (view === "relations" ? "关系图" : "资产总览"))}
          </h1>
          {meta ?? (desc && <p className="page-description">{t(desc)}</p>)}
        </div>
        <div className="page-actions">
          {item?.kind && (
            <Button onClick={() => openComposer(item.kind!)}>
              <Plus />
              {t(CREATE_LABELS[item.kind])}
            </Button>
          )}
        </div>
      </div>
      {LIST_VIEWS.includes(view) && <ListHeader />}
    </>
  );
}

/** 列表页标题下的一行轻量信息：总数 · 需要留意 · 页面说明，用圆点分隔。 */
function PageMeta({ view }: { view: ViewId }) {
  const total = useAppStore((s) => {
    switch (view) {
      case "servers":
        return s.servers.length;
      case "services":
        return s.services.length;
      case "domains":
        return s.domains.length;
      case "certs":
        return s.certs.length;
      case "ai":
        return s.aiAssets.length;
      case "vault":
        return s.secrets.length;
      case "mail":
        return s.mailboxes.length;
      case "tags":
        return tagIndex(s).length;
      default:
        return 0;
    }
  });
  const counts = useAppStore(useShallow(attentionOf));
  const pending = counts[BADGE_KEY[view]];
  const parts = [
    view === "tags" ? t("{0} 个标签", total) : t("共 {0} 项", total),
    ...(pending > 0 && view !== "tags" ? [t("{0} 项需要留意", pending)] : []),
    ...(PAGE_DESC[view] ? [t(PAGE_DESC[view]!)] : []),
  ];
  return (
    <p className="page-meta">
      {parts.map((part, index) => (
        <span key={index} className={index === 1 && pending > 0 ? "page-meta-warn" : undefined}>
          {part}
        </span>
      ))}
    </p>
  );
}

function ListHeader() {
  const view = useAppStore((s) => s.view);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const title = TITLE[view] || { all: "全部", attention: "需处理" };
  const layout = useSettings((s) => s.assetLayout);
  const setLayout = useSettings((s) => s.setAssetLayout);
  const hydrated = useAppStore((s) => s.hydrated);
  const counts = useAppStore(useShallow(attentionOf));
  const pending = counts[BADGE_KEY[view]];

  const shownLayout = hydrated ? layout : "cards";
  return (
    <div className="asset-list-toolbar">
      <div className="asset-list-toolbar-row">
        <div className="segmented" role="group" aria-label={t("筛选")}>
          <button
            type="button"
            onClick={() => setFilter("all")}
            aria-pressed={filter === "all"}
            className="segmented-item"
          >
            {t(title.all)}
          </button>
          <button
            type="button"
            onClick={() => setFilter("attention")}
            aria-pressed={filter === "attention"}
            className="segmented-item"
          >
            <span>{t(title.attention)}</span>
            {pending > 0 && <span className="segmented-count">{pending}</span>}
          </button>
        </div>

        <div className="asset-list-search">
          <Search className="asset-list-search-icon" aria-hidden="true" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("筛选当前列表")}
            className="h-9 pl-9 text-meta"
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <RefreshAllButton kind={PROBE_KIND[view]} />
          <Button
            variant="ghost"
            size="icon-sm"
            className="xl:hidden"
            onClick={() => setCommandOpen(true)}
            aria-label={t("搜索资产")}
          >
            <Search />
          </Button>
          {view !== "terminal" && view !== "mail" && (
            <>
              <div className="segmented segmented-icons" role="group" aria-label={t("显示方式")}>
                {(
                  [
                    { mode: "cards", label: "卡片视图", Icon: LayoutGrid },
                    { mode: "table", label: "表格视图", Icon: Table2 },
                    { mode: "graph", label: "关系图", Icon: Network },
                  ] as const
                ).map(({ mode, label, Icon }) => (
                  <button
                    key={mode}
                    type="button"
                    aria-label={t(label)}
                    title={t(label)}
                    aria-pressed={shownLayout === mode}
                    onClick={() => setLayout(mode)}
                    className="segmented-item"
                  >
                    <Icon />
                  </button>
                ))}
              </div>
              <AssetOrganizer />
            </>
          )}
        </div>
      </div>

      <TagBar />
    </div>
  );
}

/** Which live probe the refresh button in this view should run. */
const PROBE_KIND: Record<ViewId, ProbeKind | null> = {
  relations: null,
  renewals: null,
  phones: null,
  docs: null,
  usage: null,
  overview: "server",
  nodes: "server",
  servers: "server",
  services: null,
  domains: "domain",
  mail: null,
  ai: null,
  vault: null,
  certs: "cert",
  tags: null,
  agent: null,
  terminal: "server",
  host: null,
};

const BADGE_KEY: Record<ViewId, keyof ReturnType<typeof attentionOf>> = {
  relations: "total",
  renewals: "total",
  phones: "phones",
  docs: "total",
  usage: "total",
  overview: "total",
  nodes: "total",
  servers: "servers",
  services: "services",
  domains: "domains",
  mail: "mail",
  ai: "ai",
  vault: "vault",
  certs: "certs",
  tags: "total",
  agent: "total",
  terminal: "servers",
  host: "total",
};

const TITLE: Record<string, { all: string; attention: string }> = {
  overview: { all: "为你准备", attention: "需处理" },
  nodes: { all: "全部自建节点", attention: "需处理" },
  services: { all: "全部服务", attention: "需处理" },
  servers: { all: "全部主机", attention: "异常" },
  domains: { all: "全部域名", attention: "即将到期" },
  mail: { all: "全部邮箱", attention: "需处理" },
  ai: { all: "全部订阅", attention: "用量告警" },
  vault: { all: "全部密钥", attention: "待轮换" },
  certs: { all: "全部证书", attention: "即将到期" },
  tags: { all: "全部分组", attention: "需处理" },
  agent: { all: "问答", attention: "需处理" },
  terminal: { all: "会话", attention: "离线主机" },
};

function match(q: string, ...parts: Array<string | number | undefined>) {
  if (!q.trim()) return true;
  const n = q.toLowerCase();
  return parts.some((p) =>
    String(p ?? "")
      .toLowerCase()
      .includes(n),
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl bg-card px-6 py-16 text-center shadow-card">
      <p className="text-meta text-muted">{text}</p>
    </div>
  );
}

const GRID = "grid gap-3 @lg:grid-cols-2 @4xl:grid-cols-3";

/**
 * One list, two layouts.
 *
 * Flat is a plain grid. Grouped splits into one section per tag — an asset with
 * three tags shows up in all three, because tags are labels rather than
 * folders, and anything untagged collects in a trailing section.
 */
function AssetList<T extends { id: string } & Partial<Taggable>>({
  items,
  empty,
  render,
}: {
  items: T[];
  empty: string;
  render: (item: T) => ReactNode;
}) {
  const grouped = useAppStore((s) => s.groupByTag);

  if (items.length === 0) {
    return (
      <div className="mx-4 mt-4">
        <Empty text={empty} />
      </div>
    );
  }

  if (!grouped) {
    return <div className={cn("stagger-in mx-4 mt-4 pb-24", GRID)}>{items.map(render)}</div>;
  }

  return (
    <div className="mx-4 mt-4 space-y-6 pb-24">
      {groupByTag(items).map((group) => (
        <section key={group.tag} className={cn("stagger-in", GRID)}>
          <GroupHeading label={group.label} count={group.items.length} />
          {group.items.map(render)}
        </section>
      ))}
    </div>
  );
}

/** Shared narrowing: attention tab, tag selection, then the text filter. */
function useListFilter<T extends { status: Status } & Partial<Taggable>>(
  list: T[],
  text: (item: T) => Array<string | number | undefined>,
): T[] {
  const filter = useAppStore((s) => s.filter);
  const query = useAppStore((s) => s.query);
  const tagFilter = useAppStore((s) => s.tagFilter);
  return list.filter((item) => {
    if (
      filter === "attention" &&
      (item.status === "online" || ("lastSeen" in item && !hasServerObservation(item)))
    )
      return false;
    if (!matchesTags(item, tagFilter)) return false;
    return match(query, ...text(item));
  });
}

function ServersView() {
  const list = useAppStore((s) => s.servers);
  const items = useListFilter(list, (s) => [
    s.name,
    s.label,
    s.host,
    s.os,
    s.region,
    tagsOf(s).join(" "),
  ]);
  return (
    <AssetList
      items={items}
      empty={t("没有匹配的服务器。点击「添加服务器」录入一台。")}
      render={(s) => <ServerCard key={s.id} data={s} />}
    />
  );
}

function ServicesView() {
  const list = useAppStore((s) => s.services);
  const types = useAppStore((s) => s.assetTypes);
  const [typeFilter, setTypeFilter] = useState("all");
  // 删掉正在筛选的类型后回到全部。
  const activeType = types.some((type) => type.id === typeFilter) ? typeFilter : "all";
  const byType = useMemo(
    () => (activeType === "all" ? list : list.filter((s) => s.typeId === activeType)),
    [list, activeType],
  );
  const items = useListFilter(byType, (s) => [
    s.name,
    s.category,
    s.url,
    s.provider,
    types.find((type) => type.id === s.typeId)?.name ?? "",
    Object.values(s.fields ?? {}).join(" "),
    tagsOf(s).join(" "),
  ]);
  return (
    <>
      <div className="service-type-bar mx-4 mt-4">
        {types.length > 0 && (
          <div className="service-type-chips" role="group" aria-label={t("按资产类型筛选")}>
            {[{ id: "all", name: t("全部类型") }, ...types].map((type) => (
              <button
                key={type.id}
                type="button"
                aria-pressed={activeType === type.id}
                onClick={() => setTypeFilter(type.id)}
              >
                {type.name}
              </button>
            ))}
          </div>
        )}
        <AssetTypeManagerButton />
      </div>
      <AssetList
        items={items}
        empty={t("没有匹配的服务。点击「添加服务」记录 Workers、博客或自建服务。")}
        render={(s) => <ServiceCard key={s.id} data={s} />}
      />
    </>
  );
}

function DomainsView() {
  const list = useAppStore((s) => s.domains);
  const items = useListFilter(list, (s) => [s.name, s.registrar, s.dns, tagsOf(s).join(" ")]);
  return (
    <AssetList
      items={items}
      empty={t("没有匹配的域名。")}
      render={(s) => <DomainCard key={s.id} data={s} />}
    />
  );
}

function AiView() {
  const list = useAppStore((s) => s.aiAssets);
  const cost = subscriptionCost(list);
  const spend = cost.total;
  const missingPrice = cost.missing;
  const items = useListFilter(list, (s) => [s.name, s.provider, s.plan, tagsOf(s).join(" ")]);
  return (
    <div>
      <div className="mx-4 mt-3 rounded-xl bg-card px-4 py-3 shadow-card">
        <p className="text-2xs text-muted">{t("本月订阅合计")}</p>
        <p className="text-xl font-semibold tabular-nums">
          {cost.known === 0 && missingPrice > 0 ? (
            t("月费未填写")
          ) : (
            <CountUp value={spend} format={formatUsd} />
          )}
        </p>
        {missingPrice > 0 && (
          <p className="mt-1 text-2xs text-muted">{t("另有 {0} 个订阅未提供月费", missingPrice)}</p>
        )}
      </div>
      <AssetList
        items={items}
        empty={t("没有匹配的 AI 订阅。")}
        render={(s) => <AiCard key={s.id} data={s} />}
      />
    </div>
  );
}

function CertsView() {
  const list = useAppStore((s) => s.certs);
  const items = useListFilter(list, (s) => [s.cn, s.issuer, s.sans.join(" "), tagsOf(s).join(" ")]);
  return (
    <AssetList
      items={items}
      empty={t("没有匹配的证书。")}
      render={(s) => <CertCard key={s.id} data={s} />}
    />
  );
}

/**
 * The cross-kind lens on tags.
 *
 * Every other view is one collection; this one is one *label* across all six,
 * which is the whole reason tags are shared rather than per-kind. With nothing
 * selected it lists the tags themselves with a per-kind breakdown; pick one and
 * it turns into that tag's assets, sectioned by kind.
 */
function TagsView() {
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const mailboxes = useAppStore((s) => s.mailboxes);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const secrets = useAppStore((s) => s.secrets);
  const certs = useAppStore((s) => s.certs);
  const services = useAppStore((s) => s.services);
  const selected = useAppStore((s) => s.tagFilter);
  const query = useAppStore((s) => s.query);
  const filter = useAppStore((s) => s.filter);
  const toggleTag = useAppStore((s) => s.toggleTag);
  const clearTags = useAppStore((s) => s.clearTags);

  // On the 需处理 tab this becomes "which groups have something wrong in them",
  // which is the question worth asking of a group.
  const scope = useMemo(() => {
    const only = <T extends { status: Status }>(items: T[]) =>
      filter === "attention"
        ? items.filter(
            (x) => x.status !== "online" && (!("lastSeen" in x) || hasServerObservation(x)),
          )
        : items;
    return {
      servers: only(servers),
      domains: only(domains),
      mailboxes: only(mailboxes),
      aiAssets: only(aiAssets),
      secrets: only(secrets),
      certs: only(certs),
      services: only(services),
    };
  }, [filter, servers, domains, mailboxes, aiAssets, secrets, certs, services]);

  // Derived in a memo, not in a selector: a selector runs on every store read
  // and a fresh array never compares equal.
  const index = useMemo(() => tagIndex(scope), [scope]);

  if (index.length === 0) {
    return (
      <div className="mx-4 mt-4">
        <Empty
          text={
            filter === "attention"
              ? t("没有哪个分组里有待处理的资产。")
              : t("还没有任何标签。在资产的「标签」字段里填几个，就能跨类别分组了。")
          }
        />
      </div>
    );
  }

  if (selected.length === 0) {
    const visible = index.filter((entry) => match(query, entry.tag));
    return visible.length === 0 ? (
      <div className="mx-4 mt-4">
        <Empty text={t("没有匹配的标签。")} />
      </div>
    ) : (
      <div className={cn("stagger-in mx-4 mt-4 pb-24", GRID)}>
        {visible.map((entry) => (
          <button
            key={entry.tag}
            type="button"
            className="card-tap rounded-xl bg-card p-4 text-left shadow-card"
            onClick={() => toggleTag(entry.tag)}
          >
            <div className="flex items-baseline gap-2">
              <h3 className="truncate text-lg font-semibold tracking-tight">{entry.tag}</h3>
              <span className="ml-auto text-2xl font-semibold tabular-nums">{entry.total}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {entry.byKind.map(({ kind, count }) => (
                <span key={kind} className="chip chip-mute">
                  {t(KIND_LABEL[kind])} {count}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>
    );
  }

  const keep = <T extends { tags?: string[] }>(items: T[]) =>
    items.filter((x) => matchesTags(x, selected));

  const sections: Array<{ kind: AssetKind; items: ReactNode[] }> = (
    [
      { kind: "server", items: keep(scope.servers).map((s) => <ServerCard key={s.id} data={s} />) },
      { kind: "domain", items: keep(scope.domains).map((s) => <DomainCard key={s.id} data={s} />) },
      { kind: "mail", items: keep(scope.mailboxes).map((s) => <MailCard key={s.id} data={s} />) },
      { kind: "ai", items: keep(scope.aiAssets).map((s) => <AiCard key={s.id} data={s} />) },
      { kind: "secret", items: keep(scope.secrets).map((s) => <SecretCard key={s.id} data={s} />) },
      { kind: "cert", items: keep(scope.certs).map((s) => <CertCard key={s.id} data={s} />) },
      {
        kind: "service",
        items: keep(scope.services).map((s) => <ServiceCard key={s.id} data={s} />),
      },
    ] as Array<{ kind: AssetKind; items: ReactNode[] }>
  ).filter((section) => section.items.length > 0);

  if (sections.length === 0) {
    return (
      <div className="mx-4 mt-4">
        <Empty text={t("没有同时带上这些标签的资产。")} />
      </div>
    );
  }

  return (
    <div className="mx-4 mt-4 space-y-6 pb-24">
      {/* Which group you are inside, and the way back out. The shared tag
          strip cannot do this job here: it counts one collection, and this
          view spans all six. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs text-subtle">{t("当前分组")}</span>
        {selected.map((tag) => (
          <button
            key={tag}
            type="button"
            className="tag-chip tag-chip-on"
            title={t("从筛选中移除")}
            onClick={() => toggleTag(tag)}
          >
            {tag}
            <X className="size-3" />
          </button>
        ))}
        <button type="button" className="tag-chip tag-chip-clear" onClick={clearTags}>
          {t("返回全部分组")}
        </button>
      </div>

      {sections.map((section) => (
        <section key={section.kind} className={cn("stagger-in", GRID)}>
          <GroupHeading label={t(KIND_LABEL[section.kind])} count={section.items.length} />
          {section.items}
        </section>
      ))}
    </div>
  );
}

function TerminalView() {
  const list = useAppStore((s) => s.servers);
  const sessionIds = useAppStore((s) => s.sshSessionIds);
  const openSsh = useAppStore((s) => s.openSsh);
  const cpuMap = useLive((s) => s.cpu);
  const items = useListFilter(list, (s) => [s.name, s.host, tagsOf(s).join(" ")]);

  return (
    <div className="mx-4 mt-4 pb-24">
      <button
        type="button"
        className="btn btn-sm mb-4"
        onClick={() => openSsh("__terminal_preview__")}
      >
        <SquareTerminal className="size-4" />
        终端外观预览
      </button>
      <p className="mb-3 px-1 text-meta text-muted">
        {isWeb()
          ? t(
              "选择一台主机，由网页版所在的服务器发起真实 SSH 会话。凭据在浏览器里解密后随连接发送，服务器不保存。",
            )
          : isDesktop()
            ? t("选择一台主机，打开真实 SSH 会话。需要先在密钥库中保存该主机的凭据。")
            : t(
                "选择一台主机建立 SSH 连接。监控离线时也可尝试连接，连接结果会在终端中显示。",
              )}
      </p>
      {items.length === 0 ? (
        <Empty text={t("没有匹配的主机。")} />
      ) : (
        <div className="stagger-in grid gap-2">
          {items.map((s) => {
            const cpu = cpuMap[s.id] ?? s.cpu;
            return (
              <button
                key={s.id}
                type="button"
                data-terminal-server={s.id}
                onClick={() =>
                  s.sshConfigured === false
                    ? useAppStore.getState().openComposer("server", s.id)
                    : openSsh(s.id)
                }
                className="row-tap flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-left shadow-card disabled:opacity-40 disabled:shadow-card"
              >
                <span
                  className={hasServerObservation(s) ? dotClass(s.status) : "status-dot bg-subtle"}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold tracking-tight">{s.name}</p>
                  <p className="font-mono text-2xs text-muted">
                    {s.username}@{s.host}:{s.port}
                  </p>
                </div>
                {tagsOf(s)
                  .slice(0, 2)
                  .map((t) => (
                    <span key={t} className="chip chip-mute">
                      {t}
                    </span>
                  ))}
                <span className="text-2xs tabular-nums text-subtle">
                  {sessionIds.includes(s.id)
                    ? t("返回会话")
                    : s.sshConfigured === false
                      ? t("配置 SSH")
                      : s.collect === false
                        ? t("不采集")
                        : hasServerMetrics(s)
                          ? `CPU ${cpu}%`
                          : t("未采集")}
                </span>
                <SquareTerminal className="size-4 text-muted" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
