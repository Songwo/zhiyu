import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownUp, ChevronDown, Network, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import { createSubscriptionDetailsCache } from "@/lib/usage-connect.mjs";
import { subscriptionTrafficSummary } from "@/lib/usage-insights.mjs";
import {
  type SubscriptionDetails,
  type UsageRecord,
  type UsageSource,
  usageBytes,
} from "@/lib/usage";
import { Button } from "./ui/button";
import { V2raynTraffic } from "./v2rayn-traffic";

const formatNames: Record<SubscriptionDetails["format"], string> = {
  uri: "URI",
  base64: "Base64",
  clash: "Clash",
  "sing-box": "sing-box",
  unknown: "未识别",
};

export function SubscriptionSourceCard({
  source,
  row,
  nodeName,
  error,
  busy,
  highlighted,
  onRefresh,
  onEdit,
  onRemove,
}: {
  source: UsageSource;
  row?: UsageRecord;
  nodeName?: string;
  error?: string;
  busy: boolean;
  highlighted: boolean;
  onRefresh: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [details, setDetails] = useState<SubscriptionDetails | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const regionId = useId();
  const detailCache = useRef(
    createSubscriptionDetailsCache(async (id) => {
      const api = desktop()?.usage;
      if (!api?.subscriptionDetails) throw new Error(t("当前桌面端不支持节点详情，请更新后重试。"));
      return api.subscriptionDetails(id);
    }),
  );
  const sourceId = source.id;
  const checkedAt = source.checkedAt;
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setLoading(true);
    setDetailsError("");
    setDetails(null);
    void detailCache.current
      .read({ id: sourceId, checkedAt })
      .then((value) => {
        if (active) setDetails(value);
      })
      .catch((cause) => {
        if (active) setDetailsError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sourceId, checkedAt, expanded, attempt]);

  const traffic = subscriptionTrafficSummary(row);
  const meta = source.subscription;
  const stale = Boolean(row && (error || meta?.trafficAvailable === false));
  const nodes = details?.nodes ?? [];
  const query = search.trim().toLocaleLowerCase();
  const visibleNodes = nodes.filter(
    (node) =>
      !query ||
      `${node.name} ${node.protocol} ${node.host}:${node.port}`.toLocaleLowerCase().includes(query),
  );
  const state = error
    ? "连接需要处理"
    : !source.checkedAt
      ? "尚未采集"
      : traffic.expired
        ? "已过期"
        : traffic.exceeded
          ? "已超出额度"
          : traffic.exhausted
            ? "额度已用尽"
            : "已连接";
  const remaining = traffic.unlimited
    ? t("不限额")
    : traffic.remaining == null
      ? t("未提供")
      : usageBytes(traffic.remaining);

  return (
    <section
      className="usage-source-card subscription-source-card"
      id={`usage-source-${source.id}`}
      tabIndex={-1}
      data-highlighted={highlighted || undefined}
      data-expanded={expanded || undefined}
      data-tone="traffic"
      data-state={error ? "error" : row ? "ok" : "idle"}
    >
      <div className="usage-source-heading">
        <div className="min-w-0">
          <div className="usage-source-title">
            <span className="usage-source-icon" aria-hidden="true">
              <ArrowDownUp />
            </span>
            <div className="min-w-0">
              <h3>{source.name}</h3>
              <p>
                {t("机场订阅")}
                <span
                  className="usage-source-state"
                  data-bad={error || traffic.expired || traffic.exhausted ? true : undefined}
                >
                  {t(state)}
                </span>
              </p>
            </div>
          </div>
          {nodeName && (
            <p>
              {t("关联节点")}：{nodeName}
            </p>
          )}
        </div>
        <div className="usage-source-actions">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`${t("刷新")} ${source.name}`}
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshCw />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`${t("编辑")} ${source.name}`}
            disabled={busy}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="danger-ghost"
            aria-label={`${t("移除")} ${source.name}`}
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {error && (
        <div className="usage-source-error" role="alert">
          <p>
            {t(row ? "采集失败，保留上次有效数据" : "采集失败，请编辑连接信息或重试")}：{error}
          </p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
            {t("重试连接")}
          </Button>
        </div>
      )}
      <div className="subscription-metrics">
        <div>
          <span>{t("机场累计已用")}</span>
          <strong>{traffic.used == null ? "—" : usageBytes(traffic.used)}</strong>
        </div>
        <div>
          <span>{t("剩余流量")}</span>
          <strong>{remaining}</strong>
        </div>
        <div>
          <span>{t("总额度")}</span>
          <strong>
            {traffic.unlimited
              ? t("不限额")
              : traffic.total == null
                ? t("未提供")
                : usageBytes(traffic.total)}
          </strong>
        </div>
      </div>
      {traffic.percent != null && (
        <div
          className="subscription-progress"
          role="progressbar"
          aria-label={t("机场额度使用比例")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={traffic.percent}
          aria-valuetext={traffic.exceeded ? t("已超出额度") : `${traffic.percent.toFixed(1)}%`}
          data-exhausted={traffic.exhausted || undefined}
        >
          <span style={{ width: `${traffic.percent}%` }} />
        </div>
      )}
      <div className="subscription-meta">
        <span>
          {t("到期时间")}：
          <strong className={traffic.expired ? "text-crit" : undefined}>
            {row?.expiresAt ? new Date(row.expiresAt).toLocaleString() : t("未提供")}
          </strong>
        </span>
        <span>
          {t("采样时间")}：
          {row?.checkedAt ? new Date(row.checkedAt).toLocaleString() : t("尚未采集")}
        </span>
      </div>
      {stale && (
        <p className="subscription-note">
          {t("当前显示上次有效采样；本次采集未取得新的流量数据。")}
        </p>
      )}
      {!row && (
        <p className="subscription-note">
          {meta?.trafficMessage || t("订阅尚未提供有效流量数据。节点列表与流量信息分别解析。")}
        </p>
      )}
      {row && meta?.trafficMessage && !meta.trafficAvailable && (
        <p className="subscription-note">{meta.trafficMessage}</p>
      )}
      <p className="subscription-note">
        {t("机场总量由服务商提供，不能代表单个节点用量。下方本机流量独立统计，不与机场总量相加。")}
      </p>
      <button
        type="button"
        className="subscription-expand"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((value) => !value)}
      >
        <Network className="size-4" />
        <span>{t("节点详情")}</span>
        <span className="text-muted">
          {meta ? t("{0} 个节点", meta.nodeCount) : t("查看已缓存节点")}
        </span>
        <ChevronDown className="subscription-chevron size-4" />
      </button>
      <div id={regionId} hidden={!expanded} className="subscription-details">
        {expanded && (
          <>
            {loading && (
              <p role="status" className="subscription-note">
                {t("正在读取缓存节点…")}
              </p>
            )}
            {detailsError && (
              <div role="alert" className="usage-source-error">
                <p>{detailsError}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  {t("重新读取")}
                </Button>
              </div>
            )}
            {details && (
              <div className="subscription-detail-layout">
                <div className="subscription-catalog">
                  <div className="subscription-details-heading">
                    <strong>{t("{0} 个节点", details.nodeCount)}</strong>
                    <span>
                      {t("订阅格式")}：{t(formatNames[details.format])}
                    </span>
                  </div>
                  {details.nodesMessage && (
                    <p className="subscription-note">{details.nodesMessage}</p>
                  )}
                  {details.truncated && (
                    <p className="subscription-note">
                      {t("节点过多，仅展示安全解析上限内的节点。")}
                    </p>
                  )}
                  {nodes.length > 0 && (
                    <>
                      <label className="subscription-search">
                        <Search className="size-4" />
                        <input
                          aria-label={t("搜索订阅节点")}
                          placeholder={t("搜索名称、协议或主机")}
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </label>
                      <div className="subscription-node-list" role="list">
                        {visibleNodes.map((node) => (
                          <div className="subscription-node" key={node.id} role="listitem">
                            <strong>{node.name}</strong>
                            <span>{node.protocol.toUpperCase()}</span>
                            <code>
                              {node.host.includes(":")
                                ? `[${node.host}]:${node.port}`
                                : `${node.host}:${node.port}`}
                            </code>
                          </div>
                        ))}
                        {!visibleNodes.length && (
                          <p className="subscription-note">{t("没有匹配的节点")}</p>
                        )}
                      </div>
                    </>
                  )}
                  {!nodes.length && !details.nodesMessage && (
                    <p className="subscription-note">
                      {t("缓存中没有可展示的节点，请先刷新订阅。")}
                    </p>
                  )}
                </div>
                <V2raynTraffic nodes={details.nodes} />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
