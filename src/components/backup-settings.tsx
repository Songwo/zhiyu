import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Archive, FolderOpen, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  ASSET_KIND_LABELS,
  SECURE_FILE_LABELS,
  type AutoBackupStatus,
  type BackupPreview,
  type RestoreOutcome,
} from "@/lib/backup";
import { desktop } from "@/lib/desktop";
import { isWeb, webDownloadBackup, webRestoreBackup } from "@/lib/web";
import { intlLocale, t } from "@/lib/i18n";
import { useVault } from "@/lib/vault-state";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const when = (value: string | number) =>
  new Date(value).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {hint && <p className="mt-1 text-meta leading-relaxed text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** 「设置 → 数据」中的加密备份、从备份恢复与自动备份。 */
export function BackupSettings() {
  const api = desktop()?.backup;
  const [info, setInfo] = useState<{
    lastRestore: RestoreOutcome | null;
    secureAvailable: boolean;
  } | null>(null);
  useEffect(() => {
    if (!api) return;
    void api
      .info()
      .then(setInfo)
      .catch(() => {});
  }, [api]);
  if (!api) return isWeb() ? <WebBackup /> : null;
  return (
    <>
      <CreateBackup secureAvailable={info?.secureAvailable ?? false} />
      <RestoreBackup lastRestore={info?.lastRestore ?? null} />
      <AutoBackup />
    </>
  );
}

function CreateBackup({ secureAvailable }: { secureAvailable: boolean }) {
  const api = desktop()!.backup;
  const unlocked = useVault((s) => s.unlocked);
  const requireVault = useVault((s) => s.require);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [includeSecure, setIncludeSecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(t("两次输入的备份密码不一致"));
      return;
    }
    if (includeSecure && !unlocked) {
      const ok = await requireVault(t("包含系统保护的凭据需要先解锁密钥库。"));
      if (!ok) return;
    }
    setBusy(true);
    try {
      const result = await api.create({ password, includeSecure });
      if (!result) return;
      setPassword("");
      setConfirm("");
      setOpen(false);
      const failed = result.preview.secure.failed.length;
      toast.success(
        t(
          "已创建加密备份 {0}：{1} 项资产、{2} 篇文档",
          result.file,
          result.preview.summary.assetTotal,
          result.preview.summary.documents,
        ),
      );
      if (failed) toast.warning(t("{0} 类系统保护的凭据无法在本机解密，未放入备份。", failed));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block
      title={t("加密备份")}
      hint={t(
        "把资产、文档、密钥库、个人资料、用量与接入配置打包成一个文件，用备份密码加密。不需要退出知屿。",
      )}
    >
      {!open ? (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Archive className="size-3.5" />
          {t("创建加密备份…")}
        </Button>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("备份密码")}>
              <Input
                type="password"
                aria-label={t("备份密码")}
                value={password}
                autoComplete="new-password"
                minLength={10}
                maxLength={256}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label={t("再输一次")}>
              <Input
                type="password"
                aria-label={t("再输一次")}
                value={confirm}
                autoComplete="new-password"
                minLength={10}
                maxLength={256}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
          </div>
          <p className="text-2xs leading-relaxed text-subtle">
            {t(
              "至少 10 位，可以与主密码相同。忘记备份密码将无法恢复；备份里的密钥库仍需要创建备份时的主密码解锁。",
            )}
          </p>
          <label className="flex items-start gap-2 text-meta">
            <input
              type="checkbox"
              className="mt-1"
              checked={includeSecure}
              disabled={!secureAvailable}
              onChange={(e) => setIncludeSecure(e.target.checked)}
            />
            <span>
              <span className="font-medium">{t("同时包含系统保护的凭据")}</span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-subtle">
                {secureAvailable
                  ? t(
                      "模型 API Key、云服务与探针连接、图床 Key、Linux.do 主身份由操作系统加密，换电脑后无法解密。勾选后会在本机解密，再用备份密码加密放进备份；恢复时交给新电脑重新加密。需要先解锁密钥库。",
                    )
                  : t("当前系统没有可用的安全加密存储，无法读取这些凭据。")}
              </span>
              {includeSecure && !unlocked && (
                <span className="mt-1 block text-2xs text-warn">
                  {t("密钥库已锁定，创建时会先请你解锁。")}
                </span>
              )}
            </span>
          </label>
          {error && (
            <p role="alert" className="text-meta text-crit">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || password.length < 10}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t("选择保存位置并备份")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setPassword("");
                setConfirm("");
                setError(null);
              }}
            >
              {t("取消")}
            </Button>
          </div>
        </form>
      )}
    </Block>
  );
}

function PreviewCard({ preview }: { preview: BackupPreview }) {
  const kinds = Object.entries(preview.summary.assets).filter(([, count]) => count > 0);
  return (
    <dl className="divide-y divide-line rounded-md border border-line px-3 text-meta">
      <div className="flex justify-between gap-3 py-2">
        <dt className="text-muted">{t("创建时间")}</dt>
        <dd>{when(preview.createdAt)}</dd>
      </div>
      <div className="flex justify-between gap-3 py-2">
        <dt className="text-muted">{t("知屿版本")}</dt>
        <dd>
          {preview.appVersion || "—"}
          {preview.kind === "auto" ? ` · ${t("自动备份")}` : ""}
        </dd>
      </div>
      <div className="flex justify-between gap-3 py-2">
        <dt className="text-muted">{t("资产")}</dt>
        <dd className="text-right">
          {t("{0} 项", preview.summary.assetTotal)}
          {kinds.length > 0 && (
            <span className="block text-2xs text-subtle">
              {kinds
                .map(([kind, count]) => `${t(ASSET_KIND_LABELS[kind] ?? kind)} ${count}`)
                .join(" · ")}
            </span>
          )}
        </dd>
      </div>
      <div className="flex justify-between gap-3 py-2">
        <dt className="text-muted">{t("文档")}</dt>
        <dd>{t("{0} 篇", preview.summary.documents)}</dd>
      </div>
      <div className="flex justify-between gap-3 py-2">
        <dt className="text-muted">{t("密钥库凭据")}</dt>
        <dd>
          {preview.summary.vaultRecords === null
            ? t("无密钥库")
            : t("{0} 条", preview.summary.vaultRecords)}
        </dd>
      </div>
      <div className="flex justify-between gap-3 py-2">
        <dt className="text-muted">{t("系统保护的凭据")}</dt>
        <dd className="text-right">
          {preview.secure.included && preview.secure.count > 0
            ? preview.secure.files.map((file) => t(SECURE_FILE_LABELS[file] ?? file)).join("、")
            : t("未包含，恢复后需重新输入")}
        </dd>
      </div>
      <div className="flex justify-between gap-3 py-2">
        <dt className="text-muted">{t("文件")}</dt>
        <dd>{t("{0} 个，共 {1}", preview.fileCount, formatBytes(preview.totalBytes))}</dd>
      </div>
    </dl>
  );
}

function RestoreBackup({ lastRestore }: { lastRestore: RestoreOutcome | null }) {
  const api = desktop()!.backup;
  const [picked, setPicked] = useState<{ ticket: string; file: string; size: number } | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    if (picked) void api.cancel(picked.ticket).catch(() => {});
    setPicked(null);
    setPassword("");
    setPreview(null);
    setError(null);
  }

  async function pick() {
    setError(null);
    try {
      const result = await api.pick();
      if (!result) return;
      setPicked(result);
      setPreview(null);
      setPassword("");
    } catch (err) {
      setError(message(err));
    }
  }

  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.inspect(picked.ticket, password));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!picked || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.restore(picked.ticket, password);
      if (result.secureSkipped)
        toast.warning(t("本机安全加密不可用，系统保护的凭据未恢复，请重启后重新输入。"));
      toast.success(t("备份已准备好，知屿即将重启并完成恢复。"));
      setPassword("");
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Block
      title={t("从备份恢复")}
      hint={t(
        "用备份替换当前全部资料。替换前会把当前资料完整移到资料目录的 restore-snapshots 中，随后自动重启。",
      )}
    >
      {lastRestore?.status === "applied" && (
        <p className="mb-3 rounded-md border border-line px-3 py-2 text-meta text-muted">
          {t("上次启动已从备份恢复；恢复前的资料保存在 {0}。", lastRestore.snapshot ?? "")}
        </p>
      )}
      {lastRestore?.status === "failed" && (
        <p role="alert" className="mb-3 text-meta text-crit">
          {t("上次恢复未完成：{0}", lastRestore.message ?? "")}
        </p>
      )}
      {!picked ? (
        <Button variant="outline" size="sm" onClick={() => void pick()}>
          <FolderOpen className="size-3.5" />
          {t("选择备份文件…")}
        </Button>
      ) : (
        <div className="space-y-3">
          <p className="text-meta">
            <span className="font-medium">{picked.file}</span>
            <span className="text-subtle"> · {formatBytes(picked.size)}</span>
          </p>
          {!preview ? (
            <form onSubmit={inspect} className="space-y-3">
              <Field label={t("备份密码")}>
                <Input
                  type="password"
                  aria-label={t("备份密码")}
                  value={password}
                  autoComplete="off"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {error && (
                <p role="alert" className="text-meta text-crit">
                  {error}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={busy || !password}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  {t("读取备份")}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={reset}>
                  {t("取消")}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <PreviewCard preview={preview} />
              <p className="text-meta leading-relaxed text-warn">
                {t(
                  "恢复会替换当前的资产、文档、密钥库和设置，完成后自动重启。之后请用创建备份时的主密码解锁密钥库。",
                )}
              </p>
              {error && (
                <p role="alert" className="text-meta text-crit">
                  {error}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void restore()}>
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                  {t("恢复并重启")}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={reset}>
                  {t("取消")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Block>
  );
}

function AutoBackup() {
  const api = desktop()!.backup;
  const [status, setStatus] = useState<AutoBackupStatus | null>(null);
  const [password, setPassword] = useState("");
  const [editingPassword, setEditingPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .autoStatus()
      .then(setStatus)
      .catch((err) => setError(message(err)));
  }, [api]);

  async function run(action: () => Promise<AutoBackupStatus | null>, done?: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setStatus(next);
      if (done) toast.success(done);
      return true;
    } catch (err) {
      setError(message(err));
      // 失败信息也写进了状态，重新读取以显示最近一次错误。
      void api
        .autoStatus()
        .then(setStatus)
        .catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const needsPassword = !status.hasPassword || !status.passwordReadable || editingPassword;
  return (
    <Block
      title={t("自动备份")}
      hint={t(
        "按周期把加密备份写入你选择的文件夹（建议另一块磁盘或网盘同步目录），只保留最近几份。自动备份不包含系统保护的凭据。",
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => api.autoDirectory())}
          >
            <FolderOpen className="size-3.5" />
            {status.directory ? t("更换文件夹") : t("选择文件夹")}
          </Button>
          <span className="min-w-0 break-all text-meta text-muted">
            {status.directory ?? t("尚未选择")}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("备份周期")}>
            <Select
              aria-label={t("备份周期")}
              value={String(status.intervalHours)}
              disabled={busy}
              onValueChange={(value) =>
                void run(() => api.autoConfigure({ intervalHours: Number(value) }))
              }
              options={[
                { value: "24", label: t("每天") },
                { value: "72", label: t("每 3 天") },
                { value: "168", label: t("每周") },
              ]}
            />
          </Field>
          <Field label={t("保留份数")}>
            <Select
              aria-label={t("保留份数")}
              value={String(status.keep)}
              disabled={busy}
              onValueChange={(value) => void run(() => api.autoConfigure({ keep: Number(value) }))}
              options={[3, 5, 7, 10, 14, 30].map((n) => ({
                value: String(n),
                label: t("最近 {0} 份", n),
              }))}
            />
          </Field>
        </div>
        {needsPassword ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => api.autoConfigure({ password }), t("自动备份密码已保存")).then(
                (ok) => {
                  if (!ok) return;
                  setPassword("");
                  setEditingPassword(false);
                },
              );
            }}
          >
            <div className="min-w-56 flex-1">
              <Field label={t("自动备份密码")}>
                <Input
                  type="password"
                  aria-label={t("自动备份密码")}
                  value={password}
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={256}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>
            <Button type="submit" size="sm" disabled={busy || password.length < 10}>
              {t("保存密码")}
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-2 text-meta text-muted">
            <ShieldCheck className="size-4" />
            {t("自动备份密码已由系统加密保存在本机。")}
            <Button variant="ghost" size="sm" onClick={() => setEditingPassword(true)}>
              {t("更换")}
            </Button>
          </div>
        )}
        {status.hasPassword && !status.passwordReadable && (
          <p className="text-meta text-warn">
            {t("已保存的自动备份密码在本机无法读取（可能来自其他电脑的资料），请重新设置。")}
          </p>
        )}
        <label className="flex items-center gap-2 text-meta">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={busy}
            onChange={(e) => {
              const enabled = e.target.checked;
              // 先更新勾选状态再保存，避免等待主进程时复选框弹回；保存失败时还原。
              setStatus({ ...status, enabled });
              void run(() => api.autoConfigure({ enabled })).then((ok) => {
                if (!ok) setStatus((current) => current && { ...current, enabled: !enabled });
              });
            }}
          />
          {t("启用自动备份")}
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !status.directory || !status.hasPassword}
            onClick={() => void run(() => api.autoRun(), t("已完成一次自动备份"))}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {t("立即备份")}
          </Button>
          <span className="text-2xs text-subtle">
            {status.lastRunAt
              ? t("上次：{0}（{1}）", when(status.lastRunAt), status.lastFile ?? "")
              : t("尚未运行")}
            {status.enabled && status.nextRunAt
              ? ` · ${t("下次：{0}", when(status.nextRunAt))}`
              : ""}
          </span>
        </div>
        {(error ?? status.lastError) && (
          <p role="alert" className="text-meta text-crit">
            {error ?? t("最近一次自动备份失败：{0}", status.lastError ?? "")}
          </p>
        )}
      </div>
    </Block>
  );
}

/** 网页版：下载与桌面版同格式的加密备份；或用桌面版备份替换服务器上的资料。 */
function WebBackup() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Block
        title={t("加密备份")}
        hint={t(
          "把服务器上的资产、文档和密钥库打包成一个文件下载到这台电脑，用备份密码加密。格式与桌面版相同，可以在桌面版恢复。",
        )}
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setBusy("backup");
            webDownloadBackup(password)
              .then(() => {
                setPassword("");
                toast.success(t("已下载加密备份"));
              })
              .catch((err) => setError(message(err)))
              .finally(() => setBusy(null));
          }}
        >
          <Field label={t("备份密码")}>
            <Input
              type="password"
              aria-label={t("备份密码")}
              value={password}
              autoComplete="new-password"
              minLength={10}
              maxLength={256}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy !== null || password.length < 10}
          >
            {busy === "backup" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Archive className="size-3.5" />
            )}
            {t("下载加密备份")}
          </Button>
        </form>
      </Block>
      <Block
        title={t("从备份恢复")}
        hint={t(
          "选择桌面版或网页版导出的 .zhiyu-backup 文件，服务器上的资产、文档和密钥库会整体替换成备份里的内容。",
        )}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!file) return;
            setError(null);
            setBusy("restore");
            webRestoreBackup(file, restorePassword)
              .then(() => {
                toast.success(t("已恢复备份，正在重新载入"));
                setTimeout(() => location.reload(), 600);
              })
              .catch((err) => setError(message(err)))
              .finally(() => setBusy(null));
          }}
        >
          <input
            type="file"
            accept=".zhiyu-backup"
            aria-label={t("备份文件")}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block text-meta"
          />
          <Field label={t("备份密码")}>
            <Input
              type="password"
              aria-label={t("恢复用的备份密码")}
              value={restorePassword}
              autoComplete="off"
              onChange={(e) => setRestorePassword(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-meta">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t("我知道这会替换服务器上的全部资料（原资料留在服务器的 restore-snapshots 目录）")}
          </label>
          <Button
            type="submit"
            variant="danger"
            size="sm"
            disabled={busy !== null || !file || !restorePassword || !confirmed}
          >
            {busy === "restore" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            {t("恢复这个备份")}
          </Button>
        </form>
      </Block>
      {error && (
        <p role="alert" className="text-meta text-crit">
          {error}
        </p>
      )}
    </>
  );
}
