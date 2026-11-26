import { vaultApi } from "@/lib/vault-api";
import { AssetDocuments } from "./asset-documents";
const PhoneBindings = lazy(() =>
  import("./phone-workspace").then((module) => ({ default: module.PhoneBindings })),
);
// 指标图表带着 recharts，只在展开服务器详情时才加载。
const MetricHistory = lazy(() =>
  import("./metric-history").then((module) => ({ default: module.MetricHistory })),
);
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Boxes,
  FolderArchive,
  KeyRound,
  Pencil,
  Sparkles,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AiCard, CertCard, DomainCard, MailCard, SecretCard, ServerCard } from "./asset-card";
const BoundIntegrationPanel = lazy(() =>
  import("./integrations/bound-integration-panel").then((module) => ({
    default: module.BoundIntegrationPanel,
  })),
);
import { containerIssues } from "@/lib/server-services";
import { ServiceCard } from "./service-card";
import { AccountPanel } from "./account-panel";
import { MailStatus } from "./mail-status";
import { AiAccountsPanel } from "./ai-accounts";
import { AssetRelations } from "./asset-relations";
const SftpBrowser = lazy(() => import("./sftp-browser").then((m) => ({ default: m.SftpBrowser })));
import { RefreshOneButton } from "./refresh-button";
const ServerNodesPanel = lazy(() =>
  import("./server-nodes-panel").then((m) => ({ default: m.ServerNodesPanel })),
);
const ServerServicesPanel = lazy(() =>
  import("./server-services-panel").then((m) => ({ default: m.ServerServicesPanel })),
);
const ServerDocsPanel = lazy(() =>
  import("./server-docs-panel").then((m) => ({ default: m.ServerDocsPanel })),
);
const ServerSecretsPanel = lazy(() =>
  import("./server-secrets-panel").then((m) => ({ default: m.ServerSecretsPanel })),
);
const ServerOpsToolbox = lazy(() =>
  import("./server-ops-toolbox").then((m) => ({ default: m.ServerOpsToolbox })),
);
import { Button } from "./ui/button";
import { PROBEABLE, type ProbeKind } from "@/lib/probes";
import { useAppStore, type ExpandState } from "@/lib/store";
import type { AssetKind, Server } from "@/lib/types";
import { t } from "@/lib/i18n";
import { desktop } from "@/lib/desktop";
import { useVault } from "@/lib/vault-state";
import { deleteEncryptedAccount } from "@/lib/account-delete.mjs";
import { EditorDialog } from "./ui/editor-dialog";
import { NAV } from "./sidebar";
import { assetEntries } from "@/lib/operations";
import { toast } from "sonner";
import { TypedDeleteDialog } from "./typed-delete-dialog";
import { cardPrivateId } from "@/lib/card-private.mjs";
import { NetworkResearch } from "./network-research";
import { commitResourceChanges } from "@/lib/resource-relation-actions";
import "./asset-detail.css";

/**
 * 详情页优先显示资产自身与对应操作。关联与文档是辅助上下文；
 * 窄屏按相同的 DOM 顺序堆叠。列表仍保留筛选和滚动位置。
 */
export function AssetDetailPage() {
  const expanded = useAppStore((s) => s.expanded);
  if (!expanded) return null;
  // 按资产重建：切到另一项（例如点关联资产）时分页、确认框回到初始状态，入场动效也会重播。
  return <AssetDetail key={`${expanded.kind}:${expanded.id}`} asset={expanded} />;
}

type ServerTab = "overview" | "services" | "nodes" | "docs" | "secrets" | "ops" | "files";

function AssetDetail({ asset }: { asset: ExpandState }) {
  const view = useAppStore((s) => s.view);
  const setExpanded = useAppStore((s) => s.setExpanded);
  const openComposer = useAppStore((s) => s.openComposer);
  const remove = useAppStore((s) => s.remove);
  const currentServer = useAppStore((s) =>
    asset.kind === "server" ? s.servers.find((item) => item.id === asset.id) : undefined,
  );
  const currentSecret = useAppStore((s) =>
    asset.kind === "secret" ? s.secrets.find((item) => item.id === asset.id) : undefined,
  );
  const oauthAccountId = useAppStore((s) =>
    asset.kind === "ai"
      ? s.aiAssets.find((item) => item.id === asset.id)?.oauthAccountId
      : undefined,
  );
  const managedCard = useAppStore((s) =>
    asset.kind === "service" ? s.services.find((item) => item.id === asset.id)?.card : undefined,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [serverTab, setServerTab] = useState<ServerTab>(
    asset.focus === "nodes" ? "nodes" : "overview",
  );
  useEffect(() => {
    if (asset.focus === "nodes") setServerTab("nodes");
  }, [asset.focus, asset.nodeId]);
  const currentAccount =
    currentSecret && ["account", "password"].includes(currentSecret.kind) ? currentSecret : null;
  const detailRoot = useRef<HTMLElement>(null);
  const accountSection = useRef<HTMLDivElement>(null);
  const parent = NAV.find((item) => item.id === view);

  const close = useCallback(() => setExpanded(null), [setExpanded]);

  useLayoutEffect(() => {
    detailRoot.current?.closest(".workspace-scroll")?.scrollTo({ top: 0, behavior: "instant" });
  }, [asset.kind, asset.id, serverTab]);

  useEffect(() => {
    if (asset.focus !== "account") return;
    const frame = requestAnimationFrame(() => {
      accountSection.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
      accountSection.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [asset.focus, serverTab]);

  // Esc 返回列表；编辑器、确认框或解锁框打开时让它们自己处理。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (useVault.getState().prompt) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const deleteAccount = async () => {
    if (!currentAccount || deleting) return;
    const id = currentAccount.id;
    const vault = vaultApi();
    if (!vault) {
      toast.error(t("请在桌面版中删除加密账号。"));
      return;
    }
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await deleteEncryptedAccount({
        id,
        requireUnlocked: () =>
          useVault.getState().require(t("删除账号及其加密凭据需要解锁密钥库。")),
        removeCredential: (key: string) => vault.remove(key),
        removeAsset: async (assetId: string) => {
          remove("secret", assetId);
          await commitResourceChanges();
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const account = vaultApi() && asset.kind !== "service" && !oauthAccountId && (
    <div
      ref={accountSection}
      tabIndex={-1}
      aria-label={t("凭据位置")}
      className="detail-block detail-credentials"
    >
      <AccountPanel assetId={asset.id} kind={asset.kind} />
    </div>
  );
  const summary = <ExpandedBody kind={asset.kind} id={asset.id} />;
  const context = (
    <aside className="detail-block detail-context" aria-label={t("关联资料")}>
      <AssetRelations asset={asset} documentsSeparate />
      <AssetDocuments asset={asset} />
    </aside>
  );

  let body: ReactNode;
  if (currentServer && serverTab !== "overview") {
    body = (
      <div className="detail-block detail-tab-block">
        <div className="detail-tab-header">
          <h1 className="detail-tab-asset-name">{currentServer.name}</h1>
          <span className="detail-tab-badge">
            {t(SERVER_TABS.find(([id]) => id === serverTab)?.[1] ?? "")}
          </span>
        </div>
        <Suspense fallback={<DetailLoading />}>
          {serverTab === "services" && <ServerServicesPanel server={currentServer} />}
          {serverTab === "nodes" && (
            <ServerNodesPanel server={currentServer} focusId={asset.nodeId} />
          )}
          {serverTab === "docs" && <ServerDocsPanel server={currentServer} />}
          {serverTab === "secrets" && <ServerSecretsPanel server={currentServer} />}
          {serverTab === "ops" && <ServerOpsToolbox server={currentServer} />}
          {serverTab === "files" && <SftpBrowser serverId={asset.id} />}
        </Suspense>
      </div>
    );
  } else if (currentServer) {
    body = (
      <div className="detail-layout">
        <div className="detail-column">
          {summary}
          <div className="detail-block">
            <Suspense fallback={<DetailLoading />}>
              <MetricHistory serverId={asset.id} />
            </Suspense>
          </div>
          {account}
        </div>
        {context}
      </div>
    );
  } else {
    body = (
      <div className="detail-layout">
        <div className="detail-column">
          {summary}
          {account}
        </div>
        {context}
      </div>
    );
  }

  return (
    <section
      ref={detailRoot}
      className="asset-detail"
      aria-label={t("资产详情")}
      data-kind={asset.kind}
    >
      {confirmDelete && currentAccount && (
        <EditorDialog title={t("删除账号")} onClose={() => setConfirmDelete(false)}>
          <p className="text-sm leading-relaxed text-muted">
            {t("将删除「{0}」及其加密凭据，关联文档会保留。此操作无法撤销。", currentAccount.name)}
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              {t("取消")}
            </Button>
            <Button variant="danger" onClick={() => void deleteAccount()}>
              {t("确认删除账号")}
            </Button>
          </div>
        </EditorDialog>
      )}

      {confirmDelete && !currentAccount && (
        <TypedDeleteDialog
          name={
            assetEntries(useAppStore.getState()).find(
              (entry) => entry.kind === asset.kind && entry.id === asset.id,
            )?.label ?? ""
          }
          onClose={() => setConfirmDelete(false)}
          description={
            managedCard ? t("也会删除已保存的加密卡片资料，需要解锁密钥库。") : undefined
          }
          onConfirm={async () => {
            const api = vaultApi();
            if (managedCard && api) {
              if (!(await useVault.getState().require(t("删除卡片及其加密资料需要解锁密钥库。"))))
                return;
              await api.remove(cardPrivateId(asset.id));
            }
            setConfirmDelete(false);
            remove(asset.kind, asset.id);
            await commitResourceChanges();
          }}
        />
      )}

      <div className="detail-bar">
        <button type="button" className="detail-back" onClick={close} aria-label={t("返回列表")}>
          <ArrowLeft aria-hidden="true" />
          <span>{t(parent?.label ?? "返回")}</span>
        </button>
        <div className="detail-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const name =
                assetEntries(useAppStore.getState()).find(
                  (entry) => entry.kind === asset.kind && entry.id === asset.id,
                )?.label ?? "";
              useAppStore
                .getState()
                .askAgent(
                  t(
                    "「{0}」现在的状态、关联资产和到期情况怎么样？有哪些需要处理，下一步该做什么？请引用依据。",
                    name,
                  ),
                );
            }}
          >
            <Sparkles className="size-3.5" />
            {t("问 AI")}
          </Button>
          {isProbeKind(asset.kind) && <RefreshOneButton kind={asset.kind} id={asset.id} />}
          {asset.kind !== "secret" && <NetworkResearch asset={asset} />}
          <Button
            variant="outline"
            size="sm"
            onClick={() => openComposer(asset.kind, asset.id)}
            aria-label={t("编辑")}
          >
            <Pencil className="size-3.5" />
            {t("编辑")}
          </Button>
          <Button
            variant="danger-ghost"
            size="icon-sm"
            disabled={deleting}
            title={t("删除")}
            onClick={() => setConfirmDelete(true)}
            aria-label={t("删除")}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {currentServer && (
        <ServerDetailTabs server={currentServer} tab={serverTab} onChange={setServerTab} />
      )}
      <div className="detail-body" key={serverTab}>
        {body}
      </div>
    </section>
  );
}

const SERVER_TABS = [
  ["overview", "监控概览", Activity],
  ["services", "端口与容器", Boxes],
  ["nodes", "自建节点", Zap],
  ["docs", "服务文档", BookOpen],
  ["secrets", "绑定密钥", KeyRound],
  ["ops", "运维工具", Wrench],
  ["files", "文件SFTP", FolderArchive],
] as const;

function ServerDetailTabs({
  server,
  tab,
  onChange,
}: {
  server: Server;
  tab: ServerTab;
  onChange: (tab: ServerTab) => void;
}) {
  return (
    <div className="detail-tabs" role="group" aria-label={t("资产详情")}>
      {SERVER_TABS.map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          aria-pressed={tab === id}
          onClick={() => onChange(id)}
          className="detail-tab"
        >
          <Icon aria-hidden="true" />
          <span>{t(label)}</span>
          {id === "services" && server.serviceScan && <ServerAlertsBadge server={server} />}
          {id === "nodes" && Boolean(server.nodes?.length) && (
            <span className="detail-tab-count">{server.nodes?.length}</span>
          )}
          {id === "secrets" && Boolean(server.customSecrets?.length) && (
            <span className="detail-tab-count">{server.customSecrets?.length}</span>
          )}
          {id === "docs" && Boolean(server.docs?.trim()) && (
            <span className="detail-tab-dot" aria-hidden="true" />
          )}
        </button>
      ))}
    </div>
  );
}

function ServerAlertsBadge({ server }: { server: Server }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const count = containerIssues(server.serviceScan, server.containerAlerts, now).length;
  return count > 0 ? <span className="detail-tab-count">{count}</span> : null;
}

function DetailLoading() {
  return (
    <p className="detail-loading" role="status">
      {t("正在加载…")}
    </p>
  );
}

function DetailSummary({ children }: { children: ReactNode }) {
  return <div className="detail-block detail-summary">{children}</div>;
}

function ExpandedBody({ kind, id }: { kind: AssetKind; id: string }) {
  const server = useAppStore((s) =>
    kind === "server" ? s.servers.find((item) => item.id === id) : undefined,
  );
  const domain = useAppStore((s) =>
    kind === "domain" ? s.domains.find((item) => item.id === id) : undefined,
  );
  const mailbox = useAppStore((s) =>
    kind === "mail" ? s.mailboxes.find((item) => item.id === id) : undefined,
  );
  const ai = useAppStore((s) =>
    kind === "ai" ? s.aiAssets.find((item) => item.id === id) : undefined,
  );
  const secret = useAppStore((s) =>
    kind === "secret" ? s.secrets.find((item) => item.id === id) : undefined,
  );
  const cert = useAppStore((s) =>
    kind === "cert" ? s.certs.find((item) => item.id === id) : undefined,
  );
  const service = useAppStore((s) =>
    kind === "service" ? s.services.find((item) => item.id === id) : undefined,
  );
  const bound = server ?? domain ?? service;
  let summary: ReactNode;
  if (server) summary = <ServerCard data={server} compact={false} />;
  else if (domain) summary = <DomainCard data={domain} compact={false} />;
  else if (mailbox) summary = <MailCard data={mailbox} compact={false} />;
  else if (ai) summary = <AiCard data={ai} compact={false} />;
  else if (secret) summary = <SecretCard data={secret} compact={false} />;
  else if (cert) summary = <CertCard data={cert} compact={false} />;
  else if (service) summary = <ServiceCard data={service} compact={false} />;
  else summary = <Missing />;
  return (
    <>
      <DetailSummary>{summary}</DetailSummary>
      {(kind === "server" || kind === "domain" || kind === "service") && bound?.integration && (
        <div className="detail-block detail-functional">
          <Suspense fallback={<DetailLoading />}>
            <BoundIntegrationPanel
              key={`${id}:${bound.integration.connectionId}:${bound.integration.resourceType}:${bound.integration.remoteId}:${bound.integration.accountId ?? ""}`}
              kind={kind}
              id={id}
              integration={bound.integration}
            />
          </Suspense>
        </div>
      )}
      {mailbox && (
        <div className="detail-block detail-functional">
          <MailStatus key={mailbox.id} mailbox={mailbox} />
        </div>
      )}
      {ai && (
        <>
          <div className="detail-block detail-functional">
            <AiAccountsPanel
              key={ai.id}
              assetId={ai.id}
              linkedAccountId={ai.oauthAccountId}
              initialProvider={ai.oauthProvider}
            />
          </div>
          <div className="detail-block">
            <Suspense fallback={<DetailLoading />}>
              <PhoneBindings subscriptionId={ai.id} />
            </Suspense>
          </div>
        </>
      )}
    </>
  );
}

/** Narrow the asset kind down to the three the app can actually go and check. */
function isProbeKind(kind: AssetKind): kind is ProbeKind {
  return (PROBEABLE as readonly string[]).includes(kind);
}

function Missing() {
  return <p className="p-6 text-meta text-muted">{t("资产不存在或已删除。")}</p>;
}
