import { vaultApi } from "@/lib/vault-api";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  FolderOpen,
  Loader2,
  Lock,
  Monitor,
  Moon,
  ScrollText,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { CalendarExport, DesktopSettings } from "./operations-panel";
import { AgentSettings } from "./agent-settings";
import { StorageSettings } from "./storage-settings";
import { BackupSettings } from "./backup-settings";
import { MailPushSettings } from "./mail-push-settings";
import { WebPushSettings } from "./web-push-settings";
import { ExtensionSettings } from "./extension-settings";
import { AppUpdatePanel } from "./app-update-panel";
import { ProfileForm } from "./onboarding";
import { PrimaryIdentityPanel } from "./primary-identity-panel";
import { Field, Input, Select } from "./ui/input";
import { RELEASES } from "@/lib/changelog";
import { desktop, type AppInfo } from "@/lib/desktop";
import { isWeb } from "@/lib/web";
import { usePresence } from "@/lib/motion";
import { useSettings, ZOOM_PERCENTS, type ZoomPercent, type ThemeChoice } from "@/lib/settings";
import { snapshotOf, useAppStore } from "@/lib/store";
import { cn, downloadJson } from "@/lib/utils";
import { useVault } from "@/lib/vault-state";
import { t, type LocaleChoice } from "@/lib/i18n";

const IntegrationsSettings = lazy(() =>
  import("./integrations/integrations-settings").then((module) => ({
    default: module.IntegrationsSettings,
  })),
);

type Tab =
  | "profile"
  | "appearance"
  | "monitoring"
  | "integrations"
  | "vault"
  | "data"
  | "agent"
  | "mail-push"
  | "extension"
  | "storage"
  | "about"
  | "changelog";

// 十余个设置项按用途分组，避免平铺列表难以定位。
const TAB_GROUPS: Array<{ title: string; tabs: Array<{ id: Tab; label: string }> }> = [
  {
    title: "个人",
    tabs: [
      { id: "profile", label: "个人资料" },
      { id: "appearance", label: "外观" },
    ],
  },
  {
    title: "连接与服务",
    tabs: [
      { id: "agent", label: "模型与知识库" },
      { id: "integrations", label: "云服务与探针" },
      { id: "monitoring", label: "监控采集" },
      { id: "mail-push", label: "邮件推送" },
      { id: "extension", label: "浏览器插件" },
    ],
  },
  {
    title: "数据与安全",
    tabs: [
      { id: "vault", label: "密钥库" },
      { id: "data", label: "数据" },
      { id: "storage", label: "存储" },
    ],
  },
  {
    title: "关于",
    tabs: [
      { id: "about", label: "关于知屿" },
      { id: "changelog", label: "更新日志" },
    ],
  },
];

/** 右上角的设置弹窗：所有分页同一尺寸（与「云服务与探针」一致），切换分页时窗口不跳动。 */
export function Settings() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const { mounted, shown } = usePresence(open, 180);

  useEffect(() => {
    const show = (tab: Tab) => () => {
      const state = useAppStore.getState();
      state.setSettingsTab(tab);
      // 已经在设置页里时就地切换分页，不再叠一层弹窗。
      if (!state.settingsPage) setOpen(true);
    };
    const showProfile = show("profile");
    const showIntegrations = show("integrations");
    window.addEventListener("settings:profile", showProfile);
    window.addEventListener("settings:integrations", showIntegrations);
    return () => {
      window.removeEventListener("settings:profile", showProfile);
      window.removeEventListener("settings:integrations", showIntegrations);
    };
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".editor-dialog"))
        setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        aria-label={t("关闭设置")}
        className="anim-scrim absolute inset-0 bg-ink/40"
        data-shown={shown}
        onClick={() => setOpen(false)}
      />
      <div
        data-shown={shown}
        role="dialog"
        aria-modal="true"
        aria-label={t("设置")}
        className="settings-dialog anim-panel relative z-10 flex w-full overflow-hidden rounded-2xl bg-card shadow-float"
      >
        <SettingsBody
          header={
            <div className="sticky top-0 z-10 flex items-center justify-end bg-card/90 px-3 py-2 backdrop-blur">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("关闭")}
                onClick={() => setOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}

/**
 * 头像菜单进入的系统设置：主内容区里的一页，左侧分组导航、右侧内容，
 * 顶部返回原页面；后退、Esc 都先回到原页面。
 */
export function SettingsPage() {
  const open = useAppStore((s) => s.settingsPage);
  const close = useAppStore((s) => s.closeSettingsPage);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], .editor-dialog')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
  if (!open) return null;
  return (
    <section className="settings-page" aria-label={t("设置")}>
      <div className="detail-bar">
        <button type="button" className="detail-back" onClick={close}>
          <ArrowLeft aria-hidden="true" />
          <span>{t("返回")}</span>
        </button>
      </div>
      <header className="settings-page-head">
        <h1>{t("系统设置")}</h1>
        <p>{t("外观、连接、数据与安全，都在这里调整。")}</p>
      </header>
      <div className="settings-page-panel">
        <SettingsBody />
      </div>
    </section>
  );
}

function SettingsBody({ header }: { header?: ReactNode }) {
  const tab = useAppStore((s) => s.settingsTab) as Tab;
  const setTab = useAppStore((s) => s.setSettingsTab);
  return (
    <>
      <nav className="settings-nav flex min-h-0 w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2">
        <h2 className="px-3 pb-2 pt-3 text-meta font-semibold tracking-tight">{t("设置")}</h2>
        {TAB_GROUPS.map((group) => (
          <div key={group.title} role="group" aria-label={t(group.title)} className="mb-2">
            <div className="settings-tab-group">{t(group.title)}</div>
            {group.tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-current={tab === entry.id ? "page" : undefined}
                className={cn("settings-tab", tab === entry.id && "settings-tab-on")}
                onClick={() => setTab(entry.id)}
              >
                {t(isWeb() && entry.id === "mail-push" ? "提醒推送" : entry.label)}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="settings-content min-w-0 flex-1 overflow-y-auto">
        {header}
        <div key={tab} className="settings-content-body px-6 pb-8">
          {tab === "profile" &&
            (desktop() ? (
              <div className="space-y-6">
                <PrimaryIdentityPanel />
                <ProfileForm />
              </div>
            ) : (
              <p>{t("仅桌面版可用")}</p>
            ))}
          {tab === "appearance" && <Appearance />}
          {tab === "monitoring" && <Monitoring />}
          {tab === "integrations" && (
            <Suspense fallback={<p>{t("正在加载…")}</p>}>
              <IntegrationsSettings />
            </Suspense>
          )}
          {tab === "vault" && <VaultSection />}
          {tab === "data" && (
            <>
              <DataSection />
              <BackupSettings />
            </>
          )}
          {tab === "agent" && <AgentSettings />}
          {tab === "mail-push" && (isWeb() ? <WebPushSettings /> : <MailPushSettings />)}
          {tab === "extension" && <ExtensionSettings />}
          {tab === "storage" && <StorageSettings />}
          {tab === "about" && <About />}
          {tab === "changelog" && <Changelog />}
        </div>
      </div>
    </>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {hint && <p className="mt-1 text-meta leading-relaxed text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-meta font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-2xs leading-relaxed text-subtle">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const THEMES: Array<{ id: ThemeChoice; label: string; icon: LucideIcon }> = [
  { id: "system", label: "跟随系统", icon: Monitor },
  { id: "light", label: "浅色", icon: Sun },
  { id: "dark", label: "深色", icon: Moon },
];

function Appearance() {
  const zoomPercent = useSettings((s) => s.zoomPercent);
  const zoomReady = useSettings((s) => s.zoomReady);
  const setZoomPercent = useSettings((s) => s.setZoomPercent);
  const [zoomBusy, setZoomBusy] = useState(false);
  const [zoomError, setZoomError] = useState<string | null>(null);
  const changeZoom = async (value: ZoomPercent) => {
    setZoomBusy(true);
    setZoomError(null);
    try {
      await setZoomPercent(value);
    } catch (error) {
      setZoomError(error instanceof Error ? error.message : String(error));
    } finally {
      setZoomBusy(false);
    }
  };
  const language = useSettings((s) => s.language);
  const setLanguage = useSettings((s) => s.setLanguage);
  const theme = useSettings((s) => s.theme);
  const resolved = useSettings((s) => s.resolved);
  const setTheme = useSettings((s) => s.setTheme);

  return (
    <Section title={t("外观")}>
      <Row label={t("语言")}>
        <Select
          className="w-36 text-meta"
          aria-label={t("语言")}
          value={language}
          onValueChange={(value) => setLanguage(value as LocaleChoice)}
          options={[
            { value: "system", label: t("跟随系统") },
            { value: "zh", label: "简体中文" },
            { value: "en", label: "English" },
          ]}
        />
      </Row>
      <div className="border-b border-line py-3">
        <div className="text-meta font-medium">{t("界面大小")}</div>
        <p className="mt-1 text-2xs leading-relaxed text-muted">
          {t("调整文字与控件大小，不改变系统显示设置。")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t("界面大小")} className="flex flex-wrap gap-2">
            {ZOOM_PERCENTS.map((value) => (
              <Button
                key={value}
                variant={zoomPercent === value ? "solid" : "outline"}
                size="sm"
                aria-pressed={zoomPercent === value}
                disabled={!zoomReady || zoomBusy}
                onClick={() => void changeZoom(value)}
              >
                {value}%
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!zoomReady || zoomBusy || zoomPercent === 100}
            onClick={() => void changeZoom(100)}
          >
            {t("恢复默认大小")}
          </Button>
        </div>
        <p className="mt-2 text-2xs text-muted">
          {t("快捷键：Ctrl / ⌘ + 加减号调整，Ctrl / ⌘ + 0 恢复 100%。")}
        </p>
        {zoomError && (
          <p role="alert" className="mt-2 text-meta text-crit">
            {t("界面大小设置失败：{0}", zoomError)}
          </p>
        )}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {THEMES.map((option) => {
          const on = theme === option.id;
          const Icon = option.icon;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={on}
              className={cn("theme-option", on && "theme-option-on")}
              onClick={() => setTheme(option.id)}
            >
              <Icon className="size-5" strokeWidth={1.9} />
              <span className="text-meta font-medium">{t(option.label)}</span>
              {on && <Check className="absolute right-2.5 top-2.5 size-3.5" strokeWidth={2.6} />}
            </button>
          );
        })}
      </div>
      {theme === "system" && (
        <p className="mt-3 text-2xs text-subtle">
          {t(
            "当前系统为{0}，主题会跟着系统一起切换。",
            resolved === "dark" ? t("深色") : t("浅色"),
          )}
        </p>
      )}
      <DesktopSettings />
    </Section>
  );
}

function Monitoring() {
  const minutes = useSettings((s) => s.serverMonitorMinutes);
  const ready = useSettings((s) => s.monitorReady);
  const setMinutes = useSettings((s) => s.setServerMonitorMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await setMinutes(Number(value));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("监控采集")} hint={t("按需要选择采集频率，最近的结果会在所选周期内复用。")}>
      <Field label={t("服务器自动采集")}>
        <Select
          aria-label={t("服务器自动采集")}
          value={String(minutes)}
          disabled={!ready || busy}
          onValueChange={(value) => void save(value)}
          options={[
            { value: "0", label: t("仅手动刷新") },
            ...[1, 5, 15, 30, 60].map((n) => ({ value: String(n), label: t("每 {0} 分钟", n) })),
          ]}
        />
      </Field>
      <p className="mt-3 text-meta leading-relaxed text-muted">
        {t(
          "自动采集仅在窗口可见且密钥库已解锁时进行。手动刷新按钮始终可用；本机 AI 用量监控独立运行，不受此设置影响。",
        )}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-meta text-crit">
          {error}
        </p>
      )}
    </Section>
  );
}

function VaultSection() {
  const vault = vaultApi();
  const exists = useVault((s) => s.exists);
  const unlocked = useVault((s) => s.unlocked);
  const lock = useVault((s) => s.lock);
  const refresh = useVault((s) => s.refresh);
  const requireVault = useVault((s) => s.require);

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!vault) {
    return (
      <Section title={t("密钥库")} hint={t("浏览器预览没有密钥库；桌面版才会加密保存凭据。")}>
        <p className="text-meta text-muted">—</p>
      </Section>
    );
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPw !== confirmPw) {
      setError(t("两次输入的新主密码不一致"));
      return;
    }
    setBusy(true);
    try {
      const res = await vault!.changePassword(oldPw, newPw);
      await refresh();
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      toast(t("主密码已更新，{0} 条凭据已重新加密", res.count));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section title={t("密钥库")} hint={t("SSH 凭据、各服务账号密码与密钥完整值都存在这里。")}>
        <Row label={t("状态")} hint={exists ? undefined : t("第一次保存凭据时会让你设置主密码。")}>
          <span className={cn("chip", unlocked ? "chip-ok" : "chip-mute")}>
            {exists ? (unlocked ? t("已解锁") : t("已锁定")) : t("尚未创建")}
          </span>
        </Row>
        <Row label={t("锁定")} hint={t("锁定后内存中的密钥立即丢弃，再次读取需要重新输入主密码。")}>
          {unlocked ? (
            <Button variant="outline" size="sm" onClick={() => void lock()}>
              <Lock className="size-3.5" />

              {t("立即锁定")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!exists}
              onClick={() => void requireVault(t("解锁后可以修改主密码或读取已保存的凭据。"))}
            >
              {t("解锁")}
            </Button>
          )}
        </Row>
      </Section>

      {exists && (
        <Section
          title={t("修改主密码")}
          hint={t("换密码会用新密钥把每一条凭据重新加密一遍，全部成功后才落盘。")}
        >
          <form onSubmit={changePassword} className="space-y-3">
            <Field label={t("当前主密码")}>
              <Input
                type="password"
                value={oldPw}
                autoComplete="current-password"
                onChange={(e) => setOldPw(e.target.value)}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("新主密码")}>
                <Input
                  type="password"
                  value={newPw}
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={256}
                  onChange={(e) => setNewPw(e.target.value)}
                />
              </Field>
              <Field label={t("再输一次")}>
                <Input
                  type="password"
                  value={confirmPw}
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={256}
                  onChange={(e) => setConfirmPw(e.target.value)}
                />
              </Field>
            </div>
            {error && <p className="text-meta text-crit">{error}</p>}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy || oldPw.length < 6 || newPw.length < 10}>
                {busy && <Loader2 className="size-3.5 animate-spin" />}

                {t("更新主密码")}
              </Button>
              <span className="text-2xs text-subtle">
                {t("忘记主密码无法找回，凭据需要重新录入。")}
              </span>
            </div>
          </form>
        </Section>
      )}
    </>
  );
}

function DataSection() {
  const bridge = desktop();
  const resetDemo = useAppStore((s) => s.resetDemo);
  const importSnapshot = useAppStore((s) => s.importSnapshot);
  const log = useAppStore((s) => s.log);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (bridge) void bridge.info().then(setInfo);
  }, [bridge]);

  return (
    <Section title={t("数据")} hint={t("资产记录是明文 JSON，凭据在同目录下单独加密保存。")}>
      <Row label={t("导出提醒日历")}>
        <CalendarExport />
      </Row>
      {info && (
        <Row label={t("数据目录")} hint={info.userData}>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              bridge
                ?.openDataDir()
                .catch((err) => toast(err instanceof Error ? err.message : t("无法打开目录")))
            }
          >
            <FolderOpen className="size-3.5" />

            {t("打开")}
          </Button>
        </Row>
      )}
      <Row
        label={t("导出 JSON")}
        hint={t("只导出资产记录；账号密码与 SSH 凭据不会跟着出去。完整迁移请使用下方的加密备份。")}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const s = useAppStore.getState();
            downloadJson("zhiyu-assets.json", snapshotOf(s));
            log(t("已导出资产快照"));
          }}
        >
          {t("导出")}
        </Button>
      </Row>
      <Row label={t("导入 JSON")} hint={t("会覆盖当前的全部资产记录。")}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "application/json";
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                importSnapshot(JSON.parse(await file.text()));
                log(t("已导入资产快照"));
                toast(t("已导入"));
              } catch {
                toast(t("文件不是有效的资产快照"));
              }
            };
            input.click();
          }}
        >
          {t("导入")}
        </Button>
      </Row>
      <Row label={t("清空全部数据")} hint={t("只清资产记录，密钥库中的凭据不受影响。")}>
        <Button variant="danger" size="sm" onClick={() => resetDemo()}>
          {t("清空")}
        </Button>
      </Row>
    </Section>
  );
}

function About() {
  const bridge = desktop();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (bridge) void bridge.info().then(setInfo);
  }, [bridge]);

  return (
    <Section title={t("关于")} hint={t("知屿 —— 个人数字资产指挥台。")}>
      <Row label={t("当前版本")}>
        <span className="font-mono text-meta tabular-nums">{info?.version ?? "—"}</span>
      </Row>
      <Row label={t("运行模式")}>
        <span className="text-meta">
          {!info ? "—" : info.portable ? t("便携版") : info.packaged ? t("安装版") : t("开发版")}
        </span>
      </Row>
      <AppUpdatePanel />
      <Row
        label={t("资料目录")}
        hint={info?.portable ? t("便携版资料随程序目录一起移动。") : undefined}
      >
        <div className="flex max-w-72 min-w-0 items-center gap-2">
          <span className="truncate font-mono text-2xs text-muted" title={info?.userData}>
            {info?.userData ?? "—"}
          </span>
          {bridge && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("打开资料目录")}
              onClick={() => void bridge.openDataDir()}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          )}
        </div>
      </Row>
      <Row label={t("运行环境")}>
        <span className="font-mono text-2xs text-muted">
          {info ? `Electron ${info.electron} · Node ${info.node} · ${info.arch}` : "—"}
        </span>
      </Row>
      <Row label={t("项目主页")}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void bridge?.openExternal("https://github.com/Songwo/zhiyu")}
        >
          <ExternalLink className="size-3.5" />
          GitHub
        </Button>
      </Row>
    </Section>
  );
}

function Changelog() {
  return (
    <Section title={t("更新日志")}>
      <ol className="space-y-6">
        {RELEASES.map((release) => (
          <li key={release.version}>
            <div className="flex items-baseline gap-2">
              <h4 className="font-mono text-body font-semibold tabular-nums">{release.version}</h4>
              <span className="text-2xs tabular-nums text-subtle">{release.date}</span>
              <span className="text-meta text-muted">{release.title}</span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {release.changes.map((change) => (
                <li key={change} className="flex gap-2 text-meta leading-relaxed text-muted">
                  <ScrollText className="mt-0.5 size-3.5 shrink-0 text-subtle" strokeWidth={1.9} />
                  <span>{change}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Section>
  );
}
