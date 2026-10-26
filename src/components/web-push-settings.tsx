import { useEffect, useState } from "react";
import { BellRing, Loader2, Save, Send } from "lucide-react";
import { t } from "@/lib/i18n";
import type { MailPushProvider } from "@/lib/mail-push";
import { webApi } from "@/lib/web";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";

interface WebPushConfig {
  enabled: boolean;
  provider: MailPushProvider;
  destination: string;
  hasToken: boolean;
  leadDays: number;
}

/** 网页版：服务器按小时检查续费与备忘提醒并推送，浏览器关着也会送达。 */
export function WebPushSettings() {
  const [config, setConfig] = useState<WebPushConfig | null>(null);
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    webApi<WebPushConfig>("push")
      .then((value) => alive && setConfig(value))
      .catch((reason: unknown) => alive && setError(message(reason)));
    return () => {
      alive = false;
    };
  }, []);

  async function task(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!config) return <p role={error ? "alert" : "status"}>{error || t("加载中…")}</p>;
  const patch = (value: Partial<WebPushConfig>) => {
    setConfig({ ...config, ...value });
    setDirty(true);
    setNotice("");
  };
  return (
    <section className="space-y-4">
      <h3 className="flex items-center gap-2 text-lg font-semibold">
        <BellRing className="size-5" />
        {t("提醒推送")}
      </h3>
      <p className="text-meta leading-relaxed text-muted">
        {t(
          "服务器每小时检查一次续费与备忘提醒，浏览器关着也会推送到手机；同一件事每天最多一次，只发名称和剩余天数。推送凭据保存在你的服务器上（server/push.json），不会回传到浏览器。",
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
          {t("开启服务器提醒推送")}
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
              onChange={(event) => patch({ destination: event.target.value })}
            />
          </Field>
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
              config.hasToken && !clearToken
                ? t("已保存在服务器，留空保留")
                : t("填写对应渠道的密钥")
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
        <Field label={t("资产到期前多少天开始提醒")}>
          <Select
            aria-label={t("资产到期前多少天开始提醒")}
            value={String(config.leadDays)}
            onValueChange={(value) => patch({ leadDays: Number(value) })}
            options={[3, 7, 14, 21, 30, 60, 90].map((d) => ({
              value: String(d),
              label: t("提前 {0} 天", d),
            }))}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() =>
              void task(async () => {
                const saved = await webApi<WebPushConfig>("push", {
                  method: "PUT",
                  body: {
                    enabled: config.enabled,
                    provider: config.provider,
                    destination: config.destination,
                    leadDays: config.leadDays,
                    token: token || undefined,
                    clearToken,
                  },
                });
                setConfig(saved);
                setToken("");
                setClearToken(false);
                setDirty(false);
                setNotice(t("提醒推送配置已保存。"));
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
                await webApi("push/test", { method: "POST", body: {} });
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

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : t("提醒推送操作失败。");
