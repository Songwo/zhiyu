import { hostBridge } from "@/lib/web-bridge";
import { isWeb } from "@/lib/web";
import { useEffect, useState } from "react";
import { Database, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { clearImageGrants, imageGrantCount } from "@/lib/mail-image-grants";
import { Button } from "./ui/button";

type StorageStats = {
  files: Record<string, number>;
  cache: { dirs: Record<string, number>; total: number };
  mail: { folders: number; pages: number; messages: number; bytes: number };
};

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function StorageSettings() {
  const api = hostBridge()?.storage;
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [grants, setGrants] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api
      .stats()
      .then((value) => {
        if (alive) setStats(value);
      })
      .catch((error: Error) => {
        if (alive) toast.error(error.message);
      });
    if (alive) setGrants(imageGrantCount());
    return () => {
      alive = false;
    };
  }, [api]);
  async function clear(scope: "mail" | "chromium") {
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.clear(scope);
      setStats(await api.stats());
      toast.success(scope === "mail" ? t("已清空邮件会话缓存") : t("已清理网页缓存"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  if (!api) return <p>{t("存储管理仅在桌面版可用。")}</p>;
  const fileEntries = Object.entries(stats?.files ?? {});
  const filesTotal = fileEntries.reduce((sum, [, size]) => sum + size, 0);
  return (
    <section className="space-y-5">
      <div className="flex items-center gap-3">
        <Database className="size-5 text-muted" />
        <h3 className="text-lg font-semibold">{t("存储")}</h3>
      </div>
      <p className="text-meta text-muted">
        {isWeb()
          ? t(
              "以下是服务器资料目录里各文件的大小。网页版没有本机缓存，界面资源由浏览器自己缓存，清除浏览器的站点数据即可。",
            )
          : t(
              "缓存只影响速度，不影响数据：清理后首次访问会稍慢。资产、密钥库和凭据文件不属于缓存，不会被清理。",
            )}
      </p>
      {!stats ? (
        <p role="status" className="flex items-center gap-2 text-meta">
          <Loader2 className="size-4 animate-spin" />
          {t("正在读取存储信息…")}
        </p>
      ) : (
        <>
          <div>
            <h4 className="mb-2 font-semibold">{t("数据文件")}</h4>
            <dl className="divide-y divide-line text-meta">
              {fileEntries.map(([name, size]) => (
                <div key={name} className="flex items-center justify-between gap-3 py-2">
                  <dt className="break-all font-mono text-muted">{name}</dt>
                  <dd>{formatBytes(size)}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 py-2 font-semibold">
                <dt>{t("合计")}</dt>
                <dd>{formatBytes(filesTotal)}</dd>
              </div>
            </dl>
          </div>
          {!isWeb() && (
            <>
              <div className="border-t border-line pt-4">
                <h4 className="mb-2 font-semibold">{t("会话缓存（内存）")}</h4>
                <p className="mb-3 text-meta text-muted">
                  {t(
                    "邮件会话缓存：{0} 个文件夹列表 · {1} 页邮件列表 · {2} 封已解析邮件（约 {3}）",
                    stats.mail.folders,
                    stats.mail.pages,
                    stats.mail.messages,
                    formatBytes(stats.mail.bytes),
                  )}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void clear("mail")}
                >
                  <Trash2 className="size-4" />
                  {t("清空邮件会话缓存")}
                </Button>
              </div>
              <div className="border-t border-line pt-4">
                <h4 className="mb-2 font-semibold">{t("网页缓存（界面资源）")}</h4>
                <p className="mb-3 text-meta text-muted">
                  {t("当前占用 {0}", formatBytes(stats.cache.total))}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void clear("chromium")}
                >
                  <Trash2 className="size-4" />
                  {t("清理网页缓存")}
                </Button>
              </div>
            </>
          )}
          <div className="border-t border-line pt-4">
            <h4 className="mb-2 font-semibold">{t("图片授权记忆")}</h4>
            <p className="mb-3 text-meta text-muted">
              {t("已记住 {0} 封邮件的外部图片授权；清除后所有邮件重新询问。", grants)}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || grants === 0}
              onClick={() => {
                clearImageGrants();
                setGrants(0);
                toast.success(t("已清除图片授权记忆"));
              }}
            >
              <Trash2 className="size-4" />
              {t("清除图片授权记忆")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
