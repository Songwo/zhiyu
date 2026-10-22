import {
  FileText,
  Phone,
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
  ChevronDown,
  Ellipsis,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import { useShallow } from "zustand/react/shallow";
import { isDesktop } from "@/lib/desktop";
import { usePresence } from "@/lib/motion";
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

export interface NavGroup {
  title: string;
  items: {
    id: ViewId;
    label: string;
    icon: LucideIcon;
    badgeKey?: keyof ReturnType<typeof attentionOf>;
    kind?: AssetKind;
    countKey?:
      "servers" | "domains" | "mailboxes" | "aiAssets" | "secrets" | "certs" | "services" | "nodes";
  }[];
}

// 按使用场景分组：日常入口在前，同类资产相邻，低频工具收进可折叠分组。
export const NAV_GROUPS: NavGroup[] = [
  {
    title: "工作台",
    items: [
      { id: "overview", label: "资产总览", icon: House, badgeKey: "total" },
      { id: "renewals", label: "费用与续费", icon: CalendarClock },
      { id: "docs", label: "文档资产", icon: FileText },
      { id: "agent", label: "AI 助手", icon: MessagesSquare },
    ],
  },
  {
    title: "基础设施",
    items: [
      {
        id: "servers",
        label: "服务器",
        icon: Server,
        badgeKey: "servers",
        kind: "server",
        countKey: "servers",
      },
      { id: "nodes", label: "自建节点", icon: Radio, countKey: "nodes" },
      {
        id: "domains",
        label: "域名",
        icon: Globe,
        badgeKey: "domains",
        kind: "domain",
        countKey: "domains",
      },
      {
        id: "certs",
        label: "安全证书",
        icon: Shield,
        badgeKey: "certs",
        kind: "cert",
        countKey: "certs",
      },
      {
        id: "services",
        label: "服务资产",
        icon: Cloud,
        badgeKey: "services",
        kind: "service",
        countKey: "services",
      },
    ],
  },
  {
    title: "账号与订阅",
    items: [
      { id: "ai", label: "AI 订阅", icon: Bot, badgeKey: "ai", kind: "ai", countKey: "aiAssets" },
      { id: "usage", label: "用量记录", icon: ChartNoAxesCombined },
      {
        id: "mail",
        label: "邮箱",
        icon: Mail,
        badgeKey: "mail",
        kind: "mail",
        countKey: "mailboxes",
      },
      { id: "phones", label: "号码管理", icon: Phone, badgeKey: "phones" },
    ],
  },
  {
    title: "安全与整理",
    items: [
      {
        id: "vault",
        label: "密钥库",
        icon: KeyRound,
        badgeKey: "vault",
        kind: "secret",
        countKey: "secrets",
      },
      { id: "tags", label: "标签", icon: Tags },
    ],
  },
  {
    title: "工具",
    items: [{ id: "terminal", label: "终端", icon: SquareTerminal }],
  },
];

// 扁平导出给快捷键或其他模块使用
export const NAV = NAV_GROUPS.flatMap((g) => g.items);

export function Sidebar({
  className,
  collapsible = false,
  ...rest
}: HTMLAttributes<HTMLElement> & { collapsible?: boolean }) {
  const preference = useSettings((s) => s.sidebarCollapsed);
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
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const mailboxes = useAppStore((s) => s.mailboxes);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const secrets = useAppStore((s) => s.secrets);
  const certs = useAppStore((s) => s.certs);
  const services = useAppStore((s) => s.services);
  const counts = useAppStore(useShallow(attentionOf));
  const toolsExpanded = useSettings((s) => s.toolsExpanded);
  const setToolsExpanded = useSettings((s) => s.setToolsExpanded);
  useEffect(() => {
    if (view === "terminal") setToolsExpanded(true);
  }, [view, setToolsExpanded]);

  const totalNodesCount = useMemo(() => {
    return servers.reduce((acc, s) => acc + (s.nodes?.length || 0), 0);
  }, [servers]);

  const assetCounts = useMemo(
    () => ({
      servers: servers.length,
      domains: domains.length,
      mailboxes: mailboxes.length,
      aiAssets: aiAssets.length,
      secrets: secrets.length,
      certs: certs.length,
      services: services.length,
      nodes: totalNodesCount,
    }),
    [
      servers.length,
      domains.length,
      mailboxes.length,
      aiAssets.length,
      secrets.length,
      certs.length,
      services.length,
      totalNodesCount,
    ],
  );

  // 选中项背后的高亮块随选中项滑动，而不是每个按钮各自闪一下背景。
  const navRef = useRef<HTMLElement>(null);
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
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    for (const item of nav.querySelectorAll(".sidebar-nav-item")) observer.observe(item);
    return () => observer.disconnect();
  }, [view, toolsExpanded, collapsed]);

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
          <span
            aria-hidden="true"
            className="sidebar-active-pill"
            data-visible={Boolean(pill)}
            style={
              pill
                ? {
                    transform: `translate3d(${pill.left}px, ${pill.top}px, 0)`,
                    width: pill.width,
                    height: pill.height,
                  }
                : undefined
            }
          />
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="sidebar-section">
              {group.title === "工具" ? (
                <button
                  type="button"
                  aria-expanded={toolsExpanded}
                  aria-label={t("更多工具")}
                  title={collapsed ? t("更多工具") : undefined}
                  onClick={() => setToolsExpanded(!toolsExpanded)}
                  className="sidebar-tools-toggle flex w-full items-center justify-between"
                >
                  <Ellipsis className="sidebar-tools-icon size-5" aria-hidden="true" />
                  <span className="sidebar-tools-label">{t("更多工具")}</span>
                  <ChevronDown
                    className={cn("sidebar-tools-chevron size-3.5", toolsExpanded && "rotate-180")}
                  />
                </button>
              ) : (
                <div className="sidebar-section-title">{t(group.title)}</div>
              )}
              {(group.title !== "工具" || toolsExpanded) &&
                group.items.map((item) => {
                  const active = view === item.id;
                  const Icon = item.icon;
                  const attentionCount = item.badgeKey ? counts[item.badgeKey] : 0;
                  const totalCount = item.countKey ? assetCounts[item.countKey] : 0;

                  return (
                    <Tooltip.Root key={item.id}>
                      <Tooltip.Trigger asChild>
                        <button
                          type="button"
                          aria-label={t(item.label)}
                          onClick={() => setView(item.id)}
                          data-active={active}
                          aria-current={active ? "page" : undefined}
                          className="sidebar-nav-item group flex w-full items-center justify-between gap-2 text-left"
                        >
                          <span className="sidebar-item-content flex min-w-0 items-center gap-3">
                            <Icon
                              className="sidebar-item-icon size-[18px] shrink-0"
                              strokeWidth={1.75}
                            />
                            <span className="sidebar-item-label truncate">{t(item.label)}</span>
                          </span>
                          <span className="sidebar-item-counts flex shrink-0 items-center gap-1.5">
                            {attentionCount > 0 && (
                              <span className="sidebar-badge-attention">{attentionCount}</span>
                            )}
                            {totalCount > 0 && (
                              <span className="sidebar-badge-count">{totalCount}</span>
                            )}
                          </span>
                          {attentionCount > 0 && (
                            <span className="sidebar-attention-dot" aria-hidden="true" />
                          )}
                        </button>
                      </Tooltip.Trigger>
                      {collapsed && (
                        <Tooltip.Portal>
                          <Tooltip.Content side="right" sideOffset={10} className="sidebar-tooltip">
                            {t(item.label)}
                            {attentionCount > 0 && (
                              <span className="ml-2 text-xs">
                                {t("{0} 项待处理", attentionCount)}
                              </span>
                            )}
                            <Tooltip.Arrow className="fill-ink" />
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      )}
                    </Tooltip.Root>
                  );
                })}
            </div>
          ))}
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
            <img src={avatar} alt="" className="size-full rounded-full object-cover" />
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
          {item(t("个人资料"), () => {
            window.dispatchEvent(new Event("settings:profile"));
            useAppStore.getState().setSettingsOpen(true);
          })}
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
          {item(t("系统设置…"), () => useAppStore.getState().setSettingsOpen(true))}
          {vaultUnlocked && item(t("立即锁定密钥库"), () => void lockVault())}
          <div className="my-1 border-t border-line" />
          {item(isDesktop() ? t("清空全部数据") : t("重置演示数据"), () => resetDemo(), "danger")}
        </div>
      )}
    </div>
  );
}
