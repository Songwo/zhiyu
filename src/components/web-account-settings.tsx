import { useEffect, useState, type FormEvent } from "react";
import { LogOut, ShieldCheck } from "lucide-react";
import { t } from "@/lib/i18n";
import { webApi, webLogout } from "@/lib/web";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";

/** 网页版的登录账号：与密钥库主密码是两回事，改密后其他设备需要重新登录。 */
export function WebAccountSettings() {
  const [session, setSession] = useState<{ username: string; version: string } | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void webApi<{ username: string; version: string }>("session")
      .then(setSession)
      .catch(() => {});
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (next !== confirm) {
      setMessage({ ok: false, text: t("两次输入的新登录密码不一致") });
      return;
    }
    setBusy(true);
    try {
      await webApi("password", { method: "POST", body: { current, next } });
      setCurrent("");
      setNext("");
      setConfirm("");
      setMessage({ ok: true, text: t("登录密码已更新，其他设备需要重新登录") });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 border-t border-line pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ShieldCheck className="size-4 text-muted" />
            {t("网页登录账号")}
          </h3>
          <p className="mt-1 text-meta text-muted">
            {session
              ? t("当前登录：{0} · 服务端版本 {1}", session.username, session.version)
              : t("正在读取…")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void webLogout()}>
          <LogOut className="size-3.5" />
          {t("退出登录")}
        </Button>
      </div>
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={submit}>
        <Field label={t("当前登录密码")}>
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label={t("新登录密码")}>
          <Input
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={256}
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label={t("确认新登录密码")}>
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <Button type="submit" size="sm" disabled={busy}>
            {t(busy ? "处理中…" : "修改登录密码")}
          </Button>
          {message && (
            <span
              role={message.ok ? "status" : "alert"}
              className={message.ok ? "text-meta text-ok" : "text-meta text-crit"}
            >
              {message.text}
            </span>
          )}
        </div>
      </form>
      <p className="text-2xs leading-relaxed text-subtle">
        {t("登录密码保护网页入口；密钥库主密码只在浏览器里使用，两者互不影响。")}
      </p>
    </section>
  );
}
