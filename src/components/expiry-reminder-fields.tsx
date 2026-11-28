import { t } from "@/lib/i18n";
import { Field, Select } from "./ui/input";

export function ExpiryReminderFields({
  values,
  set,
  date,
}: {
  values: Record<string, unknown>;
  set: (key: string, value: string) => void;
  date?: string;
}) {
  const mode = String(values.expiryReminderMode ?? "legacy");
  const lead = Number(values.expiryReminderDays ?? 3);
  const days = [...new Set([0, 1, 3, 7, 14, 30, 60, lead])].sort((a, b) => a - b);
  return (
    <div className="space-y-3 border-t border-line pt-3 sm:col-span-2">
      <Field label={t("到期提醒")}>
        <Select
          aria-label={t("到期提醒")}
          value={mode}
          onValueChange={(value) => set("expiryReminderMode", value)}
          options={[
            ...(mode === "legacy" ? [{ value: "legacy", label: t("沿用系统提醒规则") }] : []),
            { value: "on", label: t("开启到期提醒") },
            { value: "off", label: t("关闭到期提醒") },
          ]}
        />
      </Field>
      {mode === "on" && (
        <Field label={t("提前提醒时间")}>
          <Select
            aria-label={t("提前提醒时间")}
            value={String(lead)}
            onValueChange={(value) => set("expiryReminderDays", value)}
            options={days.map((day) => ({
              value: String(day),
              label: day === 0 ? t("当天提醒") : t("提前 {0} 天提醒", day),
            }))}
          />
        </Field>
      )}
      <p className="text-meta text-muted">
        {!date
          ? t("填写到期日期后生效")
          : mode === "off"
            ? t("关闭提醒后，续费日历仍保留到期记录。")
            : t("保存后自动关联此资产，无需单独创建提醒。")}
      </p>
    </div>
  );
}
