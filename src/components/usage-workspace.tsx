import { usageFormFromDraft, usageFormFromSource } from "@/lib/usage-setup.mjs";
import { saveAndVerifyUsageSource } from "@/lib/usage-connect.mjs";
import { latestSubscriptionRecord } from "@/lib/usage-insights.mjs";
import { t } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, Activity, Pencil, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { useAppStore } from "@/lib/store";
import { useVault } from "@/lib/vault-state";
import {
  type UsageState,
  type UsageSource,
  type UsageRecord,
  type LocalUsageStatus,
  usageBytes,
} from "@/lib/usage";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import { EditorDialog } from "./ui/editor-dialog";
import { UsageInsights } from "./usage-insights";
import { LocalUsageControl } from "./local-usage-control";
import { SubscriptionSourceCard } from "./subscription-source-card";
import { usageCache } from "@/lib/usage-cache";
import "./usage-management.css";

const names: Record<string, string> = {
  "3x-ui": "3x-ui 面板",
  subscription: "机场订阅",
  "openai-api": "OpenAI API",
  "anthropic-api": "Anthropic API",
  oauth: "订阅账号",
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
function amount(row: UsageRecord) {
  if (row.kind === "traffic") return `↑ ${usageBytes(row.upload)} / ↓ ${usageBytes(row.download)}`;
  if (row.kind === "tokens")
    return `${t("输入")} ${(row.input ?? 0).toLocaleString()} / ${t("输出")} ${(row.output ?? 0).toLocaleString()}`;
  return row.usedPercent == null
    ? t("未提供百分比")
    : `${row.usedPercent.toFixed(1)}% ${t("已用")}`;
}

export function UsageWorkspace() {
  const [data, setData] = useState<UsageState>(
    () => usageCache.peek()?.data ?? { sources: [], records: [] },
  );
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"overview" | "sources">("overview");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UsageSource | null>(null);
  const [removing, setRemoving] = useState<UsageSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [sourceErrors, setSourceErrors] = useState<
    Record<string, { message: string; checkedAt?: string }>
  >({});
  const [focusSource, setFocusSource] = useState("");
  const [localStatus, setLocalStatus] = useState<LocalUsageStatus | null>(
    () => usageCache.peek()?.status ?? null,
  );
  const [localHistoryRequest, setLocalHistoryRequest] = useState(0);
  const [form, setForm] = useState(() => usageFormFromDraft(null));
  const setup = useAppStore((state) => state.usageSetupDraft);
  const servers = useAppStore((state) => state.servers);
  const nodes = servers.flatMap((server) =>
    (server.nodes ?? []).map((node) => ({
      value: `${server.id}:${node.id}`,
      label: `${server.name} / ${node.name}`,
    })),
  );

  useEffect(() => {
    if (!setup) return;
    setForm(usageFormFromDraft(setup));
    setEditing(null);
    setFormError("");
    setError("");
    setAdding(true);
    useAppStore.getState().clearUsageSetup();
  }, [setup]);
  const load = useCallback(async (force = true) => {
    if (!desktop()?.usage) return;
    const { data: usage, status } = await usageCache.read(force);
    setData(usage);
    setLocalStatus(status);
    setSourceErrors((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id, failure]) => {
          const source = usage.sources.find((item) => item.id === id);
          return source && source.checkedAt === failure.checkedAt;
        }),
      ),
    );
    setError("");
  }, []);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible")
        void load(false).catch((cause) => setError(errorText(cause)));
    };
    const resume = () => {
      // 唤醒只重读主进程快照，不触发网络采集。
      if (document.visibilityState === "visible")
        void load(true).catch((cause) => setError(errorText(cause)));
    };
    const unsubscribe = usageCache.subscribe((recordsChanged) => {
      const snapshot = usageCache.peek();
      if (!recordsChanged && snapshot) setLocalStatus(snapshot.status);
      else update();
    });
    update();
    const timer = setInterval(update, desktop()?.usage.onChanged ? 60000 : 10000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [load]);
  useEffect(() => {
    if (!focusSource || tab !== "sources") return;
    const timer = requestAnimationFrame(() => {
      const card = document.getElementById(`usage-source-${focusSource}`);
      card?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "nearest",
      });
      card?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(timer);
  }, [focusSource, tab, adding]);

  const latest = new Map<string, UsageRecord>();
  for (const row of data.records) {
    const key = `${row.sourceId}:${row.key}`;
    if (!latest.has(key) || latest.get(key)!.checkedAt < row.checkedAt) latest.set(key, row);
  }
  const sources = data.sources.filter((source) => !source.type.startsWith("local-"));
  function openAdd() {
    setForm(usageFormFromDraft(null));
    setEditing(null);
    setFormError("");
    setError("");
    setFocusSource("");
    setAdding(true);
  }
  function openEdit(source: UsageSource) {
    setForm(usageFormFromSource(source));
    setEditing(source);
    setFormError("");
    setFocusSource("");
    setAdding(true);
  }
  function closeEditor() {
    if (busy) return;
    setAdding(false);
    setEditing(null);
    setFormError("");
    setForm(usageFormFromDraft(null));
  }
  async function refresh(id?: string) {
    setBusy(true);
    try {
      const api = desktop()?.usage;
      if (!api) return;
      if (
        (!id || !id.startsWith("oauth:")) &&
        !(await useVault.getState().require(t("管理远程用量来源需要先解锁密钥库。")))
      )
        return;
      if (id) {
        if (id.startsWith("oauth:")) await desktop()!.aiAccounts.refresh(id.slice(6));
        else await api.refresh(id);
        setSourceErrors((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      } else {
        if (localStatus?.enabled && !localStatus.paused) await api.refreshLocal();
        const result = await api.refreshAll();
        setSourceErrors({});
        if (result.failures.length) toast.error(result.failures.join("；"));
      }
      await load();
    } catch (cause) {
      const message = errorText(cause);
      if (id)
        setSourceErrors((previous) => ({
          ...previous,
          [id]: { message, checkedAt: data.sources.find((source) => source.id === id)?.checkedAt },
        }));
      else setError(message);
      await load().catch((loadError) => setError(errorText(loadError)));
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      if (!(await useVault.getState().require(t("管理远程用量来源需要先解锁密钥库。")))) return;
      const input = { ...form };
      if (editing) {
        delete input.inboundId;
        delete input.clientEmail;
      }
      const result = await saveAndVerifyUsageSource(desktop()!.usage, input, editing?.id);
      setSourceErrors((previous) => {
        const next = { ...previous };
        if (result.error)
          next[result.source.id] = { message: result.error, checkedAt: result.source.checkedAt };
        else delete next[result.source.id];
        return next;
      });
      // 保存成功后立即放入公开来源列表，即使后续快照读取失败也能编辑重试。
      setData((previous) => ({
        ...previous,
        sources: [
          ...previous.sources.filter((source) => source.id !== result.source.id),
          result.source,
        ],
      }));
      setAdding(false);
      setEditing(null);
      setForm(usageFormFromDraft(null));
      setTab("sources");
      setFocusSource(result.source.id);
      if (result.verified) toast.success(t("已连接并完成首次采集"));
      else toast.error(t("来源已保存，可在卡片中编辑或重试"));
      await load().catch((cause) => setError(errorText(cause)));
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      if (!(await useVault.getState().require(t("管理远程用量来源需要先解锁密钥库。")))) return;
      await desktop()!.usage.remove(removing.id);
      setData((previous) => ({
        ...previous,
        sources: previous.sources.filter((source) => source.id !== removing.id),
      }));
      setRemoving(null);
      toast.success(t("来源已移除，历史用量已保留"));
      await load();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!desktop())
    return (
      <div className="px-4 pb-8 pt-1">
        <p className="text-sm text-muted">
          {t("请在桌面端配置采集来源。凭据保存在本机加密密钥库中，网页预览不读取账号。")}
        </p>
      </div>
    );

  return (
    <div className="usage-workspace space-y-6 px-4 pb-8 pt-1">
      <div className="flex flex-wrap items-start justify-end gap-4">
        <div className="flex flex-wrap gap-2">
          <LocalUsageControl
            status={localStatus}
            onChange={load}
            onViewHistory={() => {
              setTab("overview");
              setLocalHistoryRequest((value) => value + 1);
            }}
          />
          <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw className={busy ? "animate-spin" : ""} />
            {t("刷新全部")}
          </Button>
          <Button disabled={busy} onClick={openAdd}>
            <Plus />
            {t("连接用量来源")}
          </Button>
        </div>
      </div>
      <div className="usage-workspace-tabs" role="tablist" aria-label={t("用量工作区")}>
        {(
          [
            { value: "overview", label: "用量概览", icon: Activity },
            { value: "sources", label: "订阅与来源", icon: Settings2 },
          ] as const
        ).map((item, index, items) => (
          <button
            key={item.value}
            id={`usage-tab-${item.value}`}
            role="tab"
            type="button"
            aria-selected={tab === item.value}
            aria-controls={`usage-panel-${item.value}`}
            tabIndex={tab === item.value ? 0 : -1}
            onClick={() => setTab(item.value)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
              setTab(items[next].value);
              document.getElementById(`usage-tab-${items[next].value}`)?.focus();
            }}
          >
            <item.icon className="size-4" />
            {t(item.label)}
            {item.value === "sources" && <span>{sources.length}</span>}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-crit">
          {error}
        </p>
      )}
      <div
        id="usage-panel-overview"
        role="tabpanel"
        aria-labelledby="usage-tab-overview"
        hidden={tab !== "overview"}
      >
        <UsageInsights
          data={data}
          localHistoryRequest={localHistoryRequest}
          active={tab === "overview"}
        />
      </div>
      <div
        id="usage-panel-sources"
        role="tabpanel"
        aria-labelledby="usage-tab-sources"
        hidden={tab !== "sources"}
      >
        <div className="usage-sources-heading">
          <div>
            <h3>{t("已连接的采集来源")}</h3>
            <p>{t("API 和订阅每 5 分钟更新。展开节点仅查看已缓存详情，不触发订阅请求。")}</p>
          </div>
        </div>
        <div className="usage-source-grid">
          {sources.map((source) => {
            const rows = [...latest.values()]
              .filter((row) => row.sourceId === source.id)
              .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
            const nodeName = source.nodeId
              ? (nodes.find((node) => node.value === source.nodeId)?.label ?? t("节点已移除"))
              : undefined;
            const sourceError = source.error || sourceErrors[source.id]?.message;
            if (source.type === "subscription")
              return (
                <SubscriptionSourceCard
                  key={source.id}
                  source={source}
                  row={latestSubscriptionRecord(data.records, source)}
                  nodeName={nodeName}
                  error={sourceError}
                  busy={busy}
                  highlighted={focusSource === source.id}
                  onRefresh={() => void refresh(source.id)}
                  onEdit={() => openEdit(source)}
                  onRemove={() => setRemoving(source)}
                />
              );
            return (
              <section
                className="usage-source-card"
                tabIndex={-1}
                id={`usage-source-${source.id}`}
                data-highlighted={focusSource === source.id || undefined}
                key={source.id}
              >
                <div className="usage-source-heading">
                  <div className="min-w-0">
                    <h3>{source.name}</h3>
                    <p>
                      {t(names[source.type] ?? source.type)} ·{" "}
                      {sourceError
                        ? t("连接需要处理")
                        : source.checkedAt
                          ? t("已连接")
                          : t("已保存，尚未连接")}
                    </p>
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
                      onClick={() => void refresh(source.id)}
                    >
                      <RefreshCw />
                    </Button>
                    {source.type !== "oauth" && (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`${t("编辑")} ${source.name}`}
                          disabled={busy}
                          onClick={() => openEdit(source)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="danger-ghost"
                          aria-label={`${t("移除")} ${source.name}`}
                          disabled={busy}
                          onClick={() => setRemoving(source)}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {sourceError && (
                  <p role="alert" className="usage-source-error">
                    {t(
                      rows.length ? "采集失败，保留上次有效数据" : "采集失败，请编辑连接信息或重试",
                    )}
                    ：{sourceError}
                  </p>
                )}
                <div className="mt-4 space-y-3">
                  {rows.slice(0, 4).map((row) => (
                    <div key={row.key} className="text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="truncate text-muted">
                          {row.kind === "tokens" ? row.bucketStart?.slice(0, 10) : row.label}
                        </span>
                        <span className="text-right tabular-nums">{amount(row)}</span>
                      </div>
                      {row.kind === "traffic" && (
                        <p className="mt-1 text-xs text-muted">
                          {t("总额度")}：{row.total === 0 ? t("不限额") : usageBytes(row.total)} ·{" "}
                          {t("到期时间")}：
                          {row.expiresAt
                            ? new Date(row.expiresAt).toLocaleDateString()
                            : t("未提供")}
                          {row.counterReset ? ` · ${t("累计计数重置，未跨周期计算增量")}` : ""}
                        </p>
                      )}
                      {row.kind === "quota" && (
                        <p className="mt-1 text-xs text-muted">
                          {t("统计范围")}：{row.scope} · {t("下次重置")}：
                          {row.resetsAt ? new Date(row.resetsAt).toLocaleString() : t("未提供")}
                        </p>
                      )}
                    </div>
                  ))}
                  {!rows.length && (
                    <p className="text-sm text-muted">
                      {t("尚无有效用量记录，点击刷新开始采集。")}
                    </p>
                  )}
                </div>
                <div className="usage-source-footer">
                  <span>
                    {t("最后采集")}：
                    {source.checkedAt ? new Date(source.checkedAt).toLocaleString() : t("尚未采集")}
                  </span>
                  {source.type === "oauth" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => useAppStore.getState().setView("ai")}
                    >
                      {t("管理 AI 账号")}
                    </Button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
        {!sources.length && (
          <div className="usage-sources-empty">
            <Activity className="size-8 text-muted" />
            <h3>{t("添加第一个用量来源")}</h3>
            <p>{t("连接机场订阅、3x-ui 面板或组织 API，保留每次采集记录。")}</p>
            <Button variant="outline" onClick={openAdd}>
              <Plus />
              {t("连接用量来源")}
            </Button>
          </div>
        )}
        <div className="usage-account-link">
          <div>
            <strong>{t("ChatGPT / Codex · Claude 订阅账号")}</strong>
            <p>{t("在「AI 订阅」中授权账号，额度历史自动记录。订阅额度与 API Token 分别统计。")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => useAppStore.getState().setView("ai")}>
            {t("管理 AI 账号")}
          </Button>
        </div>
      </div>
      {adding && (
        <EditorDialog title={editing ? t("编辑用量来源") : t("连接用量来源")} onClose={closeEditor}>
          <form className="editor-form usage-source-editor" onSubmit={(event) => void save(event)}>
            <div className="editor-scroll">
              <fieldset disabled={busy} className="usage-source-fields">
                <p className="text-sm text-muted">
                  {editing
                    ? t("修改名称或连接信息。凭据留空保留原值，保存后重新验证。")
                    : t("选择来源，填写连接信息。保存后会验证一次，凭据加密保存在本机。")}
                </p>
                {formError && (
                  <p role="alert" className="usage-source-error">
                    {formError}
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <label>
                    {t("来源名称")}
                    <input
                      required
                      maxLength={160}
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </label>
                  <label>
                    {t("类型")}
                    <Select
                      aria-label={t("来源类型")}
                      disabled={Boolean(editing)}
                      value={form.type}
                      onValueChange={(value) => {
                        const next = usageFormFromDraft({ type: value, name: form.name });
                        if (["3x-ui", "subscription"].includes(next.type))
                          next.nodeId = form.nodeId;
                        setForm(next);
                      }}
                      options={Object.entries(names)
                        .filter(([key]) => key !== "oauth")
                        .map(([value, label]) => ({ value, label: t(label) }))}
                    />
                  </label>
                  {["3x-ui", "subscription"].includes(form.type) && (
                    <label className="sm:col-span-2">
                      {form.type === "3x-ui" ? t("面板根地址（含自定义路径）") : t("机场订阅地址")}
                      <input
                        type={form.type === "subscription" ? "password" : "url"}
                        required={!editing}
                        placeholder={editing ? t("留空保留原地址") : "https://…"}
                        value={form.url}
                        autoComplete="off"
                        onChange={(event) => setForm({ ...form, url: event.target.value })}
                      />
                    </label>
                  )}
                  {form.type === "3x-ui" && (
                    <>
                      <label>
                        {t("面板用户名")}
                        <input
                          required={!editing}
                          placeholder={editing ? t("留空保留原值") : undefined}
                          value={form.username}
                          autoComplete="off"
                          onChange={(event) => setForm({ ...form, username: event.target.value })}
                        />
                      </label>
                      <label>
                        {t("面板密码")}
                        <input
                          type="password"
                          required={!editing}
                          placeholder={editing ? t("留空保留原值") : undefined}
                          value={form.password}
                          autoComplete="new-password"
                          onChange={(event) => setForm({ ...form, password: event.target.value })}
                        />
                      </label>
                      {!editing && (
                        <details className="sm:col-span-2 rounded-md border border-line p-3">
                          <summary className="cursor-pointer text-sm">
                            {t("高级筛选（可选）")}
                          </summary>
                          <div className="mt-3 grid gap-4 sm:grid-cols-2">
                            <label>
                              {t("入站 ID（可选）")}
                              <input
                                value={form.inboundId}
                                onChange={(event) =>
                                  setForm({ ...form, inboundId: event.target.value })
                                }
                              />
                            </label>
                            <label>
                              {t("客户端 Email（可选，精确匹配）")}
                              <input
                                value={form.clientEmail}
                                onChange={(event) =>
                                  setForm({ ...form, clientEmail: event.target.value })
                                }
                              />
                            </label>
                          </div>
                        </details>
                      )}
                    </>
                  )}
                  {form.type.endsWith("-api") && (
                    <label className="sm:col-span-2">
                      {t("组织 Admin Key")}
                      <input
                        type="password"
                        required={!editing}
                        placeholder={editing ? t("留空保留原值") : undefined}
                        autoComplete="new-password"
                        value={form.apiKey}
                        onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                      />
                      <span className="text-xs text-muted">
                        {t(
                          "读取该组织最近 30 天全部 API Key 的用量。需要组织管理权限；同一组织只添加一次，避免重复汇总。",
                        )}
                      </span>
                    </label>
                  )}
                  {["3x-ui", "subscription"].includes(form.type) && (
                    <label className="sm:col-span-2">
                      {t("关联节点（可选，仅标记归属，不代表该节点独占用量）")}
                      <Select
                        aria-label={t("关联节点")}
                        value={form.nodeId}
                        onValueChange={(value) => setForm({ ...form, nodeId: value })}
                        options={[
                          { value: "", label: t("不关联") },
                          ...nodes,
                          ...(form.nodeId && !nodes.some((node) => node.value === form.nodeId)
                            ? [{ value: form.nodeId, label: t("节点已移除") }]
                            : []),
                        ]}
                      />
                    </label>
                  )}
                </div>
              </fieldset>
            </div>
            <div className="editor-footer">
              <Button type="button" variant="outline" disabled={busy} onClick={closeEditor}>
                {t("取消")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t("正在保存并验证…") : t("保存并验证连接")}
              </Button>
            </div>
          </form>
        </EditorDialog>
      )}
      {removing && (
        <EditorDialog
          title={t("移除用量来源")}
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <div className="editor-scroll">
            <p className="text-sm leading-relaxed">
              {t("移除采集来源后将停止更新，已记录的历史用量会保留。")}
            </p>
            <p className="mt-3 break-words font-semibold">{removing.name}</p>
          </div>
          <div className="editor-footer">
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              {t("取消")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? t("正在移除…") : t("确认移除")}
            </Button>
          </div>
        </EditorDialog>
      )}
    </div>
  );
}
