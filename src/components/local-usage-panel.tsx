import { hostBridge } from "@/lib/web-bridge";
import { useState } from "react";
import { History, Monitor, RefreshCw, ShieldCheck } from "lucide-react";
import { intlLocale, t } from "@/lib/i18n";
import type { LocalUsageStatus } from "@/lib/usage";
import { Button } from "./ui/button";
import "./usage-insights.css";

const statusLabels = {
  "not-found": "未发现日志目录",
  discovering: "正在查找日志",
  importing: "正在导入历史",
  ready: "采集正常",
  "no-usage": "未发现 Token 记录",
  error: "采集受阻",
};
export function LocalUsagePanel({
  status,
  onChange,
  onViewHistory,
}: {
  status: LocalUsageStatus | null;
  onChange: () => Promise<void>;
  onViewHistory: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(enabled?: boolean) {
    const api = hostBridge()?.usage;
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      if (enabled === undefined) await api.refreshLocal();
      else await api.configureLocal({ enabled });
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const hasHistory = status?.sources.some((source) => source.records > 0);
  return (
    <section className="local-usage-panel" aria-label={t("本机 AI 监控")}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="flex flex-wrap items-center gap-2 font-semibold">
            <Monitor className="size-4" />
            {t("本机 AI 监控")}
            <span className="rounded-md bg-canvas px-2 py-1 text-xs font-normal text-muted">
              {t(status?.enabled ? "监控已开启" : "未开启")}
            </span>
          </h3>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {t("直接汇总 Codex、Claude Code、Grok Build 与 Gemini CLI 的本机用量日志。")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !status?.enabled}
            onClick={() => void run()}
          >
            <RefreshCw className={busy ? "animate-spin" : ""} />
            {t("立即采集")}
          </Button>
          <Button
            size="sm"
            variant={status?.enabled ? "outline" : "solid"}
            aria-pressed={status?.enabled ?? false}
            disabled={busy || !status}
            onClick={() => void run(!status?.enabled)}
          >
            {t(status?.enabled ? "关闭本机监控" : "开启本机监控")}
          </Button>
        </div>
      </div>
      {(status?.enabled || hasHistory) && (
        <div className="local-usage-sources">
          {status?.sources.map((source) => {
            const state =
              source.status ??
              (source.error
                ? "error"
                : source.records
                  ? "ready"
                  : source.available
                    ? "no-usage"
                    : "not-found");
            const importing = state === "importing" || state === "discovering";
            return (
              <div className="local-usage-source" key={source.id} data-source-status={state}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <strong>{source.name}</strong>
                  <span
                    className="local-usage-state-dot"
                    data-active={status.enabled && (state === "ready" || importing)}
                  />
                </div>
                <p className="mt-2 flex items-center gap-2 text-xs text-muted">
                  {importing && status.enabled && (
                    <RefreshCw className="size-3 motion-safe:animate-spin" />
                  )}
                  {t(!status.enabled ? "监控已关闭" : statusLabels[state])}
                </p>
                <p className="mt-4 text-sm font-medium tabular-nums">
                  {t("{0} 条统计记录", source.records.toLocaleString(intlLocale()))}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {t("已发现 {0} 个日志文件", source.files.toLocaleString(intlLocale()))}
                </p>
                {source.lastUsageAt && (
                  <p className="mt-2 text-xs text-muted">
                    {t(
                      "最近用量：{0}",
                      new Date(source.lastUsageAt).toLocaleDateString(intlLocale()),
                    )}
                  </p>
                )}
                {importing && source.progress && (
                  <p className="mt-2 text-xs text-muted">
                    {t(
                      "已处理 {0} 个 · 待处理 {1} 个",
                      source.progress.processedFiles,
                      source.progress.pendingFiles,
                    )}
                  </p>
                )}
                {state === "no-usage" && (
                  <p className="mt-2 text-xs leading-relaxed text-muted">
                    {t("目录已找到，但尚无包含 Token 数字的会话。网页聊天不会自动生成此类日志。")}
                  </p>
                )}
                {source.error && <p className="mt-2 text-xs text-crit">{source.error}</p>}
                {!!source.warnings?.length && (
                  <details className="mt-2 text-xs text-muted">
                    <summary>{t("有记录被跳过")}</summary>
                    {source.warnings.map((warning) => (
                      <p className="mt-1" key={warning}>
                        {warning}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {status?.lastScannedAt
            ? t("最近检查：{0}", new Date(status.lastScannedAt).toLocaleString(intlLocale()))
            : t("开启后自动检查，历史记录分批导入。")}
        </p>
        {hasHistory && (
          <Button size="sm" variant="ghost" onClick={onViewHistory}>
            <History />
            {t("查看全部本机历史")}
          </Button>
        )}
      </div>
      <details className="local-usage-privacy">
        <summary>
          <ShieldCheck className="size-3.5" />
          {t("采集范围与隐私")}
        </summary>
        <p>
          {t(
            "默认开启，无需解锁密钥库。应用运行时约每 10 秒检查，仅在本机保存用量数字、模型与匿名会话标识，不保存对话、密钥或完整日志路径。",
          )}
        </p>
        <p>
          {t(
            "仅统计客户端实际写出的用量。浏览器聊天、未提供 Token 的日志无法读取。本机统计与 API 账单可能重叠，因此分开展示。",
          )}
        </p>
        {hasHistory && (
          <p>{t("已导入的历史可能早于当前日期筛选；使用「查看全部本机历史」可查看完整范围。")}</p>
        )}
      </details>
      {(error || status?.error) && (
        <p role="alert" className="mt-3 text-sm text-crit">
          {error || status?.error}
        </p>
      )}
    </section>
  );
}
