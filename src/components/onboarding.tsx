import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useRef, useState } from "react";
import { UserRound, KeyRound } from "lucide-react";
import { desktop } from "@/lib/desktop";
import { useProfile } from "@/lib/profile";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";
import { initialWorkspaceName } from "@/lib/composer-draft.mjs";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";
import { LogoMark } from "./logo";
import { ImagePicker } from "./image-picker";
import { PrimaryIdentityPanel } from "./primary-identity-panel";

export function ProfileForm({ initial = false }: { initial?: boolean }) {
  const profile = useProfile((s) => s.profile);
  const [name, setName] = useState(() =>
    initial ? initialWorkspaceName(profile?.name, t("我的工作区")) : (profile?.name ?? ""),
  );
  const [avatar, setAvatar] = useState(profile?.avatarDataUrl ?? "");
  const nameDirty = useRef(false);
  const avatarDirty = useRef(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    // 登录同步回来的资料更新尚未编辑的字段，保留用户正在输入的草稿。
    if (!nameDirty.current)
      setName(
        initial ? initialWorkspaceName(profile?.name, t("我的工作区")) : (profile?.name ?? ""),
      );
    if (!avatarDirty.current) setAvatar(profile?.avatarDataUrl ?? "");
  }, [profile?.name, profile?.avatarDataUrl, initial]);
  useEffect(() => {
    const syncDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ syncName?: boolean; syncAvatar?: boolean }>).detail;
      const latest = useProfile.getState().profile;
      if (detail?.syncName) {
        nameDirty.current = false;
        setName(latest?.name ?? "");
      }
      if (detail?.syncAvatar) {
        avatarDirty.current = false;
        setAvatar(latest?.avatarDataUrl ?? "");
      }
    };
    window.addEventListener("profile:identity-synced", syncDraft);
    return () => window.removeEventListener("profile:identity-synced", syncDraft);
  }, []);
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (imageBusy) return;
        setBusy(true);
        setError("");
        setSaved(false);
        try {
          if (initial && !profile?.vaultExists && password !== confirm)
            throw new Error(t("两次主密码不一致"));
          await hostBridge()?.profile.save({
            name: name.trim(),
            ...(avatarDirty.current ? { avatarDataUrl: avatar } : {}),
            password: initial ? password : undefined,
          });
          setPassword("");
          setConfirm("");
          nameDirty.current = false;
          avatarDirty.current = false;
          await useProfile.getState().refresh();
          await useVault.getState().refresh();
          setSaved(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {!initial && (
        <ImagePicker
          avatar
          value={avatar}
          onChange={(value) => {
            avatarDirty.current = true;
            setAvatar(value);
            setSaved(false);
          }}
          onBusyChange={setImageBusy}
          disabled={busy}
        />
      )}
      <Field label={t(initial ? "工作区名称" : "你的名字")}>
        <Input
          aria-label={t(initial ? "工作区名称" : "你的名字")}
          autoFocus={!initial}
          autoComplete="name"
          required
          maxLength={40}
          value={name}
          onChange={(e) => {
            nameDirty.current = true;
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </Field>
      {initial && (
        <>
          <p className="text-meta text-muted">{t("名称和头像可稍后在设置中修改。")}</p>
          <Field label={t(profile?.vaultExists ? "现有主密码" : "创建主密码")}>
            <Input
              aria-label={t("主密码")}
              autoFocus
              type="password"
              autoComplete={profile?.vaultExists ? "current-password" : "new-password"}
              minLength={profile?.vaultExists ? 6 : 10}
              maxLength={256}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {!profile?.vaultExists && (
            <Field label={t("确认主密码")}>
              <Input
                aria-label={t("确认主密码")}
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
          )}
          <p className="text-meta text-muted">
            {t(
              profile?.vaultExists
                ? "检测到已有密钥库，请使用原主密码。"
                : "主密码至少 10 位，无法找回。请妥善保管。",
            )}
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="text-meta text-crit">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-meta text-ok">
          {t("已保存")}
        </p>
      )}
      <Button type="submit" disabled={busy || imageBusy || !name.trim()}>
        {initial ? <KeyRound className="size-4" /> : <UserRound className="size-4" />}
        {t(busy ? "处理中…" : initial ? "进入知屿" : "保存")}
      </Button>
    </form>
  );
}

export function Onboarding() {
  const { profile, error, refresh } = useProfile();
  const dialog = useRef<HTMLDialogElement>(null);
  const blocked = Boolean(desktop()) && (!profile || !profile.ready);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (blocked) dialog.current?.showModal();
    else dialog.current?.close();
  }, [blocked]);
  if (!blocked) return null;
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => e.preventDefault()}
      aria-label={t("首次设置")}
      className="m-auto max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-line bg-card p-6 text-ink shadow-float backdrop:bg-ink/40"
    >
      <LogoMark className="mb-4 size-10" />
      <h1 className="mb-2 text-xl font-semibold">{t("欢迎使用知屿")}</h1>
      <p className="mb-5 text-meta leading-relaxed text-muted">
        {t("无需注册，资产保存在本机。主密码用于保护账号与密钥。")}
      </p>
      {error ? (
        <>
          <p role="alert" className="mb-3 text-crit">
            {error}
          </p>
          <Button onClick={() => void refresh()}>{t("重试")}</Button>
        </>
      ) : profile ? (
        <>
          <PrimaryIdentityPanel initial />
          <ProfileForm initial />
        </>
      ) : (
        <p>{t("加载中…")}</p>
      )}
    </dialog>
  );
}
