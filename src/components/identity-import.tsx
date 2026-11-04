import { useEffect, useRef, useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Fingerprint,
  Loader2,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { hostBridge, openExternal } from "@/lib/web-bridge";
import { isWeb } from "@/lib/web";
import type { IdentityConfig, IdentityProfile } from "@/lib/identities";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import { copyText } from "@/lib/utils";
import { useVault } from "@/lib/vault-state";
import { Button } from "./ui/button";
import { EditorDialog } from "./ui/editor-dialog";
import { Field, Input } from "./ui/input";
import "./identity-workspace.css";

/** 授权只在系统浏览器完成；渲染进程不接收 OAuth token。 */
export function IdentityImport({
  close,
  folderId,
  onImported,
}: {
  close: () => void;
  folderId?: string;
  onImported?: (assetId: string) => void;
}) {
  const bridge = hostBridge()?.identities;
  const [consent, setConsent] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [callback, setCallback] = useState("");
  const unlocked = useVault((state) => state.unlocked);
  const [config, setConfig] = useState<IdentityConfig | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<IdentityProfile | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "start" | "commit" | null>("load");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const session = useRef<string | null>(null);
  const alive = useRef(true);

  function discard() {
    generation.current++;
    const current = session.current;
    session.current = null;
    setSessionId(null);
    setPreview(null);
    setClientSecret("");
    setBusy(null);
    setError("");
    if (current) void bridge?.cancel(current).catch(() => {});
  }

  function dismiss() {
    discard();
    close();
  }

  useEffect(() => {
    alive.current = true;
    const invalidate = () => {
      generation.current++;
    };
    const clear = () => {
      invalidate();
      const current = session.current;
      session.current = null;
      setSessionId(null);
      setPreview(null);
      setClientSecret("");
      setConfig(null);
      setClientId("");
      setRedirectUri("");
      setError("");
      setBusy(null);
      if (current) void bridge?.cancel(current).catch(() => {});
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
      const current = session.current;
      session.current = null;
      if (current) void bridge?.cancel(current).catch(() => {});
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !unlocked) return;
    const current = ++generation.current;
    setBusy("load");
    setError("");
    void bridge
      .config()
      .then((value) => {
        if (!alive.current || current !== generation.current || !useVault.getState().unlocked)
          return;
        setConfig(value);
        setClientId(value.clientId);
        setRedirectUri(value.redirectUri);
        setConfigOpen(!value.configured);
      })
      .catch((caught) => {
        if (alive.current && current === generation.current)
          setError(caught instanceof Error ? caught.message : t("读取身份接入配置失败"));
      })
      .finally(() => {
        if (alive.current && current === generation.current) setBusy(null);
      });
  }, [bridge, unlocked, attempt]);

  useEffect(() => {
    if (!bridge || !sessionId || preview || !unlocked) return;
    const current = generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const valid = () =>
      !stopped && alive.current && current === generation.current && useVault.getState().unlocked;
    async function poll() {
      try {
        const value = await bridge!.status(sessionId!);
        if (!valid()) return;
        if (value.status === "ready" && value.preview) {
          setPreview(value.preview);
          return;
        }
        if (value.status === "error" || value.status === "cancelled") {
          setError(value.error || t("授权已取消或过期，请重新登录。"));
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
  }, [bridge, sessionId, preview, unlocked]);

  async function saveConfig() {
    if (!bridge || busy || sessionId) return;
    const current = generation.current;
    setBusy("save");
    setError("");
    try {
      const value = await bridge.configure({
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim(),
        ...(clientSecret ? { clientSecret } : {}),
        allowServerStorage: consent,
      });
      if (!alive.current || current !== generation.current || !useVault.getState().unlocked) return;
      setConfig(value);
      setClientSecret("");
      setClientId(value.clientId);
      setRedirectUri(value.redirectUri);
      setConfigOpen(false);
      toast.success(t("身份接入配置已加密保存"));
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("保存接入配置失败"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  async function start() {
    if (!bridge || busy || !config?.configured) return;
    discard();
    const current = generation.current;
    setBusy("start");
    setError("");
    try {
      const value = await bridge.start({ allowServerStorage: consent });
      if (!alive.current || current !== generation.current || !useVault.getState().unlocked) {
        void bridge.cancel(value.id).catch(() => {});
        return;
      }
      session.current = value.id;
      setSessionId(value.id);
      setAuthorizationUrl(value.authorizationUrl ?? "");
      setCallback("");
      setConfigOpen(false);
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(
          caught instanceof Error ? caught.message : t("无法启动官方授权，请检查接入配置。"),
        );
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  async function commit() {
    if (!bridge || !sessionId || !preview || busy) return;
    const current = generation.current;
    setBusy("commit");
    setError("");
    try {
      const value = await bridge.commit({ sessionId, folderId });
      // 主进程也会广播资产；这里只补上尚未到达的记录，保留其他界面正在编辑的内容。
      await useAppStore.setState((state) => ({
        secrets: state.secrets.some((item) => item.id === value.asset.id)
          ? state.secrets
          : [...state.secrets, value.asset],
      }));
      if (!alive.current || current !== generation.current || !useVault.getState().unlocked) return;
      session.current = null;
      setSessionId(null);
      setPreview(null);
      toast.success(t("身份资料已导入"));
      if (onImported) onImported(value.asset.id);
      else
        useAppStore.getState().setExpanded({
          kind: "secret",
          id: value.asset.id,
          origin: { x: window.innerWidth / 2, y: window.innerHeight / 2, w: 0, h: 0 },
        });
      close();
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("身份导入失败，请重试。"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  const waiting = !!sessionId && !preview;
  const configDirty =
    !!config &&
    (clientId.trim() !== config.clientId ||
      redirectUri.trim() !== config.redirectUri ||
      !!clientSecret);

  return (
    <EditorDialog title={t("导入身份")} onClose={dismiss}>
      <div className="editor-scroll identity-import">
        <div className="identity-intro">
          <span className="identity-mark">
            <Fingerprint aria-hidden="true" />
          </span>
          <div>
            <h3>Linux.do</h3>
            <p>
              {t(
                isWeb()
                  ? "在官方页面完成授权，独立身份凭据由可信部署服务器加密保存，与桌面密钥库分别配置。"
                  : "在系统浏览器完成官方授权，身份资料与授权凭据加密保存在本机。",
              )}
            </p>
          </div>
        </div>
        {!unlocked ? (
          <div className="identity-notice">
            <LockKeyhole className="size-5" />
            <p>{t("解锁密钥库后配置接入并导入身份。")}</p>
            <Button
              onClick={() =>
                void useVault
                  .getState()
                  .require(t("导入身份需要先解锁密钥库。"))
                  .catch(() => setError(t("解锁失败，请重试。")))
              }
            >
              {t("解锁密钥库")}
            </Button>
          </div>
        ) : busy === "load" ? (
          <p className="identity-status" role="status">
            <Loader2 className="size-4 animate-spin" />
            {t("读取接入配置…")}
          </p>
        ) : !config ? (
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            {t("重新读取")}
          </Button>
        ) : (
          <>
            {isWeb() && (
              <label className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 p-3 text-meta leading-relaxed">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={consent}
                  disabled={Boolean(sessionId) || Boolean(busy)}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                {t(
                  "我允许服务器加密保存独立身份的客户端密钥和授权令牌；管理员仍有能力访问。断开授权会删除该身份的令牌，接入配置与桌面端不互通。敏感账号建议使用桌面端。",
                )}
              </label>
            )}
            <Collapsible.Root
              open={configOpen}
              onOpenChange={setConfigOpen}
              className="identity-config"
            >
              <Collapsible.Trigger
                className="identity-config-trigger"
                disabled={!!sessionId || !!busy}
              >
                <ShieldCheck className="size-4" />
                <span>
                  {t(config.configured ? "官方接入已配置" : "首次使用：配置你的 Connect 应用")}
                </span>
                <ChevronDown className="size-4 identity-chevron" />
              </Collapsible.Trigger>
              <Collapsible.Content className="identity-collapse">
                <form
                  className="identity-config-fields"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveConfig();
                  }}
                >
                  <p className="text-meta text-muted">
                    {t(
                      "将下方回调地址填入你申请的 Linux.do Connect 应用，再保存 Client ID 与 Client Secret。",
                    )}
                  </p>
                  <Field label="Client ID">
                    <Input
                      aria-label="Client ID"
                      value={clientId}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!!busy}
                      onChange={(event) => setClientId(event.target.value)}
                    />
                  </Field>
                  <Field label="Client Secret">
                    <Input
                      aria-label="Client Secret"
                      type="password"
                      autoComplete="new-password"
                      value={clientSecret}
                      placeholder={
                        config.hasClientSecret ? t("已安全保存，留空保留原值") : t("填写应用密钥")
                      }
                      disabled={!!busy}
                      onChange={(event) => setClientSecret(event.target.value)}
                    />
                  </Field>
                  <Field label={t("回调地址")}>
                    <div className="identity-copy-field">
                      <Input
                        aria-label={t("回调地址")}
                        value={redirectUri}
                        disabled={!!busy}
                        spellCheck={false}
                        onChange={(event) => setRedirectUri(event.target.value)}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={t("复制回调地址")}
                        onClick={() =>
                          void copyText(redirectUri)
                            .then(() => toast.success(t("已复制回调地址")))
                            .catch(() => toast.error(t("复制失败，请重试")))
                        }
                      >
                        <Copy />
                      </Button>
                    </div>
                  </Field>
                  <div className="identity-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void openExternal("https://connect.linux.do/").catch(() =>
                          toast.error(t("无法打开链接")),
                        )
                      }
                    >
                      <ExternalLink />
                      {t("管理 Connect 应用")}
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        !!busy ||
                        !clientId.trim() ||
                        !redirectUri.trim() ||
                        (isWeb() && !consent) ||
                        (!config.hasClientSecret && !clientSecret)
                      }
                    >
                      {busy === "save" && <Loader2 className="animate-spin" />}
                      {t("保存接入配置")}
                    </Button>
                  </div>
                </form>
              </Collapsible.Content>
            </Collapsible.Root>
            {configDirty && (
              <p className="identity-footnote">{t("接入配置已更改，请先保存再登录。")}</p>
            )}
            {waiting && (
              <div className="identity-notice" role="status">
                <Loader2 className="size-5 animate-spin" />
                <div>
                  <strong>{t("等待浏览器授权")}</strong>
                  <p>{t("请在打开的 Linux.do 页面确认登录，完成后这里会自动显示资料。")}</p>
                </div>
              </div>
            )}
            {isWeb() && waiting && authorizationUrl && (
              <div className="space-y-3 rounded-lg border border-line p-3">
                <a
                  className="text-meta underline"
                  href={authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("打开官方授权页面")}
                </a>
                <p className="text-2xs leading-relaxed text-muted">
                  {t(
                    "完成授权后，本机回调页面可能无法打开。请复制完整地址栏链接粘贴到下方；不要输入账号密码。",
                  )}
                </p>
                <Field label={t("完整授权回调地址")}>
                  <Input
                    aria-label={t("完整授权回调地址")}
                    value={callback}
                    autoComplete="off"
                    onChange={(event) => setCallback(event.target.value)}
                  />
                </Field>
                <Button
                  disabled={Boolean(busy) || !callback.trim()}
                  onClick={() => {
                    setBusy("start");
                    void bridge
                      ?.finish?.(sessionId!, callback.trim())
                      .then(() => setCallback(""))
                      .catch((error: unknown) =>
                        setError(error instanceof Error ? error.message : String(error)),
                      )
                      .finally(() => setBusy(null));
                  }}
                >
                  {t("确认授权回调")}
                </Button>
              </div>
            )}
            {preview && (
              <div className="identity-preview">
                <p className="identity-preview-label">
                  <Check className="size-4" />
                  {t("授权成功，确认要导入的身份")}
                </p>
                <IdentityProfileSummary profile={preview} />
                <p className="identity-footnote">
                  {t("邮箱按平台返回值保存；平台未提供时不会推测或补全。")}
                </p>
              </div>
            )}
          </>
        )}
        {error && (
          <p className="identity-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="editor-footer identity-import-footer">
        {waiting || preview ? (
          <Button variant="ghost" disabled={busy === "commit"} onClick={discard}>
            {t("取消本次授权")}
          </Button>
        ) : (
          <Button variant="ghost" onClick={dismiss}>
            {t("取消")}
          </Button>
        )}
        {preview ? (
          <Button disabled={!!busy} onClick={() => void commit()}>
            {busy === "commit" ? <Loader2 className="animate-spin" /> : <Check />}
            {t("确认导入身份")}
          </Button>
        ) : (
          <Button
            disabled={
              !unlocked ||
              !config?.configured ||
              !!busy ||
              waiting ||
              configDirty ||
              (isWeb() && !consent)
            }
            onClick={() => void start()}
          >
            {busy === "start" ? <Loader2 className="animate-spin" /> : <ExternalLink />}
            {t("在浏览器登录 Linux.do")}
          </Button>
        )}
      </div>
    </EditorDialog>
  );
}

export function IdentityProfileSummary({ profile }: { profile: IdentityProfile }) {
  return (
    <div className="identity-profile">
      <div className="identity-profile-heading">
        <span className="identity-avatar" aria-hidden="true">
          {(profile.name || profile.username).slice(0, 1).toUpperCase()}
        </span>
        <div>
          <strong>{profile.name || profile.username}</strong>
          <span>@{profile.username}</span>
        </div>
        <span className="identity-level">
          {profile.trustLevel == null ? t("等级未提供") : t("信任等级 {0}", profile.trustLevel)}
        </span>
      </div>
      <dl className="identity-profile-fields">
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
                void desktop()
                  ?.openExternal(profile.profileUrl)
                  .catch(() => toast.error(t("无法打开链接")))
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
