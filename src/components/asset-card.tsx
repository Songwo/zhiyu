import {
  hasServerMetrics,
  hasServerObservation,
  isCollectionPaused,
} from "@/lib/server-observation.mjs";
import type { MouseEvent } from "react";
import {
  CircleAlert,
  Copy,
  FileText,
  Globe,
  KeyRound,
  Loader2,
  Mail,
  Radio,
  Server,
  Shield,
  SquareTerminal,
} from "lucide-react";
import { toast } from "sonner";
import { CardTag } from "./tag-bar";
import { AssetImage } from "./image-picker";
import { TimeAgo } from "./ui/time-ago";
import { isDesktop } from "@/lib/desktop";
import { isWeb } from "@/lib/web";
import { useLive } from "@/lib/live";
import { useProbeState } from "@/lib/probes";
import { tagsOf } from "@/lib/tags";
import { barTone } from "@/lib/status";
import { useAppStore } from "@/lib/store";
import type {
  AiAsset,
  AssetKind,
  Certificate,
  Domain,
  Mailbox,
  Secret,
  Server as ServerT,
} from "@/lib/types";
import { cn, copyText, daysUntil, formatDate, formatUsd } from "@/lib/utils";
import { t } from "@/lib/i18n";

import { StatusBadge } from "./ui/status-badge";

export function openFromEvent(e: MouseEvent<HTMLElement>, kind: AssetKind, id: string) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  useAppStore.getState().setExpanded({
    kind,
    id,
    origin: { x: r.left, y: r.top, w: r.width, h: r.height },
  });
}

export function ServerCard({ data, compact = true }: { data: ServerT; compact?: boolean }) {
  const liveCpu = useLive((s) => s.cpu[data.id]);
  const liveMem = useLive((s) => s.memory[data.id]);
  const cpu = liveCpu ?? data.cpu;
  const mem = liveMem ?? data.memory;
  const status = data.status;
  const paused = isCollectionPaused(data);
  const observed = hasServerObservation(data);
  const measured = hasServerMetrics(data);

  return (
    <article
      className={cn(
        "group relative bg-card text-left transition-all",
        compact ? "asset-card-valuable card-tap cursor-pointer" : "asset-card-detail",
      )}
      data-asset-id={compact ? data.id : undefined}
      onClick={compact ? (e) => openFromEvent(e, "server", data.id) : undefined}
    >
      <header className="flex items-start gap-3">
        <AssetImage
          value={data.imageDataUrl}
          fallback={
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-ink border border-line-strong/60">
              <Server className="size-4.5" strokeWidth={1.8} />
            </div>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-semibold tracking-tight text-ink">{data.name}</h3>
            <StatusBadge
              status={status}
              sonar={status === "online"}
              pending={!observed}
              pendingLabel={paused ? t("已暂停采集") : undefined}
            />
          </div>
          <p className="mt-0.5 truncate text-meta text-muted">
            {data.label} · {data.os}
          </p>
        </div>
      </header>

      <div className="mt-3 flex items-center justify-between">
        <span className="code-text select-all">
          {data.username}@{data.host}
          <span className="text-subtle">:{data.port}</span>
        </span>
        <span className="text-2xs font-medium text-subtle">{data.region}</span>
      </div>

      {/* Node / Docs / Secret Indicators */}
      {(Boolean(data.nodes?.length) ||
        Boolean(data.docs?.trim()) ||
        Boolean(data.customSecrets?.length)) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          {Boolean(data.nodes?.length) && (
            <span className="asset-feature-chip">
              <Radio aria-hidden="true" />
              {data.nodes!.length} {t("自建节点")}
            </span>
          )}
          {Boolean(data.docs?.trim()) && (
            <span className="asset-feature-chip">
              <FileText aria-hidden="true" />
              {t("已写文档")}
            </span>
          )}
          {Boolean(data.customSecrets?.length) && (
            <span className="asset-feature-chip">
              <KeyRound aria-hidden="true" />
              {data.customSecrets!.length} {t("绑定密钥")}
            </span>
          )}
        </div>
      )}

      {measured ? (
        <div
          className={cn("mt-4 grid grid-cols-3 gap-3", paused && "opacity-50")}
          title={paused ? t("已暂停采集，显示的是上次的数据") : undefined}
        >
          <Metric label="CPU" value={cpu} />
          <Metric label={t("内存")} value={mem} />
          <Metric label={t("磁盘")} value={data.disk} />
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-surface p-3 text-meta text-muted">
          {paused
            ? t("已关闭自动采集：不会连接这台主机，也不会提示离线。")
            : t("暂无监控数据，配置 SSH 后可手动采集。")}
        </p>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-1.5 border-t border-line/60 pt-2.5">
        {data.tags.map((t) => (
          <CardTag key={t} tag={t} />
        ))}
        <span className="ml-auto text-2xs tabular-nums text-subtle">
          {measured ? (
            <>
              {t("运行 {0}", data.uptime)} · <TimeAgo iso={data.lastSeen} />
            </>
          ) : paused ? null : (
            t("未采集")
          )}
        </span>
        <CollectSwitch server={data} />
      </div>

      {!paused && <ProbeNote id={data.id} error={data.probeError} at={data.probedAt} />}
      {!paused && data.probeError && !isWeb() && data.sshConfigured !== false && (
        <p className="mt-1 text-2xs text-subtle">
          {t("本机连不上这台主机（例如需要代理）？关掉右下角的「采集」，不再连接也不再告警。")}
        </p>
      )}

      {!compact && (
        <div className="mt-5 space-y-4 border-t border-line pt-4">
          {(data.kernel || data.loadavg) && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-2xs">
              {data.kernel && (
                <div>
                  <dt className="text-subtle">{t("内核")}</dt>
                  <dd className="font-mono text-ink">{data.kernel}</dd>
                </div>
              )}
              {data.loadavg && (
                <div>
                  <dt className="text-subtle">{t("负载")}</dt>
                  <dd className="font-mono text-ink">{data.loadavg}</dd>
                </div>
              )}
            </dl>
          )}
          <p className="text-meta leading-relaxed text-muted">{data.notes}</p>
          <div className="flex flex-wrap gap-2">
            <CopyBtn text={`${data.username}@${data.host} -p ${data.port}`} label={t("复制 SSH")} />
            <CopyBtn text={data.host} label={t("复制 IP")} />
            {status !== "offline" && (
              <button
                type="button"
                className="btn btn-sm btn-primary gap-1.5"
                onClick={(e) => {
                  e.stopPropagation();
                  useAppStore.getState().openSsh(data.id);
                }}
              >
                <SquareTerminal className="size-3.5" />
                {t("玻璃终端")}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/** 每台主机的「自动采集」开关：本机连不上（没有代理、内网机器）时关掉，不再探测也不再告警。 */
function CollectSwitch({ server }: { server: ServerT }) {
  if (isWeb() || server.sshConfigured === false) return null;
  const on = !isCollectionPaused(server);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={t("自动采集 {0}", server.name)}
      title={
        on
          ? t("自动采集已打开：按设定周期连接这台主机。连不上时可以关掉。")
          : t("自动采集已关闭：不连接、不告警。点击重新打开。")
      }
      className="collect-switch"
      onClick={(e) => {
        e.stopPropagation();
        const state = useAppStore.getState();
        const current = state.servers.find((s) => s.id === server.id) ?? server;
        state.upsertServer({ ...current, collect: on ? false : undefined });
        state.log(
          on ? t("关闭了 {0} 的自动采集", server.name) : t("打开了 {0} 的自动采集", server.name),
          "server",
        );
        toast(
          on
            ? t("已关闭「{0}」的自动采集，不会再连接或提示离线", server.name)
            : t("已打开「{0}」的自动采集，下个采集周期会连接", server.name),
        );
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="collect-switch-track" aria-hidden="true">
        <span className="collect-switch-thumb" />
      </span>
      <span>{t("采集")}</span>
    </button>
  );
}

function ProbeNote({ id, error, at }: { id: string; error?: string; at?: string }) {
  const busy = useProbeState((s) => Boolean(s.busy[id]));
  if (busy) {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-2xs text-muted">
        <Loader2 className="size-3.5 animate-spin text-sky-400" />
        {t("正在采集…")}
      </p>
    );
  }
  if (!error && !at) return null;
  if (error) {
    return (
      <p className="mt-3 flex items-start gap-1.5 text-2xs leading-relaxed text-crit">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">{error}</span>
      </p>
    );
  }
  return (
    <p className="mt-3 text-2xs text-subtle">
      {t("实时采集于")} <TimeAgo iso={at!} />
    </p>
  );
}

function TagRow({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <CardTag key={t} tag={t} />
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  const tone = barTone(value);
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-2xs text-muted">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums font-semibold text-ink">{clamped}%</span>
      </div>
      <div className="laser-bar">
        <div
          className={cn(
            "laser-bar-fill",
            tone === "warn" && "warning",
            tone === "crit" && "critical",
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

export function DomainCard({ data, compact = true }: { data: Domain; compact?: boolean }) {
  const d = daysUntil(data.expiresAt);
  return (
    <article
      className={cn(
        "group relative bg-card text-left transition-all",
        compact ? "asset-card-valuable card-tap cursor-pointer" : "asset-card-detail",
      )}
      data-asset-id={compact ? data.id : undefined}
      onClick={compact ? (e) => openFromEvent(e, "domain", data.id) : undefined}
    >
      <header className="flex items-start gap-3">
        <AssetImage
          value={data.imageDataUrl}
          fallback={
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-ink border border-line-strong/60">
              <Globe className="size-4.5" />
            </div>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-semibold tracking-tight text-ink">{data.name}</h3>
            <span
              className={cn(
                "badge",
                d <= 7 ? "badge-invalid" : d <= 30 ? "badge-cooling" : "badge-valid",
              )}
            >
              {d <= 0 ? t("已过期") : t("{0} 天到期", d)}
            </span>
          </div>
          <p className="mt-0.5 text-meta text-muted">
            {data.registrar} · DNS {data.dns}
          </p>
        </div>
      </header>
      <div className="mt-3 flex items-center justify-between text-meta text-muted">
        <span className="text-2xs font-mono">{t("到期 {0}", formatDate(data.expiresAt))}</span>
        <span className="code-text text-[11px]">
          {data.autoRenew ? t("✓ 自动续费") : t("✕ 手动续费")}
        </span>
      </div>
      <div className="mt-3.5 border-t border-line/60 pt-2.5">
        <TagRow tags={tagsOf(data)} />
      </div>
      <ProbeNote id={data.id} error={data.probeError} at={data.probedAt} />

      {!compact && (
        <div className="mt-4 space-y-2 border-t border-line pt-4 text-meta text-muted">
          <p className="text-2xs font-semibold text-subtle uppercase tracking-wider">Nameservers</p>
          <ul className="flex flex-wrap gap-1.5 font-mono text-2xs text-ink">
            {data.nameservers.map((n) => (
              <li key={n} className="code-text">
                {n}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-meta text-muted">{data.notes}</p>
          <div className="pt-2">
            <CopyBtn text={data.name} label={t("复制域名")} />
          </div>
        </div>
      )}
    </article>
  );
}

export function MailCard({ data, compact = true }: { data: Mailbox; compact?: boolean }) {
  const pct = data.quotaMb ? Math.round((data.usedMb / data.quotaMb) * 100) : 0;
  const kindLabel =
    data.kind === "mailbox" ? t("邮箱") : data.kind === "alias" ? t("别名") : t("转发");
  return (
    <article
      className={cn(
        "group relative bg-card text-left transition-all",
        compact ? "asset-card-valuable card-tap cursor-pointer" : "asset-card-detail",
      )}
      data-asset-id={compact ? data.id : undefined}
      onClick={compact ? (e) => openFromEvent(e, "mail", data.id) : undefined}
    >
      <header className="flex items-start gap-3">
        <AssetImage
          value={data.imageDataUrl}
          fallback={
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-ink border border-line-strong/60">
              <Mail className="size-4.5" />
            </div>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-semibold tracking-tight text-ink">{data.address}</h3>
            <StatusBadge status={data.status} sonar={data.status === "online"} />
          </div>
          <p className="mt-0.5 text-meta text-muted">
            <span className="code-text text-[11px] mr-1.5">{kindLabel}</span>
            {data.forwardTo ? ` → ${data.forwardTo}` : ""}
          </p>
        </div>
      </header>
      {data.quotaMb > 0 && (
        <div className="mt-4">
          <Metric label={t("容量使用率")} value={pct} />
          <p className="mt-1.5 text-right font-mono text-2xs text-subtle tabular-nums">
            {data.usedMb} / {data.quotaMb} MB
          </p>
        </div>
      )}
      <div className="mt-3.5 border-t border-line/60 pt-2.5">
        <TagRow tags={tagsOf(data)} />
      </div>
      {!compact && <p className="mt-4 text-meta text-muted">{data.notes}</p>}
    </article>
  );
}

export function AiCard({ data, compact = true }: { data: AiAsset; compact?: boolean }) {
  return (
    <article
      className={cn(
        "group relative bg-card text-left transition-all",
        compact ? "asset-card-valuable card-tap cursor-pointer" : "asset-card-detail",
      )}
      data-asset-id={compact ? data.id : undefined}
      onClick={compact ? (e) => openFromEvent(e, "ai", data.id) : undefined}
    >
      <header className="flex items-start gap-3">
        <AssetImage
          value={data.imageDataUrl}
          fallback={
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-2xs font-semibold text-card shadow-sm">
              {data.provider.slice(0, 2).toUpperCase()}
            </div>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-semibold tracking-tight text-ink">{data.name}</h3>
            <span className="code-text font-semibold text-ink">
              {data.monthlyUsdKnown === false ? (
                <span className="text-2xs font-normal text-muted">{t("月费未记录")}</span>
              ) : (
                <>
                  {formatUsd(data.monthlyUsd)}
                  <span className="text-2xs font-normal text-subtle"> {t("/月")}</span>
                </>
              )}
            </span>
          </div>
          <p className="mt-0.5 text-meta text-muted">
            {data.provider} · {data.plan || t("未提供套餐")}
          </p>
        </div>
      </header>
      <div className="mt-4">
        {data.oauthAccountId && !data.usageAvailable ? (
          <p className="break-words text-meta text-muted">
            {data.usageSummary ? `${t("剩余")}: ${data.usageSummary}` : t("暂无可读取额度")}
          </p>
        ) : (
          <Metric
            label={t(data.oauthAccountId ? "最高额度用量" : "本月额度消耗")}
            value={data.usagePct}
          />
        )}
        {data.usageScope && (
          <p className="mt-2 text-2xs text-muted">
            {t("额度来源")}:{" "}
            <span className="code-text text-[11px]">
              {(
                {
                  codex: "Codex",
                  claude: "Claude OAuth",
                  "grok-cli": "Grok CLI",
                  "code-assist": "Gemini Code Assist",
                } as Record<string, string>
              )[data.usageScope] || data.usageScope}
            </span>
          </p>
        )}
        {data.usageStale && (
          <p className="mt-1 text-2xs text-warn">{t("更新失败，保留上次数据")}</p>
        )}
      </div>
      <div className="mt-3.5 flex items-center justify-between border-t border-line/60 pt-2.5 text-2xs text-subtle">
        <span className="min-w-0 truncate font-mono">
          {data.oauthAccountId ? t(data.oauthDisconnected ? "授权已断开" : "已授权") : data.keyHint}
        </span>
        <StatusBadge status={data.status} sonar={data.status === "online"} />
      </div>
      <TagRow tags={tagsOf(data)} />
      {!compact && <p className="mt-4 text-meta text-muted">{data.notes}</p>}
    </article>
  );
}

export function SecretCard({ data, compact = true }: { data: Secret; compact?: boolean }) {
  const account = data.kind === "account" || data.kind === "password";
  const kindLabel = account
    ? t("账号密码")
    : data.kind === "api"
      ? "API Key"
      : data.kind === "ssh"
        ? "SSH 密钥"
        : data.kind === "token"
          ? "访问令牌"
          : t("保密凭据");
  return (
    <article
      className={cn(
        "group relative bg-card text-left transition-all",
        compact ? "asset-card-valuable card-tap cursor-pointer" : "asset-card-detail",
      )}
      data-asset-id={compact ? data.id : undefined}
      onClick={compact ? (e) => openFromEvent(e, "secret", data.id) : undefined}
    >
      <header className="flex items-start gap-3">
        <AssetImage
          value={data.imageDataUrl}
          fallback={
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-ink border border-line-strong/60">
              <KeyRound className="size-4.5" />
            </div>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-semibold tracking-tight text-ink">{data.name}</h3>
            <span className="badge badge-tag-mock text-[11px]">{kindLabel}</span>
          </div>
          <p className="mt-0.5 font-mono text-2xs text-muted">
            {account ? (
              t("账户名与密码已加密")
            ) : (
              <span className="code-text select-all">{data.hint}</span>
            )}
          </p>
        </div>
      </header>
      <div className="mt-3 flex items-center justify-between text-2xs text-subtle">
        <span>{t("金融级 AES-256 加密存储")}</span>
        <span>
          {t("上次轮换")} {formatDate(data.lastRotated)}
        </span>
      </div>
      <div className="mt-3.5 border-t border-line/60 pt-2.5">
        <TagRow tags={tagsOf(data)} />
      </div>
      {!compact && !account && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <p className="text-meta text-muted">{data.notes}</p>
          {!isDesktop() && data.value ? <SecretReveal value={data.value} /> : null}
        </div>
      )}
    </article>
  );
}

function SecretReveal({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="code-text w-full cursor-pointer justify-between py-2 text-left hover:border-ink"
      onClick={(e) => {
        e.stopPropagation();
        copyText(value);
        toast(t("已安全复制私密值至剪贴板"));
      }}
    >
      <span>{t("点击解密并复制 · {0}…", value.slice(0, 18))}</span>
      <Copy className="size-3.5" />
    </button>
  );
}

export function CertCard({ data, compact = true }: { data: Certificate; compact?: boolean }) {
  const d = daysUntil(data.expiresAt);
  return (
    <article
      className={cn(
        "group relative bg-card text-left transition-all",
        compact ? "asset-card-valuable card-tap cursor-pointer" : "asset-card-detail",
      )}
      data-asset-id={compact ? data.id : undefined}
      onClick={compact ? (e) => openFromEvent(e, "cert", data.id) : undefined}
    >
      <header className="flex items-start gap-3">
        <AssetImage
          value={data.imageDataUrl}
          fallback={
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-ink border border-line-strong/60">
              <Shield className="size-4.5" />
            </div>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-semibold tracking-tight text-ink">{data.cn}</h3>
            <span
              className={cn(
                "badge",
                d <= 7 ? "badge-invalid" : d <= 30 ? "badge-cooling" : "badge-valid",
              )}
            >
              {d <= 0 ? t("已过期") : t("{0} 天到期", d)}
            </span>
          </div>
          <p className="mt-0.5 text-meta text-muted">{data.issuer}</p>
        </div>
      </header>
      <div className="mt-3 flex items-center justify-between text-meta text-muted">
        <span className="text-2xs font-mono">{t("到期 {0}", formatDate(data.expiresAt))}</span>
        {data.protocol && <span className="code-text text-[11px]">{data.protocol}</span>}
      </div>
      {data.trusted === false && (
        <p className="mt-1.5 text-2xs text-crit">
          {t("证书链不受信任")}
          {data.untrustedReason ? t("：{0}", data.untrustedReason) : ""}
        </p>
      )}
      <div className="mt-3.5 border-t border-line/60 pt-2.5">
        <TagRow tags={tagsOf(data)} />
      </div>
      <ProbeNote id={data.id} error={data.probeError} at={data.probedAt} />
      {!compact && (
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">
            SAN 域名列表
          </p>
          <div className="flex flex-wrap gap-1.5">
            {data.sans.map((san) => (
              <span key={san} className="code-text text-2xs">
                {san}
              </span>
            ))}
          </div>
          <p className="mt-2 text-meta text-muted">{data.notes}</p>
        </div>
      )}
    </article>
  );
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      className="btn btn-sm btn-outline gap-1.5"
      onClick={(e) => {
        e.stopPropagation();
        copyText(text);
        toast(t("已复制到剪贴板"));
      }}
    >
      <Copy className="size-3.5" />
      {label}
    </button>
  );
}
