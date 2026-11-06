import { CheckCircle2, CircleX, Loader2, Ban } from "lucide-react";
import type { TaskProgressItem } from "@/lib/task-progress";
import { t } from "@/lib/i18n";
import { AnimatePresence, m } from "motion/react";
import { useMotionPreset, useMotionPolicy } from "@/lib/motion";

export function TaskProgress({ items }: { items: TaskProgressItem[] }) {
  const animation = useMotionPreset("step");
  const mode = useMotionPolicy();
  return (
    <ol className="ai-task-progress" aria-live="polite" aria-label={t("实时任务进度")}>
      {items.map((item) => (
        <m.li key={item.id} data-status={item.status} {...animation}>
          <span className="ai-task-icon" aria-hidden="true">
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={item.status}
                initial={mode === "off" ? false : { opacity: 0, scale: mode === "full" ? 0.25 : 1 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: mode === "full" ? 0.25 : 1 }}
                transition={
                  mode === "full"
                    ? { type: "spring", duration: 0.3, bounce: 0 }
                    : { duration: mode === "off" ? 0 : 0.12 }
                }
              >
                {item.status === "running" ? (
                  <Loader2 className="animate-spin" />
                ) : item.status === "done" ? (
                  <CheckCircle2 />
                ) : item.status === "cancelled" ? (
                  <Ban />
                ) : (
                  <CircleX />
                )}
              </m.span>
            </AnimatePresence>
          </span>
          <div>
            <span>{item.label}</span>
            {item.detail && <p>{item.detail}</p>}
          </div>
          <small>
            {item.endedAt ? `${((item.endedAt - item.startedAt) / 1000).toFixed(1)}s` : t("进行中")}
          </small>
        </m.li>
      ))}
    </ol>
  );
}
