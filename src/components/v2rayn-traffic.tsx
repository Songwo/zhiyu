import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Activity, ArrowDown, ArrowUp, FolderOpen, RefreshCw } from "lucide-react";
import { t, intlLocale } from "@/lib/i18n";
import { matchV2raynNodes } from "@/lib/v2rayn-match.mjs";
import {
  usageBytes,
  type SubscriptionNode,
  type V2raynNodeStat,
  type V2raynUsageState,
} from "@/lib/usage";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import "./v2rayn-traffic.css";

type Snapshot = { data: V2raynUsageState | null; error: string; busy: boolean };
let snapshot: Snapshot = { data: null, error: "", busy: false };
let request: Promise<void> | null = null;
let selecting = false;
let lastRequest = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};
const readSnapshot = () => snapshot;

async function refresh(force = false, explicit = false) {
  const bridge = hostBridge()?.usage;
  if (!bridge?.v2raynStatus || request || selecting || (!force && Date.now() - lastRequest < 4500))
    return request;
  lastRequest = Date.now();
  if (explicit || !snapshot.data) publish({ ...snapshot, busy: true });
  request = bridge
    .v2raynStatus(force)
    .then((data) => publish({ data, error: "", busy: false }))
    .catch(() => publish({ ...snapshot, error: "本机统计读取失败，请稍后重试", busy: false }))
    .finally(() => {
      request = null;
    });
  return request;
}
const poll = () => {
  if (document.visibilityState === "visible") void refresh();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("focus", poll);
  }
  poll();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      window.removeEventListener("focus", poll);
    }
  };
}
const noSubscription = () => () => {};
function savedAmount(value: number | null) {
  if (value == null) return t("未提供");
  const index =
    value > 0 ? Math.min(3, Math.max(0, Math.floor(Math.log(value) / Math.log(1024)))) : 0;
  return `${(value / 1024 ** index).toLocaleString(intlLocale(), { maximumFractionDigits: index ? 2 : 0 })} ${["KB", "MB", "GB", "TB"][index]}`;
}
const liveAmount = (value: number | null) => (value == null ? t("未提供") : usageBytes(value));
function Pair({
  up,
  down,
  saved = false,
}: {
  up: number | null;
  down: number | null;
  saved?: boolean;
}) {
  const format = saved ? savedAmount : liveAmount;
  return (
    <div className="v2rayn-pair">
      <span>
        <ArrowUp aria-hidden="true" />
        <span className="sr-only">{t("上传")}</span>
        {format(up)}
      </span>
      <span>
        <ArrowDown aria-hidden="true" />
        <span className="sr-only">{t("下载")}</span>
        {format(down)}
      </span>
    </div>
  );
}

export function V2raynTraffic({ nodes }: { nodes?: SubscriptionNode[] }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(true);
  const [scope, setScope] = useState(nodes ? "matched" : "all");
  const [page, setPage] = useState(0);
  const { data, error, busy } = useSyncExternalStore(
    visible ? subscribe : noSubscription,
    readSnapshot,
    readSnapshot,
  );
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0]?.isIntersecting ?? false),
      { rootMargin: "100px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const all = data?.nodes;
  const matched = useMemo(
    () => (nodes ? (matchV2raynNodes(all ?? [], nodes) as V2raynNodeStat[]) : (all ?? [])),
    [all, nodes],
  );
  const list = scope === "all" ? (all ?? []) : matched;
  const pages = Math.max(1, Math.ceil(list.length / 8));
  const currentPage = Math.min(page, pages - 1);
  const displayed = list.slice(currentPage * 8, currentPage * 8 + 8);
  const live = data?.live;
  const liveNode = all?.find((node) => node.id === live?.nodeId);
  const liveBelongs =
    scope === "all" || (!!liveNode && matched.some((node) => node.id === liveNode.id));
  const bridge = hostBridge()?.usage;
  async function chooseDirectory() {
    if (!bridge?.chooseV2raynDirectory || busy || selecting) return;
    selecting = true;
    try {
      if (request) await request;
      publish({ ...snapshot, busy: true });
      const selected = await bridge.chooseV2raynDirectory();
      if (selected) {
        lastRequest = Date.now();
        publish({ data: selected, error: "", busy: false });
      } else publish({ ...snapshot, busy: false });
    } catch {
      publish({
        ...snapshot,
        error: "无法读取所选目录，请选择包含客户端配置的 v2rayN 目录",
        busy: false,
      });
    } finally {
      selecting = false;
    }
  }
  return (
    <section ref={ref} className="v2rayn-traffic" aria-label={t("v2rayN 本机流量")}>
      <div className="v2rayn-heading">
        <div>
          <h4>
            <Activity aria-hidden="true" />
            {t("v2rayN 本机流量")}
          </h4>
          <p>{t("只读客户端统计，不修改代理设置")}</p>
        </div>
        <div className="v2rayn-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void chooseDirectory()}
            disabled={!bridge?.chooseV2raynDirectory || busy}
          >
            <FolderOpen />
            {t("选择目录")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("刷新本机流量")}
            title={t("刷新本机流量")}
            onClick={() => void refresh(true, true)}
            disabled={!bridge?.v2raynStatus || busy}
          >
            <RefreshCw className={busy ? "v2rayn-refreshing" : ""} />
          </Button>
        </div>
      </div>
      {!bridge?.v2raynStatus && <p className="v2rayn-note">{t("本机流量统计仅在桌面端可用")}</p>}
      {error && (
        <p className="v2rayn-notice" role="alert">
          {t(error)}
        </p>
      )}
      {data?.message && (
        <p className="v2rayn-notice" role="status">
          {t(data.message)}
        </p>
      )}
      {!data && bridge?.v2raynStatus && (
        <p className="v2rayn-note" role="status">
          {busy ? t("正在读取客户端统计…") : t("尚未读取客户端统计")}
        </p>
      )}
      {data?.available && (
        <>
          <div className="v2rayn-scope">
            <Select
              aria-label={t("客户端节点范围")}
              value={scope}
              onValueChange={(value) => {
                setScope(value);
                setPage(0);
              }}
              options={[
                ...(nodes
                  ? [{ value: "matched", label: t("当前机场匹配节点（{0}）", matched.length) }]
                  : []),
                { value: "all", label: t("全部客户端节点（{0}）", all?.length ?? 0) },
              ]}
            />
          </div>
          <div className="v2rayn-saved">
            <div className="v2rayn-section-heading">
              <h5>{t("客户端已保存统计")}</h5>
              {data.savedAt && (
                <span>
                  {t("保存时间：{0}", new Date(data.savedAt).toLocaleString(intlLocale()))}
                </span>
              )}
            </div>
            <p className="v2rayn-note">
              {t("按 v2rayN 保存口径显示（KB 按 1024 进位）；通常退出客户端时保存，不是实时值。")}
            </p>
            {displayed.length ? (
              <div className="v2rayn-node-list">
                {displayed.map((node) => (
                  <div key={node.id} className="v2rayn-node">
                    <div className="v2rayn-node-identity">
                      <strong title={node.name}>{node.name}</strong>
                      <span>
                        {node.protocol} · {node.host}:{node.port}
                      </span>
                      {scope === "all" && node.subscriptionName && (
                        <span>{node.subscriptionName}</span>
                      )}
                    </div>
                    <div className="v2rayn-node-stat">
                      <span className="v2rayn-label">{t("已保存累计")}</span>
                      <Pair up={node.savedUploadKb} down={node.savedDownloadKb} saved />
                    </div>
                    <div className="v2rayn-node-stat">
                      <span className="v2rayn-label">{t("今日已保存")}</span>
                      <Pair up={node.todayUploadKb} down={node.todayDownloadKb} saved />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="v2rayn-note">
                {scope === "matched"
                  ? t(
                      "没有唯一匹配的客户端节点。按地址、端口和协议匹配，重复配置需名称一致；可切换查看全部客户端节点。",
                    )
                  : t("客户端尚未保存节点统计")}
              </p>
            )}
            {pages > 1 && (
              <div className="v2rayn-pagination">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  {t("上一页")}
                </Button>
                <span>{t("第 {0} / {1} 页", currentPage + 1, pages)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={currentPage === pages - 1}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t("下一页")}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {data && (
        <div className="v2rayn-live">
          <div className="v2rayn-section-heading">
            <h5>{t("当前核心实时统计")}</h5>
            <span className="v2rayn-live-state" data-active={!!live?.available}>
              <i />
              {live?.available ? t("每 5 秒读取") : t("实时接口不可用")}
            </span>
          </div>
          {live?.available && liveBelongs ? (
            <>
              <p className="v2rayn-note">
                {liveNode
                  ? t("当前节点：{0}", liveNode.name)
                  : t("未匹配节点，仅展示当前核心代理出口")}
              </p>
              <div className="v2rayn-live-grid">
                <div>
                  <span className="v2rayn-label">{t("本次核心累计")}</span>
                  <Pair up={live.upload} down={live.download} />
                </div>
                <div>
                  <span className="v2rayn-label">{t("本次监测增量")}</span>
                  <Pair up={live.observedUpload} down={live.observedDownload} />
                </div>
              </div>
              <p className="v2rayn-note">
                {t("实时值以字节计量，与已保存统计分开；监测开始、节点切换或核心重置后重新累计。")}
              </p>
            </>
          ) : live?.available ? (
            <p className="v2rayn-note">
              {t("当前核心流量未归属到此机场，可切换全部客户端节点查看。")}
            </p>
          ) : (
            <p className="v2rayn-note">
              {t(live?.message || "未发现可读取的本机实时接口，已保存统计仍可查看")}
            </p>
          )}
          {live?.available && live.message && <p className="v2rayn-note">{t(live.message)}</p>}
          {live?.reset && (
            <p className="v2rayn-note">{t("检测到核心重置或节点切换，监测增量已重新开始。")}</p>
          )}
        </div>
      )}
    </section>
  );
}
