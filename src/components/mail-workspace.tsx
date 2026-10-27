import { hostBridge } from "@/lib/web-bridge";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  FolderOpen,
  FolderPlus,
  Mail,
  Pencil,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";
import { cn, uid } from "@/lib/utils";
import {
  deleteMailFolder,
  mailFolderId,
  moveMailboxes,
  normalizeMailFolders,
  type MailFolder,
} from "@/lib/mail-folders";
import { matchesTags } from "@/lib/tags";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";
import { openFromEvent } from "./asset-card";
import { MailReader } from "./mail-reader";
import { MailAvatar, MailAppearanceEditor } from "./mail-avatar";
import { CollectionCard } from "./ui/collection-card";

export function MailWorkspace() {
  const state = useAppStore();
  const folders = normalizeMailFolders(state.mailFolders);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<MailFolder | "new" | null>(null);
  const [reader, setReader] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = state.query.trim().toLocaleLowerCase();
  const matching = state.mailboxes.filter(
    (mailbox) =>
      `${mailbox.address} ${mailbox.domain} ${mailbox.notes} ${mailbox.tags.join(" ")} ${t(folders.find((item) => item.id === mailFolderId(mailbox, folders))?.name ?? "未分组")}`
        .toLocaleLowerCase()
        .includes(query) &&
      matchesTags(mailbox, state.tagFilter) &&
      (state.filter !== "attention" || mailbox.status !== "online"),
  );
  const allFolders = [...folders, { id: "", name: t("未分组"), color: "amber" as const }];
  const folder = allFolders.find((item) => item.id === active);
  const displayed = matching.filter((mailbox) => mailFolderId(mailbox, folders) === active);
  const selectedIds = selected.filter((id) => displayed.some((mailbox) => mailbox.id === id));

  async function move(target: string) {
    setBusy(true);
    try {
      await useAppStore.setState((latest) => ({
        mailboxes: moveMailboxes(
          latest.mailboxes,
          selectedIds,
          target,
          normalizeMailFolders(latest.mailFolders),
        ),
      }));
      setSelected([]);
      toast.success(t("邮箱已移动"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function openReader(id: string) {
    if (!hostBridge()) {
      toast.error(t("邮件收发需要桌面端"));
      return;
    }
    if (await useVault.getState().require(t("查看和发送邮件需要解锁密钥库。"))) setReader(id);
  }
  return (
    <section className="p-4" aria-label={t("邮箱文件夹")}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {active !== null && (
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("返回文件夹")}
              aria-label={t("返回文件夹")}
              onClick={() => {
                setActive(null);
                setSelected([]);
              }}
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <h2 className="truncate text-lg font-semibold">
            {active === null ? t("邮箱文件夹") : t(folder?.name ?? "未分组")}
          </h2>
          <span className="text-meta text-muted">
            {t("{0} 个邮箱", active === null ? matching.length : displayed.length)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {folder?.id && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("编辑文件夹")}
              title={t("编辑文件夹")}
              onClick={() => setEditor(folder)}
            >
              <Pencil className="size-4" />
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setEditor("new")}>
            <FolderPlus className="size-4" />
            {t("新建文件夹")}
          </Button>
        </div>
      </div>
      {active === null ? (
        <div className="collection-grid">
          {query &&
            !matching.length &&
            !allFolders.some((item) => t(item.name).toLocaleLowerCase().includes(query)) && (
              <div className="col-span-full py-16 text-center text-muted">
                <FolderOpen className="mx-auto mb-3 size-10" strokeWidth={1} />
                <p>{t("没有匹配的邮箱。")}</p>
              </div>
            )}
          {allFolders
            .filter(
              (item) =>
                !query ||
                t(item.name).toLocaleLowerCase().includes(query) ||
                matching.some((mailbox) => mailFolderId(mailbox, folders) === item.id),
            )
            .map((item) => {
              const mailboxes = matching.filter(
                (mailbox) => mailFolderId(mailbox, folders) === item.id,
              );
              return (
                <CollectionCard
                  key={item.id}
                  name={t(item.name)}
                  color={item.color}
                  count={mailboxes.length}
                  unit={t("个邮箱")}
                  description={
                    mailboxes.length
                      ? t("{0} 个账号", mailboxes.length)
                      : t("分类收纳，随时打开收件箱")
                  }
                  openLabel={t("打开文件夹 {0}", t(item.name))}
                  editLabel={t("编辑文件夹 {0}", t(item.name))}
                  onEdit={item.id ? () => setEditor(item) : undefined}
                  onOpen={() => {
                    setActive(item.id);
                    setSelected([]);
                  }}
                  preview={
                    mailboxes.length ? (
                      <>
                        {mailboxes.slice(0, 2).map((mailbox) => (
                          <MailAvatar
                            key={mailbox.id}
                            address={mailbox.address}
                            image={mailbox.imageDataUrl}
                            size="sm"
                          />
                        ))}
                        <span className="collection-card-preview-label">
                          {mailboxes[0].address}
                        </span>
                      </>
                    ) : (
                      <span className="collection-card-preview-label">
                        {t("空文件夹 · 打开后添加邮箱")}
                      </span>
                    )
                  }
                />
              );
            })}
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-meta">
              <input
                type="checkbox"
                checked={displayed.length > 0 && selectedIds.length === displayed.length}
                disabled={busy || !displayed.length}
                onChange={(event) =>
                  setSelected(event.target.checked ? displayed.map((item) => item.id) : [])
                }
              />
              {t("全选")}
            </label>
            {selectedIds.length > 0 && (
              <div className="w-52">
                <Select
                  aria-label={t("移动到文件夹")}
                  value=""
                  placeholder={t("移动到文件夹")}
                  disabled={busy}
                  onValueChange={(value) => void move(value === "__ungrouped" ? "" : value)}
                  options={allFolders
                    .filter((item) => item.id !== active)
                    .map((item) => ({ value: item.id || "__ungrouped", label: t(item.name) }))}
                />
              </div>
            )}
            <Button
              className="ml-auto"
              variant="ghost"
              size="sm"
              onClick={() => state.openComposer("mail", null, { folderId: active ?? "" })}
            >
              <Mail className="size-4" />
              {t("添加邮箱")}
            </Button>
          </div>
          <div className="divide-y divide-line border-y border-line">
            {displayed.map((mailbox) => (
              <div
                key={mailbox.id}
                data-mailbox-id={mailbox.id}
                className="flex items-center gap-3 py-4"
              >
                <input
                  type="checkbox"
                  aria-label={t("选择邮箱 {0}", mailbox.address)}
                  checked={selectedIds.includes(mailbox.id)}
                  disabled={busy}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selectedIds, mailbox.id]
                        : selectedIds.filter((id) => id !== mailbox.id),
                    )
                  }
                />
                <button
                  title={t("邮箱头像与分组")}
                  aria-label={t("编辑 {0} 的头像与分组", mailbox.address)}
                  onClick={() => setAppearance(mailbox.id)}
                >
                  <MailAvatar address={mailbox.address} image={mailbox.imageDataUrl} />
                </button>
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void openReader(mailbox.id)}
                  disabled={mailbox.kind !== "mailbox" || mailbox.demo}
                >
                  <span className="block truncate font-medium">{mailbox.address}</span>
                  <span className="mt-1 block truncate text-meta text-muted">
                    {mailbox.domain}
                    {` · ${t(folder?.name ?? "未分组")}`}
                    {mailbox.mailStatus ? ` · ${t("未读 {0}", mailbox.mailStatus.unseen)}` : ""}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={t("邮箱详情与连接设置")}
                  aria-label={t("邮箱详情与连接设置")}
                  onClick={(event) => openFromEvent(event, "mail", mailbox.id)}
                >
                  <Settings2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          {displayed.length === 0 && (
            <div className="py-16 text-center text-muted">
              <FolderOpen className="mx-auto mb-3 size-10" strokeWidth={1} />
              <p>{t("没有匹配的邮箱。")}</p>
            </div>
          )}
        </>
      )}
      {editor && (
        <FolderEditor
          key={editor === "new" ? "new" : editor.id}
          folder={editor}
          close={() => {
            setEditor(null);
            if (active && !useAppStore.getState().mailFolders?.some((item) => item.id === active))
              setActive(null);
          }}
        />
      )}
      {reader && <MailReader mailboxId={reader} close={() => setReader(null)} />}
      {appearance && state.mailboxes.find((item) => item.id === appearance) && (
        <MailAppearanceEditor
          mailbox={state.mailboxes.find((item) => item.id === appearance)!}
          close={() => setAppearance(null)}
        />
      )}
    </section>
  );
}

function FolderEditor({ folder, close }: { folder: MailFolder | "new"; close: () => void }) {
  const [name, setName] = useState(folder === "new" ? "" : folder.name);
  const [color, setColor] = useState<MailFolder["color"]>(folder === "new" ? "blue" : folder.color);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(remove = false) {
    setBusy(true);
    setError("");
    try {
      const latest = useAppStore.getState();
      const folders = normalizeMailFolders(latest.mailFolders);
      if (remove && folder !== "new")
        await useAppStore.setState(deleteMailFolder(latest.mailboxes, folders, folder.id));
      else {
        if (!name.trim() || name.trim().length > 40)
          throw new Error(t("文件夹名称需要 1 到 40 个字符"));
        if (
          folders.some(
            (item) => item.name === name.trim() && (folder === "new" || item.id !== folder.id),
          )
        )
          throw new Error(t("文件夹名称已存在"));
        if (folder === "new" && folders.length >= 100) throw new Error(t("最多创建 100 个文件夹"));
        const next = { id: folder === "new" ? uid() : folder.id, name: name.trim(), color };
        await useAppStore.setState({
          mailFolders:
            folder === "new"
              ? [...folders, next]
              : folders.map((item) => (item.id === folder.id ? next : item)),
        });
      }
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 rounded-lg bg-card p-5 text-ink shadow-float"
        >
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold">
              {t(folder === "new" ? "新建文件夹" : "编辑文件夹")}
            </Dialog.Title>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("关闭")}
              onClick={close}
              disabled={busy}
            >
              <X className="size-4" />
            </Button>
          </div>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field label={t("文件夹名称")}>
              <Input
                autoFocus
                aria-label={t("文件夹名称")}
                value={name}
                maxLength={40}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="flex gap-3" role="group" aria-label={t("文件夹颜色")}>
              {(["blue", "green", "rose", "amber"] as const).map((tone) => (
                <button
                  key={tone}
                  type="button"
                  aria-label={t({ blue: "蓝色", green: "绿色", rose: "玫红", amber: "琥珀" }[tone])}
                  aria-pressed={color === tone}
                  onClick={() => setColor(tone)}
                  className={cn(
                    "mail-folder-swatch",
                    `mail-folder-${tone}`,
                    color === tone && "ring-2 ring-ink ring-offset-2 ring-offset-card",
                  )}
                />
              ))}
            </div>
            {error && (
              <p className="text-meta text-crit" role="alert">
                {error}
              </p>
            )}
            {deleting && (
              <p className="text-meta text-muted">
                {t("删除文件夹后，邮箱将移至未分组，邮件和账号不会删除。")}
              </p>
            )}
            <div className="flex justify-between gap-2">
              {folder !== "new" && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => (deleting ? void save(true) : setDeleting(true))}
                >
                  <Trash2 className="size-4" />
                  {t(deleting ? "确认删除文件夹" : "删除文件夹")}
                </Button>
              )}
              <Button type="submit" className="ml-auto" disabled={busy || !name.trim()}>
                {t("保存")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
