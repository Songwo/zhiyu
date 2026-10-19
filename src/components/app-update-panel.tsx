import { useEffect, useState } from "react";
import { Download, RefreshCw, RotateCw, ExternalLink } from "lucide-react";
import { desktop, type UpdateCheck } from "@/lib/desktop";
import { useDocuments } from "@/lib/documents";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";

export function AppUpdatePanel() {
  const api = desktop();
  const [status, setStatus] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const unsubscribe = api.updates.onStatus((next) => {
      if (alive) setStatus(next);
    });
    void api.updates
      .status()
      .then(async (next) => {
        if (next.state === "idle") next = await api.checkUpdate();
        if (alive) setStatus(next);
      })
      .catch((cause) => {
        if (alive) setError(String(cause.message));
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);
  async function run(action: "check" | "download" | "install") {
    if (!api || busy) return;
    setBusy(true);
    setError("");
    try {
      if (action === "install") {
        const documents = useDocuments.getState();
        for (const [id, state] of Object.entries(documents.status))
          if (state !== "saved") await documents.flush(id);
      }
      const next = action === "check" ? await api.checkUpdate() : await api.updates[action]();
      setStatus(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const working = busy || ["checking", "downloading", "installing"].includes(status?.state ?? "");
  const message =
    status?.state === "current"
      ? t("已是最新版本（{0}）", status.current)
      : status?.state === "outdated"
        ? t("有新版本 {0} 可用", status.latest ?? "")
        : status?.state === "downloading"
          ? t("正在下载更新 {0}%", Math.floor(status.progress ?? 0))
          : status?.state === "downloaded"
            ? t("更新已下载并校验，重启后完成安装。")
            : status?.state === "installing"
              ? t("正在重启安装，请稍候…")
              : status?.state === "checking"
                ? t("正在检查更新…")
                : status?.reason;
  return (
    <section
      className="mx-5 my-4 rounded-lg border border-line bg-canvas p-4"
      aria-label={t("软件更新")}
    >
      <h4 className="font-semibold text-body">{t("软件更新")}</h4>
      <p className="mt-2 text-meta leading-relaxed text-muted" role="status" aria-live="polite">
        {api ? t(message ?? "正在检查更新…") : t("应用内更新仅支持 Windows 正式安装版。")}
      </p>
      {status?.state === "downloading" && (
        <progress
          aria-label={t("更新下载进度")}
          className="mt-3 h-2 w-full accent-ink"
          max={100}
          value={status.progress ?? 0}
        />
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {status?.state === "outdated" && status.manual && (
          <Button
            size="sm"
            onClick={() =>
              void api?.openExternal("https://github.com/Songwo/zhiyu/releases/latest")
            }
          >
            <Download />
            {t("下载新版便携包")}
          </Button>
        )}
        {status?.state === "outdated" && !status.manual && (
          <Button size="sm" disabled={working} onClick={() => void run("download")}>
            <Download />
            {t("下载更新")}
          </Button>
        )}
        {status?.state === "downloaded" && (
          <Button size="sm" disabled={working} onClick={() => void run("install")}>
            <RotateCw />
            {t("重启并安装")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!api || working || status?.state === "downloaded"}
          onClick={() => void run("check")}
        >
          <RefreshCw className={working ? "motion-safe:animate-spin" : ""} />
          {t(status?.state === "error" ? "重试检查" : "检查更新")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!api}
          onClick={() => void api?.openExternal("https://github.com/Songwo/zhiyu/releases/latest")}
        >
          <ExternalLink />
          {t("发布页")}
        </Button>
      </div>
      {status?.state === "outdated" && status.manual && (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {t(
            "便携版不会自动安装。下载新的便携压缩包后，退出知屿，解压覆盖程序文件，保留 data 文件夹即可。",
          )}
        </p>
      )}
      {status?.state === "downloaded" && (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {t("安装将关闭并重新打开知屿，请先结束正在进行的终端或其他任务。")}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-meta text-crit">
          {t(error)}
        </p>
      )}
    </section>
  );
}
