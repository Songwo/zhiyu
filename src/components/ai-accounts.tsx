import { isWeb } from "@/lib/web";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Trash2, Lock, Plus, Check, Loader2, Copy } from "lucide-react";
import { desktop } from "@/lib/desktop";
import { AI_PROVIDER_NAMES, type AiAccount, type AiProvider } from "@/lib/ai-accounts";
import { useVault } from "@/lib/vault-state";
import { useAppStore } from "@/lib/store";
import { t } from "@/lib/i18n";
import { barTone } from "@/lib/status";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";

const date = (value: string | null) => (value ? new Date(value).toLocaleString() : t("未提供"));
const labels: Record<string, string> = {
  primary_window: "主要额度",
  secondary_window: "次要额度",
  five_hour: "5 小时",
  seven_day: "7 天",
  seven_day_sonnet: "Sonnet / 7 天",
  weekly: "本周",
  code_review: "代码审查",
  monthly: "月度账单",
  on_demand: "按量付费",
  prepaid: "预付余额",
  credits: "积分",
};
const quotaLabel = (label: string) =>
  label
    .split("/")
    .map((part) => t(labels[part] ?? part))
    .join(" / ");
const services: Record<AiProvider, { scope: string; boundary: string; url: string }> = {
  openai: {
    scope: "Codex 额度",
    boundary: "此授权读取 Codex 额度，不包含 ChatGPT 网页聊天的全部限额或 API 余额。",
    url: "https://chatgpt.com/",
  },
  claude: {
    scope: "Claude OAuth 额度",
    boundary: "此授权读取 Claude OAuth 返回的共享与模型额度，不包含网页的全部权益或 API 余额。",
    url: "https://claude.ai/settings/usage",
  },
  grok: {
    scope: "Grok CLI 额度",
    boundary: "此授权读取 Grok CLI 积分与产品额度，不代表 Grok 网页订阅的全部权益。",
    url: "https://grok.com/",
  },
  gemini: {
    scope: "Gemini Code Assist 额度",
    boundary:
      "此授权读取 Gemini Code Assist 模型额度，不代表 Gemini 网页或 Google One 套餐的全部权益。",
    url: "https://gemini.google.com/",
  },
};

function QuotaDetails({ account }: { account: AiAccount }) {
  const service = services[account.provider];
  const usage = account.usage;
  const stale = usage?.status === "stale" || account.usageRefresh?.status === "error";
  const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-meta text-ok">
        <Check className="size-4 shrink-0" />
        {t("本机已保存授权")}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-meta">
        <div>
          <dt className="text-muted">{t("授权返回的套餐")}</dt>
          <dd className="mt-1 break-words font-medium">{account.plan || t("服务商未返回")}</dd>
        </div>
        <div>
          <dt className="text-muted">{t("额度来源")}</dt>
          <dd className="mt-1 font-medium">{t(service.scope)}</dd>
        </div>
        {account.subscriptionExpiresAt && (
          <div>
            <dt className="text-muted">{t("订阅到期")}</dt>
            <dd>{date(account.subscriptionExpiresAt)}</dd>
          </div>
        )}
      </dl>
      {stale && (
        <p role="status" className="text-meta text-warn">
          {t(usage ? "额度更新未完成，部分数据不是最新。" : "额度同步失败，尚无用量数据。")}
        </p>
      )}
      {account.usageRefresh?.errorCode === "FORBIDDEN" && (
        <p className="text-meta leading-relaxed text-muted">
          {t("额度请求被拒绝不表示缺少登录回调；仅凭 HTTP 403 无法确定服务商拒绝的原因。")}
        </p>
      )}
      {account.usageRefresh?.status === "error" && (
        <p className="break-words text-meta text-crit">{account.usageRefresh.message}</p>
      )}
      {!usage?.windows.length && (
        <p className="text-meta leading-relaxed text-muted">
          {usage?.unavailableReason ||
            (account.usageRefresh?.status === "error"
              ? t("暂时无法读取额度")
              : t("服务商尚未返回可读取的额度"))}
        </p>
      )}
      <div className="divide-y divide-line">
        {usage?.windows.map((item, i) => {
          const percent =
            typeof item.usedPercent === "number" && Number.isFinite(item.usedPercent)
              ? item.usedPercent
              : null;
          return (
            <div key={item.label + ":" + i} className="space-y-2 py-3">
              <div className="flex items-start justify-between gap-3 text-meta">
                <span className="min-w-0 break-words font-medium">
                  {quotaLabel(item.label)}
                  {item.stale && (
                    <small className="ml-2 font-normal text-warn">{t("上次数据")}</small>
                  )}
                </span>
                {percent !== null && (
                  <span className="shrink-0 tabular-nums">{number(percent)}%</span>
                )}
              </div>
              {percent !== null && (
                <div
                  role="progressbar"
                  aria-label={item.label}
                  aria-valuenow={Math.max(0, Math.min(100, percent))}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className={`metric-bar ${barTone(percent) === "ok" ? "" : barTone(percent)}`}
                >
                  <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
                </div>
              )}
              {(item.used !== undefined ||
                item.limit !== undefined ||
                item.remaining !== undefined) && (
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-meta tabular-nums">
                  {item.used !== undefined && (
                    <div>
                      <dt className="inline text-muted">{t("已用")}: </dt>
                      <dd className="inline">
                        {number(item.used)} {item.unit || ""}
                      </dd>
                    </div>
                  )}
                  {item.limit !== undefined && (
                    <div>
                      <dt className="inline text-muted">{t("总额度")}: </dt>
                      <dd className="inline">
                        {number(item.limit)} {item.unit || ""}
                      </dd>
                    </div>
                  )}
                  {item.remaining !== undefined && (
                    <div>
                      <dt className="inline text-muted">{t("剩余")}: </dt>
                      <dd className="inline">
                        {number(item.remaining)} {item.unit || ""}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted">
                {item.model && <span>{item.model}</span>}
                {item.windowSeconds && (
                  <span>
                    {t("统计窗口")}: {number(item.windowSeconds / 3600)} {t("小时")}
                  </span>
                )}
                {item.resetsAt && (
                  <span>
                    {t("额度重置")}: {date(item.resetsAt)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted">
        <span>{usage ? `${t("查询时间")}: ${date(usage.checkedAt)}` : t("尚无成功查询")}</span>
        <Button
          type="button"
          variant="outline"
          onClick={() => void desktop()?.openExternal(service.url)}
        >
          <ExternalLink className="size-4" />
          {t("查看官网权益")}
        </Button>
      </div>
      <details className="border-t border-line pt-2 text-2xs text-muted">
        <summary className="cursor-pointer py-1">{t("授权详情")}</summary>
        <dl className="space-y-1 pt-2">
          <div>
            {t("令牌有效期")}: {date(account.tokenExpiresAt)}
          </div>
          <div>
            {t("自动刷新令牌")}: {t(account.refreshable ? "支持" : "不支持")}
          </div>
          {account.usageRefresh && (
            <div>
              {t("最近尝试")}: {date(account.usageRefresh.attemptedAt)}
            </div>
          )}
        </dl>
      </details>
    </div>
  );
}

export function AiAccountsPanel({
  standalone = false,
  assetId,
  linkedAccountId,
  initialProvider = "openai",
}: {
  standalone?: boolean;
  assetId?: string;
  linkedAccountId?: string;
  initialProvider?: AiProvider;
}) {
  const api = desktop()?.aiAccounts;
  const unlocked = useVault((s) => s.unlocked);
  const subscriptions = useAppStore((s) => s.aiAssets);
  const [provider, setProvider] = useState<AiProvider>(initialProvider);
  const [accounts, setAccounts] = useState<AiAccount[]>([]);
  const [session, setSession] = useState<{
    id: string;
    mode: string;
    redirectUri?: string;
    manualCallback?: boolean;
  } | null>(null);
  const currentSession = useRef<string | null>(null);
  const alive = useRef(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [phase, setPhase] = useState<"pending" | "exchanging" | "syncing">("pending");
  const loadAccounts = useCallback(async () => {
    const rows = await api!.list();
    if (!alive.current) return;
    setAccounts(rows);
    const store = useAppStore.getState();
    for (const row of rows)
      if (store.aiAssets.some((item) => item.oauthAccountId === row.id)) store.syncAiAccount(row);
  }, [api]);
  const task = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (currentSession.current) void api?.cancel(currentSession.current).catch(() => {});
    };
  }, [api]);
  useEffect(() => {
    if (!api || !unlocked) {
      setAccounts([]);
      return;
    }
    let active = true;
    void api
      .list()
      .then((rows) => {
        if (!active) return;
        setAccounts(rows);
        const store = useAppStore.getState();
        // 已关联的订阅刷新缓存；不因查看设置而重新添加用户删除的订阅。
        for (const row of rows)
          if (store.aiAssets.some((item) => item.oauthAccountId === row.id))
            store.syncAiAccount(row);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [api, unlocked]);
  useEffect(() => {
    if (!api || !session) return;
    let stopped = false;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        try {
          const result = await api.status(session.id);
          if (stopped) return;
          if (result.status === "pending" || result.status === "exchanging") {
            setPhase(result.status);
            return;
          }
          window.clearInterval(timer);
          currentSession.current = null;
          if (result.status !== "connected")
            throw new Error(result.error || t("授权已取消或超时，请重试。"));
          setPhase("syncing");
          setCode("");
          setBusy(true);
          const rows = await api.list();
          if (stopped) return;
          const account = rows.find((row) => row.id === result.accountId);
          if (!account) throw new Error(t("未找到授权账号，请重新登录。"));
          useAppStore.getState().syncAiAccount(account, assetId);
          setAccounts(rows);
          setNotice(t("已添加到 AI 订阅"));
          // 先关联账号，额度接口失败不丢失已经成功的授权。
          try {
            const updated = await api.refresh(account.id);
            if (stopped) return;
            useAppStore.getState().syncAiAccount(updated);
            setAccounts((items) => items.map((item) => (item.id === updated.id ? updated : item)));
          } catch (err) {
            if (!stopped) {
              await loadAccounts();
              setError(
                t(
                  "账号已保存，暂未取得用量：{0}",
                  err instanceof Error ? err.message : String(err),
                ),
              );
            }
          }
        } catch (err) {
          if (!stopped) {
            setError(err instanceof Error ? err.message : String(err));
            window.clearInterval(timer);
            if (currentSession.current) void api.cancel(currentSession.current).catch(() => {});
            currentSession.current = null;
          }
        } finally {
          checking = false;
          if (!stopped && currentSession.current === null) {
            setSession(null);
            setCode("");
            setBusy(false);
          }
        }
      })();
    }, 700);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [api, session, assetId, loadAccounts]);

  const displayed = accounts.filter(
    (account) => !linkedAccountId || account.id === linkedAccountId,
  );
  return (
    <section className={standalone ? "space-y-3" : "border-t border-line pt-4"}>
      {!standalone && <h4 className="mb-3 font-semibold">{t("AI 服务账号")}</h4>}
      <Field label={t("授权服务商")}>
        <Select
          aria-label={t("授权服务商")}
          value={provider}
          disabled={busy || Boolean(session) || Boolean(linkedAccountId)}
          onValueChange={(value) => {
            setProvider(value as AiProvider);
            setError("");
            setNotice("");
          }}
          options={Object.entries(AI_PROVIDER_NAMES).map(([id, name]) => ({
            value: id,
            label: name,
            description: t(services[id as AiProvider].scope),
          }))}
        />
      </Field>
      <p className="mt-2 text-meta leading-relaxed text-muted">{t(services[provider].boundary)}</p>
      <div className="my-3 flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!api || busy || Boolean(session)}
          onClick={() =>
            void task(async () => {
              if (
                !api ||
                !(await useVault.getState().require(t("登录 AI 账号需要先解锁密钥库。"))) ||
                !alive.current
              )
                return;
              const value = await api.start(provider);
              if (!alive.current) {
                await api.cancel(value.id);
                return;
              }
              currentSession.current = value.id;
              setCode("");
              setPhase("pending");
              setSession(value);
            })
          }
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : !unlocked ? (
            <Lock className="size-4" />
          ) : (
            <ExternalLink className="size-4" />
          )}
          {t(linkedAccountId ? "重新授权" : "网页登录授权")}
        </Button>
        {session && (
          <Button
            type="button"
            variant="outline"
            disabled={phase === "syncing"}
            onClick={() =>
              void task(async () => {
                await api!.cancel(session.id);
                currentSession.current = null;
                setSession(null);
                setCode("");
              })
            }
          >
            {t("取消授权")}
          </Button>
        )}
      </div>
      {!session && displayed.length > 0 && (
        <p className="mb-3 text-meta text-muted">{t("当前没有进行中的登录授权。")}</p>
      )}
      {!api && (
        <p className="text-meta text-muted">
          {isWeb()
            ? t(
                "AI 账号的网页登录要在桌面版弹出的独立登录窗口里完成，网页版无法代为登录；可以改用「用量记录」里的 API 用量来源。",
              )
            : t("网页登录需要桌面版")}
        </p>
      )}
      {session && (
        <div className="mb-3 space-y-2">
          <p role="status" className="flex items-center gap-2 text-meta text-muted">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            {t(
              phase === "syncing"
                ? "登录回调已处理，正在同步额度…"
                : phase === "exchanging"
                  ? "已收到回调，正在验证授权…"
                  : session.mode === "code" || session.manualCallback
                    ? "等待填写授权结果"
                    : "等待浏览器授权返回…",
            )}
          </p>
          {phase === "pending" && session.redirectUri && (
            <div className="flex min-w-0 items-center gap-2 text-meta text-muted">
              <span className="shrink-0">{t("回调地址")}</span>
              <code className="min-w-0 flex-1 break-all text-2xs">{session.redirectUri}</code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("复制回调地址")}
                title={t("复制回调地址")}
                onClick={() =>
                  void task(async () => {
                    await navigator.clipboard.writeText(session.redirectUri!);
                    setNotice(t("已复制"));
                  })
                }
              >
                <Copy className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}
      {session && phase !== "syncing" && (
        <form
          className="mb-4 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || phase !== "pending") return;
            void task(async () => {
              setPhase("exchanging");
              try {
                await api!.finish(session.id, code);
                setCode("");
              } catch (err) {
                if (alive.current) setPhase("pending");
                throw err;
              }
            });
          }}
        >
          <Field label={t("回调链接或授权码")}>
            <Input
              aria-label={t("回调链接或授权码")}
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={busy || phase !== "pending"}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy || phase !== "pending" || !code.trim()}>
            {t("完成授权")}
          </Button>
        </form>
      )}
      {notice && (
        <p role="status" className="my-3 text-meta text-ok">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="my-3 break-words text-meta text-crit">
          {error}
        </p>
      )}
      <ul className="divide-y divide-line">
        {displayed.map((account) => {
          const linked = subscriptions.some(
            (item) => item.oauthAccountId === account.id && !item.oauthDisconnected,
          );
          return (
            <li key={account.id} className="space-y-2 py-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <strong className="block break-words text-meta">
                    {AI_PROVIDER_NAMES[account.provider]}
                  </strong>
                  <span className="block break-all text-meta text-muted">
                    {account.email || account.accountId}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title={t("刷新用量")}
                  aria-label={t("刷新用量")}
                  disabled={busy || Boolean(session)}
                  onClick={() =>
                    void task(async () => {
                      let updated: AiAccount;
                      try {
                        updated = await api!.refresh(account.id);
                      } catch (err) {
                        await loadAccounts();
                        throw err;
                      }
                      if (!alive.current) return;
                      setAccounts((rows) =>
                        rows.map((row) => (row.id === updated.id ? updated : row)),
                      );
                      if (
                        useAppStore
                          .getState()
                          .aiAssets.some((item) => item.oauthAccountId === updated.id)
                      )
                        useAppStore.getState().syncAiAccount(updated);
                    })
                  }
                >
                  <RefreshCw className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title={t("断开账号")}
                  aria-label={t("断开账号")}
                  disabled={busy || Boolean(session)}
                  onClick={() => {
                    if (window.confirm(t("删除本机授权令牌？服务器授权需要在服务商账号中撤销。")))
                      void task(async () => {
                        await api!.remove(account.id);
                        useAppStore.getState().disconnectAiAccount(account.id);
                        const rows = await api!.list();
                        if (alive.current) setAccounts(rows);
                      });
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              {linked ? (
                <p className="flex items-center gap-1 text-2xs text-ok">
                  <Check className="size-3.5" />
                  {t("已关联订阅")}
                </p>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || Boolean(session)}
                  onClick={() => {
                    useAppStore.getState().syncAiAccount(account, assetId);
                    setNotice(t("已添加到 AI 订阅"));
                  }}
                >
                  <Plus className="size-4" />
                  {t("添加到订阅")}
                </Button>
              )}
              <QuotaDetails account={account} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
