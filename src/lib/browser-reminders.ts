import { useEffect } from "react";
import { attentionLine, notificationCandidates } from "../../electron/services/notifications.mjs";
import { isDesktop } from "./desktop";
import { snapshotOf, useAppStore } from "./store";

const SEEN_KEY = "zhiyu-browser-reminders";

/** 读写「今天已经提醒过哪些」；隐私模式下读写失败就当没提醒过。 */
function seen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * 网页版：页面打开且已授权浏览器通知时，每分钟检查一次到期与备忘提醒，
 * 同一件事每天最多提醒一次。桌面版由主进程发系统通知，这里不重复。
 */
export function useBrowserReminders() {
  useEffect(() => {
    if (isDesktop() || typeof Notification === "undefined") return;
    const check = () => {
      if (Notification.permission !== "granted" || !useAppStore.getState().hydrated) return;
      const today = new Date().toDateString();
      const done = seen();
      const items = notificationCandidates(snapshotOf(useAppStore.getState()), Date.now()).filter(
        (item) => item.reason !== "offline" && done[item.key] !== today,
      );
      if (!items.length) return;
      new Notification("知屿提醒", {
        body: items
          .slice(0, 5)
          .map((item) => attentionLine(item))
          .join("\n"),
      });
      const next = Object.fromEntries(Object.entries(done).filter(([, day]) => day === today));
      for (const item of items) next[item.key] = today;
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(next));
      } catch {
        // 写不进去时下一分钟可能再提醒一次，不影响使用。
      }
    };
    check();
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, []);
}
