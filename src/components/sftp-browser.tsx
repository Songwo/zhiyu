import { hostBridge } from "@/lib/web-bridge";
import { ArrowUp, Download, File, Folder, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import type { SftpEntry } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import { useVault } from "@/lib/vault-state";
import { formatDate } from "@/lib/utils";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function SftpBrowser({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(".");
  const [draft, setDraft] = useState(".");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState("");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const requireVault = useVault((s) => s.require);
  async function load(next: string) {
    const bridge = hostBridge();
    if (!bridge) return;
    const token = ++request.current;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.sftp.list(serverId, next);
      if (token !== request.current) return;
      setEntries(result.entries);
      setPath(result.path);
      setDraft(result.path);
      setTruncated(result.truncated);
    } catch (err) {
      if (token === request.current) setError(errorText(err));
    } finally {
      if (token === request.current) setBusy(false);
    }
  }
  const join = (name: string) => `${path.replace(/\/$/, "")}/${name}`;
  return (
    <section className="detail-section">
      <div className="flex items-center justify-between gap-3">
        <h3 className="tool-heading">
          <FolderOpen className="size-4" />
          SFTP
        </h3>
        <Button
          variant="outline"
          size="sm"
          disabled={!hostBridge() || busy}
          onClick={async () => {
            if (open) {
              setOpen(false);
              return;
            }
            if (!(await requireVault(t("浏览文件需要先解锁密钥库。")))) return;
            setOpen(true);
            void load(path);
          }}
        >
          {open ? t("收起") : t("浏览文件")}
        </Button>
      </div>
      {!hostBridge() && <p className="tool-empty">{t("文件浏览需要桌面版")}</p>}
      {open && (
        <div className="mt-3 space-y-3">
          <form
            className="flex min-w-0 gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void load(draft);
            }}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy || path === "/"}
              title={t("上级目录")}
              aria-label={t("上级目录")}
              onClick={() => void load(join(".."))}
            >
              <ArrowUp className="size-4" />
            </Button>
            <input
              className="tool-input min-w-0 flex-1 font-mono"
              aria-label={t("远程路径")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              title={t("打开")}
              aria-label={t("打开")}
            >
              <FolderOpen className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              title={t("刷新")}
              aria-label={t("刷新")}
              onClick={() => void load(path)}
            >
              <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
            </Button>
          </form>
          <input
            className="tool-input w-full"
            aria-label={t("筛选文件")}
            placeholder={t("筛选文件")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          {truncated && <p className="text-meta text-warn">{t("目录过大，仅显示前 10000 项")}</p>}
          <ul className="file-list" aria-busy={busy}>
            {entries
              .filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
              .map((entry) => (
                <li className="file-row" key={entry.name}>
                  {entry.directory ? (
                    <Folder className="size-4 text-muted" />
                  ) : (
                    <File className="size-4 text-subtle" />
                  )}
                  <button
                    className="min-w-0 flex-1 truncate text-left font-mono text-meta disabled:cursor-default"
                    title={entry.name}
                    disabled={busy || (!entry.directory && !entry.symlink)}
                    onClick={() => void load(join(entry.name))}
                  >
                    {entry.name}
                    {entry.symlink ? " ↗" : ""}
                  </button>
                  <span className="hidden text-2xs text-subtle sm:inline">
                    {Number.isFinite(entry.modified)
                      ? formatDate(new Date(entry.modified).toISOString())
                      : "-"}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-2xs text-subtle">
                    {entry.directory
                      ? "-"
                      : entry.size < 1024
                        ? `${entry.size} B`
                        : entry.size < 1048576
                          ? `${(entry.size / 1024).toFixed(1)} KB`
                          : `${(entry.size / 1048576).toFixed(1)} MB`}
                  </span>
                  {!entry.directory && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={Boolean(downloading)}
                      aria-label={t("下载 {0}", entry.name)}
                      title={t("下载 {0}", entry.name)}
                      onClick={async () => {
                        setDownloading(entry.name);
                        setError("");
                        try {
                          if (await hostBridge()?.sftp.download(serverId, join(entry.name)))
                            toast(t("下载完成"));
                        } catch (err) {
                          setError(errorText(err));
                        } finally {
                          setDownloading("");
                        }
                      }}
                    >
                      {downloading === entry.name ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                    </Button>
                  )}
                </li>
              ))}
          </ul>
          {!busy &&
            !entries.some((entry) => entry.name.toLowerCase().includes(query.toLowerCase())) && (
              <p className="tool-empty">{query ? t("没有匹配项") : t("空目录")}</p>
            )}
          {busy && (
            <p className="tool-empty" role="status">
              {t("读取中…")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
