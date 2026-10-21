import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  Link2,
  Pencil,
  Phone,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { phoneExpiry } from "../../electron/services/phone-numbers.mjs";
import { billingFromForm } from "../../electron/services/renewals.mjs";
import { billingFormValues, formatBilling } from "@/lib/billing";
import { BillingFields } from "./billing-fields";
import { phonePage, visiblePhoneNumbers, type PhoneFilter } from "@/lib/phone-view.mjs";
import { useAppStore } from "@/lib/store";
import type { PhoneNumber } from "@/lib/types";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/input";
import { EditorDialog } from "./ui/editor-dialog";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function copyNumber(number: string) {
  try {
    await navigator.clipboard.writeText(number);
    toast.success(t("号码已复制"));
  } catch (error) {
    toast.error(t("复制失败：{0}", errorText(error)));
  }
}

function ExpiryLabel({ expiresAt }: { expiresAt: string }) {
  const { status, days } = phoneExpiry(expiresAt);
  const label =
    status === "unknown"
      ? t("未填到期日")
      : status === "expired"
        ? t("已到期")
        : status === "today"
          ? t("今天到期")
          : t("{0} 天后到期", days ?? 0);
  return (
    <span
      className={`chip ${status === "expired" ? "chip-crit" : status === "soon" || status === "today" ? "chip-warn" : "chip-mute"}`}
    >
      {label}
    </span>
  );
}

export function PhoneWorkspace() {
  const records = useAppStore((s) => s.phoneNumbers);
  const accounts = useAppStore((s) => s.aiAssets);
  const remove = useAppStore((s) => s.removePhoneNumber);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const filter = useAppStore((s) => s.phoneFilter);
  const focusId = useAppStore((s) => s.phoneFocusId);
  const setFilter = useAppStore((s) => s.setPhoneFilter);
  const deferredQuery = useDeferredValue(query);
  const [paging, setPaging] = useState({ query: "", filter: "all" as PhoneFilter, page: 1 });
  const [editing, setEditing] = useState<PhoneNumber | "new" | null>(null);
  const createRequested = useAppStore((s) => s.phoneCreateRequested);
  useEffect(() => {
    if (!createRequested) return;
    useAppStore.setState({ phoneCreateRequested: false });
    setEditing("new");
  }, [createRequested]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const add = () => setEditing("new");
    const tick = window.setInterval(
      () =>
        setToday((previous) => {
          const now = new Date();
          return previous.toDateString() === now.toDateString() ? previous : now;
        }),
      60_000,
    );
    window.addEventListener("nanpad:add-phone", add);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("nanpad:add-phone", add);
    };
  }, []);
  const shown = useMemo(
    () =>
      focusId
        ? records.filter((record) => record.id === focusId)
        : visiblePhoneNumbers(records, deferredQuery, filter, today),
    [records, deferredQuery, filter, today, focusId],
  );
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const page = phonePage(
    shown,
    paging.query === deferredQuery && paging.filter === filter ? paging.page : 1,
  );
  const attention = useMemo(
    () =>
      records.filter((record) =>
        ["expired", "today", "soon"].includes(phoneExpiry(record.expiresAt, today).status),
      ).length,
    [records, today],
  );
  const reset = () => {
    setQuery("");
    setFilter("all");
    setPaging({ query: "", filter: "all", page: 1 });
  };
  const turnPage = (next: number) => {
    setPaging({ query: deferredQuery, filter, page: next });
    window.requestAnimationFrame(() => list.current?.scrollIntoView({ block: "start" }));
  };
  return (
    <div className="min-w-0 space-y-5 px-4 pb-24 pt-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="max-w-2xl text-meta leading-relaxed text-muted">
            {t("保存号码、到期日及关联账号。到期前 30 天开始提示，系统通知在应用打开时提醒。")}
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            {t("号码信息保存在本机资产文件中，不记录验证码。")}
          </p>
        </div>
        <Button className="min-h-11" onClick={() => setEditing("new")}>
          <Plus />
          {t("添加号码")}
        </Button>
      </div>

      {editing && (
        <PhoneEditor
          key={editing === "new" ? "new" : editing.id}
          record={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 basis-60">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" />
          <Input
            className="min-h-11 pl-9 pr-11"
            aria-label={t("搜索号码")}
            placeholder={t("搜索号码、名称、服务商或备注")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPaging({ query: event.target.value, filter, page: 1 });
            }}
          />
          {query && (
            <button
              type="button"
              aria-label={t("清除搜索")}
              className="absolute right-0 top-0 grid size-11 place-items-center rounded-md text-muted hover:text-ink"
              onClick={() => {
                setQuery("");
                setPaging({ query: "", filter, page: 1 });
              }}
            >
              <X className="size-4" />
            </button>
          )}
        </label>
        <Select
          className="w-44"
          aria-label={t("到期筛选")}
          value={filter}
          onValueChange={(value) => {
            setFilter(value as PhoneFilter);
            setPaging({ query: deferredQuery, filter: value as PhoneFilter, page: 1 });
          }}
          options={[
            { value: "all", label: t("全部号码") },
            { value: "attention", label: t("需关注（{0}）", attention) },
            { value: "expired", label: t("已到期") },
            { value: "active", label: t("30 天后到期") },
            { value: "unknown", label: t("未填到期日") },
          ]}
        />
      </div>
      <p className="text-2xs text-muted" role="status" aria-live="polite">
        {t("共 {0} 个号码，按到期日从近到远排列。", shown.length)}{" "}
        {page.totalPages > 1 && t("每页显示 50 个")}
      </p>
      {focusId && (
        <div className="flex flex-wrap items-center gap-3 text-meta text-muted">
          <span>{t("正在查看指定号码")}</span>
          <Button variant="outline" className="min-h-11" onClick={reset}>
            {t("查看全部号码")}
          </Button>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="rounded-xl border border-line bg-card px-5 py-10 text-center">
          <Phone className="mx-auto size-8 text-muted" />
          <h3 className="mt-3 text-body font-semibold">
            {records.length ? t("没有匹配的号码") : t("还没有保存号码")}
          </h3>
          <p className="mt-2 text-meta text-muted">
            {records.length
              ? t("调整搜索或到期筛选，查看其他号码。")
              : t("添加常用或订阅服务使用的号码，集中查看到期时间。")}
          </p>
          {records.length > 0 && (
            <Button variant="outline" className="mt-4 min-h-11" onClick={reset}>
              {t("重置筛选")}
            </Button>
          )}
        </div>
      ) : (
        <div ref={list} className="scroll-mt-20 space-y-3">
          {page.items.map((record) => (
            <article
              key={record.id}
              data-phone-id={record.id}
              className="min-w-0 rounded-xl border border-line bg-card p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-52">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-all font-mono text-body font-semibold">{record.number}</h3>
                    <ExpiryLabel expiresAt={record.expiresAt} />
                  </div>
                  {(record.label || record.provider) && (
                    <p className="mt-1 break-words text-meta text-muted">
                      {[record.label, record.provider].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {(record.expiresAt || record.billing) && (
                    <p className="mt-1 text-meta text-muted">
                      {[
                        record.expiresAt && t("到期日：{0}", record.expiresAt),
                        record.billing && formatBilling(record.billing),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    aria-label={t("复制号码 {0}", record.number)}
                    onClick={() => void copyNumber(record.number)}
                  >
                    <Copy />
                    {t("复制")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    aria-label={t("编辑号码 {0}", record.number)}
                    onClick={() => {
                      setEditing(record);
                      setDeleting(null);
                    }}
                  >
                    <Pencil />
                    {t("编辑")}
                  </Button>
                  <Button
                    variant="danger-ghost"
                    className="min-h-11"
                    aria-label={t("删除号码 {0}", record.number)}
                    onClick={() => setDeleting(record.id)}
                  >
                    <Trash2 />
                    {t("删除")}
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {record.subscriptionIds.length ? (
                  record.subscriptionIds.map((id) => {
                    const account = accountById.get(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={!account}
                        aria-label={t("查看订阅 {0}", account?.name ?? t("已删除的账号"))}
                        onClick={(event) => {
                          if (!account) return;
                          const rect = event.currentTarget.getBoundingClientRect();
                          const state = useAppStore.getState();
                          state.setView("ai");
                          state.setExpanded({
                            kind: "ai",
                            id: account.id,
                            origin: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                          });
                        }}
                        className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md bg-canvas px-2 py-1 text-meta text-muted hover:text-ink disabled:cursor-default"
                      >
                        <Link2 className="size-3.5 shrink-0" />
                        <span className="min-w-0 break-words">
                          {account
                            ? [account.name, account.accountEmail].filter(Boolean).join(" · ")
                            : t("已删除的账号")}
                        </span>
                        {account && <ArrowUpRight className="size-3.5 shrink-0" />}
                      </button>
                    );
                  })
                ) : (
                  <span className="text-meta text-muted">{t("尚未关联订阅账号")}</span>
                )}
              </div>
              {record.notes && (
                <p className="mt-3 whitespace-pre-wrap break-words text-meta leading-relaxed text-muted">
                  {record.notes}
                </p>
              )}
              {deleting === record.id && (
                <div
                  className="mt-3 rounded-lg border border-line-strong p-3"
                  role="group"
                  aria-label={t("确认删除号码")}
                >
                  <p className="text-meta">{t("删除此号码及其账号关联？订阅账号本身会保留。")}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="danger"
                      className="min-h-11"
                      onClick={() => {
                        try {
                          remove(record.id);
                          setDeleting(null);
                          if (editing !== "new" && editing?.id === record.id) setEditing(null);
                          toast.success(t("号码已删除"));
                        } catch (error) {
                          toast.error(errorText(error));
                        }
                      }}
                    >
                      {t("确认删除")}
                    </Button>
                    <Button
                      variant="outline"
                      className="min-h-11"
                      onClick={() => setDeleting(null)}
                    >
                      {t("取消")}
                    </Button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {page.totalPages > 1 && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4"
          aria-label={t("号码分页")}
        >
          <span className="text-meta text-muted">
            {t("第 {0} / {1} 页", page.page, page.totalPages)}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              aria-label={t("上一页")}
              disabled={page.page <= 1 || query !== deferredQuery}
              onClick={() => turnPage(page.page - 1)}
            >
              <ChevronLeft />
              {t("上一页")}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              aria-label={t("下一页")}
              disabled={page.page >= page.totalPages || query !== deferredQuery}
              onClick={() => turnPage(page.page + 1)}
            >
              {t("下一页")}
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PhoneEditor({ record, onClose }: { record?: PhoneNumber; onClose: () => void }) {
  const accounts = useAppStore((s) => s.aiAssets);
  const save = useAppStore((s) => s.upsertPhoneNumber);
  const [form, setForm] = useState(() => ({
    number: record?.number ?? "",
    label: record?.label ?? "",
    provider: record?.provider ?? "",
    expiresAt: record?.expiresAt ?? "",
    notes: record?.notes ?? "",
    subscriptionIds: record?.subscriptionIds ?? [],
    ...billingFormValues(record?.billing),
  }));
  const [error, setError] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  const matchingAccounts = useMemo(() => {
    const needle = accountQuery.trim().toLocaleLowerCase();
    return accounts.filter((account) =>
      [account.name, account.accountEmail, account.provider]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [accounts, accountQuery]);
  const toggle = (id: string) =>
    setForm((value) => ({
      ...value,
      subscriptionIds: value.subscriptionIds.includes(id)
        ? value.subscriptionIds.filter((item) => item !== id)
        : [...value.subscriptionIds, id],
    }));
  const missing = form.subscriptionIds.filter(
    (id) => !accounts.some((account) => account.id === id),
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const now = new Date().toISOString();
      const { billingAmount, billingCurrency, billingCycle, ...fields } = form;
      save({
        ...fields,
        billing: billingFromForm({
          amount: billingAmount,
          currency: billingCurrency,
          cycle: billingCycle,
        }),
        id: record?.id ?? crypto.randomUUID(),
        createdAt: record?.createdAt ?? now,
        updatedAt: now,
      });
      toast.success(t("号码已保存"), { id: "phone-saved", position: "top-center" });
      onClose();
    } catch (error) {
      const message = errorText(error);
      setError(message);
      toast.error(message);
    }
  }
  return (
    <EditorDialog
      title={record ? t("编辑号码") : t("添加号码")}
      closeLabel={t("关闭号码表单")}
      onClose={onClose}
    >
      <form
        aria-label={record ? t("编辑号码") : t("添加号码")}
        className="editor-form"
        onSubmit={submit}
      >
        <div className="editor-scroll">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("号码")}>
              <Input
                autoFocus
                required
                type="tel"
                aria-label={t("号码")}
                placeholder="+86 138 0000 0000"
                value={form.number}
                onChange={(e) => setForm({ ...form, number: e.target.value })}
              />
            </Field>
            <Field label={t("名称（可选）")}>
              <Input
                aria-label={t("号码名称")}
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </Field>
            <Field label={t("服务商（可选）")}>
              <Input
                aria-label={t("号码服务商")}
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
              />
            </Field>
            <Field label={t("到期日（可选）")}>
              <Input
                type="date"
                aria-label={t("号码到期日")}
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              />
            </Field>
            <BillingFields
              values={form}
              set={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
            />
          </div>
          <fieldset className="mt-4">
            <legend className="text-meta font-medium text-muted">
              {t("关联订阅账号（可多选）")}
            </legend>
            {accounts.length > 0 && (
              <Input
                className="mt-2 min-h-11"
                aria-label={t("搜索关联订阅")}
                placeholder={t("按名称、邮箱或服务商搜索订阅")}
                value={accountQuery}
                onChange={(event) => setAccountQuery(event.target.value)}
              />
            )}
            {form.subscriptionIds.length > 0 && (
              <p className="mt-2 text-2xs text-muted">
                {t("已选择 {0} 个订阅，搜索不会清除已选项。", form.subscriptionIds.length)}
              </p>
            )}
            <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-line p-2">
              {!accounts.length && !missing.length && (
                <p className="p-2 text-meta text-muted">
                  {t("暂无 AI 订阅账号，可先保存号码，之后再关联。")}
                </p>
              )}
              {accounts.length > 0 && matchingAccounts.length === 0 && (
                <p className="p-2 text-meta text-muted">{t("没有匹配的订阅")}</p>
              )}
              {matchingAccounts.map((account) => (
                <label
                  key={account.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-canvas"
                >
                  <input
                    type="checkbox"
                    checked={form.subscriptionIds.includes(account.id)}
                    onChange={() => toggle(account.id)}
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 break-words text-meta">
                    {account.name}
                    {account.accountEmail && (
                      <span className="ml-2 text-muted">{account.accountEmail}</span>
                    )}
                  </span>
                </label>
              ))}
              {missing.map((id) => (
                <label
                  key={id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 px-2 py-2 text-meta text-muted"
                >
                  <input type="checkbox" checked onChange={() => toggle(id)} className="size-4" />
                  {t("已删除的账号")}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-4">
            <Field label={t("备注（可选）")}>
              <Textarea
                aria-label={t("号码备注")}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Field>
          </div>
          {error && (
            <p role="alert" className="mt-3 break-words text-meta text-crit">
              {error}
            </p>
          )}
        </div>
        <div className="editor-footer">
          <Button type="button" variant="outline" className="min-h-11" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit" className="min-h-11">
            {t("保存号码")}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}

export function PhoneBindings({ subscriptionId }: { subscriptionId: string }) {
  const numbers = useAppStore((s) => s.phoneNumbers);
  const upsert = useAppStore((s) => s.upsertPhoneNumber);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const linked = useMemo(
    () => numbers.filter((number) => number.subscriptionIds.includes(subscriptionId)),
    [numbers, subscriptionId],
  );
  const available = useMemo(
    () => numbers.filter((number) => !number.subscriptionIds.includes(subscriptionId)),
    [numbers, subscriptionId],
  );
  const matches = useMemo(
    () => visiblePhoneNumbers(available, deferredQuery, "all"),
    [available, deferredQuery],
  );
  const choices = matches.slice(0, 50);
  const manage = () => {
    useAppStore.getState().openPhones();
  };
  function bind(record: PhoneNumber, enabled: boolean) {
    try {
      upsert({
        ...record,
        subscriptionIds: enabled
          ? [...record.subscriptionIds, subscriptionId]
          : record.subscriptionIds.filter((id) => id !== subscriptionId),
        updatedAt: new Date().toISOString(),
      });
      setSelected("");
      setQuery("");
      toast.success(enabled ? t("号码已关联") : t("号码已解绑"));
    } catch (error) {
      toast.error(errorText(error));
    }
  }
  return (
    <section className="detail-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body font-semibold">{t("关联号码")}</h3>
        <Button variant="ghost" className="min-h-11" onClick={manage}>
          {t("管理号码")}
        </Button>
      </div>
      {linked.length ? (
        <div className="mt-2 space-y-2">
          {linked.map((record) => (
            <div
              key={record.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3"
            >
              <div className="min-w-0">
                <p className="break-all font-mono text-meta">{record.number}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="break-words text-meta text-muted">{record.label}</span>
                  <ExpiryLabel expiresAt={record.expiresAt} />
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  className="min-h-11"
                  aria-label={t("查看号码 {0}", record.number)}
                  onClick={() => useAppStore.getState().openPhones({ id: record.id })}
                >
                  <ArrowUpRight />
                  {t("查看")}
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-11"
                  aria-label={t("复制号码 {0}", record.number)}
                  onClick={() => void copyNumber(record.number)}
                >
                  <Copy />
                  {t("复制")}
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-11"
                  aria-label={t("解绑号码 {0}", record.number)}
                  onClick={() => bind(record, false)}
                >
                  {t("解绑")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-meta text-muted">{t("尚未关联号码，可从已保存的号码中选择。")}</p>
      )}
      {available.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {available.length > 20 && (
            <Input
              className="min-h-11 basis-full"
              aria-label={t("搜索可关联号码")}
              placeholder={t("搜索号码、名称、服务商或备注")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected("");
              }}
            />
          )}
          <Select
            className="min-w-0 flex-1 basis-48"
            aria-label={t("选择已保存的号码")}
            value={selected}
            onValueChange={setSelected}
            placeholder={t("选择已保存的号码")}
            disabled={query !== deferredQuery || choices.length === 0}
            options={choices.map((record) => ({
              value: record.id,
              label: [record.number, record.label].filter(Boolean).join(" · "),
            }))}
          />
          <Button
            variant="outline"
            className="min-h-11"
            disabled={query !== deferredQuery || !choices.some((record) => record.id === selected)}
            onClick={() => {
              const record = available.find((item) => item.id === selected);
              if (record) bind(record, true);
            }}
          >
            {t("关联号码")}
          </Button>
          {matches.length > choices.length && (
            <p className="basis-full text-2xs text-muted">
              {t("显示前 {0} 项，共 {1} 项；继续输入可缩小范围。", choices.length, matches.length)}
            </p>
          )}
          {matches.length === 0 && (
            <p className="basis-full text-2xs text-muted">{t("没有匹配的号码")}</p>
          )}
        </div>
      )}
    </section>
  );
}
