import { CheckCircle2, CircleX, Loader2, Ban } from "lucide-react";
import type { TaskProgressItem } from "@/lib/task-progress";
import { t } from "@/lib/i18n";

export function TaskProgress({ items }: { items: TaskProgressItem[] }) {
  return (
    <ol className="ai-task-progress" aria-live="polite" aria-label={t("实时任务进度")}>
      {items.map((item) => (
        <li key={item.id} data-status={item.status}>
          {item.status === "running" ? (
            <Loader2 className="animate-spin" />
          ) : item.status === "done" ? (
            <CheckCircle2 />
          ) : item.status === "cancelled" ? (
            <Ban />
          ) : (
            <CircleX />
          )}
          <div>
            <span>{item.label}</span>
            {item.detail && <p>{item.detail}</p>}
          </div>
          <small>
            {item.endedAt ? `${((item.endedAt - item.startedAt) / 1000).toFixed(1)}s` : t("进行中")}
          </small>
        </li>
      ))}
    </ol>
  );
}
