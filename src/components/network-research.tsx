import { useCallback, useEffect, useRef, useState } from "react";
import { Globe2, ExternalLink, RefreshCw, Square } from "lucide-react";
import { hostBridge } from "@/lib/web-bridge";
import { openExternal } from "@/lib/web-bridge";
import { useAppStore } from "@/lib/store";
import type { AssetKind } from "@/lib/types";
import type { ResearchJob, ResearchQuota, ResearchRecords } from "@/lib/research";
import { publicResearchQuery } from "@/lib/research-query.mjs";
import { t } from "@/lib/i18n";
import { randomId } from "@/lib/random-id";
import { Button } from "./ui/button";
import { Textarea } from "./ui/input";
import { EditorDialog } from "./ui/editor-dialog";
import { TaskProgress } from "./task-progress";
import "./document-analysis.css";
import "./network-research.css";

export function NetworkResearch({ asset }: { asset?: { kind: AssetKind; id: string } }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  if (!hostBridge()?.research) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const state = useAppStore.getState();
          const sets = {
            server: state.servers,
            domain: state.domains,
            cert: state.certs,
            ai: state.aiAssets,
            mail: state.mailboxes,
            secret: state.secrets,
            service: state.services,
          };
          setQuery(
            asset
              ? publicResearchQuery(
                  asset.kind,
                  sets[asset.kind]?.find((item) => item.id === asset.id) || {},
                )
              : "",
          );
          setOpen(true);
        }}
      >
        <Globe2 className="size-3.5" />
        {t("联网检索")}
      </Button>
      {open && <ResearchDialog initialQuery={query} onClose={() => setOpen(false)} />}
    </>
  );
}

function ResearchDialog({ initialQuery, onClose }: { initialQuery: string; onClose: () => void }) {
  const api = hostBridge()!.research;
  const [query, setQuery] = useState(initialQuery);
  const [quota, setQuota] = useState<ResearchQuota | null>(null);
  const [records, setRecords] = useState<ResearchRecords | null>(null);
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"search" | "records">("search");
  const alive = useRef(true);
  const polling = useRef(false);
  const activeJob = useRef<ResearchJob | null>(null);
  activeJob.current = job;
  const refresh = useCallback(async () => {
    const [q, r] = await Promise.all([api.quota(), api.records()]);
    if (alive.current) {
      setQuota(q);
      setRecords(r);
    }
    return q;
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void refresh()
      .then(async (q) => {
        if (q.pendingJobId) {
          const value = await api.status(q.pendingJobId);
          if (alive.current) setJob(value);
        }
      })
      .catch((failure) => {
        if (alive.current) setError(failure.message);
      });
    return () => {
      alive.current = false;
      const current = activeJob.current;
      if (current && ["queued", "searching"].includes(current.state)) void api.cancel(current.id);
    };
  }, [api, refresh]);
  const jobId = job?.id;
  const jobState = job?.state;
  useEffect(() => {
    if (!jobId || !jobState || !["queued", "searching", "awaiting_payment"].includes(jobState))
      return;
    const id = jobId;
    const timer = setInterval(
      async () => {
        if (polling.current) return;
        polling.current = true;
        try {
          const value = await api.status(id);
          if (alive.current && activeJob.current?.id === id) {
            setJob(value);
            if (!["queued", "searching", "awaiting_payment"].includes(value.state)) await refresh();
          }
        } catch (failure) {
          if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          polling.current = false;
        }
      },
      jobState === "awaiting_payment" ? 5000 : 1000,
    );
    return () => clearInterval(timer);
  }, [api, jobId, jobState, refresh]);
  const task = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const active = job && ["queued", "searching"].includes(job.state);
  return (
    <EditorDialog title={t("Exa 联网检索")} onClose={onClose}>
      <div className="research-dialog-body">
        {quota && (
          <div className="research-wallet" aria-label={t("检索额度")}>
            <div>
              <span>{t("免费剩余")}</span>
              <strong>
                {quota.freeRemaining}
                <small>/ {quota.freeLimit}</small>
              </strong>
              <p>{t("累计已用 {0} 次", quota.freeUsed)}</p>
              {Boolean(quota.freeReserved) && (
                <p>{t("进行中的请求预留 {0} 次", quota.freeReserved ?? 0)}</p>
              )}
            </div>
            <div>
              <span>{t("已购剩余")}</span>
              <strong>{quota.paidRemaining}</strong>
              <p>{t("累计购买 {0} 次，已用 {1} 次", quota.paidTotal, quota.paidUsed)}</p>
            </div>
          </div>
        )}
        <div className="research-tabs">
          <Button
            type="button"
            size="sm"
            variant={tab === "search" ? "outline" : "ghost"}
            onClick={() => setTab("search")}
          >
            {t("检索与进度")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tab === "records" ? "outline" : "ghost"}
            onClick={() => setTab("records")}
          >
            {t("购买与消耗记录")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("刷新检索额度")}
            disabled={busy}
            onClick={() =>
              void task(async () => {
                await refresh();
              })
            }
          >
            <RefreshCw />
          </Button>
        </div>
        {tab === "search" ? (
          <>
            <p className="research-help">
              {t("仅发送你确认的公开问题，不自动上传资产凭据或文档正文。失败与取消不扣检索次数。")}
            </p>
            <Textarea
              aria-label={t("联网检索问题")}
              value={query}
              maxLength={600}
              disabled={Boolean(active) || busy}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("例如：某服务商的官方套餐与使用限制")}
            />
            <div className="research-actions">
              <Button
                type="button"
                disabled={
                  !quota ||
                  !query.trim() ||
                  busy ||
                  Boolean(active) ||
                  job?.state === "awaiting_payment"
                }
                onClick={() =>
                  void task(async () => {
                    const value = await api.start({
                      requestId: `search_${randomId()}`,
                      query: query.trim(),
                    });
                    if (alive.current) setJob(value);
                    await refresh();
                  })
                }
              >
                <Globe2 />
                {t("开始检索")}
              </Button>
              {active && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void task(async () => {
                      await api.cancel(job.id);
                    })
                  }
                >
                  <Square />
                  {t("取消检索")}
                </Button>
              )}
            </div>
            {job && <TaskProgress items={job.items} />}
            {job?.state === "awaiting_payment" && (
              <div className="research-payment">
                <p>
                  {t(
                    "本次结果已准备。购买后先到账 100 次，再使用 1 次解锁此结果；后续失败不扣已购次数。",
                  )}
                </p>
                {(!quota?.purchaseGuardConfigured || quota.exaStatus === "exhausted") && (
                  <p role="status">{t("Exa 可售余额尚未核实或额度不足，积分购买已暂停。")}</p>
                )}
                <Button
                  type="button"
                  disabled={
                    busy ||
                    !quota?.purchaseGuardConfigured ||
                    !quota.paymentConfigured ||
                    quota.exaStatus === "exhausted"
                  }
                  onClick={() =>
                    void task(async () => {
                      const value = await api.checkout(job.id);
                      if (alive.current) setJob(value);
                      if (value.paymentUrl) await openExternal(value.paymentUrl);
                    })
                  }
                >
                  {t("10 LDC 购买 100 次")}
                </Button>
                {job.paymentUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        const value = await api.status(job.id);
                        if (alive.current) setJob(value);
                        await refresh();
                      })
                    }
                  >
                    {t("我已完成积分支付，刷新")}
                  </Button>
                )}
              </div>
            )}
            {job?.results && (
              <ol className="research-results">
                {job.results.map((result, index) => (
                  <li key={result.url}>
                    <span className="research-result-index">{index + 1}</span>
                    <div>
                      <button type="button" onClick={() => void openExternal(result.url)}>
                        {result.title}
                        <ExternalLink aria-hidden="true" />
                      </button>
                      <small>
                        {new URL(result.url).hostname}
                        {result.publishedDate ? ` · ${result.publishedDate.slice(0, 10)}` : ""}
                      </small>
                      {result.highlights.map((text, i) => (
                        <p key={i}>{text}</p>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <div className="research-ledger">
            {!records?.entries.length && <p>{t("还没有购买或消耗记录。")}</p>}
            {records?.entries.map((entry) => (
              <article key={entry.id}>
                <div>
                  <b>
                    {entry.kind === "purchase"
                      ? t("购买 {0} 次检索", entry.units ?? 0)
                      : entry.query}
                  </b>
                  <time>{new Date(entry.createdAt).toLocaleString()}</time>
                </div>
                <p>
                  {entry.kind === "purchase"
                    ? `${entry.amount} LDC`
                    : entry.consumed
                      ? t("消耗 1 次{0}额度", t(entry.source === "free" ? "免费" : "已购"))
                      : t("未消耗次数")}{" "}
                  ·{" "}
                  {t(
                    (
                      {
                        complete: "已完成",
                        paid: "已到账",
                        pending: "等待积分支付",
                        creating: "订单创建中",
                        unknown: "订单状态待核实",
                        searching: "检索中",
                        queued: "等待检索",
                        failed: "失败",
                        cancelled: "已取消",
                        interrupted: "服务重启已中断",
                        awaiting_payment: "等待购买额度",
                      } as Record<string, string>
                    )[entry.state] || entry.state,
                  )}
                </p>
                {entry.tradeNo && <small>{t("订单号：{0}", entry.tradeNo)}</small>}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void task(async () => {
                      const value = await api.status(entry.jobId);
                      if (alive.current) {
                        setJob(value);
                        setTab("search");
                        setQuery(value.query);
                      }
                    })
                  }
                >
                  {t("查看本次检索")}
                </Button>
              </article>
            ))}
            {records?.nextOffset != null && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    const next = await api.records(records.nextOffset!);
                    if (alive.current)
                      setRecords((previous) => ({
                        entries: [...(previous?.entries ?? []), ...next.entries],
                        nextOffset: next.nextOffset,
                      }));
                  })
                }
              >
                {t("加载更多记录")}
              </Button>
            )}
          </div>
        )}
        {error && (
          <p className="research-error" role="alert">
            {error}
          </p>
        )}
        {!quota &&
          /联网检索需要先在个人资料中使用 Linux\.do 登录|登录状态已过期|登录状态已失效/.test(
            error,
          ) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onClose();
                useAppStore.getState().openSettingsPage("profile");
              }}
            >
              {t("前往个人资料检查 Linux.do 登录")}
            </Button>
          )}
        {!quota && /联网检索服务尚未升级或配置|联网检索尚未启用/.test(error) && (
          <p className="research-help">
            {t(
              "这是站点服务配置问题，无需重新登录。维护者需升级登录服务并配置 Exa；配置完成后点击刷新检索额度。",
            )}
          </p>
        )}
      </div>
    </EditorDialog>
  );
}
