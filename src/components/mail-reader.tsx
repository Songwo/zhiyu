import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Forward,
  Folder,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  Paperclip,
  Pencil,
  RefreshCw,
  Reply,
  Save,
  Search,
  Send,
  Settings2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store";
import { useVault } from "@/lib/vault-state";
import { intlLocale, t } from "@/lib/i18n";
import { mailFolderId, normalizeMailFolders } from "@/lib/mail-folders";
import type {
  MailDraft,
  MailFolderRemote,
  MailMessage,
  MailPage,
  MailSelection,
  SmtpConnection,
} from "@/lib/mailbox";
import type { Mailbox } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/input";
import { MailAvatar, MailAppearanceEditor } from "./mail-avatar";
import { MailContent } from "./mail-content";

const emptyDraft = (): MailDraft => ({
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  text: "",
  attachments: [],
});
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const folderLabel = (folder: MailFolderRemote) => {
  const names: Record<string, string> = {
    "\\Inbox": "收件箱",
    "\\Sent": "已发送",
    "\\Drafts": "草稿",
    "\\Junk": "垃圾邮件",
    "\\Trash": "已删除",
    "\\Archive": "归档",
  };
  return folder.path.toUpperCase() === "INBOX"
    ? t("收件箱")
    : folder.specialUse && names[folder.specialUse]
      ? t(names[folder.specialUse])
      : folder.name;
};

function compactMailDate(value: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const today = new Date();
  return new Intl.DateTimeFormat(
    intlLocale(),
    date.toDateString() === today.toDateString()
      ? { hour: "2-digit", minute: "2-digit" }
      : {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}),
        },
  ).format(date);
}

function MailSkeleton({ reading = false }: { reading?: boolean }) {
  return (
    <div
      role="status"
      aria-label={t("正在读取邮件")}
      className={reading ? "py-7" : "divide-y divide-line"}
    >
      <span className="sr-only">{t("正在读取邮件")}</span>
      {Array.from({ length: reading ? 1 : 6 }, (_, index) => (
        <div key={index} className={reading ? "" : "flex gap-3 p-4"} aria-hidden="true">
          {!reading && <span className="mail-skeleton size-10 shrink-0 rounded-full" />}
          <div className="min-w-0 flex-1 space-y-3">
            <div
              className={cn("mail-skeleton rounded", reading ? "mb-7 h-6 w-3/4" : "h-3 w-2/5")}
            />
            <div className="mail-skeleton h-3 w-full rounded" />
            <div className="mail-skeleton h-3 w-4/5 rounded" />
            {reading && (
              <>
                <div className="h-5" />
                {Array.from({ length: 9 }, (_, row) => (
                  <div
                    key={row}
                    className={cn("mail-skeleton h-3 rounded", row % 3 === 2 ? "w-3/5" : "w-full")}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MailReader({ mailboxId, close }: { mailboxId: string; close: () => void }) {
  const mailbox = useAppStore((state) => state.mailboxes.find((item) => item.id === mailboxId));
  const unlocked = useVault((state) => state.unlocked);
  // 锁库后卸载整个阅读区，清除正文、收件人和附件的内存状态。
  if (!mailbox || !unlocked || !hostBridge()) return null;
  return <ReaderBody key={mailboxId} mailbox={mailbox} close={close} />;
}

function ReaderBody({ mailbox, close }: { mailbox: Mailbox; close: () => void }) {
  const localFolders = useAppStore((state) => state.mailFolders);
  const accounts = useAppStore((state) => state.mailboxes);
  const groups = normalizeMailFolders(localFolders);
  const groupName =
    groups.find((item) => item.id === mailFolderId(mailbox, groups))?.name ?? "未分组";
  const [appearance, setAppearance] = useState<
    "account" | { name: string; address: string } | null
  >(null);
  const senderImage = (address: string) =>
    mailbox.senderAvatars?.find((item) => item.address === address.toLowerCase())?.imageDataUrl ??
    accounts.find((item) => item.address.toLowerCase() === address.toLowerCase())?.imageDataUrl;
  const bridge = hostBridge()!;
  const api = bridge.mailClient;
  const [folders, setFolders] = useState<MailFolderRemote[]>([]);
  const [folder, setFolder] = useState("INBOX");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [unseen, setUnseen] = useState(false);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [messages, setMessages] = useState<MailPage | null>(null);
  const [selected, setSelected] = useState<MailSelection | null>(null);
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [loading, setLoading] = useState(Boolean(mailbox.imap));
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [compose, setCompose] = useState(false);
  const [draft, setDraft] = useState<MailDraft>(emptyDraft);
  const [draftSaved, setDraftSaved] = useState(true);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(!mailbox.smtp || !mailbox.imap);
  const alive = useRef(true);
  const readingPane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    readingPane.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [selected]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    if (mailbox.imap)
      void api
        .folders(mailbox.id)
        .then((value) => {
          if (current) setFolders(value);
        })
        .catch((caught) => {
          if (current) setError(describe(caught));
        });
    return () => {
      current = false;
    };
  }, [api, mailbox.id, mailbox.imap]);
  useEffect(() => {
    let current = true;
    setMessages(null);
    setSelected(null);
    setMessage(null);
    setError("");
    if (!mailbox.imap) return;
    setLoading(true);
    void api
      .messages(mailbox.id, { folder, page, query, unseen })
      .then((value) => {
        if (current) setMessages(value);
      })
      .catch((caught) => {
        if (current) setError(describe(caught));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, mailbox.id, mailbox.imap, folder, page, query, unseen, revision]);
  useEffect(() => {
    let current = true;
    setMessage(null);
    if (!selected) {
      setReading(false);
      return;
    }
    setReading(true);
    void api
      .read(mailbox.id, selected)
      .then((value) => {
        if (current) setMessage(value);
      })
      .catch((caught) => {
        if (current) setError(describe(caught));
      })
      .finally(() => {
        if (current) setReading(false);
      });
    return () => {
      current = false;
    };
  }, [api, mailbox.id, selected]);

  function changeDraft(patch: Partial<MailDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setDraftSaved(false);
    setConfirmSend(false);
  }
  function requestClose() {
    if (!busy) {
      if (!draftSaved) setConfirmClose(true);
      else close();
    }
  }
  async function action(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (caught) {
      if (alive.current) setError(describe(caught));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function respond(forward: boolean) {
    if (!message || !draftSaved) {
      if (!draftSaved) setError(t("请先保存当前草稿"));
      return;
    }
    setDraft({
      ...emptyDraft(),
      to: forward ? "" : message.replyTo.map((item) => item.address).join(", "),
      subject: `${forward ? "Fwd" : "Re"}: ${message.subject}`.slice(0, 200),
      text: `\n\n${message.from.map((item) => item.address).join(", ")}\n${message.date ?? ""}\n\n${message.text
        .slice(0, 20000)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`,
      ...(!forward && message.messageId ? { inReplyTo: message.messageId } : {}),
    });
    setCompose(true);
    setDraftSaved(false);
    setConfirmSend(false);
  }
  async function send() {
    await action(async () => {
      const result = await api.send(mailbox.id, draft);
      if (!alive.current) return;
      setConfirmSend(false);
      if (!result.accepted.length || result.rejected.length) {
        setError(
          t(
            "服务器接受 {0} 个收件人，拒绝 {1} 个；请核对后再处理草稿。",
            result.accepted.length,
            result.rejected.length,
          ),
        );
        return;
      }
      toast.success(t("邮件已提交给 SMTP 服务器"));
      setDraft(emptyDraft());
      setDraftSaved(true);
      setCompose(false);
      try {
        await api.saveDraft(mailbox.id, emptyDraft());
      } catch {
        setError(t("邮件已发送，但旧草稿未清除，请勿重复发送。"));
      }
    });
  }
  const folderOptions = folders.length
    ? folders.map((item) => ({ value: item.path, label: folderLabel(item) }))
    : [{ value: "INBOX", label: t("收件箱") }];
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="mail-reader fixed inset-3 z-50 mx-auto flex max-w-6xl flex-col overflow-hidden rounded-lg bg-card text-ink shadow-float sm:inset-6"
        >
          <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <button
              title={t("邮箱头像与分组")}
              aria-label={t("邮箱头像与分组")}
              className="shrink-0 rounded-full"
              disabled={busy}
              onClick={() => setAppearance("account")}
            >
              <MailAvatar address={mailbox.address} image={mailbox.imageDataUrl} />
            </button>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-body font-semibold">
                {mailbox.address}
              </Dialog.Title>
              <button
                className="mt-1 flex max-w-full items-center gap-1 text-2xs text-muted hover:text-ink"
                disabled={busy}
                title={t("邮箱头像与分组")}
                onClick={() => setAppearance("account")}
              >
                <Folder className="size-3 shrink-0" />
                <span className="truncate">{t(groupName)}</span>
              </button>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("连接设置")}
              aria-label={t("连接设置")}
              disabled={busy}
              onClick={() => setSettings(!settings)}
            >
              <Settings2 className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setCompose(!compose);
                setConfirmSend(false);
              }}
            >
              <Pencil className="size-4" />
              {t(compose ? "返回邮件" : "写邮件")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("关闭邮件窗口")}
              onClick={requestClose}
              disabled={busy}
            >
              <X className="size-4" />
            </Button>
          </header>
          {confirmClose && (
            <div
              className="flex flex-wrap items-center gap-3 border-b border-line bg-canvas p-4"
              role="alert"
            >
              <p className="flex-1 text-meta">{t("草稿尚未保存，关闭后会丢失当前编辑。")}</p>
              <Button variant="outline" onClick={() => setConfirmClose(false)}>
                {t("继续编辑")}
              </Button>
              <Button variant="outline" onClick={close}>
                {t("丢弃并关闭")}
              </Button>
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 border-b border-line px-4 py-3 text-meta text-crit"
            >
              <p className="min-w-0 flex-1 break-words">{error}</p>
              <button aria-label={t("关闭提示")} onClick={() => setError("")}>
                <X className="size-4" />
              </button>
            </div>
          )}
          {settings ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <MailConnectionSettings mailbox={mailbox} done={() => setSettings(false)} />
            </div>
          ) : compose ? (
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) setConfirmSend(true);
              }}
            >
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <p className="text-meta text-muted">
                  {t("发件人")}：{mailbox.address}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Field label={t("收件人")}>
                      <Input
                        aria-label={t("收件人")}
                        autoComplete="off"
                        value={draft.to}
                        disabled={busy}
                        onChange={(event) => changeDraft({ to: event.target.value })}
                        placeholder="name@example.com"
                      />
                    </Field>
                  </div>
                  <Field label={t("抄送")}>
                    <Input
                      aria-label={t("抄送")}
                      autoComplete="off"
                      value={draft.cc}
                      disabled={busy}
                      onChange={(event) => changeDraft({ cc: event.target.value })}
                    />
                  </Field>
                  <Field label={t("密送")}>
                    <Input
                      aria-label={t("密送")}
                      autoComplete="off"
                      value={draft.bcc}
                      disabled={busy}
                      onChange={(event) => changeDraft({ bcc: event.target.value })}
                    />
                  </Field>
                </div>
                <Field label={t("邮件主题")}>
                  <Input
                    aria-label={t("邮件主题")}
                    maxLength={200}
                    value={draft.subject}
                    disabled={busy}
                    onChange={(event) => changeDraft({ subject: event.target.value })}
                  />
                </Field>
                <Textarea
                  aria-label={t("邮件正文")}
                  className="min-h-64 leading-relaxed"
                  maxLength={256000}
                  value={draft.text}
                  disabled={busy}
                  onChange={(event) => changeDraft({ text: event.target.value })}
                />
                {draft.attachments.map((item, index) => (
                  <div key={`${index}:${item.name}`} className="flex items-center gap-2 text-meta">
                    <Paperclip className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("移除附件 {0}", item.name)}
                      disabled={busy}
                      onClick={() =>
                        changeDraft({
                          attachments: draft.attachments.filter(
                            (_, position) => position !== index,
                          ),
                        })
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
                {confirmSend && (
                  <section
                    className="space-y-2 border-y border-line py-4"
                    aria-label={t("发送确认")}
                  >
                    <h3 className="font-semibold">{t("确认发送这封邮件？")}</h3>
                    <p className="break-words text-meta">
                      {t("收件人")}：{draft.to}
                    </p>
                    {draft.cc && (
                      <p className="break-words text-meta">
                        {t("抄送")}：{draft.cc}
                      </p>
                    )}
                    {draft.bcc && (
                      <p className="break-words text-meta">
                        {t("密送")}：{draft.bcc}
                      </p>
                    )}
                    <p className="break-words text-meta">{draft.subject}</p>
                    <Button type="button" disabled={busy} onClick={() => void send()}>
                      <Send className="size-4" />
                      {t("确认发送")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmSend(false)}
                    >
                      {t("取消")}
                    </Button>
                  </section>
                )}
              </div>
              <footer className="flex flex-wrap items-center gap-2 border-t border-line p-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title={t("添加附件")}
                  aria-label={t("添加附件")}
                  disabled={busy || draft.attachments.length >= 5}
                  onClick={() =>
                    void action(async () => {
                      const items = await api.pickAttachments();
                      if (items.length + draft.attachments.length > 5)
                        throw new Error(t("最多添加 5 个附件"));
                      if (alive.current)
                        changeDraft({ attachments: [...draft.attachments, ...items] });
                    })
                  }
                >
                  <Paperclip className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api.saveDraft(mailbox.id, draft);
                      if (alive.current) {
                        setDraftSaved(true);
                        toast.success(t("草稿已加密保存"));
                      }
                    })
                  }
                >
                  <Save className="size-4" />
                  {t("保存草稿")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || !draftSaved}
                  onClick={() =>
                    void action(async () => {
                      const saved = await api.draft(mailbox.id);
                      if (alive.current && saved) {
                        setDraft(saved);
                        setDraftSaved(true);
                      }
                    })
                  }
                >
                  <FileText className="size-4" />
                  {t("恢复草稿")}
                </Button>
                <Button
                  type="submit"
                  className="ml-auto"
                  disabled={busy || !draft.to.trim() || !draft.subject.trim() || !mailbox.smtp}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  {t("发送")}
                </Button>
              </footer>
            </form>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
                <div className="w-44">
                  <Select
                    aria-label={t("邮件文件夹")}
                    disabled={busy}
                    value={folder}
                    onValueChange={(value) => {
                      setFolder(value);
                      setPage(0);
                    }}
                    options={folderOptions}
                  />
                </div>
                <form
                  className="order-last flex min-w-0 basis-full gap-1 sm:order-none sm:flex-1 sm:basis-0"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (busy) return;
                    setQuery(search);
                    setPage(0);
                  }}
                >
                  <Input
                    aria-label={t("搜索邮件主题或发件人")}
                    placeholder={t("搜索邮件主题或发件人")}
                    value={search}
                    disabled={busy}
                    maxLength={100}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="icon"
                    aria-label={t("搜索邮件")}
                    disabled={busy}
                  >
                    <Search className="size-4" />
                  </Button>
                </form>
                <label className="flex items-center gap-2 text-meta">
                  <input
                    type="checkbox"
                    checked={unseen}
                    disabled={busy}
                    onChange={(event) => {
                      setUnseen(event.target.checked);
                      setPage(0);
                    }}
                  />
                  {t("仅未读")}
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("刷新邮件")}
                  title={t("刷新邮件")}
                  disabled={busy || loading}
                  onClick={() => setRevision((value) => value + 1)}
                >
                  <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                </Button>
              </div>
              <div className="mail-reader-split grid min-h-0 flex-1 md:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)]">
                <div
                  className={cn(
                    "flex min-h-0 flex-col border-r border-line",
                    selected && "hidden md:flex",
                  )}
                >
                  <div
                    className="min-h-0 flex-1 overflow-y-auto"
                    aria-label={t("邮件列表")}
                    aria-busy={loading}
                  >
                    {loading ? (
                      <MailSkeleton />
                    ) : (
                      messages?.items.map((item) => (
                        <button
                          key={item.uid}
                          disabled={busy}
                          className={cn(
                            "mail-message-row w-full border-b border-line p-4 text-left hover:bg-canvas",
                            selected?.uid === item.uid && "mail-message-selected",
                          )}
                          aria-current={selected?.uid === item.uid ? "true" : undefined}
                          aria-label={t("查看邮件 {0}", item.subject || t("无主题"))}
                          onClick={() => {
                            setSelected({
                              uid: item.uid,
                              folder: messages.folder,
                              uidValidity: messages.uidValidity,
                            });
                            setError("");
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <MailAvatar
                              address={item.from[0]?.address ?? ""}
                              name={item.from[0]?.name}
                              image={senderImage(item.from[0]?.address ?? "")}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "min-w-0 flex-1 truncate text-meta",
                                    item.seen ? "text-muted" : "font-semibold",
                                  )}
                                >
                                  {item.from[0]?.name || item.from[0]?.address || t("未知发件人")}
                                </span>
                                <time
                                  className="shrink-0 text-2xs text-muted"
                                  title={
                                    item.date
                                      ? new Date(item.date).toLocaleString(intlLocale())
                                      : ""
                                  }
                                >
                                  {compactMailDate(item.date)}
                                </time>
                              </div>
                              <p
                                className={cn(
                                  "mt-1.5 line-clamp-2 break-words text-body leading-snug",
                                  !item.seen && "font-semibold",
                                )}
                              >
                                {item.subject || t("无主题")}
                              </p>
                              <div className="mt-2 flex items-center gap-1.5 text-2xs text-muted">
                                <span
                                  className={cn(
                                    "size-1.5 shrink-0 rounded-full",
                                    item.seen ? "bg-transparent" : "bg-link",
                                  )}
                                />
                                <span>{t(item.seen ? "已读" : "未读")}</span>
                              </div>
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                    {!loading && messages?.items.length === 0 && (
                      <div className="grid min-h-64 place-content-center gap-3 p-6 text-center text-muted">
                        <Inbox className="mx-auto size-9" strokeWidth={1.3} />
                        <p className="text-meta">{t("没有匹配的邮件")}</p>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between border-t border-line p-2">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("上一页")}
                      disabled={busy || loading || page === 0}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    <span className="text-2xs text-muted">
                      {t("第 {0} 页 · {1} 封", page + 1, messages?.total ?? 0)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("下一页")}
                      disabled={busy || loading || (page + 1) * 30 >= (messages?.total ?? 0)}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                </div>
                <div
                  className={cn(
                    "mail-reading-pane min-h-0 overflow-y-auto px-4 pb-6 sm:px-6",
                    !selected && "hidden md:block",
                  )}
                  ref={readingPane}
                  aria-label={t("邮件阅读区")}
                  aria-busy={reading}
                >
                  {selected && (
                    <Button
                      className="mb-2 mt-3 md:hidden"
                      disabled={busy}
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(null)}
                    >
                      <ArrowLeft className="size-4" />
                      {t("返回列表")}
                    </Button>
                  )}
                  {reading ? (
                    <MailSkeleton reading />
                  ) : message ? (
                    <>
                      <div className="sticky top-0 z-10 -mx-4 mb-5 flex flex-wrap gap-1 border-b border-line bg-card px-4 py-3 sm:-mx-6 sm:px-6">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => respond(false)}
                        >
                          <Reply className="size-4" />
                          {t("回复")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => respond(true)}
                        >
                          <Forward className="size-4" />
                          {t("转发")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await api.seen(mailbox.id, selected!, !message.seen);
                              if (alive.current) {
                                if (unseen && !message.seen) {
                                  setRevision((value) => value + 1);
                                  return;
                                }
                                setMessage({ ...message, seen: !message.seen });
                                setMessages(
                                  (current) =>
                                    current && {
                                      ...current,
                                      items: current.items.map((item) =>
                                        item.uid === message.uid
                                          ? { ...item, seen: !message.seen }
                                          : item,
                                      ),
                                    },
                                );
                              }
                            })
                          }
                        >
                          {message.seen ? (
                            <Mail className="size-4" />
                          ) : (
                            <MailOpen className="size-4" />
                          )}
                          {t(message.seen ? "标为未读" : "标为已读")}
                        </Button>
                      </div>
                      <h2 className="break-words text-xl font-semibold leading-snug">
                        {message.subject || t("无主题")}
                      </h2>
                      <div className="mt-5 flex items-start gap-3">
                        <button
                          className="shrink-0 rounded-full"
                          title={t("编辑发件人头像")}
                          aria-label={t("编辑发件人头像")}
                          disabled={busy || !message.from[0]?.address}
                          onClick={() => setAppearance(message.from[0])}
                        >
                          <MailAvatar
                            address={message.from[0]?.address ?? ""}
                            name={message.from[0]?.name}
                            image={senderImage(message.from[0]?.address ?? "")}
                          />
                        </button>
                        <div className="min-w-0 flex-1 text-meta">
                          <p className="break-words font-medium">
                            {message.from.map((item) => item.name || item.address).join(", ")}
                          </p>
                          <p className="mt-0.5 break-all text-2xs text-muted">
                            {message.from.map((item) => item.address).join(", ")}
                          </p>
                          <p className="mt-2 break-words text-2xs text-muted">
                            {t("收件人")}：{message.to.map((item) => item.address).join(", ")}
                          </p>
                          {!!message.cc.length && (
                            <p className="mt-1 break-words text-2xs text-muted">
                              {t("抄送")}：{message.cc.map((item) => item.address).join(", ")}
                            </p>
                          )}
                          <p className="mt-1 text-2xs text-muted">
                            {message.date
                              ? new Date(message.date).toLocaleString(intlLocale())
                              : "--"}
                          </p>
                        </div>
                      </div>
                      <div className="mail-body-enter mt-5 border-t border-line pt-5">
                        <MailContent
                          key={`${mailbox.id}:${selected?.folder}:${selected?.uidValidity}:${message.uid}`}
                          message={message}
                        />
                      </div>
                      {message.attachments.length > 0 && (
                        <div className="mt-6 border-t border-line pt-4">
                          <h3 className="mb-2 text-meta font-semibold">{t("附件")}</h3>
                          {message.attachments.map((item) => (
                            <div key={item.index} className="flex items-center gap-2 py-2">
                              <Paperclip className="size-4 shrink-0 text-muted" />
                              <span className="min-w-0 flex-1 truncate text-meta">{item.name}</span>
                              <span className="text-2xs text-muted">
                                {Math.ceil(item.size / 1024)} KB
                              </span>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title={t("下载附件")}
                                aria-label={t("下载附件 {0}", item.name)}
                                disabled={busy}
                                onClick={() =>
                                  void action(async () => {
                                    if (await api.download(mailbox.id, selected!, item.index))
                                      toast.success(t("附件已保存"));
                                  })
                                }
                              >
                                <Download className="size-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="grid h-full min-h-64 place-content-center text-center text-muted">
                      <span className="mx-auto mb-5 grid size-20 place-items-center rounded-full bg-canvas">
                        <MailOpen className="size-9" strokeWidth={1.2} />
                      </span>
                      <p className="text-meta">{t("选择一封邮件")}</p>
                    </div>
                  )}
                </div>
              </div>
              <p className="border-t border-line px-4 py-2 text-2xs text-muted">
                {t("正文仅在本机显示，不发送给 AI。远程图片默认屏蔽。")}
              </p>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
      {appearance && (
        <MailAppearanceEditor
          mailbox={mailbox}
          sender={appearance === "account" ? undefined : appearance}
          close={() => setAppearance(null)}
        />
      )}
    </Dialog.Root>
  );
}

function MailConnectionSettings({ mailbox, done }: { mailbox: Mailbox; done: () => void }) {
  const [imapHost, setImapHost] = useState(mailbox.imap?.host ?? "");
  const [imapPort, setImapPort] = useState(String(mailbox.imap?.port ?? 993));
  const [host, setHost] = useState(mailbox.smtp?.host ?? "");
  const [port, setPort] = useState(String(mailbox.smtp?.port ?? 465));
  const [security, setSecurity] = useState<SmtpConnection["security"]>(
    mailbox.smtp?.security ?? "tls",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="mx-auto max-w-lg space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          const bridge = hostBridge()!;
          const imap = await bridge.mailboxes.validate({
            host: imapHost,
            port: Number(imapPort),
            secure: true,
          });
          const smtp = await bridge.mailClient.validateSmtp({ host, port: Number(port), security });
          const latest = useAppStore.getState().mailboxes.find((item) => item.id === mailbox.id);
          if (!latest) throw new Error(t("邮箱已不存在"));
          await useAppStore.getState().upsertMail({ ...latest, imap, smtp });
          done();
        } catch (caught) {
          setError(describe(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-lg font-semibold">{t("收发邮件连接设置")}</h2>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setError("");
          try {
            const provider = await hostBridge()!.mail.guess(mailbox.address);
            if (!provider) throw new Error(t("未识别服务商，请手动填写"));
            setImapHost(provider.imap.host);
            setImapPort(String(provider.imap.port));
            setHost(provider.smtp.host);
            setPort(String(provider.smtp.port));
            setSecurity(provider.smtp.port === 465 ? "tls" : "starttls");
          } catch (caught) {
            setError(describe(caught));
          }
        }}
      >
        {t("填入服务商预设")}
      </Button>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <Field label={t("IMAP 服务器")}>
          <Input
            aria-label={t("IMAP 服务器")}
            value={imapHost}
            onChange={(event) => setImapHost(event.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label={t("IMAP 端口")}>
          <Input
            aria-label={t("IMAP 端口")}
            type="number"
            min={1}
            max={65535}
            value={imapPort}
            onChange={(event) => setImapPort(event.target.value)}
            disabled={busy}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <Field label={t("SMTP 服务器")}>
          <Input
            aria-label={t("SMTP 服务器")}
            value={host}
            onChange={(event) => setHost(event.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label={t("SMTP 端口")}>
          <Input
            aria-label={t("SMTP 端口")}
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            disabled={busy}
          />
        </Field>
      </div>
      <Select
        aria-label={t("SMTP 加密方式")}
        value={security}
        onValueChange={(value) => {
          setSecurity(value as SmtpConnection["security"]);
          setPort(value === "tls" ? "465" : "587");
        }}
        options={[
          { value: "tls", label: "TLS" },
          { value: "starttls", label: "STARTTLS" },
        ]}
        disabled={busy}
      />
      <p className="text-meta text-muted">
        {t("使用邮箱详情中已加密保存的用户名和密码 / 授权码。服务商必须允许 IMAP 和 SMTP 登录。")}
      </p>
      {error && (
        <p role="alert" className="text-meta text-crit">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        <Save className="size-4" />
        {t("保存连接设置")}
      </Button>
    </form>
  );
}
