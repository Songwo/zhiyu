import { X, LogIn, Pencil, ChartNoAxesCombined, ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { AccountFields, accountFromForm } from "./account-fields";
import { CredentialFields, credentialFromForm } from "./credential-fields";
import { MailLogin } from "./mail-login";
import { SmartPaste } from "./smart-paste";
import { AiAccountsPanel } from "./ai-accounts";
import { ImagePicker } from "./image-picker";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/input";
import { accountId, credentialId, desktop, isDesktop } from "@/lib/desktop";
import { usePresence } from "@/lib/motion";
import { KIND_LABEL } from "@/lib/status";
import { parseTags } from "@/lib/tags";
import { useVault } from "@/lib/vault-state";
import { useAppStore } from "@/lib/store";
import type {
  AiAsset,
  AssetKind,
  Certificate,
  Domain,
  Mailbox,
  Secret,
  Server,
  ServiceAsset,
  Snapshot,
} from "@/lib/types";
import { normalizeService } from "../../electron/services/service-assets.mjs";
import { SERVICE_LABELS } from "@/lib/services";
import { uid } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { accountMetadataFromForm, clearAccountDraft } from "@/lib/account-record.mjs";
import {
  initialAiMode,
  initialServerMode,
  serverAccountDraft,
  serverAccountKey,
  serverAssetFromDraft,
  sshDraftForSave,
} from "@/lib/composer-draft.mjs";

export function Composer() {
  const open = useAppStore((s) => s.composerOpen);
  const kind = useAppStore((s) => s.composerKind);
  const editingId = useAppStore((s) => s.editingId);
  const close = useAppStore((s) => s.closeComposer);
  const captureId = useAppStore((s) => s.composerPreset?._captureId);
  const unlocked = useVault((s) => s.unlocked);
  const captured = useRef(false);
  if (open) captured.current = Boolean(captureId);
  const { mounted, shown } = usePresence(open, 180);
  // Closing clears `editingId`, so the exit would otherwise re-title itself
  // from "编辑" to "添加" halfway out.
  const last = useRef({ kind, editingId });
  const [sessionRevision, setSessionRevision] = useState(0);
  useEffect(
    () =>
      useAppStore.subscribe((state, previous) => {
        if (
          state.composerOpen &&
          (!previous.composerOpen ||
            state.composerKind !== previous.composerKind ||
            state.editingId !== previous.editingId ||
            state.composerPreset !== previous.composerPreset)
        ) {
          setSessionRevision((revision) => revision + 1);
        }
      }),
    [],
  );
  if (open) last.current = { kind, editingId };
  if (!mounted || (captured.current && (!open || !unlocked))) return null;
  return (
    <ComposerBody
      key={sessionRevision}
      kind={last.current.kind}
      editingId={last.current.editingId}
      shown={shown}
      onClose={close}
    />
  );
}

function ComposerBody({
  kind,
  editingId,
  shown,
  onClose,
}: {
  kind: AssetKind;
  editingId: string | null;
  shown: boolean;
  onClose: () => void;
}) {
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const mailboxes = useAppStore((s) => s.mailboxes);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const secrets = useAppStore((s) => s.secrets);
  const certs = useAppStore((s) => s.certs);
  const services = useAppStore((s) => s.services);
  // Reading the collections directly keeps `existing` referentially stable
  // between renders, which is what the reset effect below keys on.
  const existing = findAsset(kind, editingId, {
    servers,
    domains,
    mailboxes,
    aiAssets,
    secrets,
    certs,
    services,
  });
  const preset = useAppStore((s) => s.composerPreset);
  const [form, setForm] = useState<Record<string, string>>(() => ({
    ...defaults(kind, existing),
    ...preset,
  }));
  const [aiMode, setAiMode] = useState<"choose" | "api" | "login" | "manual">(() =>
    initialAiMode(existing),
  );
  const [serverMode, setServerMode] = useState<"record" | "ssh">(() =>
    initialServerMode(existing, form),
  );
  const [imageBusy, setImageBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const standaloneAccount = kind === "secret" && form.kind === "account";
  const formRef = useRef(form);
  formRef.current = form;
  const accountGeneration = useRef(0);
  const sessionActive = useRef(true);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionActive.current = true;
    // 订阅同步失效，关闭与重新打开即使合并在同一次 React 渲染中也不能复活旧保存。
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        !state.composerOpen ||
        state.composerKind !== previous.composerKind ||
        state.editingId !== previous.editingId ||
        state.composerPreset !== previous.composerPreset
      ) {
        sessionActive.current = false;
      }
    });
    return () => {
      sessionActive.current = false;
      unsubscribe();
    };
  }, []);

  useEffect(
    () =>
      useVault.subscribe((state, previous) => {
        if (
          previous.unlocked &&
          !state.unlocked &&
          kind === "secret" &&
          formRef.current.kind === "account"
        ) {
          accountGeneration.current += 1;
          setForm(clearAccountDraft);
        }
      }),
    [kind],
  );

  useEffect(() => {
    if (!shown) return;
    // 等类型选择器释放焦点后，将键盘交给新表单，避免焦点落到页面背景。
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || useVault.getState().prompt || panel.contains(document.activeElement)) return;
      const visible = (element: HTMLElement) => element.getClientRects().length > 0;
      const input = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([disabled]), textarea:not([disabled])',
        ),
      ).find(visible);
      const action = Array.from(
        panel.querySelectorAll<HTMLElement>(".editor-scroll button:not([disabled])"),
      ).find(visible);
      (input ?? action ?? panel).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  // Reset only when the form changes *subject*. Keying on `existing` would
  // wipe half-typed input every time a background probe rewrote the record.
  useEffect(() => {
    const current = findAsset(kind, editingId, useAppStore.getState());
    const next = { ...defaults(kind, current), ...preset };
    setForm(next);
    setAiMode(initialAiMode(current));
    setServerMode(initialServerMode(current, next));
    setImageBusy(false);
  }, [kind, editingId, preset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !useVault.getState().prompt) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set(k: string, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (imageBusy || saving) return;
    if (standaloneAccount && !isDesktop()) {
      toast.error(t("账号密码需要桌面版的加密密钥库，网页版不会保存账号凭据。"));
      return;
    }
    if (standaloneAccount && !form.name?.trim()) {
      toast.error(t("请填写显示名称"));
      return;
    }
    const generation = accountGeneration.current;
    const accountStillOpen = () =>
      sessionActive.current &&
      useAppStore.getState().composerOpen &&
      (!standaloneAccount || generation === accountGeneration.current);
    const captureStillOpen = () =>
      !form._captureId ||
      (useAppStore.getState().composerOpen &&
        useAppStore.getState().composerPreset?._captureId === form._captureId &&
        useVault.getState().unlocked);
    if (!captureStillOpen() || !accountStillOpen()) return;
    const id = editingId ?? uid(kind.slice(0, 3));
    setSaving(true);
    try {
      // Secrets go to the encrypted vault before the asset is written, so a
      // half-saved record never ends up pointing at a credential that is not there.
      if (isDesktop()) {
        const sshDraft = kind === "server" ? sshDraftForSave(form, serverMode) : null;
        const sshCredential = sshDraft ? credentialFromForm(sshDraft) : null;
        const accountDraft = kind === "server" ? serverAccountDraft(form) : form;
        const draftAccount = accountFromForm(accountDraft);
        if (sshCredential || draftAccount || standaloneAccount) {
          const unlocked = await useVault.getState().require(t("保存账号与凭据需要先解锁密钥库。"));
          if (!accountStillOpen()) return;
          if (!unlocked) {
            toast(t("密钥库未解锁，凭据未保存"));
            return;
          } else {
            try {
              if (!captureStillOpen() || !accountStillOpen()) return;
              const vault = desktop()!.vault;
              const previous = editingId ? await vault.get(accountId(id)) : null;
              if (!captureStillOpen() || !accountStillOpen()) return;
              const account = accountFromForm(accountDraft, previous);
              if (standaloneAccount && (!account?.username?.trim() || !account.password)) {
                toast.error(t("请填写账户名和密码"));
                return;
              }
              if (!captureStillOpen() || !accountStillOpen()) return;
              if (sshCredential) await vault.set(credentialId(id), sshCredential);
              if (!captureStillOpen() || !accountStillOpen()) return;
              if (account) {
                await vault.set(accountId(id), account);
                if (standaloneAccount && !accountStillOpen()) {
                  if (!editingId) {
                    try {
                      await vault.remove(accountId(id));
                    } catch {
                      // 写入已经完成但锁库阻止清理时，留下可管理入口，且不碰后来打开的表单。
                      persist(kind, id, form, existing, serverMode);
                      toast.warning(
                        t("加密凭据未能清理，已保留「{0}」，可解锁后查看或删除。", form.name),
                      );
                    }
                  } else {
                    toast(t("编辑已关闭，已经写入的加密凭据已保留。"));
                  }
                  return;
                }
              }
            } catch (err) {
              if (!accountStillOpen()) return;
              toast(err instanceof Error ? err.message : t("凭据保存失败"));
              return;
            }
          }
        }
      }

      if (!captureStillOpen() || !accountStillOpen()) return;
      persist(kind, id, form, existing, serverMode);
      if (kind === "secret" && ["password", "account"].includes(form.kind) && form._mailboxId) {
        useAppStore.getState().linkAssets({ kind, id }, { kind: "mail", id: form._mailboxId });
      }
      useAppStore
        .getState()
        .log(
          `${editingId ? t("已更新") : t("已添加")} ${t(KIND_LABEL[kind])} ${form.name || form.address || form.cn || ""}`,
          kind,
        );
      toast.success(editingId ? t("已保存") : t("已添加"));
      onClose();
    } finally {
      if (sessionActive.current) setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        className="anim-scrim absolute inset-0 bg-ink/30"
        data-shown={shown}
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={
          standaloneAccount
            ? t("账号密码")
            : kind === "ai"
              ? t(editingId ? "编辑 AI 订阅" : "添加 AI 订阅")
              : t(KIND_LABEL[kind])
        }
        data-shown={shown}
        className="editor-dialog editor-dialog-inline"
      >
        <div className="editor-heading">
          <h2 className="text-lg font-semibold tracking-tight">
            {kind === "ai" ? (
              t(editingId ? "编辑 AI 订阅" : "添加 AI 订阅")
            ) : (
              <>
                {editingId ? t("编辑") : t("添加")}
                {t(standaloneAccount ? "账号密码" : KIND_LABEL[kind])}
              </>
            )}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11"
            aria-label={t("关闭")}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="editor-scroll">
          {kind === "ai" && !editingId && aiMode !== "choose" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-3"
              onClick={() => setAiMode("choose")}
            >
              <ArrowLeft className="size-3.5" />
              {t("重新选择来源")}
            </Button>
          )}
          {kind === "ai" && (aiMode === "login" || aiMode === "manual") && (
            <div
              role="tablist"
              aria-label={t("添加方式")}
              className="mb-5 grid grid-cols-2 gap-1 rounded-md bg-line p-1"
            >
              <Button
                type="button"
                role="tab"
                aria-selected={aiMode === "login"}
                variant={aiMode === "login" ? "outline" : "ghost"}
                onClick={() => setAiMode("login")}
              >
                <LogIn className="size-4" />
                {t("快速登录")}
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={aiMode === "manual"}
                variant={aiMode === "manual" ? "outline" : "ghost"}
                onClick={() => setAiMode("manual")}
              >
                <Pencil className="size-4" />
                {t("手动填写")}
              </Button>
            </div>
          )}
          {kind === "ai" && aiMode === "choose" ? (
            <div className="space-y-3">
              <p className="text-meta text-muted">{t("先选择要管理的 AI 来源。")}</p>
              <button
                type="button"
                className="flex w-full items-start gap-3 rounded-xl border border-line bg-canvas p-4 text-left transition-colors hover:bg-line focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => setAiMode("login")}
              >
                <LogIn className="mt-0.5 size-5 shrink-0 text-accent" />
                <span>
                  <span className="block font-semibold">{t("订阅账号")}</span>
                  <span className="mt-1 block text-meta text-muted">
                    {t("连接 ChatGPT / Codex、Claude 等账号，查看平台提供的订阅额度。")}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="flex w-full items-start gap-3 rounded-xl border border-line bg-canvas p-4 text-left transition-colors hover:bg-line focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => setAiMode("api")}
              >
                <ChartNoAxesCombined className="mt-0.5 size-5 shrink-0 text-accent" />
                <span>
                  <span className="block font-semibold">{t("API 调用用量")}</span>
                  <span className="mt-1 block text-meta text-muted">
                    {t("连接 OpenAI 或 Anthropic 的用量接口，记录 Token 用量。")}
                  </span>
                </span>
              </button>
              <Button type="button" variant="ghost" onClick={() => setAiMode("manual")}>
                <Pencil className="size-4" />
                {t("仅手动记录")}
              </Button>
            </div>
          ) : kind === "ai" && aiMode === "api" ? (
            <div className="space-y-4">
              <p className="text-meta leading-relaxed text-muted">
                {t(
                  "选择 API 服务商后继续设置用量来源。组织用量接口通常需要 Admin Key，普通调用 Key 可能没有查询权限。",
                )}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => useAppStore.getState().openUsageSetup({ type: "openai-api" })}
                >
                  OpenAI API
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => useAppStore.getState().openUsageSetup({ type: "anthropic-api" })}
                >
                  Anthropic API
                </Button>
              </div>
            </div>
          ) : kind === "ai" && aiMode === "login" ? (
            <div role="tabpanel" aria-label={t("快速登录")}>
              <AiAccountsPanel
                standalone
                assetId={editingId ?? undefined}
                initialProvider={(existing as AiAsset | null)?.oauthProvider}
              />
            </div>
          ) : (
            <form id="asset-composer-form" onSubmit={submit}>
              {kind !== "server" && (
                <div className="mb-4">
                  <ImagePicker
                    key={`${kind}:${editingId ?? "new"}`}
                    value={form.imageDataUrl}
                    onChange={(value) => set("imageDataUrl", value)}
                    onBusyChange={setImageBusy}
                  />
                </div>
              )}
              {kind === "ai" && !form.oauthAccountId && (
                <p className="mb-4 rounded-lg bg-canvas p-3 text-meta leading-relaxed text-muted">
                  {t("手动记录不会自动采集用量。这里的用量、月费与续费日期由你维护。")}
                </p>
              )}
              {kind === "server" ? (
                <ServerFields
                  form={form}
                  set={set}
                  editingId={editingId}
                  mode={serverMode}
                  setMode={setServerMode}
                  onBusyChange={setImageBusy}
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {fields(kind, form, set, editingId)}
                </div>
              )}
              {kind === "secret" && ["password", "account"].includes(form.kind) && (
                <div className="mt-3">
                  <Field label={t("注册邮箱")}>
                    <Select
                      aria-label={t("注册邮箱")}
                      value={form._mailboxId ?? ""}
                      onValueChange={(value) => set("_mailboxId", value)}
                      options={[
                        { value: "", label: t("暂不关联") },
                        ...mailboxes.map((mail) => ({ value: mail.id, label: mail.address })),
                      ]}
                    />
                  </Field>
                </div>
              )}
            </form>
          )}
        </div>
        {(kind !== "ai" || !["choose", "api"].includes(aiMode)) && (
          <div className="editor-footer">
            {kind === "ai" && aiMode === "login" ? (
              <Button type="button" variant="outline" onClick={onClose}>
                {t("完成")}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={onClose}>
                  {t("取消")}
                </Button>
                <Button
                  type="submit"
                  form="asset-composer-form"
                  disabled={imageBusy || saving || (standaloneAccount && !isDesktop())}
                >
                  {editingId ? t("保存") : t("添加")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ServerFields({
  form,
  set,
  editingId,
  mode,
  setMode,
  onBusyChange,
}: {
  form: Record<string, string>;
  set: (key: string, value: string) => void;
  editingId: string | null;
  mode: "record" | "ssh";
  setMode: (mode: "record" | "ssh") => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const field = (key: string, label: string, required = false) => (
    <Field label={label}>
      <Input
        aria-label={label}
        value={form[key] ?? ""}
        required={required}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <SmartPaste
          kind="server"
          onApply={(values) => {
            for (const [key, value] of Object.entries(values)) set(key, value);
            setMode("ssh");
          }}
        />
        {field("name", t("主机名"), true)}
        {field("host", "IP / Host", true)}
      </div>
      <fieldset className="rounded-xl border border-line p-3">
        <legend className="px-1 text-meta font-medium">{t("使用方式")}</legend>
        <div className="grid grid-cols-2 gap-3 text-meta">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="server-mode"
              value="record"
              checked={mode === "record"}
              onChange={() => setMode("record")}
            />
            {t("仅记录")}
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="server-mode"
              value="ssh"
              checked={mode === "ssh"}
              onChange={() => setMode("ssh")}
            />
            {t("配置 SSH")}
          </label>
        </div>
        <p className="mt-2 text-meta text-muted">
          {t(
            mode === "record"
              ? editingId
                ? "仅保存资产信息，已有 SSH 凭据会保留。"
                : "先保存名称和地址，需要连接时再配置 SSH。"
              : "填写 SSH 连接信息，凭据加密保存。",
          )}
        </p>
      </fieldset>
      {mode === "ssh" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("SSH 端口")}>
            <Input
              aria-label={t("SSH 端口")}
              type="number"
              min={1}
              max={65535}
              value={form.port ?? "22"}
              onChange={(event) => set("port", event.target.value)}
            />
          </Field>
          {field("username", t("用户名"))}
          <CredentialFields
            serverId={editingId}
            target={{
              host: form.host ?? "",
              port: form.port ?? "22",
              username: form.username ?? "root",
            }}
            form={form}
            set={set}
          />
        </div>
      )}
      <details className="rounded-xl border border-line p-3">
        <summary className="cursor-pointer text-meta font-medium">{t("更多信息（可选）")}</summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <ImagePicker
              key={`server:${editingId ?? "new"}`}
              value={form.imageDataUrl}
              onChange={(value) => set("imageDataUrl", value)}
              onBusyChange={onBusyChange}
            />
          </div>
          {field("label", t("备注名"))}
          {field("os", t("系统"))}
          {field("region", t("区域"))}
          {field("tags", t("标签（逗号分隔）"))}
          <div className="sm:col-span-2">
            <Field label={t("说明")}>
              <Textarea
                aria-label={t("说明")}
                value={form.notes ?? ""}
                onChange={(event) => set("notes", event.target.value)}
              />
            </Field>
          </div>
          <AccountFields
            assetId={editingId}
            kind="server"
            form={serverAccountDraft(form)}
            set={(key, value) => set(serverAccountKey(key), value)}
          />
        </div>
      </details>
    </div>
  );
}

function fields(
  kind: AssetKind,
  form: Record<string, string>,
  set: (k: string, v: string) => void,
  editingId: string | null,
): ReactNode[] {
  return [
    ...(kind === "secret" && form.kind === "account"
      ? []
      : [
          <SmartPaste
            key="_paste"
            kind={kind}
            onApply={(fields) => {
              for (const [k, v] of Object.entries(fields)) set(k, v);
            }}
          />,
        ]),
    ...kindFields(kind, form, set),
    ...(kind === "service" || (kind === "ai" && form.oauthAccountId)
      ? []
      : [<AccountFields key="_account" assetId={editingId} kind={kind} form={form} set={set} />]),
  ];
}

function kindFields(
  kind: AssetKind,
  form: Record<string, string>,
  set: (k: string, v: string) => void,
): ReactNode[] {
  const F = (
    key: string,
    label: string,
    extra?: { span?: boolean; area?: boolean; required?: boolean; placeholder?: string },
  ) => (
    <div key={key} className={extra?.span ? "sm:col-span-2" : ""}>
      <Field label={label}>
        {extra?.area ? (
          <Textarea
            aria-label={label}
            required={extra?.required}
            placeholder={extra?.placeholder}
            value={form[key] ?? ""}
            onChange={(e) => set(key, e.target.value)}
          />
        ) : (
          <Input
            aria-label={label}
            required={extra?.required}
            placeholder={extra?.placeholder}
            value={form[key] ?? ""}
            onChange={(e) => set(key, e.target.value)}
          />
        )}
      </Field>
    </div>
  );

  switch (kind) {
    case "server":
      return [];
    case "service":
      return [
        F("name", t("服务名称"), { required: true }),
        <Field key="category" label={t("服务类型")}>
          <Select
            aria-label={t("服务类型")}
            value={form.category || "custom"}
            onValueChange={(value) => set("category", value)}
            options={Object.entries(SERVICE_LABELS).map(([value, label]) => ({
              value,
              label: t(label),
            }))}
          />
        </Field>,
        F("url", t("服务网址"), { span: true, placeholder: "https://example.com" }),
        F("provider", t("提供方")),
        <Field key="status" label={t("手动记录状态")}>
          <Select
            aria-label={t("手动记录状态")}
            value={form.status || "online"}
            onValueChange={(value) => set("status", value)}
            options={[
              { value: "online", label: t("正常") },
              { value: "warning", label: t("注意") },
              { value: "offline", label: t("告警") },
            ]}
          />
        </Field>,
        F("tags", t("标签（逗号分隔）"), { span: true }),
        F("notes", t("说明"), { span: true, area: true }),
        <p key="privacy" className="text-meta text-muted sm:col-span-2">
          {t("登录凭据请保存在密钥库，再通过关联资产连接到此服务。服务不会自动发起探测。")}
        </p>,
      ];
    case "domain":
      return [
        F("name", t("域名"), { span: true }),
        F("registrar", t("注册商")),
        F("dns", "DNS"),
        F("expiresAt", t("到期日 YYYY-MM-DD"), { span: true }),
        F("tags", t("标签（逗号分隔）"), { span: true }),
        F("notes", t("说明"), { span: true, area: true }),
      ];
    case "mail":
      return [
        <MailLogin key="_mail-login" form={form} set={set} />,
        F("address", t("地址"), { span: true }),
        F("domain", t("所属域名")),
        F("kind", t("类型 mailbox/alias/forward")),
        F("forwardTo", t("转发至"), { span: true }),
        F("tags", t("标签（逗号分隔）"), { span: true }),
        F("notes", t("说明"), { span: true, area: true }),
      ];
    case "ai":
      if (form.oauthAccountId)
        return [
          F("name", t("名称")),
          F("monthlyUsd", t("月费 USD")),
          F("tags", t("标签（逗号分隔）"), { span: true }),
          F("notes", t("说明"), { span: true, area: true }),
        ];
      return [
        F("name", t("名称")),
        F("provider", t("厂商")),
        F("plan", t("套餐")),
        F("monthlyUsd", t("月费 USD")),
        F("keyHint", t("密钥末位")),
        F("usagePct", t("用量 %")),
        F("renewsAt", t("续费日"), { span: true }),
        F("tags", t("标签（逗号分隔）"), { span: true }),
        F("notes", t("说明"), { span: true, area: true }),
      ];
    case "secret":
      return [
        F("name", t(form.kind === "account" ? "显示名称" : "名称"), {
          required: form.kind === "account",
          placeholder: form.kind === "account" ? "Apple ID" : undefined,
        }),
        <Field key="kind" label={t("类型")}>
          <Select
            aria-label={t("类型")}
            value={form.kind || "api"}
            onValueChange={(value) => set("kind", value)}
            options={[
              { value: "account", label: t("账号密码") },
              { value: "password", label: t("网站账号 / 密码") },
              { value: "api", label: "API Key" },
              { value: "ssh", label: t("SSH 私钥") },
              { value: "token", label: "Token" },
            ]}
          />
        </Field>,
        ...(form.kind === "account" ? [] : [F("hint", t("提示"))]),
        F("tags", t("标签（逗号分隔）"), { span: true }),
        ...(form.kind === "account" ? [] : [F("notes", t("说明"), { span: true, area: true })]),
      ];
    case "cert":
      return [
        F("cn", "CN", { span: true }),
        // The probe needs somewhere to open a TLS connection; a wildcard CN
        // is not a host, so it can be overridden here.
        F("host", t("探测地址（留空则用 CN）")),
        F("port", t("端口")),
        F("issuer", t("签发者")),
        F("expiresAt", t("到期日")),
        F("sans", t("SAN（逗号分隔）"), { span: true }),
        F("tags", t("标签（逗号分隔）"), { span: true }),
        F("notes", t("说明"), { span: true, area: true }),
      ];
  }
}

function findAsset(kind: AssetKind, id: string | null, s: Snapshot): unknown {
  if (!id) return null;
  switch (kind) {
    case "server":
      return s.servers.find((x) => x.id === id) ?? null;
    case "domain":
      return s.domains.find((x) => x.id === id) ?? null;
    case "mail":
      return s.mailboxes.find((x) => x.id === id) ?? null;
    case "ai":
      return s.aiAssets.find((x) => x.id === id) ?? null;
    case "secret":
      return s.secrets.find((x) => x.id === id) ?? null;
    case "service":
      return (s.services ?? []).find((x) => x.id === id) ?? null;
    case "cert":
      return s.certs.find((x) => x.id === id) ?? null;
  }
}

function defaults(kind: AssetKind, existing: unknown): Record<string, string> {
  if (existing && typeof existing === "object") {
    const o = existing as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) out[k] = v.join(", ");
      else if (v != null) out[k] = String(v);
    }
    if (kind === "server" && o.authKind) out._authKind = String(o.authKind);
    if (kind === "ai" && o.monthlyUsdKnown === false) out.monthlyUsd = "";
    return out;
  }
  const today = new Date().toISOString().slice(0, 10);
  switch (kind) {
    case "server":
      return {
        name: "",
        label: "",
        host: "",
        port: "22",
        username: "root",
        os: "",
        region: "",
        tags: "",
        notes: "",
      };
    case "domain":
      return {
        name: "",
        registrar: "Cloudflare",
        dns: "Cloudflare",
        expiresAt: today,
        tags: "",
        notes: "",
      };
    case "mail":
      return { address: "", domain: "", kind: "mailbox", forwardTo: "", tags: "", notes: "" };
    case "ai":
      return {
        name: "",
        provider: "",
        plan: t("月付"),
        monthlyUsd: "20",
        keyHint: "",
        usagePct: "0",
        renewsAt: today,
        tags: "",
        notes: "",
      };
    case "secret":
      return { name: "", kind: "api", hint: "", tags: "", notes: "" };
    case "service":
      return {
        name: "",
        category: "custom",
        url: "",
        provider: "",
        status: "online",
        tags: "",
        notes: "",
      };
    case "cert":
      return { cn: "", issuer: "Let's Encrypt", expiresAt: today, sans: "", tags: "", notes: "" };
  }
}

function persist(
  kind: AssetKind,
  id: string,
  form: Record<string, string>,
  existing: unknown,
  serverMode: "record" | "ssh",
) {
  const s = useAppStore.getState();
  const statusOf = (iso?: string) => {
    if (!iso) return "online" as const;
    const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
    if (d <= 7) return "offline" as const;
    if (d <= 21) return "warning" as const;
    return "online" as const;
  };

  switch (kind) {
    case "server": {
      const item = serverAssetFromDraft({
        id,
        form,
        existing: (existing as Server | null) ?? null,
        tags: parseTags(form.tags ?? ""),
        now: new Date().toISOString(),
        pendingLabel: t("未采集"),
        mode: serverMode,
      });
      s.upsertServer(item);
      break;
    }
    case "domain": {
      const item: Domain = {
        id,
        integration: (existing as Domain | null)?.integration,
        imageDataUrl: form.imageDataUrl || "",
        name: form.name,
        registrar: form.registrar,
        expiresAt: form.expiresAt,
        dns: form.dns,
        nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        autoRenew: false,
        tags: parseTags(form.tags ?? ""),
        status: statusOf(form.expiresAt),
        notes: form.notes,
      };
      s.upsertDomain(item);
      break;
    }
    case "mail": {
      const previous = existing as Mailbox | null;
      const item: Mailbox = {
        ...previous,
        folderId: form.folderId ?? previous?.folderId,
        ...(form._smtpHost
          ? {
              smtp: {
                host: form._smtpHost,
                port: Number(form._smtpPort) || 465,
                security:
                  form._smtpSecurity === "starttls" ? ("starttls" as const) : ("tls" as const),
              },
            }
          : {}),
        id,
        imageDataUrl: form.imageDataUrl || "",
        address: form.address,
        domain: form.domain,
        kind: (form.kind as Mailbox["kind"]) || "mailbox",
        // Quick login fills these from what the IMAP server reported; the
        // fallback is only for a hand-typed mailbox.
        usedMb: Number(form.usedMb) || 0,
        quotaMb: Number(form.quotaMb) || (form.kind === "mailbox" ? 5120 : 0),
        forwardTo: form.forwardTo || undefined,
        tags: parseTags(form.tags ?? ""),
        status: "online",
        notes: form.notes,
        ...(form._imapHost?.trim()
          ? {
              imap: {
                host: form._imapHost.trim(),
                port: Number(form._imapPort) || 993,
                secure: form._imapSecure === "true",
              },
            }
          : previous?.imap
            ? { imap: previous.imap }
            : {}),
      };
      s.upsertMail(item);
      break;
    }
    case "ai": {
      const previous = existing as AiAsset | null;
      if (previous?.oauthAccountId) {
        s.upsertAi({
          ...previous,
          imageDataUrl: form.imageDataUrl || "",
          name: form.name,
          monthlyUsd: Number(form.monthlyUsd) || 0,
          monthlyUsdKnown: form.monthlyUsd.trim() !== "",
          tags: parseTags(form.tags ?? ""),
          notes: form.notes,
        });
        break;
      }
      const usage = Number(form.usagePct) || 0;
      const item: AiAsset = {
        id,
        imageDataUrl: form.imageDataUrl || "",
        name: form.name,
        provider: form.provider,
        plan: form.plan,
        keyHint: form.keyHint,
        monthlyUsd: Number(form.monthlyUsd) || 0,
        usagePct: usage,
        renewsAt: form.renewsAt,
        tags: parseTags(form.tags ?? ""),
        status: usage >= 90 ? "warning" : "online",
        notes: form.notes,
      };
      s.upsertAi(item);
      break;
    }
    case "secret": {
      const previous = existing as Secret | null;
      const item: Secret = {
        ...(form.kind === "account" ? {} : previous),
        id,
        imageDataUrl: form.imageDataUrl || "",
        name: form.name,
        folderId: form.folderId ?? previous?.folderId,
        kind: (form.kind as Secret["kind"]) || "api",
        ...(previous?.identityProvider && form.kind === previous.kind
          ? { identityProvider: previous.identityProvider }
          : {}),
        hint: form.hint,
        // Kept empty on purpose: the real value is in the vault.
        value: "",
        lastRotated: new Date().toISOString(),
        tags: parseTags(form.tags ?? ""),
        status: "online",
        notes: form.notes,
        ...(form.kind === "account" ? accountMetadataFromForm(form) : {}),
      };
      s.upsertSecret(item);
      break;
    }
    case "service": {
      s.upsertService(
        normalizeService({
          id,
          integration: (existing as ServiceAsset | null)?.integration,
          name: form.name,
          category: form.category,
          url: form.url,
          provider: form.provider,
          status: form.status,
          notes: form.notes,
          tags: parseTags(form.tags ?? ""),
          imageDataUrl: form.imageDataUrl || "",
        }),
      );
      break;
    }
    case "cert": {
      const prev = (existing as Certificate | null) ?? null;
      const item: Certificate = {
        id,
        imageDataUrl: form.imageDataUrl || "",
        cn: form.cn,
        issuer: form.issuer,
        expiresAt: form.expiresAt,
        sans: split(form.sans),
        tags: parseTags(form.tags ?? ""),
        status: statusOf(form.expiresAt),
        notes: form.notes,
        host: form.host || undefined,
        port: Number(form.port) || undefined,
        trusted: prev?.trusted,
        untrustedReason: prev?.untrustedReason,
        protocol: prev?.protocol,
        probedAt: prev?.probedAt,
        probeError: prev?.probeError,
      };
      s.upsertCert(item);
      break;
    }
  }
}

function split(v: string): string[] {
  return v
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
}
