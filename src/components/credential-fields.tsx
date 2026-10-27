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

  const kind = (form._authKind as CredentialKind) || "password";
  // The main process builds this phrase when TOFU refuses a changed host key;
  // matching on it is what offers the reset affordance.
  const fingerprintChanged =
    test.state === "fail" && (test.message ?? "").includes("主机指纹已变更");

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

  if (!bridge || !vault) return null;

  async function runTest() {
    const credential = credentialFromForm(form);
    if (!credential) {
      setTest({ state: "fail", message: t("请先填写密码或私钥") });
      return;
    }
    setTest({ state: "busy" });
    try {
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

  async function resetHostKeyAndRetest() {
    setResettingKey(true);
    try {
      await bridge!.ssh.resetHostKey({
        host: target.host,
        port: Number(target.port) || 22,
      });
      await runTest();
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

        <div className="mt-3 flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={runTest}>
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
          {fingerprintChanged && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resettingKey || !target.host}
              onClick={() => void resetHostKeyAndRetest()}
            >
              {resettingKey ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("重置指纹并重试")}
            </Button>
          )}
        </div>

        <p className="mt-3 text-2xs leading-relaxed text-subtle">
          {t("凭据用主密码派生的密钥加密后单独存放，不写入资产文件，导出 JSON 时也不会带出去。")}
        </p>
      </div>
    </div>
  );
}

const LABEL: Record<CredentialKind, string> = {
  password: "密码",
  key: "私钥",
  agent: "Agent",
};
