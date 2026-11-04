import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ExternalLink,
  Fingerprint,
  Loader2,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { hostBridge, openExternal } from "@/lib/web-bridge";
import { useDocuments } from "@/lib/documents";
import type { IdentityAccount, IdentityProfile } from "@/lib/identities";
import { t } from "@/lib/i18n";
import { useProfile } from "@/lib/profile";
import { useAppStore } from "@/lib/store";
import { safeImageDataUrl } from "../../electron/services/image-data.mjs";
import { Button } from "./ui/button";
import { TimeAgo } from "./ui/time-ago";
import "./primary-identity-panel.css";

/** 内嵌授权流程，也可用于首次设置的原生 dialog，不创建跨层级弹窗。 */
export function PrimaryIdentityPanel({ initial = false }: { initial?: boolean }) {
  const bridge = hostBridge()?.mainIdentity;
  const identity = useProfile((state) => state.profile?.mainIdentity);
  const [availability, setAvailability] = useState<{ configured: boolean; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [preview, setPreview] = useState<IdentityProfile | null>(null);
  const [previewAvatar, setPreviewAvatar] = useState("");
  const [syncName, setSyncName] = useState(false);
  const [syncAvatar, setSyncAvatar] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const session = useRef<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const replacing = !!identity && !!preview && identity.profile.subject !== preview.subject;

  useEffect(() => {
    if (sessionId) return;
    setSyncName(identity?.syncName ?? false);
    setSyncAvatar(identity?.syncAvatar ?? false);
  }, [identity?.syncName, identity?.syncAvatar, sessionId]);

  useEffect(() => {
    alive.current = true;
    const invalidate = () => {
      generation.current++;
    };
    return () => {
      alive.current = false;
      invalidate();
      const id = session.current;
      session.current = null;
      if (id) void bridge?.cancel(id).catch(() => {});
    };
  }, [bridge]);

  async function checkAvailability() {
    if (!bridge) return;
    setBusy("availability");
    setError("");
    const current = generation.current;
    try {
      const result = await bridge.availability();
      if (alive.current && current === generation.current) setAvailability(result);
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(String(caught instanceof Error ? caught.message : caught));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  useEffect(() => {
    void checkAvailability();
    // 接入状态只在打开面板或主动重试时读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  function discard() {
    generation.current++;
    const id = session.current;
    session.current = null;
    setSessionId(null);
    setAuthorizationUrl("");
    setPreview(null);
    setPreviewAvatar("");
    setReplaceConfirmed(false);
    setError("");
    setBusy(null);
    if (id) void bridge?.cancel(id).catch(() => {});
  }

  useEffect(() => {
    if (!bridge || !sessionId || preview) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = generation.current;
    const valid = () => !stopped && alive.current && current === generation.current;
    async function poll() {
      try {
        const result = await bridge!.status(sessionId!);
        if (!valid()) return;
        if (result.status === "ready" && result.preview) {
          setPreview(result.preview);
          setPreviewAvatar(safeImageDataUrl(result.avatarDataUrl));
          return;
        }
        if (result.status === "error" || result.status === "cancelled") {
          setError(result.error || t("授权已取消或过期，请重新登录。"));
          session.current = null;
          setSessionId(null);
          void bridge!.cancel(sessionId!).catch(() => {});
          return;
        }
        timer = setTimeout(() => void poll(), 1000);
      } catch (caught) {
        if (!valid()) return;
        setError(caught instanceof Error ? caught.message : t("读取授权状态失败，请重新登录。"));
        session.current = null;
        setSessionId(null);
        void bridge!.cancel(sessionId!).catch(() => {});
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, sessionId, preview]);

  async function start() {
    if (!bridge || busy || !availability?.configured) return;
    discard();
    setDisconnecting(false);
    setSyncName(false);
    setSyncAvatar(false);
    setBusy("start");
    const current = generation.current;
    try {
      const value = await bridge.start();
      if (!alive.current || current !== generation.current) {
        void bridge.cancel(value.id).catch(() => {});
        return;
      }
      session.current = value.id;
      setSessionId(value.id);
      setAuthorizationUrl(value.authorizationUrl || "");
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("无法启动登录，请重试。"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  async function update(action: "bind" | "preferences" | "refresh" | "disconnect") {
    if (!bridge || busy) return;
    if (action === "bind" && (!sessionId || !preview || (replacing && !replaceConfirmed))) return;
    const current = generation.current;
    setBusy(action);
    setError("");
    try {
      if (action === "bind") {
        await bridge.bind({
          sessionId: sessionId!,
          syncName,
          syncAvatar,
          ...(replacing ? { replaceSubject: identity!.profile.subject } : {}),
        });
        session.current = null;
      } else if (action === "preferences") await bridge.preferences({ syncName, syncAvatar });
      else if (action === "refresh") await bridge.refresh();
      else await bridge.disconnect();
      await useProfile.getState().refresh();
      if (!alive.current || current !== generation.current) return;
      if (useProfile.getState().error) throw new Error(useProfile.getState().error);
      if (action !== "disconnect") {
        const latest = useProfile.getState().profile?.mainIdentity;
        window.dispatchEvent(
          new CustomEvent("profile:identity-synced", {
            detail: { syncName: latest?.syncName, syncAvatar: latest?.syncAvatar },
          }),
        );
      }
      setSessionId(null);
      setPreview(null);
      setPreviewAvatar("");
      setReplaceConfirmed(false);
      setDisconnecting(false);
      toast.success(
        t(
          action === "bind"
            ? "主身份已绑定"
            : action === "disconnect"
              ? "已退出 Linux.do 登录，本机资料已保留"
              : "身份资料已更新",
        ),
      );
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("身份操作失败，请重试。"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  const waiting = !!sessionId && !preview;
  const preferencesChanged =
    identity && (syncName !== identity.syncName || syncAvatar !== identity.syncAvatar);
  return (
    <section className="primary-identity" aria-label={t("Linux.do 主身份")} data-initial={initial}>
      <header className="primary-identity-heading">
        <span className="primary-identity-mark">
          <Fingerprint aria-hidden="true" />
        </span>
        <div>
          <h3>{t("Linux.do 主身份")}</h3>
          <p>
            {t(
              initial
                ? "使用社区账号绑定知屿，也可以先在本机开始。"
                : "管理你的社区身份、资料同步和本人帖子。",
            )}
          </p>
        </div>
      </header>
      {!bridge ? (
        <p className="primary-identity-note">{t("仅桌面版可用")}</p>
      ) : (
        <>
          {identity && !preview && (
            <>
              <PrimaryProfile profile={identity.profile} avatar={identity.avatarDataUrl} />
              <div className="primary-identity-status">
                <span className={identity.connected ? "text-ok" : "text-muted"}>
                  {t(identity.connected ? "已绑定主身份" : "已退出登录")}
                </span>
                <span>
                  {t("资料同步于")} <TimeAgo iso={identity.updatedAt} />
                </span>
              </div>
              {identity.avatarMessage && (
                <p className="primary-identity-note" role="status">
                  {identity.avatarMessage}
                </p>
              )}
            </>
          )}
          {preview && (
            <div className="primary-identity-preview">
              <p className="primary-identity-success">
                <Check className="size-4" />
                {t("登录成功，请确认主身份")}
              </p>
              <PrimaryProfile profile={preview} avatar={previewAvatar} />
            </div>
          )}
          {(preview || (identity && !sessionId)) && (
            <div className="primary-identity-preferences">
              <label>
                <input
                  type="checkbox"
                  checked={syncName}
                  disabled={!!busy}
                  onChange={(event) => setSyncName(event.target.checked)}
                />
                <span>{t("同步 Linux.do 昵称")}</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={syncAvatar}
                  disabled={!!busy}
                  onChange={(event) => setSyncAvatar(event.target.checked)}
                />
                <span>{t("同步 Linux.do 头像")}</span>
              </label>
              <p className="primary-identity-note">
                {t("未勾选时保留本机昵称和头像；手动修改个人资料会关闭对应同步。")}
              </p>
              {!preview && preferencesChanged && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void update("preferences")}
                >
                  {t("保存同步偏好")}
                </Button>
              )}
            </div>
          )}
          {replacing && (
            <label className="primary-identity-confirm">
              <input
                type="checkbox"
                checked={replaceConfirmed}
                disabled={!!busy}
                onChange={(event) => setReplaceConfirmed(event.target.checked)}
              />
              <span>
                {t(
                  "确认将主身份从 @{0} 更换为 @{1}，已有本机资产和文档保留。",
                  identity!.profile.username,
                  preview!.username,
                )}
              </span>
            </label>
          )}
          {waiting && (
            <div className="space-y-2">
              <div className="primary-identity-notice" role="status">
                <Loader2 className="size-4 animate-spin" />
                <p>{t("请在浏览器完成 Linux.do 登录，授权后这里会显示资料预览。")}</p>
              </div>
              {authorizationUrl && (
                <a
                  className="primary-identity-note"
                  href={authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("打开 Linux.do 授权页面")}
                </a>
              )}
              <p className="primary-identity-note">
                {t(
                  "浏览器若显示 Invalid state，请关闭旧授权页后重新发起，不要刷新或重复使用回调链接。若 LINUX DO Connect 首页也无法登录，请先恢复社区登录后再试。",
                )}
              </p>
            </div>
          )}
          {!availability?.configured && !sessionId && (
            <div className="primary-identity-notice" role="status">
              <p>
                {busy === "availability"
                  ? t("正在检查登录服务…")
                  : availability?.message ||
                    t("登录服务暂未就绪，你可以继续本机使用，稍后在个人资料中绑定。")}
              </p>
              {busy !== "availability" && (
                <Button size="sm" variant="ghost" onClick={() => void checkAvailability()}>
                  {t("重新检查")}
                </Button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="primary-identity-error">
              {error}
            </p>
          )}
          <div className="primary-identity-actions">
            {preview ? (
              <Button
                size="sm"
                disabled={!!busy || (replacing && !replaceConfirmed)}
                onClick={() => void update("bind")}
              >
                {busy === "bind" ? <Loader2 className="animate-spin" /> : <Check />}
                {t(replacing ? "确认更换主身份" : "确认绑定主身份")}
              </Button>
            ) : (
              !waiting && (
                <Button
                  size="sm"
                  variant={identity ? "outline" : "solid"}
                  disabled={!!busy || !availability?.configured}
                  onClick={() => void start()}
                >
                  <ExternalLink />
                  {t(
                    identity
                      ? identity.connected
                        ? "更换登录账号"
                        : "重新登录 Linux.do"
                      : "使用 Linux.do 登录",
                  )}
                </Button>
              )
            )}
            {(waiting || preview) && (
              <Button size="sm" variant="ghost" disabled={busy === "bind"} onClick={discard}>
                {t("取消本次授权")}
              </Button>
            )}
            {waiting && (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void start()}>
                <RefreshCw />
                {t("浏览器报错？重新发起")}
              </Button>
            )}
            {identity?.connected && !sessionId && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void update("refresh")}
              >
                <RefreshCw className={busy === "refresh" ? "animate-spin" : ""} />
                {t("刷新身份资料")}
              </Button>
            )}
          </div>
          <p className="primary-identity-note">
            {t("Linux.do 登录用于绑定主身份；本机资产不会上传，密钥库仍由本地主密码保护。")}
          </p>
          {!initial && identity && !sessionId && (
            <>
              <PrimaryIdentityPosts key={identity.profile.subject} />
              {identity.connected && (
                <div className="primary-identity-disconnect">
                  {disconnecting ? (
                    <>
                      <p className="primary-identity-note">
                        {t(
                          "退出后清除本机登录凭据，保留身份资料及已保存的文档，不会退出其他设备。",
                        )}
                      </p>
                      <div className="primary-identity-actions">
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={!!busy}
                          onClick={() => void update("disconnect")}
                        >
                          {t("确认退出 Linux.do 登录")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() => setDisconnecting(false)}
                        >
                          {t("取消")}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => setDisconnecting(true)}
                    >
                      <Unplug />
                      {t("退出 Linux.do 登录")}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function PrimaryProfile({ profile, avatar }: { profile: IdentityProfile; avatar?: string }) {
  const image = safeImageDataUrl(avatar);
  return (
    <div className="primary-identity-profile">
      <div className="primary-identity-person">
        <span className="primary-identity-avatar">
          {image ? (
            <img src={image} alt="" />
          ) : (
            (profile.name || profile.username).slice(0, 1).toUpperCase()
          )}
        </span>
        <div>
          <strong>{profile.name || profile.username}</strong>
          <span>@{profile.username}</span>
        </div>
        <span className="primary-identity-level">
          {profile.trustLevel == null ? t("等级未提供") : t("信任等级 {0}", profile.trustLevel)}
        </span>
      </div>
      <dl>
        <div>
          <dt>{t("平台返回邮箱")}</dt>
          <dd>{profile.email || t("未提供")}</dd>
        </div>
        <div>
          <dt>{t("个人主页")}</dt>
          <dd>
            <button
              type="button"
              onClick={() =>
                void openExternal(profile.profileUrl).catch(() => toast.error(t("无法打开链接")))
              }
            >
              {profile.profileUrl}
              <ExternalLink className="size-3.5" />
            </button>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function PrimaryIdentityPosts() {
  const bridge = hostBridge()?.mainIdentity;
  const [account, setAccount] = useState<IdentityAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [postErrors, setPostErrors] = useState<Array<{ id: string; message: string }>>([]);
  const [savedDocument, setSavedDocument] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function load(options?: { force?: boolean; more?: boolean }) {
    if (!bridge || busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await bridge.loadPosts(options);
      if (!alive.current) return;
      setAccount(value);
      setSelected((items) =>
        items.filter((id) => value.posts.items.some((post) => post.id === id)),
      );
    } catch (caught) {
      if (alive.current)
        setError(caught instanceof Error ? caught.message : t("读取公开帖子失败，请重试。"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function save(force = false) {
    if (!bridge || busy || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      const value = await bridge.savePosts({ postIds: selected, force });
      if (!alive.current) return;
      if (value.documentId) setSavedDocument(value.documentId);
      setPostErrors(value.errors);
      setSelected(value.errors.map((item) => item.id));
      if (value.imported) toast.success(t("已将 {0} 条帖子全文保存为文档", value.imported));
    } catch (caught) {
      if (alive.current)
        setError(caught instanceof Error ? caught.message : t("保存帖子文档失败，请重试。"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function openDocument() {
    if (!savedDocument) return;
    try {
      await useDocuments.getState().open(savedDocument);
      useAppStore.getState().setSettingsOpen(false);
      useAppStore.getState().setExpanded(null);
      useAppStore.getState().setView("docs");
    } catch {
      toast.error(t("打开文档失败，请重试。"));
    }
  }

  return (
    <div className="primary-identity-posts">
      <h4>
        <BookOpen className="size-4" />
        {t("我的帖子")}
      </h4>
      <p className="primary-identity-note">
        {t("读取本人公开主题与回复，勾选后保存正文全文。缓存 15 分钟，受限帖子会单独提示。")}
      </p>
      <div className="primary-identity-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void load(account ? { force: true } : undefined)}
        >
          <RefreshCw className={busy ? "animate-spin" : ""} />
          {t(account ? "刷新帖子" : "加载我的帖子")}
        </Button>
        {account?.posts.fetchedAt && (
          <span className="primary-identity-note">
            {t("获取于")} <TimeAgo iso={account.posts.fetchedAt} />
          </span>
        )}
      </div>
      {account?.posts.status === "unavailable" && (
        <p className="primary-identity-notice" role="status">
          {account.posts.message || t("平台暂时不允许读取公开帖子，已保留上次缓存。")}
        </p>
      )}
      {account &&
        !account.posts.items.length &&
        !busy &&
        account.posts.status !== "unavailable" && (
          <p className="primary-identity-note">{t("目前没有可读取的公开主题或回复。")}</p>
        )}
      {!!account?.posts.items.length && (
        <>
          <div className="primary-identity-post-list">
            {account.posts.items.map((post) => (
              <label className="primary-identity-post" key={post.id}>
                <input
                  type="checkbox"
                  aria-label={t("选择帖子 {0}", post.title)}
                  disabled={busy || (selected.length >= 20 && !selected.includes(post.id))}
                  checked={selected.includes(post.id)}
                  onChange={(event) =>
                    setSelected((items) =>
                      event.target.checked
                        ? [...items, post.id]
                        : items.filter((id) => id !== post.id),
                    )
                  }
                />
                <span>
                  <strong>{post.title}</strong>
                  <span>{post.excerpt || t("此帖子未提供摘要。")}</span>
                  <small>
                    {t(post.kind === "topic" ? "主题" : "回复")}
                    {post.createdAt && (
                      <>
                        {" "}
                        · <TimeAgo iso={post.createdAt} />
                      </>
                    )}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <div className="primary-identity-actions">
            <Button size="sm" disabled={busy || !selected.length} onClick={() => void save()}>
              {t("保存所选全文（{0}）", selected.length)}
            </Button>
            {account.posts.hasMore && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void load({ more: true })}
              >
                {t("加载更多帖子")}
              </Button>
            )}
          </div>
          <p className="primary-identity-note">
            {t("每次最多选择 20 条。保存后可在文档中提取账号，检查后再加密入库。")}
          </p>
        </>
      )}
      {!!postErrors.length && (
        <div className="primary-identity-notice" role="status">
          <div>
            <strong>{t("{0} 条帖子未能导入全文", postErrors.length)}</strong>
            {postErrors.map((item) => (
              <p key={item.id}>
                {account?.posts.items.find((post) => post.id === item.id)?.title || t("帖子")}：
                {item.message}
              </p>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !selected.length}
            onClick={() => void save(true)}
          >
            {t("重试未导入的帖子")}
          </Button>
        </div>
      )}
      {savedDocument && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void openDocument()}>
          <BookOpen />
          {t("打开已保存文档")}
        </Button>
      )}
      {error && (
        <p role="alert" className="primary-identity-error">
          {error}
        </p>
      )}
    </div>
  );
}
