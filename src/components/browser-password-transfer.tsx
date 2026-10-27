import { isWeb } from "@/lib/web";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  FileKey2,
  Globe2,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import { useVault } from "@/lib/vault-state";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import "./browser-password-transfer.css";

type PasswordBridge = NonNullable<ReturnType<typeof desktop>>["passwords"];
type Preview = NonNullable<Awaited<ReturnType<PasswordBridge["previewImport"]>>>;
type Browser = "chrome" | "edge";

const BROWSERS = {
  chrome: { name: "Chrome", address: "chrome://password-manager/settings" },
  edge: { name: "Edge", address: "edge://wallet/passwords" },
};

function statusLabel(status: string) {
  if (status === "new" || status === "added") return t("可导入");
  if (status === "duplicate") return t("完全重复");
  if (status === "conflict") return t("密码冲突");
  return t("无效记录");
}

/** 密码只由主进程解析和写入；此界面只接收可撤销票据与无密码预览。 */
export function BrowserPasswordTransfer({ close }: { close: () => void }) {
  const bridge = desktop()?.passwords;
  const [direction, setDirection] = useState<"import" | "export">("import");
  const [browser, setBrowser] = useState<Browser>("chrome");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [exported, setExported] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exportConsent, setExportConsent] = useState(false);
  const generation = useRef(0);
  const ticket = useRef<string | null>(null);
  const mounted = useRef(true);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);

  function discardPreview() {
    const current = ticket.current;
    ticket.current = null;
    setPreview(null);
    if (current) void bridge?.cancelImport(current).catch(() => {});
  }

  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      generation.current++;
    };
    const clear = () => {
      invalidate();
      const current = ticket.current;
      ticket.current = null;
      setPreview(null);
      setResult(null);
      setExported(null);
      setExportConsent(false);
      setError("");
      if (current) void bridge?.cancelImport(current).catch(() => {});
    };
    const offVault = desktop()?.onVaultChanged(clear);
    const offState = useVault.subscribe((state, previous) => {
      if (!state.unlocked && previous.unlocked) clear();
    });
    return () => {
      mounted.current = false;
      invalidate();
      offVault?.();
      offState();
      const current = ticket.current;
      ticket.current = null;
      if (current) void bridge?.cancelImport(current).catch(() => {});
    };
  }, [bridge]);

  async function chooseFile() {
    if (!bridge || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (
        !(await useVault.getState().require(t("导入浏览器密码需要先解锁密钥库。"))) ||
        !mounted.current
      )
        return;
      discardPreview();
      const current = ++generation.current;
      const value = await bridge.previewImport();
      if (!mounted.current || current !== generation.current || !useVault.getState().unlocked) {
        if (value) void bridge.cancelImport(value.ticket).catch(() => {});
        return;
      }
      ticket.current = value?.ticket ?? null;
      setPreview(value);
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : t("读取密码文件失败"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function commit() {
    if (!bridge || !preview || busy) return;
    setBusy(true);
    setError("");
    const current = generation.current;
    try {
      const value = await bridge.commitImport(preview.ticket);
      // 后台可能同时推送新账号；按 id 合并，保留界面尚未写回的其他资料。
      await useAppStore.setState((state) => ({
        secrets: [
          ...state.secrets,
          ...value.assets.filter(
            (asset) => !state.secrets.some((existing) => existing.id === asset.id),
          ),
        ],
      }));
      if (!mounted.current || current !== generation.current) return;
      ticket.current = null;
      setPreview(null);
      setResult({ imported: value.imported, skipped: value.skipped });
    } catch (caught) {
      if (mounted.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("导入失败，请重新选择文件后重试。"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function exportFile() {
    if (!bridge || busy || !exportConsent) return;
    setBusy(true);
    setError("");
    setExported(null);
    try {
      if (
        !(await useVault.getState().require(t("导出浏览器密码需要先解锁密钥库。"))) ||
        !mounted.current
      )
        return;
      const current = generation.current;
      const value = await bridge.exportCsv();
      if (
        value &&
        mounted.current &&
        current === generation.current &&
        useVault.getState().unlocked
      ) {
        setExported(value.count);
        setExportConsent(false);
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : t("导出密码失败"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function switchDirection(value: "import" | "export") {
    if (busy || value === direction) return;
    generation.current++;
    discardPreview();
    setResult(null);
    setExported(null);
    setExportConsent(false);
    setError("");
    setDirection(value);
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="editor-backdrop password-transfer-enter" />
        <Dialog.Content
          className="editor-dialog password-transfer-enter"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
          }}
        >
          <div className="editor-heading">
            <div className="flex items-center gap-3">
              <FileKey2 className="size-5 text-link" />
              <Dialog.Title className="text-lg font-semibold">{t("浏览器密码")}</Dialog.Title>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("关闭")}
              onClick={close}
              disabled={busy}
            >
              <X />
            </Button>
          </div>
          <div className="editor-scroll space-y-5">
            <Dialog.Description className="text-meta leading-relaxed text-muted">
              {t("在 Chrome、Edge 与知屿之间迁移账号，让同一网站的每个账号各归其位。")}
            </Dialog.Description>
            <div
              className="grid grid-cols-2 gap-2 rounded-lg bg-canvas p-1.5"
              role="group"
              aria-label={t("迁移方向")}
            >
              <Button
                variant={direction === "import" ? "solid" : "ghost"}
                aria-pressed={direction === "import"}
                onClick={() => switchDirection("import")}
                disabled={busy}
              >
                <ArrowDownToLine />
                {t("导入到知屿")}
              </Button>
              <Button
                variant={direction === "export" ? "solid" : "ghost"}
                aria-pressed={direction === "export"}
                onClick={() => switchDirection("export")}
                disabled={busy}
              >
                <ArrowUpFromLine />
                {t("导出到浏览器")}
              </Button>
            </div>
            {!preview && (
              <div className="space-y-3 rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-meta font-medium">
                    <Globe2 className="size-4 text-muted" />
                    {t(direction === "import" ? "选择来源浏览器" : "选择目标浏览器")}
                  </span>
                  <div className="flex gap-1" role="group" aria-label={t("浏览器类型")}>
                    {(Object.keys(BROWSERS) as Browser[]).map((key) => (
                      <Button
                        key={key}
                        size="sm"
                        className="min-h-11"
                        variant={browser === key ? "secondary" : "ghost"}
                        aria-pressed={browser === key}
                        disabled={busy}
                        onClick={() => setBrowser(key)}
                      >
                        {BROWSERS[key].name}
                      </Button>
                    ))}
                  </div>
                </div>
                <p className="text-meta leading-relaxed text-muted">
                  {direction === "import"
                    ? t(
                        "复制下方地址，在 {0} 地址栏粘贴打开密码设置，选择「导出密码」，再把 CSV 文件导入这里。浏览器可能要求验证系统身份。",
                        BROWSERS[browser].name,
                      )
                    : t(
                        "导出后，复制下方地址到 {0} 地址栏，在密码设置中选择「导入密码」，选择刚保存的 CSV。浏览器版本不同，入口可能位于设置或更多菜单。",
                        BROWSERS[browser].name,
                      )}
                </p>
                <div className="flex min-w-0 items-center gap-2 rounded-md bg-canvas pl-3 text-ink">
                  <code className="min-w-0 flex-1 break-all text-meta">
                    {BROWSERS[browser].address}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("复制密码设置地址")}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(BROWSERS[browser].address)
                        .then(() => toast.success(t("地址已复制，请粘贴到浏览器地址栏。")))
                        .catch(() => setError(t("复制失败，请手动选择上方地址。")));
                    }}
                  >
                    <Copy />
                  </Button>
                </div>
              </div>
            )}
            {direction === "import" ? (
              <>
                <div className="flex gap-3 text-meta leading-relaxed text-muted">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-link" />
                  <p>
                    {t(
                      "同站不同账号独立保存。完全重复的记录会跳过；同账号密码不同的冲突会保留原记录并跳过导入。预览不展示密码，确认后加密保存到本机。",
                    )}
                  </p>
                </div>
                {preview && (
                  <div className="space-y-3" aria-label={t("导入预览")}>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {[
                        { label: t("新增账号"), value: preview.added },
                        { label: t("完全重复"), value: preview.duplicates },
                        { label: t("密码冲突"), value: preview.conflicts },
                        { label: t("无效记录"), value: preview.invalid },
                      ].map((item) => (
                        <div key={item.label} className="rounded-md bg-canvas px-3 py-3 text-ink">
                          <span className="block text-xl font-semibold tabular-nums">
                            {item.value}
                          </span>
                          <span className="text-meta text-muted">{item.label}</span>
                        </div>
                      ))}
                    </div>
                    <div className="max-h-64 overflow-auto rounded-md border border-line">
                      <table className="w-full table-fixed text-left text-meta">
                        <caption className="sr-only">{t("不包含密码的账号预览")}</caption>
                        <thead className="sticky top-0 bg-canvas text-muted">
                          <tr>
                            <th className="w-2/5 px-3 py-2 font-medium" scope="col">
                              {t("网站")}
                            </th>
                            <th className="w-2/5 px-3 py-2 font-medium" scope="col">
                              {t("账户名")}
                            </th>
                            <th className="w-1/5 px-2 py-2 font-medium" scope="col">
                              {t("状态")}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {preview.rows.map((row, index) => (
                            <tr key={index}>
                              <td className="break-all px-3 py-3 align-top">
                                <span className="block font-medium">
                                  {row.title || t("未命名账号")}
                                </span>
                                <span className="text-2xs text-muted">{row.url}</span>
                              </td>
                              <td className="break-all px-3 py-3 align-top">
                                {row.username || "—"}
                              </td>
                              <td
                                className={cn(
                                  "break-words px-2 py-3 align-top",
                                  row.status === "conflict" ? "text-crit" : "text-muted",
                                )}
                              >
                                {statusLabel(row.status)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-meta text-muted">
                      {t("共 {0} 条记录；预览显示 {1} 条。", preview.total, preview.rows.length)}
                    </p>
                    {preview.conflicts > 0 && (
                      <p className="text-meta leading-relaxed text-muted">
                        {t(
                          "冲突账号不会覆盖。请核对现有账号，在账号详情中手动更新需要保留的密码。",
                        )}
                      </p>
                    )}
                  </div>
                )}
                {result && (
                  <div role="status" className="flex gap-3 rounded-lg bg-canvas p-4 text-ink">
                    <Check className="mt-0.5 size-5 shrink-0 text-link" />
                    <div>
                      <p className="font-medium">{t("已导入 {0} 个账号", result.imported)}</p>
                      <p className="mt-1 text-meta text-muted">
                        {t(
                          "跳过 {0} 条重复、冲突或无效记录。账号已加入密钥库，请删除浏览器导出的明文 CSV。",
                          result.skipped,
                        )}
                      </p>
                    </div>
                  </div>
                )}
                {!preview && !result && (
                  <p className="text-meta text-muted">
                    {t("支持 Chrome / Edge 标准 CSV，最多 10 MiB、10,000 条记录。")}
                  </p>
                )}
              </>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-line bg-canvas p-4 text-ink">
                  <h4 className="flex items-center gap-2 font-medium">
                    <FileKey2 className="size-5" />
                    {t("导出的 CSV 含明文密码")}
                  </h4>
                  <p className="mt-2 text-meta leading-relaxed text-muted">
                    {t(
                      "用于浏览器导入，任何拿到文件的人都能读取账号和密码。请保存在自己的本机目录，导入浏览器后删除；不要用表格软件打开或共享此文件。",
                    )}
                  </p>
                  <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 py-2 text-meta leading-relaxed">
                    <input
                      className="mt-1 size-4 shrink-0 accent-ink"
                      type="checkbox"
                      checked={exportConsent}
                      disabled={busy}
                      onChange={(event) => setExportConsent(event.target.checked)}
                    />
                    <span>{t("我了解明文风险，导入浏览器后会删除 CSV 文件。")}</span>
                  </label>
                </div>
                <p className="text-meta leading-relaxed text-muted">
                  {t(
                    "导出密钥库中有网站地址的账号密码，保留同站多个账号。API Key、SSH 私钥和无网站地址的记录不导出。保存前还需在系统对话框确认。",
                  )}
                </p>
                {exported !== null && (
                  <p role="status" className="flex items-center gap-2 text-meta">
                    <Check className="size-5 text-link" />
                    {t("已导出 {0} 个账号。请到浏览器的密码设置完成导入。", exported)}
                  </p>
                )}
              </div>
            )}
            {!bridge && (
              <p className="text-meta text-muted">
                {isWeb()
                  ? t(
                      "CSV 迁移要读写这台电脑上的文件并弹出系统确认框，只在桌面版提供。网页版可以用桌面版迁移后，通过「设置 → 数据」的加密备份恢复过来。",
                    )
                  : t("仅桌面版可用")}
              </p>
            )}
            {error && (
              <p role="alert" className="break-words text-meta text-crit">
                {error}
              </p>
            )}
          </div>
          <div className="editor-footer flex-wrap" aria-busy={busy}>
            <Button variant="ghost" size="sm" disabled={busy} onClick={close}>
              {t(result || exported !== null ? "完成" : "取消")}
            </Button>
            {direction === "import" ? (
              <>
                {preview && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void chooseFile()}
                  >
                    {t("重新选择")}
                  </Button>
                )}
                <Button
                  disabled={!bridge || busy || (preview !== null && preview.added === 0)}
                  onClick={() => void (preview ? commit() : chooseFile())}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
                  {preview ? t("导入 {0} 个账号", preview.added) : t("选择 CSV 文件")}
                </Button>
              </>
            ) : (
              <Button
                disabled={!bridge || busy || !exportConsent}
                onClick={() => void exportFile()}
              >
                {busy ? <Loader2 className="animate-spin" /> : <ArrowUpFromLine />}
                {t("导出 CSV 文件")}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
