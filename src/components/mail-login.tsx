import { hostBridge } from "@/lib/web-bridge";
import { CheckCircle2, Loader2, LogIn, Mail, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OAuthLogin } from "./oauth-login";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";
import { type MailLogin, type MailProvider } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; result: MailLogin }
  | { kind: "fail"; message: string };

/**
 * Log in to the mailbox, then fill the form from what the server said.
 *
 * OAuth would hand back a token and never a password, which is not what a
 * credential vault wants; IMAP hands back proof that the 授权码 you are about to
 * store actually works, plus the real quota and message counts. So this signs
 * in for real and reports what it found.
 */
export function MailLogin({
  form,
  set,
}: {
  form: Record<string, string>;
  set: (key: string, value: string) => void;
}) {
  const bridge = hostBridge();
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<Record<string, MailProvider>>({});
  const [provider, setProvider] = useState<string>("");
  const [address, setAddress] = useState(form.address ?? "");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState(form._imapHost ?? "");
  const [port, setPort] = useState(form._imapPort ?? "993");
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    if (bridge && open) void bridge.mail.providers().then(setProviders);
  }, [bridge, open]);

  // Typing the address is enough to know which provider it is.
  useEffect(() => {
    if (!bridge || !address.includes("@")) return;
    let alive = true;
    void bridge.mail.guess(address).then((g) => {
      if (alive && g) setProvider(g.id);
    });
    return () => {
      alive = false;
    };
  }, [bridge, address]);

  if (!bridge) return null;

  const picked = provider ? providers[provider] : undefined;

  async function signIn() {
    setState({ kind: "busy" });
    try {
      const result = await bridge!.mail.test({
        address,
        password,
        host: picked?.imap.host ?? host,
        port: picked?.imap.port ?? Number(port),
        secure: true,
      });
      setState({ kind: "ok", result });

      // Everything the server told us goes straight into the form.
      set("address", result.address);
      set("domain", result.address.split("@")[1] ?? "");
      set("kind", "mailbox");
      set("_username", result.address);
      set("_password", password);
      set("_imapHost", result.imap.host);
      set("_imapPort", String(result.imap.port));
      set("_imapSecure", "true");
      if (result.smtp) {
        set("_smtpHost", result.smtp.host);
        set("_smtpPort", String(result.smtp.port));
        set("_smtpSecurity", result.smtp.port === 465 ? "tls" : "starttls");
      }
      if (result.usedMb !== undefined) set("usedMb", String(result.usedMb));
      if (result.quotaMb !== undefined) set("quotaMb", String(result.quotaMb));
      const lines = [
        `IMAP: ${result.imap.host}:${result.imap.port}`,
        result.smtp ? `SMTP: ${result.smtp.host}:${result.smtp.port}` : null,
        t("登录验证通过 · 收件箱 {0} 封，未读 {1} 封", result.messages, result.unseen),
      ].filter(Boolean);
      set("notes", lines.join("\n"));
      toast(t("已登录 {0}", result.address));
    } catch (err) {
      setState({ kind: "fail", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="sm:col-span-2">
      {!open ? (
        <button type="button" className="paste-trigger" onClick={() => setOpen(true)}>
          <LogIn className="size-4" strokeWidth={1.9} />
          <span className="font-medium">{t("快捷登录")}</span>
          <span className="text-2xs text-subtle">
            {t("登录一次，地址 / 容量 / 服务器设置自动填好")}
          </span>
        </button>
      ) : (
        <div className="rounded-xl bg-canvas p-4">
          <div className="mb-3 flex items-center gap-2">
            <Mail className="size-4 text-muted" />
            <h3 className="text-meta font-semibold">{t("快捷登录")}</h3>
            <button
              type="button"
              className="ml-auto text-2xs text-subtle hover:text-ink"
              onClick={() => setOpen(false)}
            >
              {t("收起")}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("邮箱地址")}>
              <Input
                autoFocus
                value={address}
                placeholder="you@qq.com"
                autoComplete="off"
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
            <Field label={t("服务商")}>
              <Select
                aria-label={t("服务商")}
                value={provider}
                onValueChange={setProvider}
                options={[
                  { value: "", label: t("自动识别 / 自定义") },
                  ...Object.entries(providers).map(([id, provider]) => ({
                    value: id,
                    label: provider.label,
                  })),
                ]}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t("密码 / 授权码")}>
                <Input
                  type="password"
                  value={password}
                  autoComplete="off"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>
            {!picked && (
              <>
                <Field label={t("IMAP 服务器")}>
                  <Input
                    aria-label={t("IMAP 服务器")}
                    value={host}
                    placeholder="imap.example.com"
                    autoComplete="off"
                    onChange={(event) => setHost(event.target.value)}
                  />
                </Field>
                <Field label={t("TLS 端口")}>
                  <Input
                    aria-label={t("TLS 端口")}
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                  />
                </Field>
              </>
            )}
          </div>

          {picked && (
            <p className="mt-2 text-2xs leading-relaxed text-muted">
              {picked.authNote}
              <span className="ml-1 font-mono text-subtle">
                IMAP {picked.imap.host}:{picked.imap.port}
              </span>
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={state.kind === "busy" || !address.includes("@") || !password}
              onClick={signIn}
            >
              {state.kind === "busy" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogIn className="size-3.5" />
              )}

              {t("登录并填充")}
            </Button>

            {state.kind === "ok" && (
              <span className="flex items-center gap-1.5 text-2xs text-ok">
                <CheckCircle2 className="size-3.5" />
                {state.result.providerLabel} {t("· 收件箱 {0} 封", state.result.messages)}
                {state.result.quotaMb ? ` · ${state.result.usedMb}/${state.result.quotaMb} MB` : ""}
              </span>
            )}
            {state.kind === "fail" && (
              <span className={cn("flex items-start gap-1.5 text-2xs text-crit")}>
                <XCircle className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0">{state.message}</span>
              </span>
            )}
          </div>

          <p className="mt-3 text-2xs leading-relaxed text-subtle">
            {t("登录直接连服务商的 IMAP，凭据校验通过后才会存进加密库；不经过任何中间服务。")}
          </p>

          <OAuthLogin set={set} />
        </div>
      )}
    </div>
  );
}
