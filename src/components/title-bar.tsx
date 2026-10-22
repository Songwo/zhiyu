import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Search,
  Sun,
  Moon,
  Settings2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { WindowControls } from "./window-controls";
import { NAV } from "./sidebar";
import { LogoMark } from "./logo";
import { desktop } from "@/lib/desktop";
import { goBack, goForward, useNavHistory } from "@/lib/nav-history";
import { useAppStore } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { t } from "@/lib/i18n";
import { assetEntries } from "@/lib/operations";

export function TitleBar() {
  const bridge = desktop();
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const resolved = useSettings((s) => s.resolved);
  const setTheme = useSettings((s) => s.setTheme);
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useSettings((s) => s.setSidebarCollapsed);
  const detail = useAppStore((s) =>
    s.expanded
      ? (assetEntries(s).find((x) => x.kind === s.expanded?.kind && x.id === s.expanded?.id)
          ?.label ?? null)
      : null,
  );
  const settingsPage = useAppStore((s) => s.settingsPage);
  const canBack = useNavHistory((s) => s.past.length > 0) || detail !== null || settingsPage;
  const canForward = useNavHistory((s) => s.future.length > 0);
  const view = useAppStore((s) => s.view);
  const page = NAV.find((item) => item.id === view);
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    // 侧栏顶部需要为 macOS 红绿灯按钮让位。
    if (platform) document.documentElement.dataset.platform = platform;
  }, [platform]);
  useEffect(() => {
    let alive = true;
    void bridge?.win
      .state()
      .then((state) => {
        if (alive) setPlatform(state.platform);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bridge]);
  return (
    <header className="drag-strip app-titlebar" onDoubleClick={() => bridge?.win.toggleMaximize()}>
      <div className="flex min-w-0 items-center gap-2">
        {platform === "darwin" && <span className="w-16 shrink-0 md:hidden" />}
        <button
          type="button"
          className="chrome-action desktop-sidebar-toggle shrink-0"
          aria-label={t(sidebarCollapsed ? "展开主导航" : "收起主导航")}
          title={t(sidebarCollapsed ? "展开主导航" : "收起主导航")}
          aria-expanded={!sidebarCollapsed}
          aria-controls="primary-navigation"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          <span
            className="sidebar-toggle-icon size-5"
            data-collapsed={sidebarCollapsed}
            aria-hidden="true"
          >
            <PanelLeftClose className="sidebar-toggle-close" />
            <PanelLeftOpen className="sidebar-toggle-open" />
          </span>
        </button>
        <button
          type="button"
          className="chrome-action mobile-menu-button shrink-0"
          aria-label={t("打开菜单")}
          onClick={() => useAppStore.getState().setMobileNav(true)}
        >
          <Menu className="size-5" />
        </button>
        <div className="nav-history-actions hidden shrink-0 items-center md:flex">
          <button
            type="button"
            className="chrome-action"
            aria-label={t("后退")}
            title={t("后退（Alt+←）")}
            disabled={!canBack}
            onClick={goBack}
          >
            <ArrowLeft className="size-4" />
          </button>
          <button
            type="button"
            className="chrome-action"
            aria-label={t("前进")}
            title={t("前进（Alt+→）")}
            disabled={!canForward}
            onClick={goForward}
          >
            <ArrowRight className="size-4" />
          </button>
        </div>
        <LogoMark className="size-6 shrink-0 md:hidden" />
        <nav aria-label={t("当前位置")} className="titlebar-crumbs">
          <span className="titlebar-crumb-root">{t("知屿")}</span>
          <ChevronRight className="titlebar-crumb-sep" aria-hidden="true" />
          {settingsPage ? (
            <span className="titlebar-crumb-current">{t("系统设置")}</span>
          ) : detail === null ? (
            <span className="titlebar-crumb-current">
              {t(page?.label ?? (view === "relations" ? "关系图" : "资产总览"))}
            </span>
          ) : (
            <>
              <button
                type="button"
                className="titlebar-crumb-link"
                onClick={() => useAppStore.getState().setExpanded(null)}
              >
                {t(page?.label ?? (view === "relations" ? "关系图" : "资产总览"))}
              </button>
              <ChevronRight className="titlebar-crumb-sep" aria-hidden="true" />
              <span className="titlebar-crumb-current">{detail}</span>
            </>
          )}
        </nav>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className="workspace-search"
          onClick={() => setCommandOpen(true)}
          aria-label={t("搜索资产")}
        >
          <Search className="size-4" />
          <span className="hidden sm:inline">{t("搜索资产")}</span>
          <kbd className="hidden sm:inline text-xs">{platform === "darwin" ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
        <button
          type="button"
          className="chrome-action"
          aria-label={t("切换主题外观")}
          onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
        >
          {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
        <button
          type="button"
          className="chrome-action"
          aria-label={t("系统设置…")}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 className="size-4" />
        </button>
        {bridge && <WindowControls />}
      </div>
    </header>
  );
}
