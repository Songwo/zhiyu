import { CheckCircle2, KeyRound, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/input";
import { credentialId, type CredentialKind, type SshCredential } from "@/lib/desktop";
import { vaultApi } from "@/lib/vault-api";
import { isWeb } from "@/lib/web";
import { hostBridge } from "@/lib/web-bridge";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";

/** Form keys that belong to the vault, never to the asset record. */
export const CRED_KEYS = ["_authKind", "_password", "_privateKey", "_passphrase"] as const;

export function credentialFromForm(form: Record<string, string>): SshCredential | null {
  const kind = (form._authKind as CredentialKind) || "password";
  if (kind === "agent") return { kind };
  if (kind === "password") return form._password ? { kind, password: form._password } : null;
  // A pasted ssh config gives a path rather than the key itself; the main
  // process reads it at connect time.
  if (form._privateKeyPath) {
    return {
      kind,
      privateKeyPath: form._privateKeyPath,
      passphrase: form._passphrase || undefined,
    };
  }
  return form._privateKey
    ? { kind, privateKey: form._privateKey, passphrase: form._passphrase || undefined }
    : null;
}

/**
 * SSH credentials for one host.
 *
 * The secret is written to the encrypted vault under the server's id, never
 * into the asset JSON — so exporting or syncing assets can never leak a
 * password. Editing an existing host shows only whether something is stored;
 * the value itself is not read back into the form.
 */
export function CredentialFields({
  serverId,
  target,
  form,
  set,
}: {
  serverId: string | null;
  target: { host: string; port: string; username: string };
  form: Record<string, string>;
  set: (key: string, value: string) => void;
}) {
  // 桌面版由主进程连接；网页版由服务器连接，凭据仍只存在浏览器加密的密钥库里。
  const bridge = hostBridge();
  const vault = vaultApi();
  const requireVault = useVault((s) => s.require);
  const unlocked = useVault((s) => s.unlocked);
  const [stored, setStored] = useState<CredentialKind | null | "unknown">("unknown");
  const [test, setTest] = useState<{ state: "idle" | "busy" | "ok" | "fail"; message?: string }>({
    state: "idle",
  });
  const [resettingKey, setResettingKey] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetTyped, setResetTyped] = useState("");
  const targetLabel = `${target.host}:${Number(target.port) || 22}`;

  const kind = (form._authKind as CredentialKind) || "password";

  // Only the kind is read back, so the panel can say "已保存" without
  // putting a decrypted password into the DOM.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!vault || !serverId || !unlocked) {
        if (alive) setStored(serverId ? "unknown" : null);
        return;
      }
      try {
        const cred = await vault.get(credentialId(serverId));
        if (alive) setStored(cred?.kind ?? null);
      } catch {
        if (alive) setStored("unknown");
      }
    })();
    return () => {
      alive = false;
    };
  }, [vault, serverId, unlocked]);

  useEffect(() => {
    setResetOpen(false);
    setResetTyped("");
    setTest({ state: "idle" });
  }, [target.host, target.port, target.username]);

  if (!bridge || !vault) return null;

  async function runTest() {
    setTest({ state: "busy" });
    try {
      let credential = credentialFromForm(form);
      if (!credential && serverId) {
        if (!(await requireVault(t("测试连接需要解锁已保存的 SSH 凭据。")))) {
          setTest({ state: "idle" });
          return;
        }
        const saved = await vault!.get(credentialId(serverId));
        if (saved?.kind === kind) credential = saved;
      }
      if (!credential) throw new Error(t("请先填写密码或私钥"));
      const res = await bridge!.ssh.test(
        {
          id: serverId ?? "draft",
          host: target.host,
          port: Number(target.port) || 22,
          username: target.username || "root",
        },
        credential,
      );
      setTest({ state: "ok", message: res.message });
    } catch (err) {
      setTest({ state: "fail", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function resetHostKey() {
    if (resetTyped !== targetLabel || !target.host || resettingKey) return;
    if (!(await requireVault(t("重置主机指纹需要先解锁密钥库。")))) return;
    setResettingKey(true);
    try {
      await bridge!.ssh.resetHostKey({
        host: target.host,
        port: Number(target.port) || 22,
      });
      setResetOpen(false);
      setResetTyped("");
      setTest({
        state: "ok",
        message: t("已清除旧指纹。下次连接会记录新指纹，请核对后再测试连接。"),
      });
    } catch (err) {
      setTest({ state: "fail", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setResettingKey(false);
    }
  }

  return (
    <div className="sm:col-span-2">
      <div className="rounded-xl bg-canvas p-4">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="size-4 text-muted" />
          <h3 className="text-meta font-semibold">{t("SSH 凭据")}</h3>
          <span className="ml-auto text-2xs text-subtle">
            {stored === "unknown"
              ? unlocked
                ? t("未读取")
                : t("密钥库已锁定")
              : stored
                ? t("已保存（{0}）", LABEL[stored])
                : t("尚未保存")}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("认证方式")}>
            <Select
              aria-label={t("认证方式")}
              value={kind}
              onValueChange={(value) => set("_authKind", value)}
              options={[
                { value: "password", label: t("密码") },
                { value: "key", label: t("私钥") },
                // 网页版由服务器发起连接，服务器上没有你的 SSH agent。
                ...(isWeb() ? [] : [{ value: "agent", label: "SSH Agent" }]),
              ]}
            />
          </Field>

          {kind === "password" && (
            <Field label={t("密码")}>
              <Input
                type="password"
                value={form._password ?? ""}
                autoComplete="off"
                placeholder={stored === "password" ? t("留空则沿用已保存的密码") : ""}
                onChange={(e) => set("_password", e.target.value)}
              />
            </Field>
          )}

          {kind === "key" && (
            <>
              <Field label={t("私钥口令（可选）")}>
                <Input
                  type="password"
                  value={form._passphrase ?? ""}
                  autoComplete="off"
                  onChange={(e) => set("_passphrase", e.target.value)}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label={t("私钥内容（OpenSSH / PEM）")}>
                  <Textarea
                    value={form._privateKey ?? ""}
                    spellCheck={false}
                    placeholder={
                      stored === "key"
                        ? t("留空则沿用已保存的私钥")
                        : "-----BEGIN OPENSSH PRIVATE KEY-----"
                    }
                    className="min-h-28 font-mono text-2xs"
                    onChange={(e) => set("_privateKey", e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}

          {kind === "agent" && isWeb() && (
            <p className="self-end pb-2 text-2xs text-crit sm:col-span-1">
              {t("网页版由服务器发起 SSH 连接，不能使用 SSH agent，请改用密码或私钥。")}
            </p>
          )}
          {kind === "agent" && !isWeb() && (
            <p className="self-end pb-2 text-2xs text-muted sm:col-span-1">
              {t("使用系统 SSH agent（Windows 为 Pageant，其它平台读 SSH_AUTH_SOCK）。")}
            </p>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={test.state === "busy" || resettingKey}
            onClick={runTest}
          >
            {test.state === "busy" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <KeyRound className="size-3.5" />
            )}

            {t("测试连接")}
          </Button>
          {!unlocked && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void requireVault(t("保存 SSH 凭据需要先解锁密钥库。"))}
            >
              {t("解锁密钥库")}
            </Button>
          )}
          {test.message && (
            <span
              className={
                test.state === "ok"
                  ? "flex items-center gap-1.5 text-2xs text-ok"
                  : "flex items-center gap-1.5 text-2xs text-crit"
              }
            >
              {test.state === "ok" ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <XCircle className="size-3.5" />
              )}
              {test.message}
            </span>
          )}
          {target.host && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resettingKey || test.state === "busy"}
              onClick={() => {
                setResetOpen(true);
                setResetTyped("");
              }}
            >
              {resettingKey ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("重置主机指纹")}
            </Button>
          )}
        </div>

        {resetOpen && (
          <fieldset className="mt-3 space-y-3 rounded-lg border border-warn/40 bg-warn/5 p-3">
            <legend className="px-1 text-meta font-semibold">{t("确认重置主机指纹")}</legend>
            <p className="break-words text-meta text-muted">
              {t(
                "指纹变化可能来自服务器重装，也可能是连接劫持。请通过云控制台等可信渠道核对新指纹；仅在确认服务器密钥已更换后清除旧记录。此操作不会自动重连。",
              )}
            </p>
            <p className="break-all font-mono text-meta">{targetLabel}</p>
            <Field label={t("输入完整主机地址和端口以确认")}>
              <Input
                aria-label={t("输入完整主机地址和端口以确认")}
                value={resetTyped}
                autoComplete="off"
                spellCheck={false}
                disabled={resettingKey}
                onChange={(event) => setResetTyped(event.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resettingKey}
                onClick={() => setResetOpen(false)}
              >
                {t("取消")}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={resettingKey || resetTyped !== targetLabel}
                onClick={() => void resetHostKey()}
              >
                {t("确认清除旧指纹")}
              </Button>
            </div>
          </fieldset>
        )}

        <p className="mt-3 text-2xs leading-relaxed text-subtle">
          {t("凭据用主密码派生的密钥加密后单独存放，不写入资产文件，导出 JSON 时也不会带出去。")}
        </p>
        {isWeb() && (
          <p className="mt-2 text-2xs leading-relaxed text-warn">
            {t(
              "Web 端连接会将本次 SSH 凭据交给部署服务器处理。请仅连接可信部署；敏感主机建议使用桌面端。",
            )}
          </p>
        )}
      </div>
    </div>
  );
}

const LABEL: Record<CredentialKind, string> = {
  password: "密码",
  key: "私钥",
  agent: "Agent",
};
