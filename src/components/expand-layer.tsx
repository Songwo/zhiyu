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
  FolderArchive,
  KeyRound,
  Pencil,
  Sparkles,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AiCard, CertCard, DomainCard, MailCard, SecretCard, ServerCard } from "./asset-card";
const BoundIntegrationPanel = lazy(() =>
  import("./integrations/bound-integration-panel").then((module) => ({
    default: module.BoundIntegrationPanel,
  })),
);
import { ServiceCard } from "./service-card";
import { AccountPanel } from "./account-panel";
import { MailStatus } from "./mail-status";
import { AiAccountsPanel } from "./ai-accounts";
import { AssetRelations, SftpBrowser } from "./operations-panel";
import { RefreshOneButton } from "./refresh-button";
import { ServerNodesPanel } from "./server-nodes-panel";
import { ServerDocsPanel } from "./server-docs-panel";
import { ServerSecretsPanel } from "./server-secrets-panel";
import { ServerOpsToolbox } from "./server-ops-toolbox";
import { Button } from "./ui/button";
import { PROBEABLE, type ProbeKind } from "@/lib/probes";
import { useAppStore, type ExpandState } from "@/lib/store";
import type { AssetKind } from "@/lib/types";
import { t } from "@/lib/i18n";
import { desktop } from "@/lib/desktop";
import { useVault } from "@/lib/vault-state";
import { deleteEncryptedAccount } from "@/lib/account-delete.mjs";
import { EditorDialog } from "./ui/editor-dialog";
import { NAV } from "./sidebar";
import { assetEntries } from "@/lib/operations";
import { toast } from "sonner";

/**
 * 资产详情是主内容区里的一页，而不是浮在列表上的弹窗：顶部返回原列表，
 * 左列放资产本身与指标，右列放关联、文档和凭据。列表保持挂载，返回时
 * 筛选和滚动位置都还在。
 */
export function AssetDetailPage() {
  const expanded = useAppStore((s) => s.expanded);
  if (!expanded) return null;
  // 按资产重建：切到另一项（例如点关联资产）时分页、确认框回到初始状态，入场动效也会重播。
  return <AssetDetail key={`${expanded.kind}:${expanded.id}`} asset={expanded} />;
}

type ServerTab = "overview" | "nodes" | "docs" | "secrets" | "ops" | "files";

function AssetDetail({ asset }: { asset: ExpandState }) {
  const view = useAppStore((s) => s.view);
  const setExpanded = useAppStore((s) => s.setExpanded);
  const openComposer = useAppStore((s) => s.openComposer);
  const remove = useAppStore((s) => s.remove);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const servers = useAppStore((s) => s.servers);
  const secrets = useAppStore((s) => s.secrets);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [serverTab, setServerTab] = useState<ServerTab>("overview");
  const currentServer = asset.kind === "server" ? servers.find((s) => s.id === asset.id) : null;
  const currentAccount =
    asset.kind === "secret"
      ? secrets.find((item) => item.id === asset.id && ["account", "password"].includes(item.kind))
      : null;
  const accountSection = useRef<HTMLDivElement>(null);
  const parent = NAV.find((item) => item.id === view);

  const close = useCallback(() => setExpanded(null), [setExpanded]);

  useEffect(() => {
    if (asset.focus !== "account") return;
    const timer = window.setTimeout(() => {
      accountSection.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      accountSection.current?.focus({ preventScroll: true });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [asset.focus]);

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
    const bridge = desktop();
    if (!bridge) {
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
        removeCredential: (key: string) => bridge.vault.remove(key),
        removeAsset: (assetId: string) => remove("secret", assetId),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const account = (
    <div ref={accountSection} tabIndex={-1} aria-label={t("凭据位置")} className="detail-block">
      <AccountPanel key={`${asset.kind}:${asset.id}`} assetId={asset.id} kind={asset.kind} />
    </div>
  );
  const summary = (
    <div className="detail-block detail-summary">
      <ExpandedBody kind={asset.kind} id={asset.id} />
    </div>
  );
  const relations = (
    <div className="detail-block">
      <AssetRelations key={`links:${asset.kind}:${asset.id}`} asset={asset} />
    </div>
  );
  const accountInAside =
    !currentAccount &&
    asset.kind !== "service" &&
    (asset.kind !== "ai" || !aiAssets.find((item) => item.id === asset.id)?.oauthAccountId);

  let body: ReactNode;
  if (currentServer && serverTab !== "overview") {
    body = (
      <div className="detail-block">
        {serverTab === "nodes" && (
          <ServerNodesPanel key={`nodes:${asset.id}`} server={currentServer} />
        )}
        {serverTab === "docs" && (
          <ServerDocsPanel key={`docs:${asset.id}`} server={currentServer} />
        )}
        {serverTab === "secrets" && (
          <ServerSecretsPanel key={`secrets:${asset.id}`} server={currentServer} />
        )}
        {serverTab === "ops" && <ServerOpsToolbox key={`ops:${asset.id}`} server={currentServer} />}
        {serverTab === "files" && <SftpBrowser key={`files:${asset.id}`} serverId={asset.id} />}
      </div>
    );
  } else if (currentServer) {
    body = (
      <div className="detail-layout">
        <div className="detail-column">
          {summary}
          <div className="detail-block">
            <Suspense fallback={<p className="p-5 text-sm text-muted">{t("正在加载…")}</p>}>
              <MetricHistory key={`metrics:${asset.id}`} serverId={asset.id} />
            </Suspense>
          </div>
        </div>
        <div className="detail-column">
          {relations}
          {account}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="detail-layout">
        <div className="detail-column">
          {summary}
          {currentAccount && account}
        </div>
        <div className="detail-column">
          {relations}
          <div className="detail-block">
            <AssetDocuments asset={asset} />
          </div>
          {accountInAside && account}
        </div>
      </div>
    );
  }

  return (
    <section className="asset-detail" aria-label={t("资产详情")} data-kind={asset.kind}>
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
            onClick={() => (currentAccount ? setConfirmDelete(true) : remove(asset.kind, asset.id))}
            aria-label={t("删除")}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* 服务器详情的分页：中性图标、不换行，选中项为浅灰轨道上的白块。 */}
      {currentServer && (
        <div className="detail-tabs" role="group" aria-label={t("资产详情")}>
          {(
            [
              ["overview", "监控概览", Activity, 0],
              ["nodes", "自建节点", Zap, currentServer.nodes?.length ?? 0],
              ["docs", "服务文档", BookOpen, 0],
              ["secrets", "绑定密钥", KeyRound, currentServer.customSecrets?.length ?? 0],
              ["ops", "运维工具", Wrench, 0],
              ["files", "文件SFTP", FolderArchive, 0],
            ] as const
          ).map(([id, label, Icon, count]) => (
            <button
              key={id}
              type="button"
              aria-pressed={serverTab === id}
              onClick={() => setServerTab(id)}
              className="detail-tab"
            >
              <Icon aria-hidden="true" />
              <span>{t(label)}</span>
              {count > 0 && <span className="detail-tab-count">{count}</span>}
              {id === "docs" && Boolean(currentServer.docs?.trim()) && (
                <span className="detail-tab-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}

      {/* 换分页时重建，内容按卡片依次浮入。 */}
      <div className="detail-body" key={serverTab}>
        {body}
      </div>
    </section>
  );
}

function ExpandedBody({ kind, id }: { kind: AssetKind; id: string }) {
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const mailboxes = useAppStore((s) => s.mailboxes);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const secrets = useAppStore((s) => s.secrets);
  const certs = useAppStore((s) => s.certs);
  const services = useAppStore((s) => s.services);

  switch (kind) {
    case "server": {
      const d = servers.find((x) => x.id === id);
      return d ? (
        <>
          <ServerCard data={d} compact={false} />
          {d.integration && (
            <Suspense fallback={<p>{t("正在加载…")}</p>}>
              <BoundIntegrationPanel
                key={`${id}:${d.integration.connectionId}:${d.integration.resourceType}:${d.integration.remoteId}:${d.integration.accountId ?? ""}`}
                kind="server"
                id={id}
                integration={d.integration}
              />
            </Suspense>
          )}
        </>
      ) : (
        <Missing />
      );
    }
    case "domain": {
      const d = domains.find((x) => x.id === id);
      return d ? (
        <>
          <DomainCard data={d} compact={false} />
          {d.integration && (
            <Suspense fallback={<p>{t("正在加载…")}</p>}>
              <BoundIntegrationPanel
                key={`${id}:${d.integration.connectionId}:${d.integration.resourceType}:${d.integration.remoteId}:${d.integration.accountId ?? ""}`}
                kind="domain"
                id={id}
                integration={d.integration}
              />
            </Suspense>
          )}
        </>
      ) : (
        <Missing />
      );
    }
    case "mail": {
      const d = mailboxes.find((x) => x.id === id);
      return d ? (
        <>
          <MailCard data={d} compact={false} />
          <div className="px-4">
            <MailStatus key={d.id} mailbox={d} />
          </div>
        </>
      ) : (
        <Missing />
      );
    }
    case "ai": {
      const d = aiAssets.find((x) => x.id === id);
      return d ? (
        <>
          <AiCard data={d} compact={false} />
          <div className="px-4 pb-4">
            <AiAccountsPanel
              key={d.id}
              assetId={d.id}
              linkedAccountId={d.oauthAccountId}
              initialProvider={d.oauthProvider}
            />
          </div>
          <Suspense fallback={<p className="p-4 text-sm text-muted">{t("正在加载…")}</p>}>
            <PhoneBindings subscriptionId={d.id} />
          </Suspense>
        </>
      ) : (
        <Missing />
      );
    }
    case "secret": {
      const d = secrets.find((x) => x.id === id);
      return d ? <SecretCard data={d} compact={false} /> : <Missing />;
    }
    case "service": {
      const d = services.find((x) => x.id === id);
      return d ? (
        <>
          <ServiceCard data={d} compact={false} />
          {d.integration && (
            <Suspense fallback={<p>{t("正在加载…")}</p>}>
              <BoundIntegrationPanel
                key={`${id}:${d.integration.connectionId}:${d.integration.resourceType}:${d.integration.remoteId}:${d.integration.accountId ?? ""}`}
                kind="service"
                id={id}
                integration={d.integration}
              />
            </Suspense>
          )}
        </>
      ) : (
        <Missing />
      );
    }
    case "cert": {
      const d = certs.find((x) => x.id === id);
      return d ? <CertCard data={d} compact={false} /> : <Missing />;
    }
  }
}

/** Narrow the asset kind down to the three the app can actually go and check. */
function isProbeKind(kind: AssetKind): kind is ProbeKind {
  return (PROBEABLE as readonly string[]).includes(kind);
}

function Missing() {
  return <p className="p-6 text-meta text-muted">{t("资产不存在或已删除。")}</p>;
}
