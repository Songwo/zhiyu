import { useState } from "react";
import { toast } from "sonner";
import {
  assetExpiryReminders,
  expiryReminderFormValues,
  expiryReminderFromForm,
} from "../../electron/services/expiry-reminders.mjs";
import { useAppStore } from "@/lib/store";
import { formatBilling } from "@/lib/billing";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { EditorDialog } from "./ui/editor-dialog";
import { ExpiryReminderFields } from "./expiry-reminder-fields";
import { expiryReminderLabel } from "@/lib/asset-expiry-reminders";
import { MarkRenewedButton } from "./mark-renewed";

type AssetReminder = ReturnType<typeof assetExpiryReminders>[number];

function viewAsset(row: AssetReminder, target: HTMLElement) {
  const state = useAppStore.getState();
  if (row.kind === "phone") state.openPhones({ id: row.id });
  else {
    const { x, y, width: w, height: h } = target.getBoundingClientRect();
    state.setExpanded({ kind: row.kind, id: row.id, origin: { x, y, w, h } });
  }
}

export function AssetExpiryReminderCards({ rows }: { rows: AssetReminder[] }) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const editing = rows.find((row) => row.key === editingKey);
  return (
    <>
      {rows.map((row) => (
        <article
          key={row.key}
          className="reminder-card"
          data-tone={
            row.expiryReminder?.enabled === false ? "later" : row.days < 0 ? "over" : "later"
          }
          aria-label={t("资产到期：{0}", row.name)}
        >
          <div className="reminder-count">
            <strong>{row.days === 0 ? t("今天") : Math.abs(row.days)}</strong>
            {row.days !== 0 && <span>{row.days > 0 ? t("天后") : t("天前到期")}</span>}
          </div>
          <div className="min-w-0 flex-1">
            <h3>{row.name}</h3>
            <p className="reminder-meta">
              {t("资产到期")} · {row.date} · {expiryReminderLabel(row.expiryReminder)}
            </p>
            {row.billing && (
              <p className="reminder-note">
                {t("续费金额")}：{formatBilling(row.billing)}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={(event) => viewAsset(row, event.currentTarget)}
              >
                {t("查看资产")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingKey(row.key)}>
                {t("编辑提醒")}
              </Button>
              <MarkRenewedButton entry={row} />
            </div>
          </div>
        </article>
      ))}
      {editing && (
        <AssetExpiryReminderEditor
          key={editing.key}
          row={editing}
          onClose={() => setEditingKey(null)}
        />
      )}
    </>
  );
}

function AssetExpiryReminderEditor({ row, onClose }: { row: AssetReminder; onClose: () => void }) {
  const [form, setForm] = useState(() => expiryReminderFormValues(row));
  return (
    <EditorDialog title={t("编辑提醒")} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            useAppStore
              .getState()
              .setAssetExpiryReminder(row.kind, row.id, expiryReminderFromForm(form));
            toast.success(t("已保存提醒「{0}」", row.name));
            onClose();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-meta text-muted">{row.date}</p>
        </div>
        <ExpiryReminderFields
          values={form}
          date={row.date}
          set={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
        />
        <p className="text-meta text-muted">{t("到期日期、名称和费用跟随资产更新。")}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit">{t("保存")}</Button>
        </div>
      </form>
    </EditorDialog>
  );
}
