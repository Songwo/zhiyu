import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/utils";
import { webApi } from "@/lib/web";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";

interface SecuritySession {
  id: string;
  current: boolean;
  ip: string;
  agent: string;
  createdAt: string;
  seenAt: string;
}
interface SecurityEvent {
  at: string;
  kind: string;
  ip?: string;
  agent?: string;
  reason?: string;
  recovery?: boolean;
}
interface Security {
  totp: { enabled: boolean; recoveryLeft: number };
  sessions: SecuritySession[];
  log: SecurityEvent[];
  encrypted: boolean;
  allowlist: string[] | null;
  recentFailures: number;
}

const EVENT_TEXT: Record<string, string> = {
  login: "登录成功",
  fail: "登录失败",
  blocked: "被限流拒绝",
  logout: "退出登录",
  setup: "创建账号",
  password: "修改登录密码",
  "totp-on": "开启了两步验证",
  "totp-off": "关闭了两步验证",
  revoke: "退出了一台设备",
  "revoke-others": "退出了其他所有设备",
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Card({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <div
      className={
        tone === "warn"
          ? "rounded-xl border border-warn/40 bg-warn/5 p-4"
          : "rounded-xl border border-line bg-card p-4"
      }
    >
      {children}
    </div>
  );
}

/** 网页版的账号安全：两步验证、登录设备、登录记录，以及当前连接是否加密。 */
export function WebSecuritySettings() {
  const [data, setData] = useState<Security | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void webApi<Security>("security")
      .then(setData)
      .catch((reason) => setError(errorText(reason)));
  }, []);
  useEffect(load, [load]);
  if (!data) return error ? <p className="text-meta text-crit">{error}</p> : null;
  const plain =
    !data.encrypted &&
    location.protocol === "http:" &&
    !/^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
  return (
    <section className="space-y-5 border-t border-line pt-6" aria-label={t("账号安全")}>
      <header>
        <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <LockKeyhole className="size-4 text-muted" />
          {t("账号安全")}
        </h3>
        <p className="mt-1 text-meta leading-relaxed text-muted">
          {t(
            "网页版放在公网上时，登录页是别人能碰到的唯一入口：用两步验证、HTTPS 和来源限制把它守住。",
          )}
        </p>
      </header>

      {plain && (
        <Card tone="warn">
          <p className="flex items-start gap-2 text-meta">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            {t(
              "当前连接没有加密（http）：登录密码会在网络上明文传输。请给服务器配置 HTTPS，或只在可信的内网 / VPN 里访问。",
            )}
          </p>
        </Card>
      )}

      <Card>
        <p className="flex items-center gap-2 text-meta font-medium">
          <ShieldCheck className="size-4 text-muted" />
          {t("访问来源限制")}
        </p>
        <p className="mt-2 text-2xs leading-relaxed text-muted">
          {data.allowlist
            ? t(
                "已开启：只有 {0} 能打开这个网站，其他来源的连接会被直接断开。",
                data.allowlist.join("、"),
              )
            : t(
                "未设置：任何地址都能打开登录页。可以在服务器上设置环境变量 ZHIYU_ALLOWED_NETS，只允许自己的 IP、家里或公司网段、VPN（填 private 表示全部内网）。",
              )}
        </p>
      </Card>

      <TwoFactor
        enabled={data.totp.enabled}
        recoveryLeft={data.totp.recoveryLeft}
        onChanged={load}
      />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-meta font-semibold">{t("登录中的设备")}</h4>
          {data.sessions.length > 1 && (
            <Button
              size="sm"
              variant="danger-ghost"
              onClick={() =>
                void webApi("sessions/revoke-others", { method: "POST", body: {} })
                  .then(load)
                  .catch((reason) => setError(errorText(reason)))
              }
            >
              {t("退出其他所有设备")}
            </Button>
          )}
        </div>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {data.sessions.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-meta font-medium">
                  {session.agent || t("未知浏览器")} · {session.ip || "—"}
                  {session.current && (
                    <span className="ml-2 text-2xs text-ok">{t("当前设备")}</span>
                  )}
                </p>
                <p className="text-2xs text-muted">
                  {t("最近活动 {0}", relativeTime(session.seenAt))} ·{" "}
                  {t("登录于 {0}", relativeTime(session.createdAt))}
                </p>
              </div>
              {!session.current && (
                <Button
                  size="sm"
                  variant="danger-ghost"
                  onClick={() =>
                    void webApi("sessions/revoke", { method: "POST", body: { id: session.id } })
                      .then(load)
                      .catch((reason) => setError(errorText(reason)))
                  }
                >
                  {t("退出")}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <p className="text-2xs text-muted">{t("7 天没有任何操作的登录会自动失效。")}</p>
      </div>

      <div className="space-y-2">
        <h4 className="text-meta font-semibold">
          {t("最近的登录记录")}
          {data.recentFailures > 0 && (
            <span className="ml-2 text-2xs font-normal text-warn">
              {t("15 分钟内全站有 {0} 次失败", data.recentFailures)}
            </span>
          )}
        </h4>
        <ul className="max-h-56 space-y-1 overflow-y-auto text-2xs text-muted">
          {data.log.slice(0, 30).map((event, index) => (
            <li key={index} className="flex flex-wrap gap-x-2">
              <span className="shrink-0 tabular-nums">{relativeTime(event.at)}</span>
              <span
                className={
                  event.kind === "fail" || event.kind === "blocked" ? "text-crit" : undefined
                }
              >
                {t(EVENT_TEXT[event.kind] ?? "其他事件")}
                {event.recovery ? `（${t("使用了恢复码")}）` : ""}
              </span>
              <span>{[event.agent, event.ip].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ul>
        <p className="text-2xs text-muted">
          {t("开启「设置 → 提醒推送」后，新来源登录和反复失败会推送到手机。记录里不保存任何密码。")}
        </p>
      </div>
      {error && (
        <p role="alert" className="break-words text-meta text-crit">
          {error}
        </p>
      )}
    </section>
  );
}

function TwoFactor({
  enabled,
  recoveryLeft,
  onChanged,
}: {
  enabled: boolean;
  recoveryLeft: number;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<"idle" | "password" | "scan" | "codes" | "disable">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState<{ secret: string; qr: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setStep("idle");
    setPassword("");
    setCode("");
    setSecret(null);
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await webApi<{ secret: string; uri: string }>("totp/start", {
        method: "POST",
        body: { password },
      });
      const QRCode = await import("qrcode");
      setSecret({
        secret: result.secret,
        qr: await QRCode.toDataURL(result.uri, { margin: 1, width: 192 }),
      });
      setPassword("");
      setStep("scan");
    });
  };
  const enable = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await webApi<{ recovery: string[] }>("totp/enable", {
        method: "POST",
        body: { code },
      });
      setRecovery(result.recovery);
      setCode("");
      setSecret(null);
      setStep("codes");
      onChanged();
    });
  };
  const disable = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await webApi("totp/disable", { method: "POST", body: { password, code } });
      reset();
      onChanged();
    });
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-meta font-medium">
            <KeyRound className="size-4 text-muted" />
            {t("两步验证（TOTP）")}
            {enabled && <span className="text-2xs text-ok">{t("已开启")}</span>}
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            {enabled
              ? t("登录需要密码加手机验证器里的 6 位验证码。剩余恢复码 {0} 个。", recoveryLeft)
              : t(
                  "开启后，只知道密码的人也登录不进来。推荐开启，Google Authenticator、Microsoft Authenticator、1Password 等都支持。",
                )}
          </p>
        </div>
        {step === "idle" && (
          <Button
            size="sm"
            variant={enabled ? "danger-ghost" : "primary"}
            onClick={() => setStep(enabled ? "disable" : "password")}
          >
            {enabled ? t("关闭") : t("开启两步验证")}
          </Button>
        )}
      </div>

      {step === "password" && (
        <form className="mt-4 grid gap-3 sm:max-w-sm" onSubmit={start}>
          <Field label={t("当前登录密码")}>
            <Input
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t("继续")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={reset}>
              {t("取消")}
            </Button>
          </div>
        </form>
      )}

      {step === "scan" && secret && (
        <form className="mt-4 grid gap-4 sm:grid-cols-[auto_1fr]" onSubmit={enable}>
          <img
            src={secret.qr}
            width={192}
            height={192}
            alt={t("两步验证二维码")}
            className="rounded-xl bg-white p-2"
          />
          <div className="space-y-3">
            <p className="text-meta text-muted">
              {t("用验证器 App 扫描二维码；不方便扫码时手动输入下面的密钥。")}
            </p>
            <code className="block break-all rounded-lg bg-surface px-3 py-2 font-mono text-meta tracking-wider">
              {secret.secret.replace(/(.{4})/g, "$1 ").trim()}
            </code>
            <Field label={t("验证器里显示的 6 位验证码")}>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                required
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                {t("确认并开启")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={reset}>
                {t("取消")}
              </Button>
            </div>
          </div>
        </form>
      )}

      {step === "codes" && (
        <div className="mt-4 space-y-3">
          <p className="flex items-start gap-2 text-meta">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            {t(
              "两步验证已开启。下面是 8 个一次性恢复码，丢了手机时可以代替验证码登录。只显示这一次，请现在抄下来或保存到密码管理器。",
            )}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:max-w-md">
            {recovery.map((item) => (
              <code
                key={item}
                className="rounded-lg bg-surface px-3 py-1.5 text-center font-mono text-meta tracking-wider"
              >
                {item}
              </code>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(recovery.join("\n")).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? t("已复制") : t("复制")}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setRecovery([]);
                setStep("idle");
              }}
            >
              {t("我已保存")}
            </Button>
          </div>
        </div>
      )}

      {step === "disable" && (
        <form className="mt-4 grid gap-3 sm:max-w-sm" onSubmit={disable}>
          <Field label={t("当前登录密码")}>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label={t("验证码或恢复码")}>
            <Input
              autoComplete="one-time-code"
              required
              maxLength={24}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="danger" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t("确认关闭")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={reset}>
              {t("取消")}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 break-words text-meta text-crit">
          {error}
        </p>
      )}
    </Card>
  );
}
