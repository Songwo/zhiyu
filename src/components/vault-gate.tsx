import { isWeb } from "@/lib/web";
import { KeyRound, Lock, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";
import { usePresence } from "@/lib/motion";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";

/** 所有凭据操作共用解锁弹窗，解锁后继续原操作；主密码不进入持久化状态。 */
export function VaultGate() {
  const prompt = useVault((s) => s.prompt);
  const exists = useVault((s) => s.exists);
  const create = useVault((s) => s.create);
  const unlock = useVault((s) => s.unlock);
  const resolvePrompt = useVault((s) => s.resolvePrompt);
  const { mounted, shown } = usePresence(prompt !== null, 180);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPassword("");
    setConfirm("");
    setError(null);
    if (prompt) {
      // 等进入动画开始再聚焦，避免输入光标跟随面板移动。
      const t = window.setTimeout(() => field.current?.focus(), 60);
      return () => window.clearTimeout(t);
    }
  }, [prompt]);

  if (!mounted) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (working) return;
    setError(null);
    if (!exists && password !== confirm) {
      setError(t("两次输入的主密码不一致"));
      return;
    }
    setWorking(true);
    try {
      if (exists) await unlock(password);
      else await create(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      field.current?.focus();
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog.Root
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open && !working) resolvePrompt(false);
      }}
    >
      <Dialog.Portal forceMount>
        <div className="z-gate fixed inset-0 flex items-center justify-center px-4">
          <Dialog.Overlay
            forceMount
            className="anim-scrim absolute inset-0 bg-ink/40"
            data-shown={shown}
          />
          <Dialog.Content
            forceMount
            asChild
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!working) resolvePrompt(false);
            }}
            onPointerDownOutside={(event) => {
              if (working) event.preventDefault();
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              field.current?.focus();
            }}
          >
            <form
              onSubmit={submit}
              data-shown={shown}
              className="anim-panel relative z-10 w-full max-w-sm rounded-2xl bg-card p-6 shadow-float"
            >
              <div className="mb-4 flex items-start gap-3">
                <div className="grid size-10 shrink-0 place-items-center rounded-full bg-line">
                  {exists ? <Lock className="size-5" /> : <ShieldCheck className="size-5" />}
                </div>
                <div className="min-w-0">
                  <Dialog.Title className="text-lg font-semibold tracking-tight">
                    {exists ? t("解锁密钥库") : t("设置主密码")}
                  </Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-meta text-muted">
                    {prompt?.reason}
                  </Dialog.Description>
                </div>
              </div>

              <div className="space-y-3">
                <Field label={t("主密码")}>
                  <Input
                    ref={field}
                    type="password"
                    aria-label={t("主密码")}
                    disabled={working}
                    value={password}
                    autoComplete={exists ? "current-password" : "new-password"}
                    minLength={exists ? 6 : 10}
                    maxLength={exists ? undefined : 256}
                    placeholder={exists ? undefined : t("至少 10 位")}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                {!exists && (
                  <Field label={t("再输一次")}>
                    <Input
                      type="password"
                      aria-label={t("再输一次")}
                      disabled={working}
                      value={confirm}
                      autoComplete="new-password"
                      minLength={10}
                      maxLength={256}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </Field>
                )}
              </div>

              {exists && (
                <p className="mt-3 rounded-md bg-canvas px-3 py-2 text-2xs leading-relaxed text-muted">
                  {t(
                    isWeb()
                      ? "主密码只在这个标签页里用于解密，服务器只保存密文；刷新或关闭页面后会重新锁定。"
                      : "本次运行内无需重复解锁；锁屏、休眠或退出后会重新锁定。",
                  )}
                </p>
              )}

              {!exists && (
                <p className="mt-3 flex gap-2 rounded-md bg-banner px-3 py-2 text-2xs leading-relaxed text-muted">
                  <KeyRound className="mt-0.5 size-3.5 shrink-0" />

                  {t(
                    "主密码只用来在本机派生加密密钥，不会保存、也不会离开这台电脑。忘记后无法找回，凭据需要重新录入。",
                  )}
                </p>
              )}

              {error && (
                <p role="alert" className="mt-3 text-meta text-crit">
                  {error}
                </p>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={working}
                  onClick={() => resolvePrompt(false)}
                >
                  {t("取消")}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    working ||
                    password.length < (exists ? 6 : 10) ||
                    (!exists && password.length > 256)
                  }
                >
                  {working ? t("处理中…") : exists ? t("解锁") : t("创建")}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
