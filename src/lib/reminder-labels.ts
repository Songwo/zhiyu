import { t } from "./i18n";
import type { Reminder } from "./types";

export const REPEAT_LABEL: Record<Reminder["repeat"], string> = {
  none: "不重复",
  week: "每周",
  month: "每月",
  year: "每年",
};

/** 倒计时文字：今天 / N 天后 / 已过期 N 天。 */
export function countdown(days: number) {
  return days === 0 ? t("今天") : days > 0 ? t("{0} 天后", days) : t("已过期 {0} 天", -days);
}
