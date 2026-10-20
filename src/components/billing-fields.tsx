import { Field, Input, Select } from "./ui/input";
import { CYCLE_LABEL } from "@/lib/billing";
import { t } from "@/lib/i18n";

/**
 * 费用与续费字段：金额留空即不记录费用。服务器、域名、服务资产和号码共用，
 * 续费视图与提醒都读这里保存的值。
 */
export function BillingFields({
  values,
  set,
  date,
}: {
  values: Record<string, unknown>;
  set: (key: string, value: string) => void;
  /** 需要在这里一起填写到期日时传入；域名和号码的到期日已有自己的输入框。 */
  date?: { key: string; label: string };
}) {
  return (
    <fieldset className="rounded-xl border border-line p-3 sm:col-span-2">
      <legend className="px-1 text-meta font-medium">{t("费用与续费（可选）")}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {date && (
          <Field label={date.label}>
            <Input
              type="date"
              aria-label={date.label}
              value={String(values[date.key] ?? "")}
              onChange={(event) => set(date.key, event.target.value)}
            />
          </Field>
        )}
        <Field label={t("续费金额")}>
          <Input
            inputMode="decimal"
            aria-label={t("续费金额")}
            placeholder={t("留空则不记录")}
            value={String(values.billingAmount ?? "")}
            onChange={(event) => set("billingAmount", event.target.value)}
          />
        </Field>
        <Field label={t("币种")}>
          <Select
            aria-label={t("币种")}
            value={String(values.billingCurrency || "CNY")}
            onValueChange={(value) => set("billingCurrency", value)}
            options={[
              { value: "CNY", label: t("人民币 CNY") },
              { value: "USD", label: t("美元 USD") },
            ]}
          />
        </Field>
        <Field label={t("计费周期")}>
          <Select
            aria-label={t("计费周期")}
            value={String(values.billingCycle || "year")}
            onValueChange={(value) => set("billingCycle", value)}
            options={(["month", "year", "once"] as const).map((value) => ({
              value,
              label: t(CYCLE_LABEL[value]),
            }))}
          />
        </Field>
      </div>
    </fieldset>
  );
}
