import { chipClass, dotClass, STATUS_LABEL } from "@/lib/status";
import type { Status } from "@/lib/types";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function StatusBadge({
  status,
  sonar = true,
  pending = false,
  pendingLabel,
  className,
}: {
  status: Status;
  sonar?: boolean;
  pending?: boolean;
  pendingLabel?: string;
  className?: string;
}) {
  if (pending)
    return (
      <span
        className={cn(
          "chip inline-flex items-center gap-1.5 border border-line bg-surface text-muted",
          className,
        )}
        data-status={pendingLabel ? "paused" : "pending"}
      >
        <span className="size-1.5 rounded-full bg-muted" />
        <span>{pendingLabel ?? t("未采集")}</span>
      </span>
    );
  return (
    <span
      key={status}
      className={cn(
        chipClass(status),
        "status-feedback inline-flex items-center gap-1.5",
        className,
      )}
      data-status={status}
    >
      {sonar ? (
        <span className="sonar-beacon">
          <span
            className={cn(
              "sonar-ring",
              status === "warning" && "sonar-ring-warn",
              status === "offline" && "sonar-ring-crit",
            )}
          />
          <span
            className={cn(
              "live-dot",
              status === "warning" && "live-dot-warn",
              status === "offline" && "live-dot-crit",
            )}
          />
        </span>
      ) : (
        <span className={dotClass(status)} />
      )}
      <span>{t(STATUS_LABEL[status])}</span>
    </span>
  );
}
