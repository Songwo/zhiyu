import { BellRing, Check, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { daysUntil, localDay, shiftDay } from "../../electron/services/reminders.mjs";
import { newId } from "@/lib/asset-types";
import { isDesktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import type { Reminder } from "@/lib/types";
import { cn } from "@/lib/utils";
import { REPEAT_LABEL } from "@/lib/reminder-labels";
import { Button } from "./ui/button";
import { EditorDialog } from "./ui/editor-dialog";
import { Field, Input, Select, Textarea } from "./ui/input";
import { PageSection } from "./ui/page";

const TEMPLATES: Array<[string, Reminder["repeat"], number]> = [
  ["宽带续费", "year", 7],
  ["车险续保", "year", 14],
  ["信用卡还款", "month", 3],
  ["护照到期", "none", 60],
];

function blank(title = "", repeat: Reminder["repeat"] = "none", leadDays = 3): Reminder {
  const due = new Date();
  due.setDate(due.getDate() + 7);
  return { id: newId("rem"), title, note: "", dueAt: localDay(due), repeat, leadDays };
}

/** 费用与续费页的「备忘提醒」：自己写的事项与日期，大号倒计时。 */
export function RemindersSection() {
  const reminders = useAppStore((s) => s.reminders);
  const hydrated = useAppStore((s) => s.hydrated);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [showDone, setShowDone] = useState(false);
  const active = useMemo(() => {
    const now = new Date();
    return reminders
      .filter((r) => !r.done)
      .map((r) => ({ r, days: daysUntil(r.dueAt, now) }))
      .sort((a, b) => a.days - b.days);
  }, [reminders]);
  const done = reminders.filter((r) => r.done);
  if (!hydrated) return null;
  const state = useAppStore.getState();
  return (
    <PageSection
      title={t("备忘提醒")}
      description={t("自己写的事项与日期：证件、保修、交费、续费……到期前按设定天数提醒")}
      aria-label={t("备忘提醒")}
      action={
        <div className="flex items-center gap-2">
          <BrowserNotifyButton />
          <Button size="sm" onClick={() => setEditing(blank())}>
            <Plus className="size-4" />
            {t("新建提醒")}
          </Button>
        </div>
      }
    >
      {active.length === 0 ? (
        <div className="reminder-empty">
          <BellRing aria-hidden="true" />
          <p>{t("还没有提醒。从常见事项开始：")}</p>
          <div className="reminder-templates">
            {TEMPLATES.map(([title, repeat, lead]) => (
              <button
                key={title}
                type="button"
                onClick={() => setEditing(blank(t(title), repeat, lead))}
              >
                {t(title)} · {t(REPEAT_LABEL[repeat])}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="reminder-grid">
          {active.map(({ r, days }) => (
            <article
              key={r.id}
              className="reminder-card"
              data-tone={days < 0 ? "over" : days <= r.leadDays ? "due" : "later"}
              aria-label={t("提醒 {0}", r.title)}
            >
              <div className="reminder-count">
                <strong>{days === 0 ? t("今天") : Math.abs(days)}</strong>
                {days !== 0 && <span>{days > 0 ? t("天后") : t("天前到期")}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <h3>{r.title}</h3>
                <p className="reminder-meta">
                  {r.dueAt} · {t(REPEAT_LABEL[r.repeat])} · {t("提前 {0} 天提醒", r.leadDays)}
                </p>
                {r.note && <p className="reminder-note">{r.note}</p>}
              </div>
              <div className="reminder-actions">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("完成 {0}", r.title)}
                  title={
                    r.repeat === "none"
                      ? t("完成")
                      : t("完成这一次，顺延到 {0}", shiftDay(r.dueAt, r.repeat))
                  }
                  onClick={() => {
                    const before = r;
                    state.completeReminder(r.id);
                    const after = useAppStore.getState().reminders.find((x) => x.id === r.id);
                    toast.success(
                      after?.done
                        ? t("已完成「{0}」", r.title)
                        : t("已完成，下次 {0}", after?.dueAt ?? ""),
                      {
                        action: {
                          label: t("撤销"),
                          onClick: () => useAppStore.getState().upsertReminder(before),
                        },
                      },
                    );
                  }}
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("编辑 {0}", r.title)}
                  onClick={() => setEditing(r)}
                >
                  <Pencil className="size-4" />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="reminder-done">
          <button type="button" className="section-link" onClick={() => setShowDone((v) => !v)}>
            {showDone ? t("收起已完成") : t("已完成 {0} 项", done.length)}
          </button>
          {showDone && (
            <ul>
              {done.map((r) => (
                <li key={r.id}>
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className="text-2xs text-subtle">{r.doneAt ?? r.dueAt}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("恢复 {0}", r.title)}
                    onClick={() => state.upsertReminder({ ...r, done: false, doneAt: undefined })}
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    aria-label={t("删除 {0}", r.title)}
                    onClick={() => state.removeReminder(r.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && <ReminderEditor reminder={editing} onClose={() => setEditing(null)} />}
    </PageSection>
  );
}

export function ReminderEditor({ reminder, onClose }: { reminder: Reminder; onClose: () => void }) {
  const exists = useAppStore((s) => s.reminders.some((r) => r.id === reminder.id));
  const [form, setForm] = useState(reminder);
  const set = <K extends keyof Reminder>(key: K, value: Reminder[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  return (
    <EditorDialog title={exists ? t("编辑提醒") : t("新建提醒")} onClose={onClose}>
      <form
        className="reminder-form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            useAppStore.getState().upsertReminder({ ...form, title: form.title.trim() });
            toast.success(t("已保存提醒「{0}」", form.title.trim()));
            onClose();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <Field label={t("提醒什么")}>
          <Input
            aria-label={t("提醒什么")}
            required
            autoFocus
            maxLength={80}
            placeholder={t("例如：宽带续费")}
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("日期")}>
            <Input
              aria-label={t("日期")}
              type="date"
              required
              value={form.dueAt}
              onChange={(e) => set("dueAt", e.target.value)}
            />
          </Field>
          <Field label={t("重复")}>
            <Select
              aria-label={t("重复")}
              value={form.repeat}
              onValueChange={(v) => set("repeat", v as Reminder["repeat"])}
              options={Object.entries(REPEAT_LABEL).map(([value, label]) => ({
                value,
                label: t(label),
              }))}
            />
          </Field>
        </div>
        <Field label={t("提前几天提醒")}>
          <Select
            aria-label={t("提前几天提醒")}
            value={String(form.leadDays)}
            onValueChange={(v) => set("leadDays", Number(v))}
            options={[0, 1, 3, 7, 14, 30, 60].map((d) => ({
              value: String(d),
              label: d === 0 ? t("当天") : t("提前 {0} 天", d),
            }))}
          />
        </Field>
        <Field label={t("备注")}>
          <Textarea
            aria-label={t("备注")}
            maxLength={1000}
            value={form.note}
            onChange={(e) => set("note", e.target.value)}
          />
        </Field>
        <p className="text-2xs text-subtle">
          {t(
            "桌面版会弹系统通知，也可以在「设置 → 邮件推送」里推送到微信或 Telegram；网页版在打开时提醒。",
          )}
        </p>
        <div className={cn("flex gap-2", exists ? "justify-between" : "justify-end")}>
          {exists && (
            <Button
              type="button"
              variant="danger-ghost"
              onClick={() => {
                useAppStore.getState().removeReminder(reminder.id);
                toast.success(t("已删除提醒"), {
                  action: {
                    label: t("撤销"),
                    onClick: () => useAppStore.getState().upsertReminder(reminder),
                  },
                });
                onClose();
              }}
            >
              <Trash2 className="size-4" />
              {t("删除")}
            </Button>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("取消")}
            </Button>
            <Button type="submit" disabled={!form.title.trim() || !form.dueAt}>
              {t("保存")}
            </Button>
          </div>
        </div>
      </form>
    </EditorDialog>
  );
}

/** 网页版：请求浏览器通知权限，打开页面时按时提醒。 */
function BrowserNotifyButton() {
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  if (isDesktop() || permission !== "default") return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => void Notification.requestPermission().then((p) => setPermission(p))}
    >
      <BellRing className="size-4" />
      {t("开启浏览器通知")}
    </Button>
  );
}
