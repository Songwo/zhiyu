import { AI_PROVIDER_NAMES, type AiAccount } from "./ai-accounts.ts";
import type { AiAsset } from "./types.ts";

// 资产文件只保留展示字段和授权引用，令牌始终留在密钥库中。
export function subscriptionFromAccount(account: AiAccount, previous?: AiAsset): AiAsset {
  const percentages =
    account.usage?.windows.flatMap((item) =>
      typeof item.usedPercent === "number" && Number.isFinite(item.usedPercent)
        ? [item.usedPercent]
        : [],
    ) ?? [];
  const usagePct = percentages.length ? Math.max(...percentages) : 0;
  const absolute = account.usage?.windows.find((item) => item.remaining !== undefined);
  return {
    id: previous?.id ?? `ai_${account.id}`,
    name: previous?.name || account.email || AI_PROVIDER_NAMES[account.provider],
    provider: AI_PROVIDER_NAMES[account.provider],
    plan: account.plan || previous?.plan || "",
    keyHint: previous?.keyHint ?? "",
    monthlyUsd: previous?.monthlyUsd ?? 0,
    monthlyUsdKnown: previous ? previous.monthlyUsdKnown !== false : false,
    usagePct,
    usageAvailable: percentages.length > 0,
    usageCheckedAt: account.usage?.checkedAt,
    usageStale: account.usage?.status === "stale" || account.usageRefresh?.status === "error",
    usageScope: account.usage?.scope,
    usageSummary: absolute
      ? `${absolute.label}: ${absolute.remaining} ${absolute.unit ?? ""}`.trim()
      : undefined,
    // 令牌到期、额度重置都不是续费日期。
    expiryReminder:
      previous?.expiryReminder ?? (previous ? undefined : { enabled: true, leadDays: 3 }),
    renewsAt: previous?.renewsAt ?? "",
    subscriptionExpiresAt: account.subscriptionExpiresAt,
    tags: previous?.tags ?? [],
    status: usagePct >= 90 || account.usageRefresh?.status === "error" ? "warning" : "online",
    notes: previous?.notes ?? "",
    imageDataUrl: previous?.imageDataUrl,
    oauthAccountId: account.id,
    oauthProvider: account.provider,
    oauthDisconnected: false,
    accountEmail: account.email,
  };
}
