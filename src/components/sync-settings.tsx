import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Link2,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import type { SyncEvent, SyncScope, SyncStatus, WebPairing, WebSyncInfo } from "@/lib/sync";
import { relativeTime } from "@/lib/utils";
import { isWeb, webApi } from "@/lib/web";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";

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

function Fingerprint({ value }: { value: string }) {
  return (
    <code className="block break-all rounded-lg bg-surface px-3 py-2 font-mono text-meta tracking-wide">
      {value}
    </code>
  );
}

/** 设置 → 同步：桌面端负责配对与同步，网页版负责生成配对码和管理设备。 */
export function SyncSettings() {
  return isWeb() ? <WebSyncHost /> : <DesktopSync />;
}

// ———— 桌面端 ————

function DesktopSync() {
  const bridge = desktop()?.sync;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const reload = useCallback(() => {
    void bridge?.status().then(setStatus);
  }, [bridge]);
  useEffect(() => {
    reload();
    return bridge?.onChanged(reload);
  }, [bridge, reload]);
  if (!bridge) return <p className="text-meta text-muted">{t("同步只在桌面版提供。")}</p>;
  if (!status) return <p className="text-meta text-muted">{t("正在加载…")}</p>;

  const run = async (name: string, work: () => Promise<SyncStatus | void>) => {
    setBusy(name);
    setError("");
    try {
      const next = await work();
      if (next) setStatus(next);
    } catch (reason) {
      setError(errorText(reason));
      reload();
    } finally {
      setBusy("");
    }
  };

  if (!status.paired)
    return (
      <PairForm
        busy={busy === "pair"}
        error={error}
        onPair={(input) => run("pair", () => bridge.pair(input))}
      />
    );

  const result = status.lastResult;
  const scopeLabels: Array<{ key: keyof SyncScope; title: string; hint: string }> = [
    {
      key: "assets",
      title: t("资产与关联"),
      hint: t("服务器、域名、邮箱、订阅等记录与它们之间的关联"),
    },
    { key: "documents", title: t("文档"), hint: t("工作区里的全部文档") },
    {
      key: "vault",
      title: t("密钥库（只传密文）"),
      hint: t(
        "密码、密钥等凭据以 AES-256-GCM 密文同步，服务器看不到明文；两边必须使用同一个主密码",
      ),
    },
  ];
  return (
    <div className="space-y-5">
      <header>
        <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Link2 className="size-4 text-muted" />
          {t("与网页版同步")}
        </h3>
        <p className="mt-1 text-meta leading-relaxed text-muted">
          {t(
            "已与你自己服务器上的网页版配对，每 2 分钟和每次修改后自动同步。冲突时不会丢数据，两份都会保留。",
          )}
        </p>
      </header>

      {status.attention && (
        <Card tone="warn">
          <p className="flex items-start gap-2 text-meta">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            {status.attention.message}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {status.attention.kind === "rollback" && (
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() => void run("accept", () => bridge.acceptServerState())}
              >
                {t("接受服务器当前状态")}
              </Button>
            )}
            {status.attention.kind === "vault-conflict" && (
              <>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void run("vault", () => bridge.resolveVault("local"))}
                >
                  {t("以桌面版为准")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void run("vault", () => bridge.resolveVault("remote"))}
                >
                  {t("以网页版为准")}
                </Button>
              </>
            )}
          </div>
        </Card>
      )}

      <Card>
        <dl className="grid gap-3 text-meta sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted">{t("服务器")}</dt>
          <dd className="break-all">{status.server?.url}</dd>
          <dt className="text-muted">{t("服务器指纹")}</dt>
          <dd>{status.server && <Fingerprint value={status.server.fingerprint} />}</dd>
          <dt className="text-muted">{t("这台设备")}</dt>
          <dd>{status.device?.name}</dd>
          <dt className="text-muted">{t("上次同步")}</dt>
          <dd>
            {status.lastSyncAt ? relativeTime(status.lastSyncAt) : t("还没有同步过")}
            {result?.ok === false && <span className="ml-2 text-crit">{t("失败")}</span>}
          </dd>
        </dl>
        {status.server?.url.startsWith("http://") && (
          <p className="mt-3 flex items-start gap-2 text-2xs text-muted">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            {t("当前地址是 http://：同步内容仍由 ZSP 端到端加密并认证，但建议为服务器配置 HTTPS。")}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!!busy || status.running}
            onClick={() => void run("sync", () => bridge.syncNow())}
          >
            {busy === "sync" || status.running ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            {t("立即同步")}
          </Button>
          {result?.ok && (
            <span className="text-2xs text-subtle">
              {t(
                "拉取 {0} · 推送 {1} · 合并 {2} · 删除 {3}",
                result.pulled ?? 0,
                result.pushed ?? 0,
                result.merged ?? 0,
                result.deleted ?? 0,
              )}
            </span>
          )}
        </div>
        {(error || (result?.ok === false && result.error)) && (
          <p role="alert" className="mt-3 break-words text-meta text-crit">
            {error || result?.error}
          </p>
        )}
        {result?.warnings?.map((warning, index) => (
          <p key={index} className="mt-2 text-2xs text-muted">
            {warning}
          </p>
        ))}
      </Card>

      <section>
        <h4 className="text-meta font-semibold">{t("同步哪些内容")}</h4>
        <div className="mt-2 space-y-2">
          {scopeLabels.map(({ key, title, hint }) => (
            <label key={key} className="flex items-start gap-3 rounded-xl border border-line p-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-ink"
                checked={status.scope[key]}
                disabled={!!busy}
                onChange={(event) =>
                  void run("scope", () => bridge.setScope({ [key]: event.target.checked }))
                }
              />
              <span className="min-w-0">
                <span className="block text-meta font-medium">{title}</span>
                <span className="block text-2xs leading-relaxed text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-2xs leading-relaxed text-muted">
          {t("系统加密保存的 Cloudflare Token、模型 API Key 等不会同步，需要在网页版里重新填写。")}
        </p>
      </section>

      {!!status.log?.length && (
        <section>
          <h4 className="text-meta font-semibold">{t("最近记录")}</h4>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-2xs text-muted">
            {status.log.slice(0, 20).map((entry, index) => (
              <li key={index} className="flex gap-2">
                <span className="shrink-0 tabular-nums">{relativeTime(entry.at)}</span>
                <span className="min-w-0 break-words">{entry.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="border-t border-line pt-4">
        {confirmUnpair ? (
          <div className="space-y-3">
            <p className="text-meta text-muted">
              {t("解除配对后，这台设备不再同步；两边已有的资料都保留。之后可以重新配对。")}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="danger"
                disabled={!!busy}
                onClick={() => void run("unpair", () => bridge.unpair())}
              >
                <Unplug />
                {t("确认解除配对")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmUnpair(false)}>
                {t("取消")}
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="danger-ghost" onClick={() => setConfirmUnpair(true)}>
            <Unplug />
            {t("解除配对")}
          </Button>
        )}
      </section>
    </div>
  );
}

function PairForm({
  busy,
  error,
  onPair,
}: {
  busy: boolean;
  error: string;
  onPair: (input: { url: string; code: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onPair({ url: url.trim(), code: code.trim() });
  };
  return (
    <form className="space-y-5" onSubmit={submit}>
      <header>
        <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Link2 className="size-4 text-muted" />
          {t("与网页版同步")}
        </h3>
        <p className="mt-1 text-meta leading-relaxed text-muted">
          {t(
            "把桌面版的资产、文档（以及可选的密钥库）同步到你自己 VPS 上部署的网页版，两边都能改，合并后一致。配对只需要一次。",
          )}
        </p>
      </header>
      <Card>
        <ol className="list-decimal space-y-1 pl-5 text-meta text-muted">
          <li>{t("在网页版打开「设置 → 同步」，点「生成配对码」。")}</li>
          <li>{t("在这里填入网页版的地址和配对码（5 分钟内有效，只能用一次）。")}</li>
          <li>{t("配对成功后，核对两边显示的服务器指纹是否一致（可选）。")}</li>
        </ol>
      </Card>
      <Field label={t("网页版地址")}>
        <Input
          aria-label={t("网页版地址")}
          required
          type="url"
          placeholder="https://zhiyu.example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      <Field label={t("配对码")}>
        <Input
          aria-label={t("配对码")}
          required
          autoComplete="off"
          spellCheck={false}
          className="font-mono tracking-widest"
          placeholder="K7M2Q-9XWPD"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </Field>
      {url.trim().startsWith("http://") && (
        <p className="text-2xs leading-relaxed text-muted">
          {t(
            "http:// 地址也可以配对：配对码不会在网络上明文传输，同步内容也由 ZSP 端到端加密。跨网络使用仍建议配置 HTTPS。",
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-meta text-crit">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {t("配对")}
      </Button>
    </form>
  );
}

// ———— 网页版 ————

const EVENT_TEXT: Record<string, string> = {
  "pairing-created": "生成了配对码",
  "pairing-cancelled": "取消了配对码",
  "pairing-failed": "有人用错误的配对码尝试配对",
  "pairing-exhausted": "配对码因多次错误或尝试过多已作废",
  paired: "设备已配对",
  "device-revoked": "设备已被撤销",
  "device-unpaired": "设备主动解除了配对",
  sync: "设备完成了同步",
};

function WebSyncHost() {
  const [info, setInfo] = useState<WebSyncInfo | null>(null);
  const [pairing, setPairing] = useState<
    (WebPairing & { startedAt: number; devicesBefore: number }) | null
  >(null);
  const [infoAt, setInfoAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => {
    void webApi<WebSyncInfo>("sync")
      .then((next) => {
        setInfo(next);
        setInfoAt(Date.now());
      })
      .catch((reason) => setError(errorText(reason)));
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load]);
  // 码过期，或生成之后刷新到的状态显示服务器已不再等待配对（被用掉或作废）时，收起显示的码。
  useEffect(() => {
    if (!pairing) return;
    if (pairing.expiresAt <= now) {
      setPairing(null);
      return;
    }
    if (info && infoAt > pairing.startedAt && !info.pairing) {
      const devices = info.devices.filter((device) => !device.revokedAt).length;
      toast(devices > pairing.devicesBefore ? t("设备已配对") : t("配对码已失效，请重新生成"));
      setPairing(null);
    }
  }, [pairing, info, infoAt, now]);

  const task = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      load();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!info) return <p className="text-meta text-muted">{t("正在加载…")}</p>;
  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;
  const active = info.devices.filter((device) => !device.revokedAt);
  return (
    <div className="space-y-5">
      <header>
        <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <MonitorSmartphone className="size-4 text-muted" />
          {t("桌面端同步")}
        </h3>
        <p className="mt-1 text-meta leading-relaxed text-muted">
          {t(
            "让桌面版和这台服务器上的网页版保持一致。配对用一次性配对码，之后每次同步都用设备密钥互相认证并加密，即使服务器没有 HTTPS 也不会被中间人篡改。",
          )}
        </p>
      </header>

      <Card>
        <p className="text-meta font-medium">{t("这台服务器的指纹")}</p>
        <div className="mt-2">
          <Fingerprint value={info.fingerprint} />
        </div>
        <p className="mt-2 text-2xs leading-relaxed text-muted">
          {t("配对成功后，桌面版会显示同一个指纹，可以核对确认连的是这台服务器。")}
        </p>
      </Card>

      <Card>
        {pairing ? (
          <div className="space-y-3">
            <p className="text-meta text-muted">{t("在桌面版「设置 → 同步」里输入这个配对码：")}</p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-xl bg-surface px-4 py-3 font-mono text-2xl font-semibold tracking-[0.25em]">
                {pairing.code}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(pairing.code).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? t("已复制") : t("复制")}
              </Button>
            </div>
            <p className="text-2xs text-muted">
              {t("{0} 秒后失效，只能用一次。填错 3 次会作废。", left)}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void task(async () => {
                  await webApi("sync/pairing/cancel", { method: "POST", body: {} });
                  setPairing(null);
                })
              }
            >
              {t("取消配对码")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-meta text-muted">
              {active.length
                ? t("已配对 {0} 台设备。要添加另一台，生成新的配对码。", active.length)
                : t("还没有配对的设备。")}
            </p>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  const created = await webApi<WebPairing>("sync/pairing", {
                    method: "POST",
                    body: {},
                  });
                  setPairing({ ...created, startedAt: Date.now(), devicesBefore: active.length });
                })
              }
            >
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
              {t("生成配对码")}
            </Button>
          </div>
        )}
      </Card>

      {error && (
        <p role="alert" className="break-words text-meta text-crit">
          {error}
        </p>
      )}

      {!!info.devices.length && (
        <section>
          <h4 className="text-meta font-semibold">{t("已配对的设备")}</h4>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
            {info.devices.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-meta font-medium">
                    {device.name}
                    {device.revokedAt && (
                      <span className="ml-2 text-2xs text-crit">{t("已撤销")}</span>
                    )}
                  </p>
                  <p className="text-2xs text-muted">
                    {device.lastSeenAt
                      ? t("最近同步 {0}", relativeTime(device.lastSeenAt))
                      : t("还没有同步过")}
                  </p>
                </div>
                {device.revokedAt ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void task(() =>
                        webApi("sync/remove", { method: "POST", body: { id: device.id } }).then(
                          () => undefined,
                        ),
                      )
                    }
                  >
                    <Trash2 />
                    {t("移除记录")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    disabled={busy}
                    onClick={() =>
                      void task(() =>
                        webApi("sync/revoke", { method: "POST", body: { id: device.id } }).then(
                          () => undefined,
                        ),
                      )
                    }
                  >
                    {t("撤销")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs leading-relaxed text-muted">
            {t("撤销后这台设备立即无法同步，已有的连接也会断开。")}
          </p>
        </section>
      )}

      {!!info.events.length && (
        <section>
          <h4 className="text-meta font-semibold">{t("同步与安全记录")}</h4>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-2xs text-muted">
            {info.events.slice(0, 30).map((event: SyncEvent, index) => (
              <li key={index} className="flex gap-2">
                <span className="shrink-0 tabular-nums">{relativeTime(event.at)}</span>
                <span className="min-w-0 break-words">
                  {t(EVENT_TEXT[event.kind] ?? "其他事件")}
                  {event.device ? ` · ${event.device}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
