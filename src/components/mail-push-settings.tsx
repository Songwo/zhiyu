import { useEffect, useState } from "react";
import { Bell, Loader2, Lock, Save, Send } from "lucide-react";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import type { MailPushConfig, MailPushProvider } from "@/lib/mail-push";
import { useAppStore } from "@/lib/store";
import { useVault } from "@/lib/vault-state";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";

export function MailPushSettings() {
  const api = desktop()?.mailPush;
  const mailboxes = useAppStore((state) => state.mailboxes);
  const unlocked = useVault((state) => state.unlocked);
  const requireVault = useVault((state) => state.require);
  const [config, setConfig] = useState<MailPushConfig | null>(null);
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    setConfig(null);
    setToken("");
    setClearToken(false);
    setError("");
    setNotice("");
    setDirty(false);
    if (api && unlocked) {
      void api
        .config()
        .then((value) => {
          if (alive) setConfig(value);
        })
        .catch((reason: unknown) => {
          if (alive)
            setError(reason instanceof Error ? reason.message : t("邮件推送配置加载失败。"));
        });
    }
    return () => {
      alive = false;
    };
  }, [api, unlocked]);

  async function task(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("邮件推送操作失败。"));
    } finally {
      setBusy(false);
    }
  }

  if (!api) return <p className="text-meta text-muted">{t("邮件推送仅在桌面端可用。")}</p>;
  if (!unlocked) {
    return (
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">{t("邮件推送")}</h3>
        <Button variant="outline" onClick={() => void requireVault(t("配置邮件推送"))}>
          <Lock />
          {t("解锁密钥库")}
        </Button>
      </section>
    );
  }
  if (!config) return <p role={error ? "alert" : "status"}>{error || t("加载中…")}</p>;
  const available = mailboxes.filter((mailbox) => mailbox.kind === "mailbox" && !mailbox.demo);
  const patch = (value: Partial<MailPushConfig>) => {
    setConfig({ ...config, ...value });
    setDirty(true);
    setNotice("");
  };
  return (
    <section className="space-y-4">
      <h3 className="flex items-center gap-2 text-lg font-semibold">
        <Bell className="size-5" />
        {t("邮件推送")}
      </h3>
      <p className="text-meta leading-relaxed text-muted">
        {t(
          "仅发送新增、未读数量和检查时间，不发送邮箱地址、标题或正文。桌面端运行且密钥库解锁时生效，首次检查仅建立基线。",
        )}
      </p>
      <fieldset disabled={busy} className="space-y-4">
        <label className="flex min-h-10 items-center gap-3 text-meta">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
            className="size-4 accent-ink"
          />
          {t("启用自动邮件推送")}
        </label>
        <label className="flex min-h-10 items-center gap-3 text-meta">
          <input
            type="checkbox"
            checked={config.reminders === true}
            onChange={(event) => patch({ reminders: event.target.checked })}
            className="size-4 accent-ink"
          />
          {t("续费与备忘提醒也推送到这个渠道")}
        </label>
        <Field label={t("推送渠道")}>
          <Select
            aria-label={t("推送渠道")}
            value={config.provider}
            onValueChange={(value) => {
              patch({ provider: value as MailPushProvider, destination: "", hasToken: false });
              setToken("");
              setClearToken(true);
            }}
            options={[
              { value: "telegram", label: "Telegram" },
              { value: "serverchan", label: t("Server酱 / 微信") },
              { value: "wecom", label: t("企业微信群机器人") },
              { value: "wxpusher", label: "WxPusher" },
            ]}
          />
        </Field>
        {(config.provider === "telegram" || config.provider === "wxpusher") && (
          <Field label={config.provider === "wxpusher" ? t("接收用户 UID") : "Chat ID"}>
            <Input
              aria-label={config.provider === "wxpusher" ? t("接收用户 UID") : "Chat ID"}
              value={config.destination}
              placeholder={config.provider === "wxpusher" ? "UID_…" : "-1001234567890"}
              onChange={(event) => {
                patch({ destination: event.target.value, hasToken: false });
                setClearToken(!token);
              }}
            />
          </Field>
        )}
        {config.provider === "wxpusher" && (
          <p className="text-meta leading-relaxed text-muted">
            {t(
              "在 WxPusher 创建应用并关注后，填写 AppToken 和自己的用户 UID。仅推送邮件数量，不包含邮件内容。",
            )}
          </p>
        )}
        <Field
          label={
            config.provider === "telegram"
              ? "Bot Token"
              : config.provider === "serverchan"
                ? "SendKey"
                : config.provider === "wxpusher"
                  ? "AppToken"
                  : t("机器人 Key")
          }
        >
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={t("推送凭据")}
            value={token}
            placeholder={
              config.hasToken && !clearToken ? t("已加密保存，留空保留") : t("填写对应渠道的密钥")
            }
            onChange={(event) => {
              setToken(event.target.value);
              setClearToken(false);
              setDirty(true);
              setNotice("");
            }}
          />
        </Field>
        {config.hasToken && (
          <label className="flex min-h-10 items-center gap-3 text-meta">
            <input
              type="checkbox"
              className="size-4 accent-ink"
              checked={clearToken}
              onChange={(event) => {
                setClearToken(event.target.checked);
                setToken("");
                setDirty(true);
              }}
            />
            {t("清除已保存的推送凭据")}
          </label>
        )}
        <Field label={t("检查间隔（分钟）")}>
          <Input
            type="number"
            min={5}
            max={1440}
            step={1}
            aria-label={t("检查间隔（分钟）")}
            value={config.intervalMinutes}
            onChange={(event) => patch({ intervalMinutes: Number(event.target.value) })}
          />
        </Field>
        <fieldset className="space-y-1">
          <legend className="mb-2 text-meta font-medium text-muted">{t("接收提醒的邮箱")}</legend>
          {!available.length && <p className="text-meta text-subtle">{t("尚无可检查的邮箱。")}</p>}
          {available.map((mailbox) => (
            <label
              key={mailbox.id}
              className="flex min-h-10 items-center gap-3 border-b border-line py-2 text-meta last:border-0"
            >
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-ink"
                checked={config.mailboxIds.includes(mailbox.id)}
                onChange={(event) =>
                  patch({
                    mailboxIds: event.target.checked
                      ? [...config.mailboxIds, mailbox.id]
                      : config.mailboxIds.filter((id) => id !== mailbox.id),
                  })
                }
              />
              <span className="min-w-0 break-all">{mailbox.address}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() =>
              void task(async () => {
                const saved = await api.save({
                  enabled: config.enabled,
                  provider: config.provider,
                  destination: config.destination,
                  mailboxIds: config.mailboxIds,
                  intervalMinutes: config.intervalMinutes,
                  reminders: config.reminders === true,
                  token: token || undefined,
                  clearToken,
                });
                setConfig(saved);
                setToken("");
                setClearToken(false);
                setDirty(false);
                setNotice(t("邮件推送配置已保存。"));
              })
            }
          >
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            {t("保存")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={dirty || !config.hasToken}
            onClick={() =>
              void task(async () => {
                await api.test();
                setNotice(t("测试消息已发送。"));
              })
            }
          >
            <Send />
            {t("发送测试消息")}
          </Button>
          {dirty && <span className="text-2xs text-subtle">{t("有未保存的更改")}</span>}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="break-words text-meta text-crit">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-meta text-ok">
          {notice}
        </p>
      )}
    </section>
  );
}
