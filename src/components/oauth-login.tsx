import { CheckCircle2, ExternalLink, FileJson, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";
import { desktop, oauthClientId, type OAuthProvider, type OAuthResult } from "@/lib/desktop";
import { hostBridge, openExternal, webInvoke } from "@/lib/web-bridge";
import { vaultApi } from "@/lib/vault-api";
import { isWeb } from "@/lib/web";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; address: string; label: string }
  | { kind: "fail"; message: string };

/** What a provider's downloaded client file looks like, in the shapes we accept. */
function readClientFile(json: unknown): { clientId: string; clientSecret: string } | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, Record<string, string> | undefined>;
  // Google writes `{installed: {...}}` for desktop clients, `{web: {...}}` otherwise.
  const block = root.installed ?? root.web ?? (root as unknown as Record<string, string>);
  const clientId = (block as Record<string, string>)?.client_id;
  const clientSecret = (block as Record<string, string>)?.client_secret ?? "";
  if (typeof clientId !== "string" || !clientId.trim() || typeof clientSecret !== "string")
    return null;
  return { clientId, clientSecret };
}

/**
 * Sign in with the provider's own login page.
 *
 * OAuth hands back a token, never a password — so this is not a way to capture
 * a credential, it is a way to get an address the provider has *verified* plus
 * a grant that can be refreshed later. The IMAP panel above remains the path
 * for anything that needs the mailbox itself.
 */
export function OAuthLogin({ set }: { set: (key: string, value: string) => void }) {
  const bridge = hostBridge();
  const unlocked = useVault((s) => s.unlocked);
  const requireVault = useVault((s) => s.require);
  const [providers, setProviders] = useState<Record<string, OAuthProvider>>({});
  const [provider, setProvider] = useState("google");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [configured, setConfigured] = useState(false);
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<{
    id: string;
    authorizationUrl: string;
    redirectUri: string;
  } | null>(null);
  const [callback, setCallback] = useState("");
  const pendingRef = useRef<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      if (pendingRef.current)
        void webInvoke("mail:oauth-cancel", pendingRef.current).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    generation.current++;
    if (pendingRef.current) void webInvoke("mail:oauth-cancel", pendingRef.current).catch(() => {});
    pendingRef.current = null;
    setPending(null);
    setCallback("");
    setState({ kind: "idle" });
    if (!unlocked) {
      setClientSecret("");
      setClientId("");
      setConfigured(false);
    }
  }, [provider, unlocked]);

  useEffect(() => {
    if (bridge) void bridge.mail.oauthProviders().then(setProviders);
  }, [bridge]);

  // The client registration lives in the vault like any other secret.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!bridge || !unlocked) return;
      try {
        const saved = await vaultApi()!.get(oauthClientId(provider));
        if (!alive) return;
        setConfigured(Boolean(saved?.username));
        setClientId(saved?.username ?? "");
        setClientSecret(saved?.password ?? "");
      } catch {
        if (alive) setConfigured(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bridge, unlocked, provider]);

  if (!bridge) return null;
  const config = providers[provider];

  async function pickFile() {
    try {
      const native = desktop();
      const json = native
        ? await native.pickJson()
        : await new Promise<unknown>((resolve, reject) => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".json,application/json";
            input.addEventListener("cancel", () => resolve(null));
            input.onchange = () => {
              void (async () => {
                const file = input.files?.[0];
                if (!file) return resolve(null);
                if (file.size > 256 * 1024) throw new Error("文件过大");
                resolve(JSON.parse(await file.text()));
              })().catch(reject);
            };
            input.click();
          });
      if (json === null) return;
      const parsed = readClientFile(json);
      if (!parsed) {
        toast.error(t("这个 JSON 里没有有效的 client_id 或 client_secret"));
        return;
      }
      setClientId(parsed.clientId);
      setClientSecret(parsed.clientSecret);
      toast(t("已读取客户端配置，保存后即可登录"));
    } catch {
      toast.error(t("无法读取客户端配置，请选择不超过 256 KB 的有效 JSON 文件。"));
    }
  }

  async function saveClient() {
    if (!(await requireVault(t("保存 OAuth 客户端配置需要先解锁密钥库。")))) return;
    await vaultApi()!.set(oauthClientId(provider), {
      username: clientId.trim(),
      password: clientSecret.trim(),
      updatedAt: new Date().toISOString(),
    });
    setConfigured(true);
    setEditing(false);
    toast(t("客户端配置已保存"));
  }

  async function signIn() {
    const current = generation.current;
    setState({ kind: "busy" });
    try {
      if (isWeb()) {
        if (!consent) throw new Error(t("请先确认允许服务器临时处理邮箱授权。"));
        const session = await webInvoke<{
          id: string;
          authorizationUrl: string;
          redirectUri: string;
        }>("mail:oauth-start", {
          provider,
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          allowServerProcessing: true,
        });
        if (current !== generation.current) {
          void webInvoke("mail:oauth-cancel", session.id);
          return;
        }
        pendingRef.current = session.id;
        setPending(session);
        setCallback("");
        setState({ kind: "idle" });
        return;
      }
      const result = await bridge!.mail.oauthSignIn({
        provider,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      if (current !== generation.current) return;
      applyResult(result);
    } catch (err) {
      if (current === generation.current)
        setState({ kind: "fail", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function applyResult(result: OAuthResult) {
    setState({ kind: "ok", address: result.address, label: result.providerLabel });

    set("address", result.address);
    set("domain", result.address.split("@")[1] ?? "");
    set("kind", "mailbox");
    set("_username", result.address);
    set("_oauthProvider", result.provider);
    set("_oauthRefresh", result.refreshToken ?? "");
    set("_oauthExpires", result.expiresAt ?? "");
    set("_oauthScope", result.scope);
    set(
      "notes",
      [
        t("{0} 授权登录{1}", result.providerLabel, result.name ? ` · ${result.name}` : ""),
        result.refreshToken ? t("已保存刷新令牌") : t("未返回刷新令牌（可能未请求离线访问）"),
      ].join("\n"),
    );
    toast(t("已通过 {0} 登录 {1}", result.providerLabel, result.address));
  }

  const needsSecret = config?.usesSecret ?? true;
  const ready = clientId.trim() && (!needsSecret || clientSecret.trim());

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted" />
        <h4 className="text-meta font-semibold">{t("或用服务商账号授权")}</h4>
        <div className="ml-auto flex gap-1">
          {Object.entries(providers).map(([id, p]) => (
            <button
              key={id}
              type="button"
              className={`tag-chip ${provider === id ? "tag-chip-on" : ""}`}
              disabled={state.kind === "busy" || Boolean(pending)}
              onClick={() => setProvider(id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {!unlocked ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void requireVault(t("OAuth 客户端配置存在密钥库里，需要先解锁。"))}
        >
          {t("解锁密钥库")}
        </Button>
      ) : configured && !editing ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={state.kind === "busy" || Boolean(pending) || (isWeb() && !consent)}
            onClick={signIn}
          >
            {state.kind === "busy" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ExternalLink className="size-3.5" />
            )}

            {t("用 {0} 登录", config?.label ?? "")}
          </Button>
          <button
            type="button"
            className="text-2xs text-subtle hover:text-ink"
            onClick={() => setEditing(true)}
          >
            {t("换个客户端")}
          </button>
          {state.kind === "ok" && (
            <span className="flex items-center gap-1.5 text-2xs text-ok">
              <CheckCircle2 className="size-3.5" />
              {state.label} · {state.address}
            </span>
          )}
          {state.kind === "fail" && (
            <span className="flex items-start gap-1.5 text-2xs text-crit">
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">{state.message}</span>
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={pickFile}>
              <FileJson className="size-3.5" />

              {t("选择客户端 JSON")}
            </Button>
            <span className="text-2xs text-subtle">
              {t("就是控制台下载的 client_secret_*.json")}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("客户端 ID")}>
              <Input
                value={clientId}
                autoComplete="off"
                className="font-mono text-2xs"
                onChange={(e) => setClientId(e.target.value)}
              />
            </Field>
            {needsSecret && (
              <Field label={t("客户端密钥")}>
                <Input
                  type="password"
                  value={clientSecret}
                  autoComplete="off"
                  className="font-mono text-2xs"
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </Field>
            )}
          </div>

          {config && (
            <p className="text-2xs leading-relaxed text-muted">
              {config.setupNote}{" "}
              <button
                type="button"
                className="underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                onClick={() => void openExternal(config.consoleUrl)}
              >
                {t("打开控制台")}
              </button>
            </p>
          )}

          <Button type="button" variant="outline" size="sm" disabled={!ready} onClick={saveClient}>
            {t("保存客户端配置")}
          </Button>
        </div>
      )}

      {isWeb() && (
        <label className="mt-3 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 p-3 text-2xs leading-relaxed">
          <input
            type="checkbox"
            className="mt-1"
            checked={consent}
            disabled={Boolean(pending)}
            onChange={(event) => setConsent(event.target.checked)}
          />
          {t(
            "我允许可信部署服务器临时处理客户端密钥和邮箱授权令牌，仅用于核验邮箱地址；服务器不持久保存此次令牌，刷新令牌随资产保存到浏览器加密密钥库。敏感邮箱建议使用桌面端。此授权不会赋予邮件收发权限。",
          )}
        </label>
      )}
      {pending && (
        <fieldset className="mt-3 space-y-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-meta">{t("完成邮箱授权")}</legend>
          <a
            className="text-meta underline"
            href={pending.authorizationUrl}
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
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!callback.trim() || state.kind === "busy"}
              onClick={() => {
                const current = generation.current;
                setState({ kind: "busy" });
                void webInvoke<OAuthResult>("mail:oauth-finish", pending.id, callback.trim())
                  .then((result) => {
                    if (current !== generation.current) return;
                    pendingRef.current = null;
                    setPending(null);
                    setCallback("");
                    applyResult(result);
                  })
                  .catch((error: unknown) => {
                    if (current === generation.current)
                      setState({
                        kind: "fail",
                        message: error instanceof Error ? error.message : String(error),
                      });
                  });
              }}
            >
              {t("确认授权回调")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                generation.current++;
                void webInvoke("mail:oauth-cancel", pending.id).catch(() => {});
                pendingRef.current = null;
                setPending(null);
                setCallback("");
                setState({ kind: "idle" });
              }}
            >
              {t("取消授权")}
            </Button>
          </div>
        </fieldset>
      )}
      <p className="mt-2 text-2xs leading-relaxed text-subtle">
        {t(
          "授权在你自己的浏览器里完成，应用只拿到已验证的地址与刷新令牌 —— OAuth\n        本来就不会把密码交给第三方应用。",
        )}
      </p>
    </div>
  );
}
