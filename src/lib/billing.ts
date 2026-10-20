import type { Billing, BillingCurrency, BillingCycle } from "./types";
import { intlLocale, t } from "./i18n";

export const CYCLE_LABEL: Record<BillingCycle, string> = {
  month: "每月",
  year: "每年",
  once: "一次性",
};

export function formatMoney(amount: number, currency: BillingCurrency): string {
  return new Intl.NumberFormat(intlLocale(), {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}

export function formatBilling(billing: Billing): string {
  const money = formatMoney(billing.amount, billing.currency);
  if (billing.cycle === "month") return t("{0}/月", money);
  if (billing.cycle === "year") return t("{0}/年", money);
  return t("{0} · 一次性", money);
}

/** 编辑表单里的费用字段，金额留空表示不记录。 */
export function billingFormValues(billing: Billing | undefined) {
  return {
    billingAmount: billing ? String(billing.amount) : "",
    billingCurrency: billing?.currency ?? "CNY",
    billingCycle: billing?.cycle ?? "year",
  };
}
