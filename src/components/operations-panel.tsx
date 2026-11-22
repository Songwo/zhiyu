import { CalendarArrowDown } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { desktop, type DesktopPreferences } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import { calendarItems, createCalendar } from "@/lib/operations";
import { useAppStore } from "@/lib/store";
import { downloadText } from "@/lib/utils";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function CalendarExport() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={t("导出提醒日历")}
      aria-label={t("导出提醒日历")}
      onClick={() => {
        const items = calendarItems(useAppStore.getState());
        if (!items.length) {
          toast(t("没有待处理的事项，全部正常。"));
          return;
        }
        downloadText("zhiyu-reminders.ics", createCalendar(items), "text/calendar;charset=utf-8");
        toast(t("已导出 {0} 项提醒", items.length));
      }}
    >
      <CalendarArrowDown className="size-4" />
    </Button>
  );
}

export function DesktopSettings() {
  const [prefs, setPrefs] = useState<DesktopPreferences | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const bridge = desktop();
    if (bridge)
      void bridge.preferences
        .get()
        .then(setPrefs)
        .catch((err) => setError(errorText(err)));
  }, []);
  if (!desktop()) return null;
  const save = async (patch: Partial<DesktopPreferences>) => {
    setBusy(true);
    setError("");
    try {
      const next = await desktop()!.preferences.set(patch);
      setPrefs((old) => ({ ...old, ...next }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-6 space-y-3 border-t border-line pt-4">
      <h3 className="tool-heading">{t("后台运行")}</h3>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      {prefs && (
        <>
          <label className="flex items-center justify-between gap-3 text-meta">
            <span>{t("关闭窗口后驻留托盘")}</span>
            <input
              type="checkbox"
              checked={prefs.closeToTray}
              disabled={busy || prefs.trayAvailable === false}
              onChange={(e) => void save({ closeToTray: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-meta">
            <span>{t("到期与离线系统通知")}</span>
            <input
              type="checkbox"
              checked={prefs.notifications}
              disabled={busy || prefs.notificationSupported === false}
              onChange={(e) => void save({ notifications: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-meta">
            <span>{t("到期前多少天开始提醒")}</span>
            <select
              aria-label={t("到期前多少天开始提醒")}
              value={prefs.reminderDays ?? 21}
              disabled={busy}
              onChange={(e) => void save({ reminderDays: Number(e.target.value) })}
              className="rounded-md border border-line bg-card px-2 py-1"
            >
              {[3, 7, 14, 21, 30, 60, 90].map((days) => (
                <option key={days} value={days}>
                  {t("{0} 天", days)}
                </option>
              ))}
            </select>
          </label>
          {prefs.trayAvailable === false && <p className="tool-error">{t("系统托盘不可用")}</p>}
          {prefs.notificationSupported === false && (
            <p className="tool-error">{t("系统通知不可用")}</p>
          )}
        </>
      )}
    </div>
  );
}
