import { totpApi } from "@/lib/web-totp";
import { useEffect, useRef, useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronDown,
  Copy,
  KeyRound,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/utils";
import { useVault } from "@/lib/vault-state";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";
import "./account-totp.css";

type TotpBridge = NonNullable<ReturnType<typeof desktop>>["totp"];
type TotpStatus = Awaited<ReturnType<TotpBridge["status"]>>;
type TotpCode = Awaited<ReturnType<TotpBridge["code"]>>;

/** seed 只临时存在输入框中；验证码由主进程按需生成。 */
export function AccountTotp({ assetId }: { assetId: string }) {
  const bridge = totpApi();
  const unlocked = useVault((state) => state.unlocked);
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [currentCode, setCurrentCode] = useState<TotpCode | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "remove" | null>(null);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [codeAttempt, setCodeAttempt] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const expanded = useRef(false);
  expanded.current = open;

  useEffect(() => {
    alive.current = true;
    const invalidate = () => {
      generation.current++;
    };
    const clear = () => {
      invalidate();
      setStatus(null);
      setCurrentCode(null);
      setRemaining(0);
      setSecret("");
      setOpen(false);
      setEditing(false);
      setDeleting(false);
      setError("");
      setCodeError("");
      setBusy(null);
      setCopying(false);
    };
    const off = useVault.subscribe((state, previous) => {
      if (!state.unlocked && previous.unlocked) clear();
    });
    const offVault = desktop()?.onVaultChanged(clear);
    return () => {
      alive.current = false;
      invalidate();
      off();
      offVault?.();
    };
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    setStatus(null);
    setCurrentCode(null);
    setRemaining(0);
    setSecret("");
    setEditing(false);
    setDeleting(false);
    setError("");
    if (!bridge || !unlocked) {
      setBusy(null);
      return;
    }
    setBusy("load");
    void bridge
      .status(assetId)
      .then((value) => {
        if (alive.current && current === generation.current && useVault.getState().unlocked)
          setStatus(value);
      })
      .catch((caught) => {
        if (alive.current && current === generation.current)
          setError(caught instanceof Error ? caught.message : t("读取验证码配置失败，请重试。"));
      })
      .finally(() => {
        if (alive.current && current === generation.current) setBusy(null);
      });
  }, [bridge, assetId, unlocked, attempt]);

  useEffect(() => {
    setCurrentCode(null);
    setRemaining(0);
    setCodeError("");
    if (!bridge || !open || !unlocked || !status?.configured || editing) return;
    const current = generation.current;
    let stopped = false;
    let fetching = false;
    let failed = false;
    let value: TotpCode | null = null;
    const valid = () =>
      !stopped && alive.current && current === generation.current && useVault.getState().unlocked;
    async function renew() {
      if (!valid() || fetching || document.hidden) return;
      fetching = true;
      try {
        const next = await bridge!.code(assetId);
        if (!valid() || document.hidden) return;
        value = next;
        setCurrentCode(next);
        setRemaining(Math.max(0, Math.ceil((next.expiresAt - Date.now()) / 1000)));
        setCodeError("");
      } catch (caught) {
        if (!valid()) return;
        failed = true;
        setCurrentCode(null);
        setCodeError(caught instanceof Error ? caught.message : t("生成验证码失败，请重试。"));
      } finally {
        fetching = false;
      }
    }
    const tick = () => {
      if (!valid() || document.hidden) return;
      const seconds = value ? Math.max(0, Math.ceil((value.expiresAt - Date.now()) / 1000)) : 0;
      setRemaining(seconds);
      if (seconds === 0 && !failed) {
        setCurrentCode(null);
        void renew();
      }
    };
    const visibility = () => {
      value = null;
      setCurrentCode(null);
      setRemaining(0);
      if (!document.hidden) {
        failed = false;
        void renew();
      }
    };
    void renew();
    const timer = setInterval(tick, 250);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [bridge, assetId, open, unlocked, status, editing, codeAttempt]);

  async function save() {
    if (!bridge || busy || !secret.trim() || !unlocked) return;
    const current = generation.current;
    setBusy("save");
    setError("");
    try {
      const result = await bridge.configure({ assetId, secret: secret.trim() });
      if (!alive.current || current !== generation.current || !useVault.getState().unlocked) return;
      setSecret("");
      setStatus(result);
      setEditing(false);
      toast.success(t("动态验证码已配置"));
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("保存验证码配置失败，请重试。"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  async function remove() {
    if (!bridge || busy || !unlocked) return;
    const current = generation.current;
    setBusy("remove");
    setError("");
    try {
      await bridge.remove(assetId);
      if (!alive.current || current !== generation.current || !useVault.getState().unlocked) return;
      setCurrentCode(null);
      setSecret("");
      setDeleting(false);
      setAttempt((value) => value + 1);
      toast.success(t("本机验证码配置已删除"));
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("删除验证码配置失败，请重试。"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  async function copyCode() {
    if (!bridge || !currentCode || copying || !unlocked) return;
    const current = generation.current;
    setCopying(true);
    try {
      const value =
        currentCode.expiresAt - Date.now() < 1000 ? await bridge.code(assetId) : currentCode;
      if (
        !alive.current ||
        current !== generation.current ||
        !useVault.getState().unlocked ||
        !expanded.current ||
        document.hidden
      )
        return;
      if (value.expiresAt <= Date.now()) throw new Error(t("验证码刚刚过期，请复制下一组验证码。"));
      await copyText(value.code);
      toast.success(t("已复制动态验证码"));
    } catch (caught) {
      if (alive.current && current === generation.current)
        toast.error(caught instanceof Error ? caught.message : t("复制失败，请重试"));
    } finally {
      if (alive.current && current === generation.current) setCopying(false);
    }
  }

  function toggle(value: boolean) {
    setOpen(value);
    if (!value) {
      setCurrentCode(null);
      setSecret("");
      setEditing(false);
      setDeleting(false);
      setCodeError("");
    }
  }

  return (
    <Collapsible.Root className="account-totp" open={open} onOpenChange={toggle}>
      <Collapsible.Trigger className="account-totp-trigger">
        <KeyRound className="size-4" />
        <span>{t("动态验证码")}</span>
        <span className="account-totp-summary">
          {t(!unlocked ? "已锁定" : status?.configured ? "已配置" : "未配置")}
        </span>
        <ChevronDown className="size-4" />
      </Collapsible.Trigger>
      <Collapsible.Content className="account-totp-collapse">
        <div className="account-totp-body">
          {!unlocked ? (
            <div className="account-totp-notice">
              <p>{t("解锁后可查看此账号的动态验证码。")}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void useVault
                    .getState()
                    .require(t("查看动态验证码需要先解锁密钥库。"))
                    .catch(() => setError(t("解锁失败，请重试。")))
                }
              >
                <LockKeyhole />
                {t("解锁查看")}
              </Button>
            </div>
          ) : busy === "load" ? (
            <p className="account-totp-muted" role="status">
              {t("读取验证码配置…")}
            </p>
          ) : !status ? (
            <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {t("重新读取")}
            </Button>
          ) : editing ? (
            <form
              className="account-totp-config"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Field label={t("验证器密钥或 otpauth 链接")}>
                <Input
                  autoFocus
                  aria-label={t("验证器密钥或 otpauth 链接")}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={secret}
                  disabled={!!busy}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </Field>
              <p className="account-totp-muted">
                {t(
                  "粘贴网站提供的 Base32 密钥或 otpauth://totp 链接。密钥加密保存在本机，不会显示或写入文档。",
                )}
              </p>
              {status.configured && (
                <p className="account-totp-muted">{t("保存后将替换本机现有验证码配置。")}</p>
              )}
              <div className="account-totp-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => {
                    setSecret("");
                    setEditing(false);
                    setError("");
                  }}
                >
                  {t("取消")}
                </Button>
                <Button type="submit" size="sm" disabled={!!busy || !secret.trim()}>
                  {busy === "save" && <Loader2 className="animate-spin" />}
                  {t("保存验证码配置")}
                </Button>
              </div>
            </form>
          ) : !status.configured ? (
            <div className="account-totp-notice">
              <p>{t("将网站的两步验证密钥保存在此账号下，登录时直接复制验证码。")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditing(true);
                  setError("");
                }}
              >
                <Plus />
                {t("添加动态验证码")}
              </Button>
            </div>
          ) : (
            <>
              {(status.issuer || status.label) && (
                <p className="account-totp-label">
                  {[status.issuer, status.label].filter(Boolean).join(" · ")}
                </p>
              )}
              <div className="account-totp-value" data-expiring={remaining > 0 && remaining <= 5}>
                <span
                  className="account-totp-digits"
                  aria-label={t("当前动态验证码")}
                  data-totp-code
                >
                  {currentCode && remaining > 0
                    ? `${currentCode.code.slice(0, currentCode.code.length / 2)} ${currentCode.code.slice(currentCode.code.length / 2)}`
                    : "— — —"}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("复制动态验证码")}
                  disabled={!currentCode || remaining <= 0 || copying || !!busy}
                  onClick={() => void copyCode()}
                >
                  <Copy />
                </Button>
              </div>
              <div className="account-totp-timer">
                <progress
                  value={remaining}
                  max={currentCode?.period || status.period}
                  aria-label={t("验证码剩余有效时间")}
                />
                <span>
                  {currentCode
                    ? t("{0} 秒后更新", remaining)
                    : codeError
                      ? t("暂时无法生成")
                      : t("生成验证码…")}
                </span>
              </div>
              {codeError && (
                <div className="account-totp-notice">
                  <p className="account-totp-error" role="alert">
                    {codeError}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCodeAttempt((value) => value + 1)}
                  >
                    <RefreshCw />
                    {t("重试验证码")}
                  </Button>
                </div>
              )}
              {deleting ? (
                <div className="account-totp-notice">
                  <p>
                    {t(
                      "仅删除本机验证码密钥，不会关闭网站的两步验证。请先确认你保留了其他验证方式。",
                    )}
                  </p>
                  <div className="account-totp-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => setDeleting(false)}
                    >
                      {t("取消")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => void remove()}
                    >
                      {busy === "remove" && <Loader2 className="animate-spin" />}
                      {t("确认删除验证码配置")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="account-totp-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => {
                      setEditing(true);
                      setCurrentCode(null);
                      setError("");
                    }}
                  >
                    {t("更换验证器密钥")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => setDeleting(true)}
                  >
                    <Trash2 />
                    {t("删除配置")}
                  </Button>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="account-totp-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
