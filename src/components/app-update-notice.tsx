import { Download, RefreshCw, CheckCircle2, X } from "lucide-react";
import { useAppUpdates } from "@/lib/app-updates";
import { useAppStore } from "@/lib/store";
import { isWeb } from "@/lib/web";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";

/** 常驻轻提示，不打开对话框、不抢焦点，也不自动安装或重启。 */
export function AppUpdateNotice() {
  const status = useAppUpdates((s) => s.status),
    dismissed = useAppUpdates((s) => s.dismissed);
  if (
    !status?.latest ||
    dismissed === status.latest ||
    !["outdated", "downloading", "downloaded"].includes(status.state)
  )
    return null;
  const downloading = status.state === "downloading",
    ready = status.state === "downloaded";
  const Icon = downloading ? RefreshCw : ready ? CheckCircle2 : Download;
  return (
    <aside
      aria-label={t("版本更新提醒")}
      className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-link/25 bg-link/5 px-4 py-3 text-meta sm:mx-6"
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-link" />
      <div className="min-w-0 flex-1" role="status" aria-live="polite">
        <p className="font-medium">
          {downloading
            ? t("正在后台下载 {0} · {1}%", status.latest, Math.floor(status.progress ?? 0))
            : ready
              ? t("新版 {0} 已下载，方便时再安装", status.latest)
              : t("知屿 {0} 可以更新了", status.latest)}
        </p>
        <p className="mt-0.5 text-2xs text-muted">
          {t(
            isWeb()
              ? "由部署管理员更新镜像；当前页面不会自动升级或刷新。"
              : status.manualKind === "platform"
                ? "请下载对应芯片架构的新版应用；当前操作不受影响。"
                : status.manual
                  ? "便携版需下载新版压缩包，保留 data 文件夹；当前操作不受影响。"
                  : "你可以继续编辑和使用终端；确认安装前不会重启。",
          )}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          const s = useAppStore.getState();
          s.setSettingsTab("about");
          s.setSettingsOpen(true);
        }}
      >
        {t("查看更新")}
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("本次暂不提醒")}
        onClick={() => useAppUpdates.getState().dismiss()}
      >
        <X />
      </Button>
    </aside>
  );
}
