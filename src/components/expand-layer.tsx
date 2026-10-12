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
  BookOpen,
  FolderArchive,
  KeyRound,
  Pencil,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { cardRect, flipTransform, reduceMotion } from "@/lib/motion";
import { PROBEABLE, type ProbeKind } from "@/lib/probes";
import { useAppStore, type ExpandState } from "@/lib/store";
import type { AssetKind } from "@/lib/types";
import { t } from "@/lib/i18n";
import { desktop } from "@/lib/desktop";
import { useVault } from "@/lib/vault-state";
import { deleteEncryptedAccount } from "@/lib/account-delete.mjs";
import { EditorDialog } from "./ui/editor-dialog";
import { toast } from "sonner";

const ENTER_MS = 340;
const EXIT_MS = 220;

/**
 * The detail sheet grows out of the card that was clicked and shrinks back into
 * it — a FLIP against the card's real rectangle, remeasured on the way out so a
 * scroll (or a resize) mid-session still lands on the card rather than where it
 * used to be.
 */
export function ExpandLayer() {
  const expanded = useAppStore((s) => s.expanded);
  const setExpanded = useAppStore((s) => s.setExpanded);
  const openComposer = useAppStore((s) => s.openComposer);
  const remove = useAppStore((s) => s.remove);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const servers = useAppStore((s) => s.servers);
  const secrets = useAppStore((s) => s.secrets);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [visible, setVisible] = useState<ExpandState | null>(null);
  const [shown, setShown] = useState(false);
  const [serverTab, setServerTab] = useState<
    "overview" | "nodes" | "docs" | "secrets" | "ops" | "files"
  >("overview");
  const currentServer =
    visible?.kind === "server" ? servers.find((s) => s.id === visible.id) : null;
  const currentAccount =
    visible?.kind === "secret"
      ? secrets.find(
          (item) => item.id === visible.id && ["account", "password"].includes(item.kind),
        )
      : null;

  useEffect(() => {
    setServerTab("overview");
    setConfirmDelete(false);
  }, [visible?.id]);

  const panel = useRef<HTMLDivElement>(null);
  const accountSection = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const exitTimer = useRef(0);

  // `expanded` is the source of truth; local state only outlives it for the
  // length of the exit.
  useEffect(() => {
    if (expanded) {
      window.clearTimeout(exitTimer.current);
      closing.current = false;
      setVisible(expanded);
      return;
    }
    if (!visible || closing.current) return;
    closing.current = true;
    setShown(false);
    const el = panel.current;
    if (el && !reduceMotion()) {
      const from = cardRect(visible.id) ?? visible.origin;
      el.style.willChange = "transform, opacity";
      el.style.transition = `transform ${EXIT_MS}ms var(--ease-out), opacity ${EXIT_MS}ms ease-in`;
      el.style.transform = flipTransform(from, el.getBoundingClientRect());
      el.style.opacity = "0";
    }
    exitTimer.current = window.setTimeout(() => setVisible(null), reduceMotion() ? 0 : EXIT_MS);
  }, [expanded, visible]);

  // Enter: paint at the card's rectangle, then release to the laid-out one.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || !visible || closing.current) return;
    const settle = () => {
      if (closing.current) return;
      el.style.transform = "none";
      el.style.willChange = "auto";
      el.style.transition = "";
    };
    if (reduceMotion()) {
      settle();
      setShown(true);
      return;
    }
    const to = el.getBoundingClientRect();
    el.style.willChange = "transform, opacity";
    el.style.transition = "none";
    el.style.transform = flipTransform(visible.origin, to);
    el.style.opacity = "0.25";
    // Force the closed frame to land before the transition is armed.
    const _reflow = el.offsetWidth;
    el.style.transition = `transform ${ENTER_MS}ms var(--ease-out-soft), opacity ${Math.round(ENTER_MS * 0.6)}ms var(--ease-out)`;
    el.style.transform = "translate3d(0, 0, 0) scale(1)";
    el.style.opacity = "1";
    setShown(true);
    const timer = window.setTimeout(settle, ENTER_MS + 50);
    const onEnd = (event: TransitionEvent) => {
      if (event.target === el && event.propertyName === "transform") settle();
    };
    el.addEventListener("transitionend", onEnd);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("transitionend", onEnd);
    };
  }, [visible]);

  useEffect(() => () => window.clearTimeout(exitTimer.current), []);

  useEffect(() => {
    if (visible?.focus !== "account") return;
    const timer = window.setTimeout(
      () => {
        accountSection.current?.scrollIntoView({ block: "nearest" });
        accountSection.current?.focus({ preventScroll: true });
      },
      reduceMotion() ? 0 : ENTER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [visible]);

  const close = useCallback(() => setExpanded(null), [setExpanded]);
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

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmDelete && !useVault.getState().prompt) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, close, confirmDelete]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-8 sm:py-12"
      role="dialog"
      aria-modal="true"
      aria-label={t("资产详情")}
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
      <button
        type="button"
        aria-label={t("关闭")}
        className="anim-scrim absolute inset-0 bg-ink/35"
        data-shown={shown}
        onClick={close}
      />
      <div
        ref={panel}
        className="relative z-10 w-full max-w-2xl overflow-hidden rounded-2xl bg-card shadow-float"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-meta font-medium text-muted">{t("资产详情")}</span>
          <div className="flex items-center gap-1">
            {isProbeKind(visible.kind) && <RefreshOneButton kind={visible.kind} id={visible.id} />}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => openComposer(visible.kind, visible.id)}
              aria-label={t("编辑")}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={deleting}
              onClick={() =>
                currentAccount ? setConfirmDelete(true) : remove(visible.kind, visible.id)
              }
              aria-label={t("删除")}
            >
              <Trash2 className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={close} aria-label={t("关闭")}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Server Sub-Tabs Bar */}
        {visible.kind === "server" && currentServer && (
          <div className="flex border-b border-line bg-surface-subtle/40 px-3 py-1.5 gap-1 overflow-x-auto text-xs">
            <button
              type="button"
              onClick={() => setServerTab("overview")}
              className={`btn-pill px-3 py-1 flex items-center gap-1.5 font-medium transition-colors cursor-pointer ${
                serverTab === "overview"
                  ? "bg-card text-ink shadow-xs border border-line"
                  : "text-muted hover:text-ink"
              }`}
            >
              <Activity className="size-3.5 text-muted" />
              <span>{t("监控概览")}</span>
            </button>
            <button
              type="button"
              onClick={() => setServerTab("nodes")}
              className={`btn-pill px-3 py-1 flex items-center gap-1.5 font-medium transition-colors cursor-pointer ${
                serverTab === "nodes"
                  ? "bg-card text-ink shadow-xs border border-line"
                  : "text-muted hover:text-ink"
              }`}
            >
              <Zap className="size-3.5 text-emerald-400" />
              <span>{t("自建节点")}</span>
              {Boolean(currentServer.nodes?.length) && (
                <span className="rounded-full bg-emerald-500/20 text-emerald-400 px-1.5 py-0.2 text-[10px] font-mono">
                  {currentServer.nodes!.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setServerTab("docs")}
              className={`btn-pill px-3 py-1 flex items-center gap-1.5 font-medium transition-colors cursor-pointer ${
                serverTab === "docs"
                  ? "bg-card text-ink shadow-xs border border-line"
                  : "text-muted hover:text-ink"
              }`}
            >
              <BookOpen className="size-3.5 text-sky-400" />
              <span>{t("服务文档")}</span>
              {Boolean(currentServer.docs?.trim()) && (
                <span className="size-1.5 rounded-full bg-sky-400" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setServerTab("secrets")}
              className={`btn-pill px-3 py-1 flex items-center gap-1.5 font-medium transition-colors cursor-pointer ${
                serverTab === "secrets"
                  ? "bg-card text-ink shadow-xs border border-line"
                  : "text-muted hover:text-ink"
              }`}
            >
              <KeyRound className="size-3.5 text-amber-400" />
              <span>{t("绑定密钥")}</span>
              {Boolean(currentServer.customSecrets?.length) && (
                <span className="rounded-full bg-amber-500/20 text-amber-400 px-1.5 py-0.2 text-[10px] font-mono">
                  {currentServer.customSecrets!.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setServerTab("ops")}
              className={`btn-pill px-3 py-1 flex items-center gap-1.5 font-medium transition-colors cursor-pointer ${
                serverTab === "ops"
                  ? "bg-card text-ink shadow-xs border border-line"
                  : "text-muted hover:text-ink"
              }`}
            >
              <Wrench className="size-3.5 text-amber-400" />
              <span>{t("运维工具")}</span>
            </button>
            <button
              type="button"
              onClick={() => setServerTab("files")}
              className={`btn-pill px-3 py-1 flex items-center gap-1.5 font-medium transition-colors cursor-pointer ${
                serverTab === "files"
                  ? "bg-card text-ink shadow-xs border border-line"
                  : "text-muted hover:text-ink"
              }`}
            >
              <FolderArchive className="size-3.5 text-muted" />
              <span>{t("文件SFTP")}</span>
            </button>
          </div>
        )}

        <div className="max-h-[min(70vh,640px)] overflow-y-auto">
          {visible.kind === "server" && currentServer ? (
            <>
              {serverTab === "overview" && (
                <>
                  <ExpandedBody kind={visible.kind} id={visible.id} />
                  <Suspense fallback={<p className="p-4 text-sm text-muted">{t("正在加载…")}</p>}>
                    <MetricHistory key={`metrics:${visible.id}`} serverId={visible.id} />
                  </Suspense>
                  <AssetRelations key={`links:${visible.kind}:${visible.id}`} asset={visible} />
                  <div ref={accountSection} tabIndex={-1} aria-label={t("凭据位置")}>
                    <AccountPanel
                      key={`${visible.kind}:${visible.id}`}
                      assetId={visible.id}
                      kind={visible.kind}
                    />
                  </div>
                </>
              )}
              {serverTab === "nodes" && (
                <ServerNodesPanel key={`nodes:${visible.id}`} server={currentServer} />
              )}
              {serverTab === "docs" && (
                <ServerDocsPanel key={`docs:${visible.id}`} server={currentServer} />
              )}
              {serverTab === "secrets" && (
                <ServerSecretsPanel key={`secrets:${visible.id}`} server={currentServer} />
              )}
              {serverTab === "ops" && (
                <ServerOpsToolbox key={`ops:${visible.id}`} server={currentServer} />
              )}
              {serverTab === "files" && (
                <SftpBrowser key={`files:${visible.id}`} serverId={visible.id} />
              )}
            </>
          ) : (
            <>
              <ExpandedBody kind={visible.kind} id={visible.id} />
              {currentAccount && (
                <div ref={accountSection} tabIndex={-1} aria-label={t("凭据位置")}>
                  <AccountPanel
                    key={`${visible.kind}:${visible.id}`}
                    assetId={visible.id}
                    kind={visible.kind}
                  />
                </div>
              )}
              {visible.kind === "server" && (
                <Suspense fallback={<p className="p-4 text-sm text-muted">{t("正在加载…")}</p>}>
                  <MetricHistory key={`metrics:${visible.id}`} serverId={visible.id} />
                </Suspense>
              )}
              {visible.kind === "server" && (
                <SftpBrowser key={`files:${visible.id}`} serverId={visible.id} />
              )}
              <AssetRelations key={`links:${visible.kind}:${visible.id}`} asset={visible} />
              <AssetDocuments asset={visible} />
              {!currentAccount &&
                visible.kind !== "service" &&
                (visible.kind !== "ai" ||
                  !aiAssets.find((item) => item.id === visible.id)?.oauthAccountId) && (
                  <div ref={accountSection} tabIndex={-1} aria-label={t("凭据位置")}>
                    <AccountPanel
                      key={`${visible.kind}:${visible.id}`}
                      assetId={visible.id}
                      kind={visible.kind}
                    />
                  </div>
                )}
            </>
          )}
        </div>
      </div>
    </div>
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
