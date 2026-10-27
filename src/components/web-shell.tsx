import { useEffect, useMemo, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  FileText,
  Gauge,
  House,
  LayoutGrid,
  Lock,
  Menu as MenuIcon,
  Moon,
  Plus,
  Search,
  Server,
  Sun,
  Unlock,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { createInCurrentView } from "@/lib/create-asset";
import { t } from "@/lib/i18n";
import { usePresence } from "@/lib/motion";
import { useProfile } from "@/lib/profile";
import { useSettings } from "@/lib/settings";
import { attentionOf } from "@/lib/status";
import { snapshotOf, useAppStore } from "@/lib/store";
import type { ViewId } from "@/lib/types";
import { cn, downloadJson } from "@/lib/utils";
import { useVault } from "@/lib/vault-state";
import { webLogout } from "@/lib/web";
import { safeImageDataUrl } from "../../electron/services/image-data.mjs";
import { SHORTCUTS_EVENT } from "./keyboard-shortcuts";
import { LogoMark } from "./logo";
import { NAV_GROUPS, type NavGroup } from "./sidebar";
import { WEB_NAV } from "./web-nav";
import "./web-shell.css";

type NavItem = NavGroup["items"][number];

/** 网页版的导航分组：在桌面版分组基础上把「主机监控」放进工作台。 */
const GROUPS: NavGroup[] = NAV_GROUPS.map((group) =>
  group.title === "工作台"
    ? { ...group, items: [group.items[0], ...WEB_NAV, ...group.items.slice(1)] }
    : group,
);
const ALL = GROUPS.flatMap((group) => group.items);
const find = (id: ViewId) => ALL.find((item) => item.id === id)!;

/** 顶栏常驻的入口，其余放进「更多」。 */
const PRIMARY: Array<{ id: ViewId; label: string }> = [
  { id: "overview", label: "总览" },
  { id: "host", label: "主机监控" },
  { id: "servers", label: "服务器" },
  { id: "domains", label: "域名" },
  { id: "renewals", label: "续费" },
  { id: "docs", label: "文档" },
  { id: "agent", label: "AI 助手" },
];

/** 窄屏底部的快捷入口。 */
const BOTTOM: Array<{ id: ViewId; label: string; icon: typeof House }> = [
  { id: "overview", label: "总览", icon: House },
  { id: "host", label: "主机", icon: Gauge },
  { id: "servers", label: "服务器", icon: Server },
  { id: "docs", label: "文档", icon: FileText },
];

function useBadges() {
  return useAppStore(useShallow(attentionOf));
}

/** 网页版顶栏：悬浮在页面上方的居中导航条，取代桌面版的左侧栏与标题栏。 */
export function WebTopBar() {
  const view = useAppStore((s) => s.view);
  const settingsPage = useAppStore((s) => s.settingsPage);
  const setView = useAppStore((s) => s.setView);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const badges = useBadges();
  const [menuOpen, setMenuOpen] = useState(false);
  const inMore = !PRIMARY.some((item) => item.id === view);

  return (
    <>
      <header className="web-topbar">
        <div className="web-topbar-bar">
          <button
            type="button"
            className="web-brand"
            aria-label={t("回到总览")}
            onClick={() => setView("overview")}
          >
            <LogoMark className="size-7 shrink-0" />
            <span className="web-brand-name">
              {t("知屿")}
              <span>Zhiyu</span>
            </span>
          </button>

          <nav aria-label={t("主导航")} className="web-nav">
            {PRIMARY.map((item) => {
              const active = !settingsPage && view === item.id;
              const badge = find(item.id).badgeKey ? badges[find(item.id).badgeKey!] : 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  className="web-nav-item"
                  data-active={active}
                  onClick={() => setView(item.id)}
                >
                  {t(item.label)}
                  {badge > 0 && item.id !== "overview" && (
                    <span className="web-nav-badge" aria-label={t("{0} 项待处理", badge)}>
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
            <MoreMenu active={!settingsPage && inMore} />
          </nav>

          <div className="web-actions">
            <button
              type="button"
              className="web-search"
              aria-label={t("搜索资产")}
              onClick={() => setCommandOpen(true)}
            >
              <Search className="size-4" />
              <span className="web-search-label">{t("搜索资产")}</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              type="button"
              className="web-icon-button web-new"
              aria-label={t("新建资产")}
              title={t("新建资产（Ctrl N）")}
              onClick={() => void createInCurrentView()}
            >
              <Plus className="size-4" />
              <span className="web-new-label">{t("新建")}</span>
            </button>
            <ThemeButton />
            <VaultButton />
            <AccountMenu />
            <button
              type="button"
              className="web-icon-button web-menu-button"
              aria-label={t("打开菜单")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <MenuIcon className="size-5" />
            </button>
          </div>
        </div>
      </header>
      <WebMenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}

function ThemeButton() {
  const resolved = useSettings((s) => s.resolved);
  const setTheme = useSettings((s) => s.setTheme);
  return (
    <button
      type="button"
      className="web-icon-button web-optional"
      aria-label={t("切换主题外观")}
      onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
    >
      {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

function VaultButton() {
  const unlocked = useVault((s) => s.unlocked);
  const exists = useVault((s) => s.exists);
  const label = t(unlocked ? "锁定密钥库" : exists ? "解锁密钥库" : "创建密钥库");
  return (
    <button
      type="button"
      className="web-icon-button web-optional"
      aria-label={label}
      title={label}
      data-on={unlocked}
      onClick={async () => {
        try {
          if (unlocked) await useVault.getState().lock();
          else await useVault.getState().require(t("解锁后继续查看和编辑账号。"));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      }}
    >
      {unlocked ? <Unlock className="size-4" /> : <Lock className="size-4" />}
    </button>
  );
}

/** 「更多」：其余页面按分组平铺成一块面板，键盘可以上下选择。 */
function MoreMenu({ active }: { active: boolean }) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const badges = useBadges();
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" className="web-nav-item" data-active={active}>
          <LayoutGrid className="size-4" aria-hidden="true" />
          {active ? t(find(view).label) : t("更多")}
          <ChevronDown className="web-nav-chevron size-3.5" aria-hidden="true" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="center" sideOffset={12} className="web-more">
          {GROUPS.map((group) => (
            <Menu.Group key={group.title} className="web-more-group">
              <Menu.Label className="web-more-title">
                {t(group.title === "工具" ? "更多工具" : group.title)}
              </Menu.Label>
              {group.items.map((item) => {
                const Icon = item.icon;
                const badge = item.badgeKey ? badges[item.badgeKey] : 0;
                return (
                  <Menu.Item
                    key={item.id}
                    className="web-more-item"
                    data-active={view === item.id}
                    onSelect={() => setView(item.id)}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    <span>{t(item.label)}</span>
                    {badge > 0 && item.id !== "overview" && (
                      <span className="web-nav-badge">{badge}</span>
                    )}
                  </Menu.Item>
                );
              })}
            </Menu.Group>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function AccountMenu() {
  const name = useProfile((s) => s.profile?.name) || t("知屿用户");
  const avatarDataUrl = useProfile((s) => s.profile?.avatarDataUrl);
  const avatar = useMemo(() => safeImageDataUrl(avatarDataUrl), [avatarDataUrl]);
  const unlocked = useVault((s) => s.unlocked);
  const store = useAppStore;
  const item = (label: string, onSelect: () => void, danger = false) => (
    <Menu.Item
      className={cn("web-account-item", danger && "web-account-danger")}
      onSelect={onSelect}
    >
      {label}
    </Menu.Item>
  );
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" className="web-avatar" aria-label={t("账号与设置")}>
          {avatar ? (
            <img src={avatar} alt="" className="size-full rounded-full object-cover" />
          ) : (
            Array.from(name)[0]
          )}
          <span className={cn("web-avatar-dot", unlocked ? "bg-ok" : "bg-muted")} aria-hidden />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={12} className="web-account">
          <div className="web-account-head">
            <strong>{name}</strong>
            <span>{t(unlocked ? "凭据已解锁" : "凭据已锁定")}</span>
          </div>
          {item(t("个人资料"), () => store.getState().openSettingsPage("profile"))}
          {item(t("系统设置…"), () => store.getState().openSettingsPage())}
          {item(t("键盘快捷键"), () => window.dispatchEvent(new Event(SHORTCUTS_EVENT)))}
          <Menu.Separator className="web-account-sep" />
          {item(t("导出 JSON 快照"), () => {
            downloadJson("zhiyu-assets.json", snapshotOf(store.getState()));
            store.getState().log(t("已导出资产快照"));
          })}
          {item(t("导入 JSON 快照"), () => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "application/json";
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                store.getState().importSnapshot(JSON.parse(await file.text()));
                store.getState().log(t("已导入资产快照"));
              } catch (error) {
                toast.error(error instanceof Error ? error.message : String(error));
              }
            };
            input.click();
          })}
          {unlocked && item(t("立即锁定密钥库"), () => void useVault.getState().lock())}
          <Menu.Separator className="web-account-sep" />
          {item(t("退出登录"), () => void webLogout())}
          {item(t("清空全部数据"), () => store.getState().resetDemo(), true)}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** 窄屏菜单：铺满整屏的面板，入口按分组排列，依次浮现。 */
function WebMenuSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mounted, shown } = usePresence(open, 300);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const badges = useBadges();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!mounted) return null;
  let index = 0;
  return (
    <div
      className="web-sheet"
      data-shown={shown}
      role="dialog"
      aria-modal="true"
      aria-label={t("全部页面")}
    >
      <div className="web-sheet-head">
        <span className="web-brand">
          <LogoMark className="size-7 shrink-0" />
          <span className="web-brand-name">
            {t("知屿")}
            <span>Zhiyu</span>
          </span>
        </span>
        <button
          ref={close}
          type="button"
          className="web-icon-button"
          aria-label={t("关闭菜单")}
          onClick={onClose}
        >
          <X className="size-5" />
        </button>
      </div>
      <button
        type="button"
        className="web-sheet-search"
        onClick={() => {
          onClose();
          setCommandOpen(true);
        }}
      >
        <Search className="size-4" />
        {t("搜索资产")}
      </button>
      <nav className="web-sheet-groups" aria-label={t("主导航")}>
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h2>{t(group.title === "工具" ? "更多工具" : group.title)}</h2>
            <div className="web-sheet-grid">
              {group.items.map((item: NavItem) => {
                const Icon = item.icon;
                const badge = item.badgeKey ? badges[item.badgeKey] : 0;
                const delay = Math.min(index++ * 60, 400);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="web-sheet-item"
                    data-active={view === item.id}
                    style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
                    onClick={() => {
                      setView(item.id);
                      onClose();
                    }}
                  >
                    <Icon className="size-5" aria-hidden="true" />
                    <span>{t(item.label)}</span>
                    {badge > 0 && item.id !== "overview" && (
                      <span className="web-nav-badge">{badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </div>
  );
}

/** 手机宽度的底部快捷栏，最后一格打开整屏菜单。 */
export function WebBottomNav() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <nav aria-label={t("快捷导航")} className="web-bottom">
        {BOTTOM.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={view === id ? "page" : undefined}
            data-active={view === id}
            onClick={() => setView(id)}
          >
            <Icon className="size-5" />
            {t(label)}
          </button>
        ))}
        <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <LayoutGrid className="size-5" />
          {t("全部")}
        </button>
      </nav>
      <WebMenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}
