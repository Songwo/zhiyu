import { RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "../ui/button";
import { dateText, type useInventory } from "./data";

export function FetchStatus({ busy, error, data, refresh }: ReturnType<typeof useInventory>) {
  return (
    <div className="integration-fetch-status">
      <div className="min-w-0 flex-1">
        {error ? (
          <p role="alert" className="tool-error">
            {error}
          </p>
        ) : (
          <p className="text-2xs text-muted">
            {data ? t("上次同步：{0}", dateText(data.fetchedAt)) : t("正在加载…")}
            {data?.cached ? ` · ${t("缓存")}` : ""}
          </p>
        )}
        {error && data && <p className="text-2xs text-muted">{t("正在显示上次成功同步的数据")}</p>}
      </div>
      <Button variant="ghost" size="sm" disabled={busy} onClick={refresh}>
        <RefreshCw className={busy ? "animate-spin" : ""} />
        {t("刷新")}
      </Button>
    </div>
  );
}

export function ResourceStatus({ status }: { status: string }) {
  const labels: Record<string, string> = {
    online: "在线",
    offline: "离线",
    pending: "等待上报",
    up: "正常",
    down: "异常",
    active: "已激活",
    healthy: "健康",
    inactive: "未激活",
    degraded: "降级",
    unknown: "未知",
    down_error: "异常",
  };
  return (
    <span className="integration-status" data-status={status}>
      {t(labels[status] ?? "未知")}
    </span>
  );
}
