import { Command } from "cmdk";
import {
  Bot,
  CalendarDays,
  Keyboard,
  Phone,
  Settings2,
  SunMoon,
  Sparkles,
  Globe,
  KeyRound,
  Mail,
  Plus,
  Server as ServerIcon,
  Shield,
  SquareTerminal,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { commandResults } from "@/lib/command-results.mjs";
import { NAV } from "./sidebar";
import { usePresence } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { KIND_LABEL } from "@/lib/status";
import { tagIndex, tagsOf } from "@/lib/tags";
import type { AssetKind } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { SHORTCUTS_EVENT } from "./keyboard-shortcuts";

const KIND_ICON: Record<AssetKind, LucideIcon> = {
  server: ServerIcon,
  domain: Globe,
  mail: Mail,
  ai: Bot,
  secret: KeyRound,
  cert: Shield,
  service: Globe,
};

interface Entry {
  id: string;
  /** What cmdk filters against — never rendered. */
  search: string;
  icon: LucideIcon;
  label: string;
  meta?: string;
  hint?: string;
  run: () => void;
}

interface Section {
  heading: string;
  entries: Entry[];
}

export function CommandPalette() {
  const open = useAppStore((s) => s.commandOpen);
  const setOpen = useAppStore((s) => s.setCommandOpen);
  const { mounted, shown } = usePresence(open, 160);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useAppStore.getState().commandOpen) {
        e.preventDefault();
        setOpen(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useAppStore.getState().commandOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  if (!mounted) return null;
  return <Palette shown={shown} onClose={() => setOpen(false)} />;
}

function Palette({ shown, onClose }: { shown: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const setView = useAppStore((s) => s.setView);
  const focusTag = useAppStore((s) => s.focusTag);
  const openSsh = useAppStore((s) => s.openSsh);
  const openComposer = useAppStore((s) => s.openComposer);
  const setExpanded = useAppStore((s) => s.setExpanded);
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const mailboxes = useAppStore((s) => s.mailboxes);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const secrets = useAppStore((s) => s.secrets);
  const certs = useAppStore((s) => s.certs);
  const services = useAppStore((s) => s.services);
  const phoneNumbers = useAppStore((s) => s.phoneNumbers);

  /**
   * Sections are built from data and empty ones are dropped — a heading with
   * nothing under it (which is what an empty estate used to show) reads as a
   * broken list rather than an empty one.
   */
  const sections = useMemo<Section[]>(() => {
    /** Open an asset's detail sheet from the middle of the screen. */
    const reveal = (kind: AssetKind, id: string, view: Parameters<typeof setView>[0]) => () => {
      setView(view);
      const w = Math.min(560, window.innerWidth - 48);
      setExpanded({
        kind,
        id,
        origin: {
          x: (window.innerWidth - w) / 2,
          y: window.innerHeight * 0.32,
          w,
          h: 180,
        },
      });
      onClose();
    };

    const asset = (
      kind: AssetKind,
      id: string,
      label: string,
      meta: string,
      tags: string[],
      view: Parameters<typeof setView>[0],
    ): Entry => ({
      id: `${kind}:${id}`,
      search: `${label} ${meta} ${tags.join(" ")} ${t(KIND_LABEL[kind])}`,
      icon: KIND_ICON[kind],
      label,
      meta,
      run: reveal(kind, id, view),
    });

    const out: Section[] = [];

    const pages: Entry[] = NAV.map((n) => ({
      id: `page:${n.id}`,
      search: t("{0} 页面", n.label),
      icon: n.icon,
      label: t(n.label),
      run: () => {
        setView(n.id);
        onClose();
      },
    }));
    out.push({ heading: t("页面"), entries: pages });

    // 常用操作：搜「主题」「设置」「模板」「快捷键」都能直达。
    out.push({
      heading: t("操作"),
      entries: [
        {
          id: "action:templates",
          search: t("订阅模板 常用订阅 新建 ChatGPT iCloud Cloudflare"),
          icon: Sparkles,
          label: t("从常用订阅模板添加"),
          run: () => {
            onClose();
            useAppStore.getState().setCreatePickerOpen(true);
          },
        },
        {
          id: "action:custom-type",
          search: t("自定义资产 自定义类型 字段 NAS 新建类型"),
          icon: Sparkles,
          label: t("新建自定义资产类型"),
          run: () => {
            onClose();
            useAppStore.getState().setCreatePickerOpen(true);
          },
        },
        {
          id: "action:calendar",
          search: t("续费日历 到期 续费 费用"),
          icon: CalendarDays,
          label: t("打开续费日历"),
          run: () => {
            setView("renewals");
            onClose();
          },
        },
        {
          id: "action:theme",
          search: t("切换主题 深色 浅色 外观 dark light"),
          icon: SunMoon,
          label: t("切换深色 / 浅色外观"),
          run: () => {
            const settings = useSettings.getState();
            settings.setTheme(settings.resolved === "dark" ? "light" : "dark");
            onClose();
          },
        },
        {
          id: "action:settings",
          search: t("系统设置 偏好 备份 数据"),
          icon: Settings2,
          label: t("打开系统设置"),
          run: () => {
            onClose();
            useAppStore.getState().openSettingsPage();
          },
        },
        {
          id: "action:shortcuts",
          search: t("键盘快捷键 快捷键 帮助 shortcut"),
          icon: Keyboard,
          label: t("键盘快捷键"),
          run: () => {
            onClose();
            window.dispatchEvent(new Event(SHORTCUTS_EVENT));
          },
        },
      ],
    });

    const sshEntries: Entry[] = servers
      .filter((server) => server.sshConfigured !== false)
      .map((s) => ({
        id: `ssh:${s.id}`,
        search: `ssh ${s.name} ${s.host} ${s.username} ${tagsOf(s).join(" ")}`,
        icon: SquareTerminal,
        label: t("连接 {0}", s.name),
        meta: `${s.username}@${s.host}`,
        hint: s.status === "offline" ? t("离线") : undefined,
        run: () => {
          if (s.status !== "offline") openSsh(s.id);
          else setView("servers");
          onClose();
        },
      }));

    const assets: Entry[] = [
      ...phoneNumbers.map((phone) => ({
        id: `phone:${phone.id}`,
        search: `${phone.number} ${phone.label} ${phone.provider} ${phone.notes}`,
        icon: Phone,
        label: phone.label || phone.number,
        meta: phone.number,
        run: () => {
          useAppStore.getState().openPhones({ id: phone.id });
          onClose();
        },
      })),
      ...servers.map((s) => asset("server", s.id, s.name, s.host, tagsOf(s), "servers")),
      ...domains.map((s) => asset("domain", s.id, s.name, s.registrar, tagsOf(s), "domains")),
      ...mailboxes.map((s) => asset("mail", s.id, s.address, s.domain, tagsOf(s), "mail")),
      ...aiAssets.map((s) => asset("ai", s.id, s.name, s.provider, tagsOf(s), "ai")),
      ...secrets.map((s) => asset("secret", s.id, s.name, s.hint, tagsOf(s), "vault")),
      ...services.map((s) => asset("service", s.id, s.name, s.url, tagsOf(s), "services")),
      ...certs.map((s) => asset("cert", s.id, s.cn, s.issuer, tagsOf(s), "certs")),
    ];
    if (assets.length) out.push({ heading: t("资产"), entries: assets });

    const tags = tagIndex({ servers, domains, mailboxes, aiAssets, secrets, certs, services });
    if (tags.length) {
      out.push({
        heading: t("分组"),
        entries: tags.map((entry) => ({
          id: `tag:${entry.tag}`,
          search: t("标签 分组 {0}", entry.tag),
          icon: Tag,
          label: entry.tag,
          meta: t("{0} 项资产", entry.total),
          run: () => {
            focusTag(entry.tag);
            onClose();
          },
        })),
      });
    }

    out.push({
      heading: t("新建"),
      entries: (Object.keys(KIND_LABEL) as AssetKind[]).map((kind) => ({
        id: `new:${kind}`,
        search: t("新建 添加 {0}", t(KIND_LABEL[kind])),
        icon: Plus,
        label: t("添加{0}", t(KIND_LABEL[kind])),
        run: () => {
          openComposer(kind);
          onClose();
        },
      })),
    });

    if (sshEntries.length) out.push({ heading: t("SSH 会话"), entries: sshEntries });
    return out;
  }, [
    servers,
    phoneNumbers,
    domains,
    mailboxes,
    aiAssets,
    secrets,
    certs,
    services,
    setView,
    setExpanded,
    openSsh,
    openComposer,
    focusTag,
    onClose,
  ]);

  const results = useMemo(() => commandResults(sections, deferredQuery), [sections, deferredQuery]);
  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="anim-scrim absolute inset-0 bg-ink/30"
        data-shown={shown}
        aria-label={t("关闭搜索")}
        onClick={onClose}
      />
      <Command
        className="anim-panel relative mx-auto mt-[12vh] flex max-h-[70vh] w-[min(600px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl bg-card shadow-float"
        data-shown={shown}
        loop
        shouldFilter={false}
      >
        <Command.Input
          autoFocus
          aria-label={t("搜索资产与操作")}
          value={query}
          onValueChange={setQuery}
          placeholder={t("搜索号码、资产、标签或页面…")}
          className="h-13 w-full shrink-0 border-b border-line bg-transparent px-4 text-body outline-none placeholder:text-subtle"
        />
        <Command.List
          aria-busy={query !== deferredQuery}
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          <Command.Empty className="px-3 py-10 text-center text-meta text-muted">
            {t("没有匹配项")}
          </Command.Empty>
          {results.sections.map((section) => (
            <Command.Group key={section.heading} heading={section.heading} className="cmd-group">
              {section.entries.map((entry) => (
                <Item
                  key={entry.id}
                  value={entry.id}
                  onSelect={() => {
                    if (query === deferredQuery) entry.run();
                  }}
                >
                  <entry.icon className="size-4 shrink-0 text-subtle" strokeWidth={1.9} />
                  <span className="truncate">{entry.label}</span>
                  {entry.meta && (
                    <span className="truncate font-mono text-2xs text-subtle">{entry.meta}</span>
                  )}
                  {entry.hint && <span className="ml-auto chip chip-mute">{entry.hint}</span>}
                </Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
        {results.total > results.shown && (
          <p className="border-t border-line px-4 py-2 text-2xs text-muted" role="status">
            {t("显示前 {0} 项，共 {1} 项；继续输入可缩小范围。", results.shown, results.total)}
          </p>
        )}
        <footer className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2 text-2xs text-subtle">
          <span>
            <Key>↑</Key>
            <Key>↓</Key> {t("选择")}
          </span>
          <span>
            <Key>↵</Key> {t("打开")}
          </span>
          <span>
            <Key>esc</Key> {t("关闭")}
          </span>
        </footer>
      </Command>
    </div>
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-1 inline-grid h-4 min-w-4 place-items-center rounded-xs bg-line px-1 font-mono text-2xs text-muted">
      {children}
    </kbd>
  );
}

function Item({
  value,
  children,
  onSelect,
}: {
  value: string;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-meta transition-colors duration-150 ease-out data-[selected=true]:bg-line"
    >
      {children}
    </Command.Item>
  );
}
