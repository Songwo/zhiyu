import { hostBridge } from "@/lib/web-bridge";
import { Check, Loader2, MailCheck, RefreshCw, Save, Settings2, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import type { Mailbox } from "@/lib/types";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";
import { MailReader } from "./mail-reader";
import { useVault } from "@/lib/vault-state";

export function MailStatus({ mailbox }: { mailbox: Mailbox }) {
  const bridge = hostBridge();
  const [editing, setEditing] = useState(!mailbox.imap);
  const [host, setHost] = useState(mailbox.imap?.host ?? "");
  const [port, setPort] = useState(String(mailbox.imap?.port ?? 993));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    setHost(mailbox.imap?.host ?? "");
    setPort(String(mailbox.imap?.port ?? 993));
    setEditing(!mailbox.imap);
    setError("");
    setSaved(false);
  }, [mailbox.id, mailbox.imap?.host, mailbox.imap?.port, mailbox.imap]);

  if (!bridge || mailbox.kind !== "mailbox") return null;
  const result = mailbox.mailStatus;
  const disabled = busy || Boolean(mailbox.demo);

  async function saveConnection() {
    setBusy(true);
    setError("");
    try {
      const imap = await bridge!.mailboxes.validate({ host, port: Number(port), secure: true });
      const latest = useAppStore.getState().mailboxes.find((entry) => entry.id === mailbox.id);
      if (!latest) return;
      useAppStore.getState().upsertMail({ ...latest, imap, mailStatus: undefined });
      setSaved(true);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("邮箱检查失败"));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const checked = await bridge!.mailboxes.check(mailbox.id);
      const latest = useAppStore.getState().mailboxes.find((entry) => entry.id === mailbox.id);
      if (
        !latest ||
        latest.address !== checked.address ||
        JSON.stringify(latest.imap) !== JSON.stringify(mailbox.imap)
      )
        return;
      useAppStore.getState().upsertMail({
        ...latest,
        mailStatus: checked,
        ...(checked.usedMb === undefined ? {} : { usedMb: checked.usedMb }),
        ...(checked.quotaMb === undefined ? {} : { quotaMb: checked.quotaMb }),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("邮箱检查失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-line py-5" aria-label={t("收件箱状态")}>
      <Button
        className="mb-4"
        variant="outline"
        disabled={Boolean(mailbox.demo)}
        onClick={async () => {
          if (await useVault.getState().require(t("查看和发送邮件需要解锁密钥库。")))
            setReading(true);
        }}
      >
        <Inbox className="size-4" />
        {t("打开收件箱与写信")}
      </Button>
      {reading && <MailReader mailboxId={mailbox.id} close={() => setReading(false)} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-meta font-semibold">
          <MailCheck className="size-4" />
          {t("收件箱状态")}
        </h3>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={t("IMAP 连接设置")}
            title={t("IMAP 连接设置")}
            onClick={() => setEditing(!editing)}
          >
            <Settings2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !mailbox.imap}
            onClick={refresh}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("检查新邮件")}
          </Button>
        </div>
      </div>
      {editing && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
            <Field label={t("IMAP 服务器")}>
              <Input
                aria-label={t("IMAP 服务器")}
                value={host}
                placeholder="imap.example.com"
                autoComplete="off"
                disabled={disabled}
                onChange={(event) => setHost(event.target.value)}
              />
            </Field>
            <Field label={t("TLS 端口")}>
              <Input
                aria-label={t("TLS 端口")}
                value={port}
                type="number"
                min={1}
                max={65535}
                disabled={disabled}
                onChange={(event) => setPort(event.target.value)}
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !host.trim()}
            onClick={saveConnection}
          >
            <Save className="size-3.5" />
            {t("保存连接设置")}
          </Button>
        </div>
      )}
      {result ? (
        <div className="mt-4">
          <dl className="grid grid-cols-3 gap-3">
            <div>
              <dt className="text-2xs text-muted">{t("收件箱总数")}</dt>
              <dd className="mt-1 font-mono text-lg tabular-nums">{result.messages}</dd>
            </div>
            <div>
              <dt className="text-2xs text-muted">{t("未读邮件")}</dt>
              <dd className="mt-1 font-mono text-lg tabular-nums">{result.unseen}</dd>
            </div>
            <div>
              <dt className="text-2xs text-muted">{t("本次新增")}</dt>
              <dd className="mt-1 font-mono text-lg tabular-nums">{result.newMessages ?? "--"}</dd>
            </div>
          </dl>
          {result.newMessages === null && (
            <p className="mt-3 text-2xs leading-relaxed text-muted">
              {t("首次检查或邮箱状态重置，暂不统计新增邮件。")}
            </p>
          )}
          <p className="mt-2 text-2xs text-subtle">
            {t("上次检查：{0}", new Date(result.checkedAt).toLocaleString())}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-2xs text-muted">{t("尚未检查收件箱")}</p>
      )}
      {saved && (
        <p className="mt-3 flex items-center gap-1.5 text-2xs text-ok" role="status">
          <Check className="size-3.5" />
          {t("连接设置已保存")}
        </p>
      )}
      {mailbox.demo && <p className="mt-3 text-2xs text-muted">{t("演示邮箱不连接真实服务")}</p>}
      {error && (
        <p className="mt-3 break-words text-2xs text-crit" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
