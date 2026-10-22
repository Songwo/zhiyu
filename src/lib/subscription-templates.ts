/**
 * 常用订阅模板：一键预填名称、网址、费用和下次续费日，保存前都可以修改。
 * 价格是常见的标准价，仅作起点；实际以账单为准。
 */

export type TemplateKind = "ai" | "service";

export interface SubscriptionTemplate {
  id: string;
  kind: TemplateKind;
  name: string;
  /** 模板分组：AI 工具、开发与云服务、个人订阅。 */
  group: "ai" | "dev" | "life";
  provider: string;
  plan?: string;
  url?: string;
  amount: number;
  currency: "CNY" | "USD";
  cycle: "month" | "year";
}

export const TEMPLATE_GROUPS: { id: SubscriptionTemplate["group"]; label: string }[] = [
  { id: "ai", label: "AI 工具" },
  { id: "dev", label: "开发与云服务" },
  { id: "life", label: "个人订阅" },
];

export const SUBSCRIPTION_TEMPLATES: SubscriptionTemplate[] = [
  { id: "chatgpt-plus", kind: "ai", group: "ai", name: "ChatGPT Plus", provider: "OpenAI", plan: "Plus", amount: 20, currency: "USD", cycle: "month" },
  { id: "claude-pro", kind: "ai", group: "ai", name: "Claude Pro", provider: "Anthropic", plan: "Pro", amount: 20, currency: "USD", cycle: "month" },
  { id: "cursor-pro", kind: "ai", group: "ai", name: "Cursor Pro", provider: "Cursor", plan: "Pro", amount: 20, currency: "USD", cycle: "month" },
  { id: "copilot", kind: "ai", group: "ai", name: "GitHub Copilot", provider: "GitHub", plan: "Pro", amount: 10, currency: "USD", cycle: "month" },
  { id: "gemini", kind: "ai", group: "ai", name: "Google AI Pro", provider: "Google", plan: "AI Pro", amount: 19.99, currency: "USD", cycle: "month" },
  { id: "cloudflare-workers", kind: "service", group: "dev", name: "Cloudflare Workers Paid", provider: "Cloudflare", url: "https://dash.cloudflare.com", amount: 5, currency: "USD", cycle: "month" },
  { id: "vercel-pro", kind: "service", group: "dev", name: "Vercel Pro", provider: "Vercel", url: "https://vercel.com/dashboard", amount: 20, currency: "USD", cycle: "month" },
  { id: "github-pro", kind: "service", group: "dev", name: "GitHub Pro", provider: "GitHub", url: "https://github.com/settings/billing", amount: 4, currency: "USD", cycle: "month" },
  { id: "1password", kind: "service", group: "dev", name: "1Password", provider: "1Password", url: "https://my.1password.com", amount: 35.88, currency: "USD", cycle: "year" },
  { id: "icloud", kind: "service", group: "life", name: "iCloud+ 200GB", provider: "Apple", url: "https://www.icloud.com", amount: 21, currency: "CNY", cycle: "month" },
  { id: "netflix", kind: "service", group: "life", name: "Netflix", provider: "Netflix", url: "https://www.netflix.com/account", amount: 15.49, currency: "USD", cycle: "month" },
  { id: "spotify", kind: "service", group: "life", name: "Spotify Premium", provider: "Spotify", url: "https://www.spotify.com/account", amount: 11.99, currency: "USD", cycle: "month" },
  { id: "notion", kind: "service", group: "life", name: "Notion Plus", provider: "Notion", url: "https://www.notion.so", amount: 10, currency: "USD", cycle: "month" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** 下一个续费日：从今天起推一个周期，月底顺延到当月最后一天。 */
export function nextRenewal(cycle: SubscriptionTemplate["cycle"], today: Date): string {
  const months = cycle === "month" ? 1 : 12;
  const index = today.getFullYear() * 12 + today.getMonth() + months;
  const year = Math.floor(index / 12);
  const month = index % 12;
  const last = new Date(year, month + 1, 0).getDate();
  return `${year}-${pad(month + 1)}-${pad(Math.min(today.getDate(), last))}`;
}

/**
 * 模板对应的编辑器预填值。AI 订阅只有美元月费字段，年付折成月费；
 * 服务资产使用通用的费用字段与到期日。
 */
export function templatePreset(template: SubscriptionTemplate, today: Date): Record<string, string> {
  const date = nextRenewal(template.cycle, today);
  if (template.kind === "ai") {
    const monthly = template.cycle === "month" ? template.amount : template.amount / 12;
    return {
      name: template.name,
      provider: template.provider,
      plan: template.plan ?? "",
      monthlyUsd: String(Math.round(monthly * 100) / 100),
      renewsAt: date,
      tags: "订阅",
    };
  }
  return {
    name: template.name,
    category: "custom",
    provider: template.provider,
    url: template.url ?? "",
    billingAmount: String(template.amount),
    billingCurrency: template.currency,
    billingCycle: template.cycle,
    expiresAt: date,
    tags: "订阅",
  };
}
