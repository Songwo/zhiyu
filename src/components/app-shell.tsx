import { Bot, FileText, House, Phone, Server } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Toaster, toast } from "sonner";
import { CommandPalette } from "./command-palette";
import { Composer } from "./composer";
import { CreateAssetPicker } from "./create-asset-picker";
import { createInCurrentView } from "@/lib/create-asset";
import { CaptureInbox } from "./capture-inbox";
import { ExpandLayer } from "./expand-layer";
import { RightRail } from "./right-rail";
import { Sidebar } from "./sidebar";
import { GlobalMarkdownImport } from "./global-markdown-import";
import { Settings } from "./settings";
import { SshTerminal } from "./ssh-terminal";
import { TitleBar } from "./title-bar";
import { VaultGate } from "./vault-gate";
import { Onboarding } from "./onboarding";
import { MainView, TopTabs } from "./views";
import { desktop, isDesktop } from "@/lib/desktop";
import { useLive } from "@/lib/live";
import { startNavHistory } from "@/lib/nav-history";
import { usePresence } from "@/lib/motion";
import { refreshAll } from "@/lib/probes";
import { migrateSecretValues } from "@/lib/vault-migrate";
import { useAppStore } from "@/lib/store";
import type { ViewId } from "@/lib/types";
import { mergeSnapshotChange } from "@/lib/snapshot-merge";
import { cn } from "@/lib/utils";
import {
  startThemeSync,
  startLocaleSync,
  startDisplaySync,
  startMonitorSync,
  useSettings,
} from "@/lib/settings";
import { startServerMonitor } from "../../electron/services/server-monitor.mjs";
import { useVault } from "@/lib/vault-state";
import { useDocuments } from "@/lib/documents";
import { t, subscribeLocale, getLocale } from "@/lib/i18n";

export function AppShell() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => "zh" as const);
  useEffect(() => startLocaleSync(), []);
  useEffect(() => startNavHistory(), []);
  useEffect(() => startDisplaySync((message) => toast(t("界面大小设置失败：{0}", message))), []);
  useEffect(() => {
    const bridge = desktop();
    if (bridge) void bridge.preferences.set({ locale }).catch((err) => toast(String(err.message)));
  }, [locale]);
  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    const off = bridge.onAttention((asset) => {
      if (asset.kind === "phone") {
        const state = useAppStore.getState();
        const phone = state.phoneNumbers.find((record) => record.id === asset.id);
        state.openPhones(phone ? { id: phone.id } : { attention: true });
        return;
      }
      useAppStore.getState().setExpanded({
        kind: asset.kind,
        id: asset.id,
        origin: { x: window.innerWidth / 2, y: 50, w: 100, h: 50 },
      });
    });
    const offVault = bridge.onVaultChanged(() => {
      if (useAppStore.getState().composerPreset?._captureId) useAppStore.getState().closeComposer();
      void useVault.getState().refresh();
    });
    const offPasswords = bridge.passwords.onChanged((assets) => {
      useAppStore.setState((state) => ({
        secrets: [
          ...state.secrets,
          ...assets.filter((asset) => !state.secrets.some((item) => item.id === asset.id)),
        ],
      }));
    });
    const offDocuments = bridge.documents.onChanged?.((change) => {
      if (change?.document || change?.removedId) {
        useDocuments.getState().acceptChange(change);
        return;
      }
      void useDocuments
        .getState()
        .load(true)
        .catch((error) => toast.error(String(error.message)));
    });
    const offAssets = bridge.store.onChanged?.((change) => {
      const state = useAppStore.getState();
      state.importSnapshot(mergeSnapshotChange(state, change));
    });
    const offMetricError = bridge.metrics.onError((event) =>
      toast(t("指标记录失败：{0}", event.error)),
    );
    return () => {
      off();
      offVault();
      offPasswords();
      offDocuments?.();
      offAssets?.();
      offMetricError();
    };
  }, []);
  const view = useAppStore((s) => s.view);
  const workspaceScroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // 页面共用此容器；只在导航时归零，保留数据刷新和文档内部的阅读位置。
    workspaceScroll.current?.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [view]);
  const setView = useAppStore((s) => s.setView);
  const setHydrated = useAppStore((s) => s.setHydrated);
  const hydrated = useAppStore((s) => s.hydrated);
  const assetLayout = useSettings((s) => s.assetLayout);
  const wideWorkspace =
    (hydrated && assetLayout !== "cards" && view !== "agent" && view !== "terminal") ||
    view === "docs" ||
    view === "usage" ||
    view === "nodes" ||
    view === "phones" ||
    view === "agent" ||
    view === "overview" ||
    view === "renewals" ||
    view === "relations";
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const vaultUnlocked = useVault((s) => s.unlocked);
  const monitorReady = useSettings((s) => s.monitorReady);
  const serverMonitorMinutes = useSettings((s) => s.serverMonitorMinutes);
  useEffect(() => startMonitorSync((message) => toast.error(message)), []);

  useEffect(() => {
    void Promise.resolve(useAppStore.persist.rehydrate()).then(() => setHydrated(true));
  }, [setHydrated]);

  // Web preview only: the numbers have nothing behind them, so they drift
  // instead of sitting frozen. The desktop build reads the real thing below.
  useEffect(() => {
    if (isDesktop()) return;
    const tick = () => {
      const servers = useAppStore.getState().servers;
      for (const s of servers) {
        if (s.status === "offline" || s.sshConfigured === false) continue;
        const prevC = useLive.getState().cpu[s.id] ?? s.cpu;
        const prevM = useLive.getState().memory[s.id] ?? s.memory;
        const cpu = clamp(prevC + (Math.random() - 0.48) * 5, 3, 98);
        const memory = clamp(prevM + (Math.random() - 0.5) * 2.4, 8, 96);
        useLive.getState().set(s.id, Math.round(cpu), Math.round(memory));
      }
    };
    tick();
    const t = window.setInterval(tick, 2400);
    return () => window.clearInterval(t);
  }, []);

  // Stamps `<html data-theme>` and keeps following the OS while the choice is
  // "跟随系统". Returns its own teardown.
  useEffect(() => startThemeSync(), []);

  useEffect(() => {
    void useVault.getState().refresh();
  }, []);

  // Anything still holding a plaintext secret body moves into the vault the
  // first time it is open.
  useEffect(() => {
    if (!isDesktop() || !vaultUnlocked) return;
    void migrateSecretValues();
  }, [vaultUnlocked]);

  // Real metric sweeps, but never before the vault is open: probing needs the
  // stored credentials, and a password prompt on launch would be rude.
  useEffect(() => {
    if (!isDesktop() || !vaultUnlocked || !monitorReady) return;
    return startServerMonitor({
      minutes: serverMonitorMinutes,
      visible: () => document.visibilityState === "visible",
      refresh: () => refreshAll("server", { force: false, minAgeMs: serverMonitorMinutes * 60000 }),
      onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    });
  }, [vaultUnlocked, monitorReady, serverMonitorMinutes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (e.repeat || document.querySelector('[role="dialog"]') || useVault.getState().prompt)
          return;
        void createInCurrentView();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        useAppStore.getState().setSettingsOpen(true);
      }
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandOpen]);

  return (
    <div
      data-app-ready={hydrated}
      className="flex h-[var(--app-viewport-height,100dvh)] min-h-0 flex-col bg-canvas text-ink"
    >
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar collapsible className="hidden md:flex" />
        <MobileDrawer />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 对话使用内部滚动；资产视图保留两列共用的滚动区域。 */}
          <div
            ref={workspaceScroll}
            className={cn(
              "min-h-0 flex-1 overflow-y-auto",
              view === "docs" && "documents-shell",
              view === "agent" && "agent-shell",
            )}
          >
            <div
              className={cn(
                "mx-auto flex w-full max-w-[1560px] items-start px-1 md:px-3",
                view === "agent" && "agent-shell-columns",
              )}
            >
              <main
                className={cn(
                  "@container min-w-0 flex-1",
                  view === "agent" && "agent-shell-main",
                  !wideWorkspace && "xl:border-r xl:border-line",
                )}
              >
                <TopTabs />
                <MainView />
              </main>
              {!wideWorkspace && <RightRail className="hidden xl:block" />}
            </div>
          </div>
        </div>
      </div>

      <nav
        aria-label={t("快捷导航")}
        className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-center justify-around border-t border-line bg-sidebar/95 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {MOBILE_NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setView(item.id)}
              className={cn(
                "relative flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 text-2xs transition-colors duration-150 ease-out",
                active ? "font-semibold text-ink" : "text-muted",
              )}
            >
              <Icon
                className="size-5 transition-transform duration-240 ease-out-soft"
                strokeWidth={active ? 2.4 : 1.8}
              />
              {t(item.label)}
              <span
                className={cn(
                  "absolute inset-x-3 bottom-0.5 h-0.5 rounded-full bg-ink transition-[opacity,transform] duration-240 ease-out-soft",
                  active ? "scale-x-100 opacity-100" : "scale-x-0 opacity-0",
                )}
              />
            </button>
          );
        })}
      </nav>

      <ExpandLayer />
      <SshTerminal />
      <Settings />
      <Composer />
      <CreateAssetPicker />
      <CaptureInbox />
      <GlobalMarkdownImport />
      <CommandPalette />
      <VaultGate />
      <Onboarding />
      <Toaster
        position="bottom-right"
        toastOptions={{
          className: "!bg-card !text-ink !shadow-[var(--shadow-float)] !border-0 !rounded-lg",
        }}
      />
    </div>
  );
}

function MobileDrawer() {
  const open = useAppStore((s) => s.mobileNav);
  const setMobileNav = useAppStore((s) => s.setMobileNav);
  const { mounted, shown } = usePresence(open, 220);
  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button
        type="button"
        className="anim-scrim absolute inset-0 bg-ink/30"
        data-shown={shown}
        aria-label={t("关闭菜单")}
        onClick={() => setMobileNav(false)}
      />
      <Sidebar className="anim-drawer relative z-10 h-full shadow-float" data-shown={shown} />
    </div>
  );
}

const MOBILE_NAV: { id: ViewId; label: string; icon: typeof House }[] = [
  { id: "overview", label: "总览", icon: House },
  { id: "servers", label: "主机", icon: Server },
  { id: "docs", label: "文档", icon: FileText },
  { id: "ai", label: "AI", icon: Bot },
  { id: "phones", label: "号码", icon: Phone },
];

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}
