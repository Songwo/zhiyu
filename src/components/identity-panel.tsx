import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ExternalLink,
  FilePlus2,
  Fingerprint,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Unplug,
  ScanText,
} from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { hostBridge, openExternal } from "@/lib/web-bridge";
import { isWeb } from "@/lib/web";
import { useDocuments } from "@/lib/documents";
import type { IdentityAccount } from "@/lib/identities";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import { useVault } from "@/lib/vault-state";
import { Button } from "./ui/button";
import { TimeAgo } from "./ui/time-ago";
import { IdentityImport, IdentityProfileSummary } from "./identity-import";
import { DocumentAccountExtract } from "./document-account-extract";
import "./identity-workspace.css";

export function IdentityPanel({ assetId }: { assetId: string }) {
  const bridge = hostBridge()?.identities;
  const unlocked = useVault((state) => state.unlocked);
  const folderId = useAppStore(
    (state) => state.secrets.find((item) => item.id === assetId)?.folderId,
  );
  const [account, setAccount] = useState<IdentityAccount | null>(null);
  const [busy, setBusy] = useState<"load" | "refresh" | "posts" | "save" | "disconnect" | null>(
    "load",
  );
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [postsOpen, setPostsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [disconnecting, setDisconnecting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [savedDocument, setSavedDocument] = useState<string | null>(null);
  const [postErrors, setPostErrors] = useState<Array<{ id: string; message: string }>>([]);
  const [extractOpen, setExtractOpen] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const invalidate = () => {
      generation.current++;
    };
    const clear = () => {
      invalidate();
      setAccount(null);
      setSelected([]);
      setError("");
      setBusy(null);
      setSavedDocument(null);
      setPostErrors([]);
      setExtractOpen(false);
      setPostsOpen(false);
      setDisconnecting(false);
      setImportOpen(false);
    };
    const off = useVault.subscribe((state, previous) => {
      if (!state.unlocked && previous.unlocked) clear();
    });
    const offVault = desktop()?.onVaultChanged(clear);
    return () => {
      alive.current = false;
      invalidate();
      off();
      offVault?.();
    };
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    setAccount(null);
    setSelected([]);
    setPostsOpen(false);
    setSavedDocument(null);
    setPostErrors([]);
    setExtractOpen(false);
    setDisconnecting(false);
    setError("");
    if (!bridge || !unlocked) {
      setBusy(null);
      return;
    }
    setBusy("load");
    void bridge
      .get(assetId)
      .then((value) => {
        if (alive.current && current === generation.current && useVault.getState().unlocked)
          setAccount(value);
      })
      .catch((caught) => {
        if (alive.current && current === generation.current)
          setError(caught instanceof Error ? caught.message : t("身份资料读取失败，请重试。"));
      })
      .finally(() => {
        if (alive.current && current === generation.current) setBusy(null);
      });
  }, [assetId, bridge, unlocked, attempt]);

  async function update(
    action: "refresh" | "posts" | "disconnect",
    options?: { force?: boolean; more?: boolean },
  ) {
    if (!bridge || busy || !unlocked) return;
    const current = generation.current;
    setBusy(action);
    setError("");
    try {
      const value =
        action === "refresh"
          ? await bridge.refresh(assetId)
          : action === "disconnect"
            ? await bridge.disconnect(assetId)
            : await bridge.loadPosts(assetId, options);
      if (!alive.current || current !== generation.current || !useVault.getState().unlocked) return;
      setAccount(value);
      setSelected((items) =>
        items.filter((id) => value.posts.items.some((post) => post.id === id)),
      );
      if (action === "disconnect") {
        setDisconnecting(false);
        toast.success(t(isWeb() ? "服务器授权已断开，已导入资料已保留" : "本机授权已断开，已导入资料已保留"));
      }
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("身份操作失败，请重试。"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  async function savePosts(force = false) {
    if (!bridge || busy || !selected.length || !unlocked) return;
    const current = generation.current;
    setBusy("save");
    setError("");
    setPostErrors([]);
    try {
      const result = await bridge.savePosts({ assetId, postIds: selected, force });
      if (!alive.current || current !== generation.current || !useVault.getState().unlocked) return;
      if (result.documentId) setSavedDocument(result.documentId);
      setPostErrors(result.errors);
      setSelected(result.errors.map((item) => item.id));
      if (result.imported) toast.success(t("已将 {0} 条帖子全文保存为关联文档", result.imported));
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("保存帖子文档失败，请重试。"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  async function openDocument() {
    if (!savedDocument) return;
    try {
      await useDocuments.getState().open(savedDocument);
      useAppStore.getState().setExpanded(null);
      useAppStore.getState().setView("docs");
    } catch {
      toast.error(t("打开文档失败，请重试。"));
    }
  }

  return (
    <section className="identity-panel" aria-label={t("Linux.do 身份资料")}>
      <div className="identity-panel-heading">
        <Fingerprint className="size-4" />
        <h3>{t("社区身份")}</h3>
        <span>Linux.do</span>
      </div>
      {!unlocked ? (
        <div className="identity-notice">
          <LockKeyhole className="size-5" />
          <p>{t("身份资料与授权凭据已加密，解锁后查看。")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void useVault
                .getState()
                .require(t("查看身份资料需要先解锁密钥库。"))
                .catch(() => setError(t("解锁失败，请重试。")))
            }
          >
            {t("解锁查看")}
          </Button>
        </div>
      ) : busy === "load" ? (
        <p className="identity-status" role="status">
          <Loader2 className="size-4 animate-spin" />
          {t("读取身份资料…")}
        </p>
      ) : !account ? (
        <div className="identity-notice">
          <p>{t("暂时无法读取此身份资料。")}</p>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            {t("重新连接身份")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t("重新读取")}
          </Button>
        </div>
      ) : (
        <>
          <IdentityProfileSummary profile={account.profile} />
          <div className="identity-sync">
            <span className={account.connected ? "identity-connected" : "text-muted"}>
              {t(account.connected ? "已连接" : "已断开授权")}
            </span>
            <span>
              {t("资料同步于")} <TimeAgo iso={account.updatedAt} />
            </span>
          </div>
          <div className="identity-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void openExternal(account.profile.profileUrl).catch(() =>
                  toast.error(t("无法打开链接")),
                )
              }
            >
              <ExternalLink />
              {t("打开个人主页")}
            </Button>
            {account.connected ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy}
                onClick={() => void update("refresh")}
              >
                <RefreshCw className={busy === "refresh" ? "animate-spin" : ""} />
                {t("刷新身份资料")}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                {t("重新授权")}
              </Button>
            )}
          </div>
          {!account.connected && (
            <p className="identity-footnote">
              {t(isWeb() ? "服务器已删除此授权令牌，已导入资料与关联文档仍然保留。" : "本机已停止使用此授权。已导入的身份资料与关联文档仍然保留。")}
            </p>
          )}
          <div className="identity-posts">
            <div className="identity-posts-heading">
              <BookOpen className="size-4" />
              <h4>{t("公开主题与回复")}</h4>
              {postsOpen && <span>{t("已取得 {0} 条", account.posts.items.length)}</span>}
            </div>
            <p className="identity-footnote">
              {t(
                "列表展示公开帖子摘要，保存时读取所选帖子的全文。缓存 15 分钟；已取得条数不代表总发帖数。",
              )}
            </p>
            {!postsOpen ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() => {
                  setPostsOpen(true);
                  void update("posts");
                }}
              >
                {t(account.posts.items.length ? "查看已缓存帖子" : "读取公开帖子")}
              </Button>
            ) : (
              <>
                <div className="identity-posts-toolbar">
                  <span className="text-2xs text-subtle">
                    {account.posts.fetchedAt ? (
                      <>
                        {t("获取于")} <TimeAgo iso={account.posts.fetchedAt} />
                      </>
                    ) : (
                      t("尚未获取公开帖子")
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => void update("posts", { force: true })}
                  >
                    <RefreshCw className={busy === "posts" ? "animate-spin" : ""} />
                    {t("刷新帖子")}
                  </Button>
                </div>
                {account.posts.status === "unavailable" && (
                  <p className="identity-notice" role="status">
                    {account.posts.message || t("平台暂时不允许读取公开帖子，已保留上次缓存。")}
                  </p>
                )}
                {busy === "posts" && (
                  <p className="identity-status" role="status">
                    <Loader2 className="size-4 animate-spin" />
                    {t("读取公开帖子…")}
                  </p>
                )}
                {!account.posts.items.length &&
                  busy !== "posts" &&
                  account.posts.status !== "unavailable" && (
                    <p className="identity-footnote">{t("目前没有可读取的公开主题或回复。")}</p>
                  )}
                <div className="identity-post-list">
                  {account.posts.items.map((post) => (
                    <article className="identity-post" key={post.id}>
                      <label className="identity-post-select">
                        <input
                          type="checkbox"
                          disabled={!!busy}
                          checked={selected.includes(post.id)}
                          onChange={(event) =>
                            setSelected((items) =>
                              event.target.checked
                                ? [...items, post.id]
                                : items.filter((id) => id !== post.id),
                            )
                          }
                          aria-label={t("选择帖子 {0}", post.title)}
                        />
                      </label>
                      <div className="identity-post-content">
                        <button
                          type="button"
                          className="identity-post-title"
                          onClick={() =>
                            void openExternal(post.url).catch(() => toast.error(t("无法打开链接")))
                          }
                        >
                          {post.title}
                          <ExternalLink className="size-3.5" />
                        </button>
                        <p>{post.excerpt || t("此帖子未提供摘要。")}</p>
                        <div className="identity-post-meta">
                          <span>{t(post.kind === "topic" ? "主题" : "回复")}</span>
                          {post.createdAt && <TimeAgo iso={post.createdAt} />}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="identity-actions">
                  {account.posts.hasMore && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => void update("posts", { more: true })}
                    >
                      {t("加载更多帖子")}
                    </Button>
                  )}
                  {account.posts.items.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy || !selected.length}
                      onClick={() => void savePosts()}
                    >
                      {busy === "save" ? <Loader2 className="animate-spin" /> : <FilePlus2 />}
                      {t(busy === "save" ? "正在读取帖子全文…" : "导入全文并关联")}
                      {selected.length > 0 && <span>{selected.length}</span>}
                    </Button>
                  )}
                </div>
                {postErrors.length > 0 && (
                  <div className="identity-notice" role="status">
                    <div>
                      <strong>{t("{0} 条帖子未能导入全文", postErrors.length)}</strong>
                      {postErrors.map((item) => (
                        <p key={item.id}>
                          {account.posts.items.find((post) => post.id === item.id)?.title ||
                            t("帖子")}
                          ：{item.message}
                        </p>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy || !selected.length}
                      onClick={() => void savePosts(true)}
                    >
                      {t("重试未导入的帖子")}
                    </Button>
                  </div>
                )}
                {savedDocument && (
                  <div className="identity-actions">
                    <Button variant="ghost" size="sm" onClick={() => void openDocument()}>
                      <BookOpen />
                      {t("查看已保存的关联文档")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setExtractOpen(true)}>
                      <ScanText />
                      {t("提取文档中的账号")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
          {account.connected && (
            <div className="identity-disconnect">
              {disconnecting ? (
                <>
                  <p>
                    {t(
                      isWeb() ? "断开后删除服务器保存的身份令牌，保留身份资料与文档。平台侧授权需前往 Linux.do Connect 撤销。" : "断开后会删除本机授权凭据，保留已导入的身份资料与文档。平台侧授权可在 Linux.do Connect 中撤销。",
                    )}
                  </p>
                  <div className="identity-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => setDisconnecting(false)}
                    >
                      {t("取消")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => void update("disconnect")}
                    >
                      {busy === "disconnect" && <Loader2 className="animate-spin" />}
                      {t(isWeb() ? "确认断开服务器授权" : "确认断开本机授权")}
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => setDisconnecting(true)}
                >
                  <Unplug />
                  {t(isWeb() ? "断开服务器授权" : "断开本机授权")}
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p className="identity-error" role="alert">
          {error}
        </p>
      )}
      {importOpen && (
        <IdentityImport
          folderId={folderId}
          close={() => setImportOpen(false)}
          onImported={(id) => {
            if (id === assetId) setAttempt((value) => value + 1);
            else
              useAppStore.getState().setExpanded({
                kind: "secret",
                id,
                origin: { x: window.innerWidth / 2, y: window.innerHeight / 2, w: 0, h: 0 },
              });
          }}
        />
      )}
      {extractOpen && savedDocument && (
        <DocumentAccountExtract documentId={savedDocument} close={() => setExtractOpen(false)} />
      )}
    </section>
  );
}
