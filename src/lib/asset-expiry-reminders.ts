import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { assetExpiryReminders } from "../../electron/services/expiry-reminders.mjs";
import { useAppStore } from "./store";
import { t } from "./i18n";
import type { ExpiryReminder } from "./types";

export function useAssetExpiryReminders() {
  const snapshot = useAppStore(
    useShallow((s) => ({
      servers: s.servers,
      domains: s.domains,
      certs: s.certs,
      aiAssets: s.aiAssets,
      services: s.services,
      phoneNumbers: s.phoneNumbers,
    })),
  );
  return useMemo(() => assetExpiryReminders(snapshot), [snapshot]);
}

export function expiryReminderLabel(setting?: ExpiryReminder) {
  if (!setting) return t("沿用系统提醒规则");
  if (!setting.enabled) return t("已关闭到期提醒");
  return setting.leadDays === 0 ? t("当天提醒") : t("提前 {0} 天提醒", setting.leadDays);
}
