import {
  ArrowUp,
  CalendarArrowDown,
  Download,
  File,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Unlink,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Select } from "./ui/input";
import { AssetPicker } from "./asset-picker";
import { desktop, type DesktopPreferences, type SftpEntry } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import {
  assetEntries,
  calendarItems,
  createCalendar,
  refKey,
  type AssetRef,
} from "@/lib/operations";
import { useAppStore } from "@/lib/store";
import { KIND_LABEL } from "@/lib/status";
import { useVault } from "@/lib/vault-state";
import { downloadText, formatDate } from "@/lib/utils";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function CalendarExport() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={t("导出提醒日历")}
      aria-label={t("导出提醒日历")}
      onClick={() => {
        const items = calendarItems(useAppStore.getState());
        if (!items.length) {
          toast(t("没有待处理的事项，全部正常。"));
          return;
        }
        downloadText("zhiyu-reminders.ics", createCalendar(items), "text/calendar;charset=utf-8");
        toast(t("已导出 {0} 项提醒", items.length));
      }}
    >
      <CalendarArrowDown className="size-4" />
    </Button>
  );
}

export function AssetRelations({ asset }: { asset: AssetRef }) {
  const state = useAppStore();
  const [selected, setSelected] = useState("");
  const [multiple, setMultiple] = useState<string[]>([]);
  const [batch, setBatch] = useState(false);
  const entries = assetEntries(state);
  const self = refKey(asset);
  const related = state.links.flatMap((link) =>
    refKey(link.from) === self ? [link.to] : refKey(link.to) === self ? [link.from] : [],
  );
  const choices = entries.filter(
    (entry) => refKey(entry) !== self && !related.some((ref) => refKey(ref) === refKey(entry)),
  );
  return (
    <section className="detail-section">
      <h3 className="tool-heading">
        <Link2 className="size-4" />
        {t("关联资产")}
      </h3>
      {related.length === 0 && <p className="tool-empty">{t("尚未关联资产")}</p>}
      <ul className="divide-y divide-line">
        {related.map((ref) => {
          const entry = entries.find((x) => refKey(x) === refKey(ref));
          if (!entry) return null;
          return (
            <li key={refKey(ref)} className="flex min-w-0 items-center gap-2 py-2">
              <button
                className="min-w-0 flex-1 text-left text-meta hover:underline"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  state.setExpanded({
                    ...ref,
                    origin: { x: r.x, y: r.y, w: r.width, h: r.height },
                  });
                }}
              >
                <span className="mr-2 text-subtle">{t(KIND_LABEL[ref.kind])}</span>
                <span className="break-words">{entry.label}</span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("解除关联")}
                aria-label={t("解除关联")}
                onClick={() => state.unlinkAssets(asset, ref)}
              >
                <Unlink className="size-4" />
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex min-w-0 gap-2">
        <Select
          className="min-w-0 flex-1 text-meta"
          aria-label={t("选择关联资产")}
          value={choices.some((x) => refKey(x) === selected) ? selected : ""}
          onValueChange={setSelected}
          options={[
            { value: "", label: t("选择关联资产") },
            ...choices.map((entry) => ({
              value: refKey(entry),
              label: entry.label,
              description: t(KIND_LABEL[entry.kind]),
            })),
          ]}
        />
        <Button
          variant="outline"
          size="icon-sm"
          disabled={!choices.some((x) => refKey(x) === selected)}
          title={t("添加关联")}
          aria-label={t("添加关联")}
          onClick={() => {
            const target = choices.find((x) => refKey(x) === selected);
            if (target) {
              state.linkAssets(asset, target);
              setSelected("");
            }
          }}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <Button
        variant="ghost"
        className="mt-2"
        aria-expanded={batch}
        onClick={() => setBatch(!batch)}
      >
        {t("搜索与多选关联")}
      </Button>
      {batch && (
        <div className="mt-2 space-y-3">
          <AssetPicker
            label={t("选择多个关联资产")}
            entries={choices}
            selected={multiple}
            onChange={setMultiple}
          />
          <Button
            disabled={!choices.some((entry) => multiple.includes(refKey(entry)))}
            onClick={() => {
              state.linkAssetsMany(
                asset,
                choices.filter((entry) => multiple.includes(refKey(entry))),
              );
              setMultiple([]);
            }}
          >
            <Plus className="mr-2 size-4" />
            {t("添加所选关联")}
          </Button>
        </div>
      )}
    </section>
  );
}

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
    const bridge = desktop();
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
          disabled={!desktop() || busy}
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
      {!desktop() && <p className="tool-empty">{t("文件浏览需要桌面版")}</p>}
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
                          if (await desktop()?.sftp.download(serverId, join(entry.name)))
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

export function DesktopSettings() {
  const [prefs, setPrefs] = useState<DesktopPreferences | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const bridge = desktop();
    if (bridge)
      void bridge.preferences
        .get()
        .then(setPrefs)
        .catch((err) => setError(errorText(err)));
  }, []);
  if (!desktop()) return null;
  const save = async (patch: Partial<DesktopPreferences>) => {
    setBusy(true);
    setError("");
    try {
      const next = await desktop()!.preferences.set(patch);
      setPrefs((old) => ({ ...old, ...next }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-6 space-y-3 border-t border-line pt-4">
      <h3 className="tool-heading">{t("后台运行")}</h3>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      {prefs && (
        <>
          <label className="flex items-center justify-between gap-3 text-meta">
            <span>{t("关闭窗口后驻留托盘")}</span>
            <input
              type="checkbox"
              checked={prefs.closeToTray}
              disabled={busy || prefs.trayAvailable === false}
              onChange={(e) => void save({ closeToTray: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-meta">
            <span>{t("到期与离线系统通知")}</span>
            <input
              type="checkbox"
              checked={prefs.notifications}
              disabled={busy || prefs.notificationSupported === false}
              onChange={(e) => void save({ notifications: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-meta">
            <span>{t("到期前多少天开始提醒")}</span>
            <select
              aria-label={t("到期前多少天开始提醒")}
              value={prefs.reminderDays ?? 21}
              disabled={busy}
              onChange={(e) => void save({ reminderDays: Number(e.target.value) })}
              className="rounded-md border border-line bg-card px-2 py-1"
            >
              {[3, 7, 14, 21, 30, 60, 90].map((days) => (
                <option key={days} value={days}>
                  {t("{0} 天", days)}
                </option>
              ))}
            </select>
          </label>
          {prefs.trayAvailable === false && <p className="tool-error">{t("系统托盘不可用")}</p>}
          {prefs.notificationSupported === false && (
            <p className="tool-error">{t("系统通知不可用")}</p>
          )}
        </>
      )}
    </div>
  );
}
