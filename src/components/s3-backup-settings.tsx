import { useEffect, useRef, useState } from "react";
import { CloudUpload, Loader2, Unplug, ShieldCheck } from "lucide-react";
import { backupAutomation } from "@/lib/backup-automation";
import type { S3BackupStatus, S3BackupTarget } from "@/lib/backup";
import { isWeb } from "@/lib/web";
import { useVault } from "@/lib/vault-state";
import { t, intlLocale } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";

const DEFAULT: S3BackupTarget = {
  provider: "s3",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  bucket: "",
  region: "us-east-1",
  prefix: "zhiyu-backups",
  pathStyle: true,
  allowInsecure: false,
};
export function S3BackupSettings({
  onChanged,
  reload = 0,
}: {
  onChanged: () => void;
  reload?: number;
}) {
  const api = backupAutomation(),
    web = isWeb();
  const [status, setStatus] = useState<S3BackupStatus | null>(null),
    [form, setForm] = useState(DEFAULT);
  const [accessKeyId, setAccessKeyId] = useState(""),
    [secretAccessKey, setSecretAccessKey] = useState(""),
    [sessionToken, setSessionToken] = useState("");
  const [accountId, setAccountId] = useState(""),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const started = generation.current;
    if (reload)
      void api
        ?.s3Status()
        .then((next) => {
          if (generation.current === started) setStatus(next);
        })
        .catch(() => {});
  }, [api, reload]);
  useEffect(() => {
    let alive = true;
    void api
      ?.s3Status()
      .then((s) => {
        if (alive) {
          setStatus(s);
          setForm(s.target ?? DEFAULT);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [api]);
  const patch = (values: Partial<S3BackupTarget>) => {
    setForm((f) => ({ ...f, ...values }));
    setDirty(true);
    setNotice("");
  };
  const run = async (work: () => Promise<S3BackupStatus>, done: string) => {
    const operation = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const s = await work();
      if (operation !== generation.current) return;
      setStatus(s);
      setDirty(false);
      setAccessKeyId("");
      setSecretAccessKey("");
      setSessionToken("");
      setNotice(done);
      onChanged();
    } catch (e) {
      if (operation !== generation.current) return;
      setError(e instanceof Error ? e.message : String(e));
      void api
        ?.s3Status()
        .then((next) => {
          if (operation === generation.current) setStatus(next);
        })
        .catch(() => {});
    } finally {
      if (operation === generation.current) setBusy(false);
    }
  };
  if (!api) return null;
  if (!status && !error)
    return (
      <p role="status" className="text-meta text-muted">
        {t("加载中…")}
      </p>
    );
  return (
    <section className="mb-8 space-y-4" aria-label={t("S3 云端备份")}>
      <header>
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <CloudUpload className="size-5" />
          {t("S3 云端备份")}
        </h3>
        <p className="mt-1 text-meta leading-relaxed text-muted">
          {t(
            "先在本地生成加密备份，再上传到你绑定的存储。只清理当前工作区上传并记录的旧备份，不会删除桶内其他文件。备份密码和存储密钥不会放进备份。",
          )}
        </p>
      </header>
      {web && (
        <label className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 p-3 text-meta leading-relaxed">
          <input
            type="checkbox"
            className="mt-1"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          {t(
            "我允许可信部署服务器加密保管 S3 凭据并执行备份上传；管理员仍能访问这些凭据，敏感资产建议使用桌面端。",
          )}
        </label>
      )}
      <fieldset disabled={busy} className="space-y-3">
        <Field label={t("存储类型")}>
          <Select
            aria-label={t("存储类型")}
            value={form.provider}
            onValueChange={(value) => {
              const provider = value as S3BackupTarget["provider"];
              setAccountId("");
              patch({
                ...DEFAULT,
                bucket: form.bucket,
                prefix: form.prefix,
                provider,
                endpoint:
                  provider === "oss"
                    ? "https://s3.oss-cn-hangzhou.aliyuncs.com"
                    : provider === "s3"
                      ? DEFAULT.endpoint
                      : "",
                region: provider === "r2" ? "auto" : "us-east-1",
                pathStyle: provider !== "oss",
              });
            }}
            options={[
              { value: "s3", label: "Amazon S3 / S3 Compatible" },
              { value: "r2", label: "Cloudflare R2" },
              { value: "oss", label: t("阿里云 OSS（S3 兼容接口）") },
              { value: "minio", label: "MinIO" },
            ]}
          />
        </Field>
        {form.provider === "r2" && (
          <Field label={t("Cloudflare 账号 ID（快捷生成 Endpoint）")}>
            <Input
              aria-label={t("Cloudflare 账号 ID（快捷生成 Endpoint）")}
              value={accountId}
              autoComplete="off"
              onChange={(e) => {
                setAccountId(e.target.value);
                if (/^[a-f0-9]{32}$/i.test(e.target.value.trim()))
                  patch({ endpoint: `https://${e.target.value.trim()}.r2.cloudflarestorage.com` });
              }}
            />
          </Field>
        )}
        <Field label="Endpoint">
          <Input
            aria-label="Endpoint"
            value={form.endpoint}
            placeholder="https://storage.example.com"
            autoComplete="off"
            onChange={(e) => patch({ endpoint: e.target.value })}
          />
        </Field>
        {form.provider === "oss" && (
          <p className="text-2xs leading-relaxed text-muted">
            {t(
              "OSS 请使用 s3.oss-存储区域.aliyuncs.com 兼容端点，区域必须匹配 Bucket；默认签名区域沿用官方示例 us-east-1。",
            )}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bucket">
            <Input
              aria-label="Bucket"
              value={form.bucket}
              autoComplete="off"
              onChange={(e) => patch({ bucket: e.target.value })}
            />
          </Field>
          <Field label={t("签名区域")}>
            <Input
              aria-label={t("签名区域")}
              value={form.region}
              autoComplete="off"
              onChange={(e) => patch({ region: e.target.value })}
            />
          </Field>
          <Field label="Access Key ID">
            <Input
              aria-label="Access Key ID"
              value={accessKeyId}
              placeholder={status?.hasCredentials ? t("已加密保存，留空沿用") : ""}
              autoComplete="off"
              onChange={(e) => {
                setAccessKeyId(e.target.value);
                setDirty(true);
              }}
            />
          </Field>
          <Field label="Secret Access Key">
            <Input
              aria-label="Secret Access Key"
              type="password"
              value={secretAccessKey}
              placeholder={status?.hasCredentials ? t("已加密保存，留空沿用") : ""}
              autoComplete="new-password"
              onChange={(e) => {
                setSecretAccessKey(e.target.value);
                setDirty(true);
              }}
            />
          </Field>
        </div>
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-meta">{t("高级连接设置")}</summary>
          <div className="mt-3 space-y-3">
            <Field label={t("备份前缀")}>
              <Input
                aria-label={t("备份前缀")}
                value={form.prefix}
                onChange={(e) => patch({ prefix: e.target.value })}
              />
            </Field>
            <Field label="Session Token">
              <Input
                aria-label="Session Token"
                type="password"
                value={sessionToken}
                autoComplete="off"
                onChange={(e) => {
                  setSessionToken(e.target.value);
                  setDirty(true);
                }}
              />
            </Field>
            <label className="flex items-center gap-2 text-meta">
              <input
                type="checkbox"
                checked={form.pathStyle}
                onChange={(e) => patch({ pathStyle: e.target.checked })}
              />
              {t("路径寻址（MinIO / R2 常用）")}
            </label>
            <label className="flex items-start gap-2 text-meta text-warn">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.allowInsecure}
                onChange={(e) => patch({ allowInsecure: e.target.checked })}
              />
              {t("允许可信内网 HTTP（请求和备份元信息缺少传输加密，建议使用 HTTPS）")}
            </label>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={
              (web && !consent) ||
              !form.endpoint ||
              !form.bucket ||
              (!status?.hasCredentials && (!accessKeyId || !secretAccessKey))
            }
            onClick={() =>
              void run(async () => {
                if (
                  !web &&
                  !(await useVault.getState().require(t("绑定云端备份需要先解锁密钥库。")))
                )
                  throw new Error(t("密钥库未解锁"));
                await api.s3Configure({
                  ...form,
                  accessKeyId,
                  secretAccessKey,
                  sessionToken,
                  ...(web ? { allowServerStorage: consent } : {}),
                });
                await api.s3Test();
                return api.s3Configure({
                  enabled: true,
                  ...(web ? { allowServerStorage: consent } : {}),
                });
              }, t("S3 已绑定，后续自动备份会上传加密文件。"))
            }
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CloudUpload className="size-4" />
            )}
            {t("测试并绑定")}
          </Button>
          {status?.hasCredentials && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void run(() => api.s3Disconnect(), t("已解除绑定；云端已有备份会保留。"))
              }
            >
              <Unplug className="size-4" />
              {t("解除绑定")}
            </Button>
          )}
        </div>
        {status?.bound && (
          <label className="flex items-center gap-2 text-meta">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={dirty || (web && !consent && !status.enabled)}
              onChange={(e) => {
                const enabled = e.target.checked;
                setStatus((current) => current && { ...current, enabled });
                void run(
                  () =>
                    api.s3Configure({
                      enabled,
                      ...(web ? { allowServerStorage: consent } : {}),
                    }),
                  t("云端备份设置已保存"),
                );
              }}
            />
            {t("自动备份同时上传 S3")}
          </label>
        )}
      </fieldset>
      {status?.bound && !dirty && (
        <p className="flex items-center gap-2 text-2xs text-ok">
          <ShieldCheck className="size-4" />
          {t("连接读写与清理测试已通过")}
        </p>
      )}
      {notice && (
        <p role="status" className="text-meta text-ok">
          {notice}
        </p>
      )}
      {(error || status?.lastError) && (
        <p role="alert" className="break-words text-meta text-crit">
          {error || status?.lastError}
        </p>
      )}
      <p className="text-2xs leading-relaxed text-muted">
        {t(
          "仅授予备份前缀下的对象写入、读取元信息和删除权限。云端保留份数沿用自动备份设置；如需恢复，从存储下载 .zhiyu-backup 文件，再使用从备份恢复。",
        )}
      </p>
      {Boolean(status?.history.length) && (
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-meta">{t("云端备份记录")}</summary>
          <ul className="mt-3 space-y-3">
            {status!.history.slice(0, 10).map((r) => (
              <li key={r.id} className="break-words text-2xs">
                <p>
                  {new Date(r.at).toLocaleString(intlLocale())} ·{" "}
                  {t(
                    r.state === "uploaded"
                      ? "上传成功"
                      : r.state === "pruned"
                        ? "已按策略清理"
                        : "上传失败",
                  )}
                </p>
                <p className="text-muted">
                  {r.file} · {(r.bytes / 1024 / 1024).toFixed(2)} MB
                </p>
                {r.error && <p className="text-crit">{r.error}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
