import { isWeb, webLogout } from "@/lib/web";
import {
  FileText,
  Phone,
  CreditCard,
  Smartphone,
  ChartNoAxesCombined,
  Bot,
  CalendarClock,
  Cloud,
  Globe,
  House,
  KeyRound,
  Mail,
  Server,
  MessagesSquare,
  Shield,
  SquareTerminal,
  Tags,
  Radio,
  Lock,
  Unlock,
  ChevronRight,
  LayoutGrid,
  X,
  Plus,
  Network,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import { useShallow } from "zustand/react/shallow";
import { isDesktop } from "@/lib/desktop";
import { usePresence, useMotionPolicy } from "@/lib/motion";
import { m } from "motion/react";
import { useAppStore, snapshotOf } from "@/lib/store";
import { attentionOf } from "@/lib/status";
import type { AssetKind, ViewId } from "@/lib/types";
import { cn, downloadJson } from "@/lib/utils";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";
import { useProfile } from "@/lib/profile";
import { useSettings } from "@/lib/settings";
import { toast } from "sonner";
import { safeImageDataUrl } from "../../electron/services/image-data.mjs";
import { createInCurrentView } from "@/lib/create-asset";
import { LogoMark } from "./logo";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import "./sidebar-navigation.css";
import { SHORTCUTS_EVENT } from "./keyboard-shortcuts";

export interface NavGroup {
  id: string;
  title: string;
  items: {
    id: ViewId;
    label: string;
    icon: LucideIcon;
    badgeKey?: keyof ReturnType<typeof attentionOf>;
    kind?: AssetKind;
  }[];
}

// 完整功能目录与全局搜索共用一份导航定义。
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "workspace",
    title: "工作台",
    items: [
      { id: "overview", label: "资产总览", icon: House, badgeKey: "total" },
      { id: "relations", label: "资产关系图", icon: Network },
      { id: "renewals", label: "费用与续费", icon: CalendarClock },
      { id: "docs", label: "文档资产", icon: FileText },
      { id: "agent", label: "AI 助手", icon: MessagesSquare },
    ],
  },
  {
    id: "infrastructure",
    title: "基础设施",
    items: [
      { id: "servers", label: "服务器", icon: Server, badgeKey: "servers", kind: "server" },
      { id: "nodes", label: "自建节点", icon: Radio },
      { id: "domains", label: "域名", icon: Globe, badgeKey: "domains", kind: "domain" },
      { id: "certs", label: "安全证书", icon: Shield, badgeKey: "certs", kind: "cert" },
      { id: "services", label: "服务资产", icon: Cloud, badgeKey: "services", kind: "service" },
    ],
  },
  {
    id: "accounts",
    title: "账号与订阅",
    items: [
      { id: "ai", label: "AI 订阅", icon: Bot, badgeKey: "ai", kind: "ai" },
      { id: "usage", label: "用量记录", icon: ChartNoAxesCombined },
      { id: "mail", label: "邮箱", icon: Mail, badgeKey: "mail", kind: "mail" },
      { id: "phones", label: "号码管理", icon: Phone, badgeKey: "phones" },
      { id: "cards", label: "U 卡与支付卡", icon: CreditCard },
      { id: "esims", label: "eSIM 卡", icon: Smartphone },
    ],
  },
  {
    id: "security",
    title: "安全与整理",
    items: [
      { id: "vault", label: "密钥库", icon: KeyRound, badgeKey: "vault", kind: "secret" },
      { id: "tags", label: "标签", icon: Tags },
    ],
  },
  {
    id: "tools",
    title: "工具",
    items: [{ id: "terminal", label: "终端", icon: SquareTerminal }],
  },
];

// 扁平导出给快捷键或其他模块使用
export const NAV = NAV_GROUPS.flatMap((g) => g.items);

type NavItem = NavGroup["items"][number];
const commonViews = ["overview", "renewals", "mail", "docs"];
const commonItems = commonViews.map((id) => NAV.find((item) => item.id === id)!);

export function Sidebar({
  className,
  collapsible = false,
  ...rest
}: HTMLAttributes<HTMLElement> & { collapsible?: boolean }) {
  const preference = useSettings((s) => s.sidebarCollapsed);
  const directorySource = collapsible ? "sidebar" : "drawer";
  const directoryOpen = useAppStore((s) => s.navigationDirectory === directorySource);
  const setNavigationDirectory = useAppStore((s) => s.setNavigationDirectory);
  const collapsed = collapsible && preference;
  const [motionReady, setMotionReady] = useState(false);
  useEffect(() => {
    // 等待持久化布局落定，避免首次打开时从默认宽度播放收起动画。
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setMotionReady(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  const view = useAppStore((s) => (s.settingsPage ? undefined : s.view));
  const setView = useAppStore((s) => s.setView);
  const counts = useAppStore(useShallow(attentionOf));
  const currentItem = commonViews.some((id) => id === view)
    ? undefined
    : NAV.find((item) => item.id === view);

  // 选中项背后的高亮块随选中项滑动，而不是每个按钮各自闪一下背景。
  const navRef = useRef<HTMLElement>(null);
  const motionMode = useMotionPolicy();
  const [pill, setPill] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>('.sidebar-nav-item[data-active="true"]');
      if (!active) return setPill(null);
      // offset* 相对导航的内边距盒，与绝对定位的参照一致，不受滚动条槽位和按压缩放影响。
      setPill({
        top: active.offsetTop,
        left: active.offsetLeft,
        width: active.offsetWidth,
        height: active.offsetHeight,
      });
    };
    // 导航放不下时在可继续滚动的一侧淡出，让被裁掉的图标看得出下面还有内容。
    const fade = () => {
      const top = nav.scrollTop > 2;
      const bottom = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 2;
      nav.dataset.fade = top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "none";
    };
    const update = () => {
      measure();
      fade();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    for (const item of nav.querySelectorAll(".sidebar-nav-item")) observer.observe(item);
    nav.addEventListener("scroll", fade, { passive: true });
    return () => {
      observer.disconnect();
      nav.removeEventListener("scroll", fade);
    };
  }, [view, collapsed]);

  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={100}>
      <aside
        id={collapsible ? "primary-navigation" : undefined}
        data-collapsed={collapsed}
        data-motion-ready={motionReady}
        className={cn("app-sidebar flex h-full w-60 shrink-0 flex-col select-none", className)}
        {...rest}
      >
        <div className="sidebar-brand drag-strip">
          <LogoMark className="sidebar-brand-mark size-7 shrink-0" />
          <span className="sidebar-item-label sidebar-brand-name">
            {t("知屿")} <span>Zhiyu</span>
          </span>
        </div>

        <div className="sidebar-create">
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                aria-label={t("新建资产")}
                className="sidebar-create-button"
                onClick={() => void createInCurrentView()}
              >
                <Plus className="sidebar-item-icon size-[18px] shrink-0" strokeWidth={2} />
                <span className="sidebar-item-label">{t("新建资产")}</span>
                <kbd className="sidebar-item-counts sidebar-create-kbd">Ctrl N</kbd>
              </button>
            </Tooltip.Trigger>
            {collapsed && (
              <Tooltip.Portal>
                <Tooltip.Content side="right" sideOffset={10} className="sidebar-tooltip">
                  {t("新建资产")}
                  <Tooltip.Arrow className="fill-ink" />
                </Tooltip.Content>
              </Tooltip.Portal>
            )}
          </Tooltip.Root>
        </div>

        <nav
          ref={navRef}
          aria-label={t("主导航")}
          className="sidebar-nav relative flex-1 overflow-y-auto px-3 pb-4"
        >
          <m.span
            aria-hidden="true"
            className="sidebar-active-pill"
            data-motion-engine="motion"
            data-visible={Boolean(pill)}
            initial={false}
            animate={
              pill
                ? {
                    x: pill.left,
                    y: pill.top,
                    width: pill.width,
                    height: pill.height,
                    opacity: 1,
                  }
                : { opacity: 0 }
            }
            transition={
              motionMode === "full" && motionReady
                ? { type: "spring", duration: 0.32, bounce: 0 }
                : { duration: 0 }
            }
          />
          <div className="sidebar-nav-list">
            <span className="sidebar-nav-caption sidebar-item-label">{t("常用入口")}</span>
            {commonItems.map((item) => (
              <SidebarPage
                key={item.id}
                item={item}
                active={view === item.id}
                attention={item.badgeKey ? counts[item.badgeKey] : 0}
                compact={collapsed}
                onSelect={() => setView(item.id)}
              />
            ))}
            {currentItem && (
              <div className="sidebar-current">
                <span className="sidebar-nav-caption sidebar-item-label">{t("当前页面")}</span>
                <SidebarPage
                  item={currentItem}
                  active
                  attention={currentItem.badgeKey ? counts[currentItem.badgeKey] : 0}
                  compact={collapsed}
                  onSelect={() => setView(currentItem.id)}
                />
              </div>
            )}
            <div className="sidebar-directory-entry">
              <Dialog.Root
                open={directoryOpen}
                onOpenChange={(open) => setNavigationDirectory(open ? directorySource : null)}
              >
                <Tooltip.Root>
                  <Dialog.Trigger asChild>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        aria-label={t("全部功能")}
                        className="sidebar-nav-item sidebar-directory-trigger flex w-full items-center justify-between gap-2 text-left"
                      >
                        <span className="sidebar-item-content flex min-w-0 items-center gap-3">
                          <LayoutGrid
                            className="sidebar-item-icon size-[18px] shrink-0"
                            strokeWidth={1.75}
                            aria-hidden="true"
                          />
                          <span className="sidebar-item-label truncate">{t("全部功能")}</span>
                        </span>
                        <ChevronRight
                          className="sidebar-directory-chevron size-4 shrink-0"
                          aria-hidden="true"
                        />
                      </button>
                    </Tooltip.Trigger>
                  </Dialog.Trigger>
                  {collapsed && <SidebarTooltip label={t("全部功能")} />}
                </Tooltip.Root>
                <Dialog.Portal>
                  <Dialog.Overlay className="sidebar-directory-overlay" />
                  <Dialog.Content
                    className="sidebar-directory"
                    onCloseAutoFocus={(event) => {
                      const { commandOpen, settingsOpen, mobileNav } = useAppStore.getState();
                      if (commandOpen || settingsOpen || (!collapsible && !mobileNav))
                        event.preventDefault();
                    }}
                  >
                    <header className="sidebar-directory-head">
                      <div>
                        <Dialog.Title asChild>
                          <h2>{t("全部功能")}</h2>
                        </Dialog.Title>
                        <Dialog.Description>{t("按分类浏览知屿的所有页面。")}</Dialog.Description>
                      </div>
                      <Dialog.Close className="sidebar-directory-close" aria-label={t("关闭")}>
                        <X className="size-5" aria-hidden="true" />
                      </Dialog.Close>
                    </header>
                    <div className="sidebar-directory-grid">
                      {NAV_GROUPS.map((group) => (
                        <section key={group.id} aria-label={t(group.title)}>
                          <h3>{t(group.title)}</h3>
                          {group.items.map(({ id, label, icon: Icon, badgeKey }) => {
                            const attention = badgeKey ? counts[badgeKey] : 0;
                            return (
                              <button
                                key={id}
                                type="button"
                                className="sidebar-directory-page"
                                aria-current={view === id ? "page" : undefined}
                                aria-description={
                                  attention > 0 ? t("{0} 项待处理", attention) : undefined
                                }
                                onClick={() => setView(id)}
                              >
                                <Icon
                                  className="size-4 shrink-0"
                                  strokeWidth={1.75}
                                  aria-hidden="true"
                                />
                                <span>{t(label)}</span>
                                {attention > 0 && (
                                  <span className="sidebar-badge-attention" aria-hidden="true">
                                    {attention}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </section>
                      ))}
                    </div>
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
            </div>
          </div>
        </nav>

        {/* 密钥库入口固定在导航底部，收起后仍可直接操作。 */}
        <div className="sidebar-profile-footer mt-auto shrink-0 space-y-1 p-3">
          <SidebarUtilities compact={collapsed} />
          <ProfileMenu compact={collapsed} />
        </div>
      </aside>
    </Tooltip.Provider>
  );
}

function SidebarAttention({ count }: { count: number }) {
  if (!count) return null;
  return (
    <>
      <span className="sidebar-item-counts sidebar-badge-attention" aria-hidden="true">
        {count}
      </span>
      <span className="sidebar-attention-dot" aria-hidden="true" />
    </>
  );
}

function SidebarTooltip({ label, attention = 0 }: { label: string; attention?: number }) {
  return (
    <Tooltip.Portal>
      <Tooltip.Content side="right" sideOffset={10} className="sidebar-tooltip">
        {label}
        {attention > 0 && <span className="ml-2 text-xs">{t("{0} 项待处理", attention)}</span>}
        <Tooltip.Arrow className="fill-ink" />
      </Tooltip.Content>
    </Tooltip.Portal>
  );
}

function SidebarPage({
  item,
  active,
  attention,
  compact,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  attention: number;
  compact: boolean;
  onSelect: () => void;
}) {
  const { icon: Icon, label } = item;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={t(label)}
          aria-description={attention > 0 ? t("{0} 项待处理", attention) : undefined}
          aria-current={active ? "page" : undefined}
          data-active={active}
          className="sidebar-nav-item flex w-full items-center justify-between gap-2 text-left"
          onClick={onSelect}
        >
          <span className="sidebar-item-content flex min-w-0 items-center gap-3">
            <Icon
              className="sidebar-item-icon size-[18px] shrink-0"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className="sidebar-item-label truncate">{t(label)}</span>
          </span>
          <SidebarAttention count={attention} />
        </button>
      </Tooltip.Trigger>
      {compact && <SidebarTooltip label={t(label)} attention={attention} />}
    </Tooltip.Root>
  );
}

function SidebarUtilities({ compact }: { compact: boolean }) {
  const unlocked = useVault((s) => s.unlocked);
  const [busy, setBusy] = useState(false);
  const entries = [
    ...(isDesktop()
      ? [
          {
            label: t(unlocked ? "锁定密钥库" : "解锁密钥库"),
            icon: unlocked ? Unlock : Lock,
            action: async () => {
              if (unlocked) await useVault.getState().lock();
              else await useVault.getState().require(t("解锁后继续查看和编辑账号。"));
            },
          },
        ]
      : []),
  ];
  return entries.map(({ label, icon: Icon, action }) => (
    <Tooltip.Root key={label}>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={busy}
          className="sidebar-nav-item flex w-full items-center gap-3 text-left disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            try {
              await action();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon className="sidebar-item-icon size-[18px] shrink-0" strokeWidth={1.75} />
          <span className="sidebar-item-label truncate">{label}</span>
        </button>
      </Tooltip.Trigger>
      {compact && (
        <Tooltip.Portal>
          <Tooltip.Content side="right" sideOffset={10} className="sidebar-tooltip">
            {label}
            <Tooltip.Arrow className="fill-ink" />
          </Tooltip.Content>
        </Tooltip.Portal>
      )}
    </Tooltip.Root>
  ));
}

function ProfileMenu({ compact = false }: { compact?: boolean }) {
  const resetDemo = useAppStore((s) => s.resetDemo);
  const log = useAppStore((s) => s.log);
  const importSnapshot = useAppStore((s) => s.importSnapshot);
  const vaultUnlocked = useVault((s) => s.unlocked);
  const lockVault = useVault((s) => s.lock);
  const name = useProfile((s) => s.profile?.name) || "知屿用户";
  const avatarDataUrl = useProfile((s) => s.profile?.avatarDataUrl);
  const avatar = useMemo(() => safeImageDataUrl(avatarDataUrl), [avatarDataUrl]);
  const [open, setOpen] = useState(false);
  const { mounted, shown } = usePresence(open, 150);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function item(label: string, onClick: () => void, tone?: "danger") {
    return (
      <button
        type="button"
        className={cn(
          "sidebar-menu-item block w-full text-left",
          tone === "danger" ? "text-crit font-medium" : "text-ink",
        )}
        onClick={() => {
          setOpen(false);
          onClick();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      ref={root}
      className={cn(
        "sidebar-profile-card relative flex items-center",
        compact && "sidebar-profile-compact",
      )}
    >
      <button
        type="button"
        aria-label={t("更多操作")}
        aria-expanded={open}
        title={compact ? `${name} · ${t(vaultUnlocked ? "凭据已解锁" : "凭据已锁定")}` : undefined}
        className="sidebar-profile-trigger flex min-w-0 w-full items-center gap-2.5 rounded-lg text-left text-muted hover:text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sidebar-profile-avatar relative grid size-9 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-card">
          {avatar ? (
            <img src={avatar} alt={t("个人头像")} className="size-full rounded-full object-cover" />
          ) : (
            Array.from(name)[0]
          )}
          <span
            className={cn("sidebar-vault-dot", vaultUnlocked ? "bg-ok" : "bg-muted")}
            aria-hidden="true"
          />
        </span>

        <span className="sidebar-profile-details min-w-0 flex-1">
          <span className="block truncate text-xs font-bold leading-tight text-ink">{name}</span>
          <span className="flex items-center gap-1 text-[10.5px] text-muted">
            {vaultUnlocked ? (
              <span className="flex items-center gap-1 text-ok font-medium">
                <Unlock className="size-2.5" />
                <span>{t("凭据已解锁")}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-muted">
                <Lock className="size-2.5" />
                <span>{t("凭据已锁定")}</span>
              </span>
            )}
          </span>
        </span>
        <span
          className="sidebar-profile-ellipsis grid size-7 shrink-0 place-items-center"
          aria-hidden="true"
        >
          ···
        </span>
      </button>

      {mounted && (
        <div
          className={cn(
            "anim-panel sidebar-menu absolute bottom-14 left-0 right-0 z-30 overflow-hidden p-1",
            compact && "sidebar-profile-popover",
          )}
          data-shown={shown}
        >
          <div className="border-b border-line px-3 py-1.5 text-[11px] font-semibold text-muted">
            {t("工作区与备份")}
          </div>
          {item(t("个人资料"), () => useAppStore.getState().openSettingsPage("profile"))}
          {item(t("导出 JSON 快照"), () => {
            const s = useAppStore.getState();
            downloadJson("zhiyu-assets.json", snapshotOf(s));
            log(t("已导出资产快照"));
          })}
          {item(t("导入 JSON 快照"), () => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "application/json";
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                importSnapshot(JSON.parse(await file.text()));
                log(t("已导入资产快照"));
              } catch (error) {
                toast.error(error instanceof Error ? error.message : String(error));
              }
            };
            input.click();
          })}
          {item(t("系统设置…"), () => useAppStore.getState().openSettingsPage())}
          {item(t("键盘快捷键"), () => window.dispatchEvent(new Event(SHORTCUTS_EVENT)))}
          {vaultUnlocked && item(t("立即锁定密钥库"), () => void lockVault())}
          <div className="my-1 border-t border-line" />
          {isWeb() && item(t("退出登录"), () => void webLogout())}
          {item(
            isDesktop() || isWeb() ? t("清空全部数据") : t("重置演示数据"),
            () => resetDemo(),
            "danger",
          )}
        </div>
      )}
    </div>
  );
}
