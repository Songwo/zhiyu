import { isWeb } from "@/lib/web";
import { vaultApi } from "@/lib/vault-api";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
  X,
  UserRound,
  ArrowDownUp,
  LockKeyhole,
  ShieldCheck,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store";
import { t } from "@/lib/i18n";
import { cn, uid } from "@/lib/utils";
import {
  deleteSecretFolder,
  moveSecrets,
  normalizeSecretFolders,
  secretFolderId,
  type SecretFolder,
} from "@/lib/secret-folders";
import { matchesTags } from "@/lib/tags";
import type { Secret } from "@/lib/types";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";
import { openFromEvent } from "./asset-card";
import { CollectionCard } from "./ui/collection-card";
import { BrowserPasswordTransfer } from "./browser-password-transfer";
import { isDesktop } from "@/lib/desktop";
import { useVault } from "@/lib/vault-state";

const KIND_LABEL: Record<Secret["kind"], string> = {
  account: "账号密码",
  password: "网站账号",
  api: "API Key",
  ssh: "SSH 私钥",
  token: "Token",
};

/**
 * 密钥分组工作台（0.10.0）：密钥数量增长后按分组收纳，结构对齐邮箱收纳
 * 文件夹——分组网格进入、组内行列表、批量移动、重命名与颜色编辑。
 * 只在卡片布局启用；表格与关系图布局保持原有平铺行为。
 */
export function VaultWorkspace() {
  const state = useAppStore();
  const unlocked = useVault((s) => s.unlocked);
  const requireVault = useVault((s) => s.require);
  const folders = normalizeSecretFolders(state.secretFolders);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<SecretFolder | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const query = state.query.trim().toLocaleLowerCase();
  const matching = state.secrets.filter(
    (secret) =>
      `${secret.name} ${secret.kind} ${secret.hint} ${secret.tags.join(" ")} ${t(
        folders.find((item) => item.id === secretFolderId(secret, folders))?.name ?? "未分组",
      )}`
        .toLocaleLowerCase()
        .includes(query) &&
      matchesTags(secret, state.tagFilter) &&
      (state.filter !== "attention" || secret.status !== "online"),
  );
  const allFolders = [...folders, { id: "", name: t("未分组"), color: "amber" as const }];
  const folder = allFolders.find((item) => item.id === active);
  const displayed = matching.filter((secret) => secretFolderId(secret, folders) === active);
  const selectedIds = selected.filter((id) => displayed.some((secret) => secret.id === id));

  async function move(target: string) {
    setBusy(true);
    try {
      await useAppStore.setState((latest) => ({
        secrets: moveSecrets(
          latest.secrets,
          selectedIds,
          target,
          normalizeSecretFolders(latest.secretFolders),
        ),
      }));
      setSelected([]);
      toast.success(t("密钥已移动"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="p-4" aria-label={t("密钥分组")}>
      {vaultApi() && (
        <div
          className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3"
          role="status"
        >
          {unlocked ? (
            <ShieldCheck className="size-5 shrink-0 text-ok" />
          ) : (
            <LockKeyhole className="size-5 shrink-0 text-muted" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-meta font-semibold">
              {t(unlocked ? "密钥库已解锁" : "密钥库已锁定")}
            </p>
            <p className="mt-1 text-2xs text-muted">
              {t(
                unlocked
                  ? isWeb()
                    ? "主密码只在这个标签页里用于解密；刷新或关闭页面后会重新锁定。"
                    : "本次运行内无需重复解锁；锁屏、休眠或退出后会重新锁定。"
                  : "资料仍然保留。点击账号即可解锁并查看，无需前往设置。",
              )}
            </p>
          </div>
          {!unlocked && (
            <Button
              size="sm"
              onClick={() =>
                void requireVault(t("解锁后继续查看和编辑账号。")).catch((error) =>
                  toast.error(String(error)),
                )
              }
            >
              <LockKeyhole className="size-4" />
              {t("解锁密钥库")}
            </Button>
          )}
        </div>
      )}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {active !== null && (
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("返回分组")}
              aria-label={t("返回分组")}
              onClick={() => {
                setActive(null);
                setSelected([]);
              }}
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <h2 className="truncate text-lg font-semibold">
            {active === null ? t("密钥分组") : t(folder?.name ?? "未分组")}
          </h2>
          <span className="text-meta text-muted">
            {t("{0} 项资料", active === null ? matching.length : displayed.length)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isWeb() && (
            <Button variant="outline" size="sm" onClick={() => setTransferOpen(true)}>
              <ArrowDownUp className="size-4" />
              {t("浏览器密码")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              state.openComposer("secret", null, { kind: "account", folderId: active ?? "" })
            }
          >
            <UserRound className="size-4" />
            {t("添加账号")}
          </Button>
          {folder?.id && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("编辑分组")}
              title={t("编辑分组")}
              onClick={() => setEditor(folder)}
            >
              <Pencil className="size-4" />
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setEditor("new")}>
            <FolderPlus className="size-4" />
            {t("新建分组")}
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
                <p>{t("没有匹配的密钥。")}</p>
              </div>
            )}
          {allFolders
            .filter(
              (item) =>
                !query ||
                t(item.name).toLocaleLowerCase().includes(query) ||
                matching.some((secret) => secretFolderId(secret, folders) === item.id),
            )
            .map((item) => {
              const members = matching.filter(
                (secret) => secretFolderId(secret, folders) === item.id,
              );
              return (
                <CollectionCard
                  key={item.id}
                  name={t(item.name)}
                  color={item.color}
                  count={members.length}
                  unit={t("项资料")}
                  description={
                    members.length
                      ? t(
                          "{0} 个账号 · {1} 项凭据",
                          members.filter((secret) => ["account", "password"].includes(secret.kind))
                            .length,
                          members.filter((secret) => !["account", "password"].includes(secret.kind))
                            .length,
                        )
                      : t("账号与凭据的独立收纳空间")
                  }
                  openLabel={t("打开分组 {0}", t(item.name))}
                  editLabel={t("编辑分组 {0}", t(item.name))}
                  onEdit={item.id ? () => setEditor(item) : undefined}
                  onOpen={() => {
                    setActive(item.id);
                    setSelected([]);
                  }}
                  preview={
                    members.length ? (
                      members.slice(0, 2).map((secret) => (
                        <span key={secret.id} className="collection-card-preview-chip">
                          {secret.name}
                        </span>
                      ))
                    ) : (
                      <span className="collection-card-preview-label">
                        {t("空分组 · 打开后添加资料")}
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
                  aria-label={t("移动到分组")}
                  value=""
                  placeholder={t("移动到分组")}
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
              onClick={() => state.openComposer("secret", null, { folderId: active ?? "" })}
            >
              <Plus className="size-4" />
              {t("添加密钥")}
            </Button>
          </div>
          <div className="divide-y divide-line border-y border-line">
            {displayed.map((secret) => (
              <div
                key={secret.id}
                className="group flex items-center gap-3 rounded-lg px-2 transition-colors duration-150 hover:bg-card"
              >
                <input
                  type="checkbox"
                  aria-label={t("选择密钥 {0}", secret.name)}
                  checked={selectedIds.includes(secret.id)}
                  disabled={busy}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selectedIds, secret.id]
                        : selectedIds.filter((id) => id !== secret.id),
                    )
                  }
                />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  aria-label={t("查看账号与凭据 {0}", secret.name)}
                  onClick={(event) => {
                    openFromEvent(event, "secret", secret.id);
                    if (vaultApi() && !useVault.getState().unlocked)
                      void requireVault(t("解锁后继续查看和编辑账号。")).catch((error) =>
                        toast.error(String(error)),
                      );
                  }}
                >
                  {["account", "password"].includes(secret.kind) ? (
                    <UserRound className="size-5 shrink-0 text-muted" />
                  ) : (
                    <KeyRound className="size-5 shrink-0 text-muted" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{secret.name}</span>
                    <span className="mt-1 block truncate text-meta text-muted">
                      {t(KIND_LABEL[secret.kind] ?? secret.kind)}
                      {secret.hint ? ` · ${secret.hint}` : ""}
                      {secret.tags.length ? ` · ${secret.tags.join(" / ")}` : ""}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" />
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={t("编辑账号与凭据")}
                  aria-label={t("编辑账号与凭据 {0}", secret.name)}
                  onClick={async () => {
                    try {
                      if (vaultApi() && !(await requireVault(t("解锁后继续查看和编辑账号。"))))
                        return;
                      state.openComposer("secret", secret.id);
                    } catch (error) {
                      toast.error(String(error));
                    }
                  }}
                >
                  <Pencil className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          {displayed.length === 0 && (
            <div className="py-16 text-center text-muted">
              <FolderOpen className="mx-auto mb-3 size-10" strokeWidth={1} />
              <p>{t("没有匹配的密钥。")}</p>
            </div>
          )}
        </>
      )}
      {transferOpen && <BrowserPasswordTransfer close={() => setTransferOpen(false)} />}
      {editor && (
        <FolderEditor
          key={editor === "new" ? "new" : editor.id}
          folder={editor}
          close={() => {
            setEditor(null);
            if (active && !useAppStore.getState().secretFolders?.some((item) => item.id === active))
              setActive(null);
          }}
        />
      )}
    </section>
  );
}

function FolderEditor({ folder, close }: { folder: SecretFolder | "new"; close: () => void }) {
  const [name, setName] = useState(folder === "new" ? "" : folder.name);
  const [color, setColor] = useState<SecretFolder["color"]>(
    folder === "new" ? "blue" : folder.color,
  );
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(remove = false) {
    setBusy(true);
    setError("");
    try {
      const latest = useAppStore.getState();
      const folders = normalizeSecretFolders(latest.secretFolders);
      if (remove && folder !== "new")
        await useAppStore.setState(deleteSecretFolder(latest.secrets, folders, folder.id));
      else {
        if (!name.trim() || name.trim().length > 40)
          throw new Error(t("分组名称需要 1 到 40 个字符"));
        if (
          folders.some(
            (item) => item.name === name.trim() && (folder === "new" || item.id !== folder.id),
          )
        )
          throw new Error(t("分组名称已存在"));
        if (folder === "new" && folders.length >= 100) throw new Error(t("最多创建 100 个分组"));
        const next = { id: folder === "new" ? uid() : folder.id, name: name.trim(), color };
        await useAppStore.setState({
          secretFolders:
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
              {t(folder === "new" ? "新建分组" : "编辑分组")}
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
            <Field label={t("分组名称")}>
              <Input
                autoFocus
                aria-label={t("分组名称")}
                value={name}
                maxLength={40}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="flex gap-3" role="group" aria-label={t("分组颜色")}>
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
                {t("删除分组后，密钥将移至未分组，密钥本身和凭据不会删除。")}
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
                  {t(deleting ? "确认删除分组" : "删除分组")}
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
