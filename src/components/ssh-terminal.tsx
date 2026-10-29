import {
  ArrowLeft,
  Copy,
  RotateCw,
  Settings2,
  ClipboardPaste,
  Unplug,
  Lock,
  ArrowDown,
  Command,
  Eraser,
  Maximize2,
  Minimize2,
  SquareTerminal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LiveShell, type ShellStatus, type ShellControls, type ShellViewport } from "./live-shell";
import { desktop, type NativeTerminalAppearance, type NativeTerminalBounds } from "@/lib/desktop";
import { useAppStore } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { useVault } from "@/lib/vault-state";
import type { Server } from "@/lib/types";
import { terminalPalette } from "@/lib/terminal-appearance.mjs";
import { t } from "@/lib/i18n";
import { hostBridge } from "@/lib/web-bridge";
import { Button } from "./ui/button";

const PREVIEW_ID = "__terminal_preview__";
const PREVIEW_SERVER = {
  id: PREVIEW_ID,
  name: "外观预览",
  label: "外观预览",
  host: "",
  username: "",
  port: 22,
} as Server;
type Palette = ReturnType<typeof terminalPalette>;
// 只插入命令不回车，避免误触直接在生产服务器上执行。
const SNIPPETS = [
  { label: "磁盘", command: "df -h" },
  { label: "内存", command: "free -h" },
  { label: "负载", command: "uptime" },
  { label: "进程", command: "top" },
  { label: "高占用", command: "ps aux --sort=-%cpu | head -n 15" },
  { label: "端口", command: "ss -tulpn" },
  { label: "网卡", command: "ip -br addr" },
  { label: "容器", command: "docker ps" },
  { label: "失败服务", command: "systemctl --failed" },
  { label: "系统日志", command: "journalctl -n 100 --no-pager" },
  { label: "大目录", command: "du -sh * | sort -rh | head" },
];

function Tool({
  label,
  title = label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="terminal-tool"
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SshTerminal({ active = true }: { active?: boolean }) {
  const id = useAppStore((s) => s.sshServerId);
  const ids = useAppStore((s) => s.sshSessionIds);
  const servers = useAppStore((s) => s.servers);
  const open = useAppStore((s) => s.openSsh);
  const sessions = ids
    .map((session) =>
      session === PREVIEW_ID ? PREVIEW_SERVER : servers.find((server) => server.id === session),
    )
    .filter((server): server is Server => Boolean(server));
  return (
    <>
      {sessions.length > 1 && (
        <nav className="terminal-session-tabs" aria-label="终端会话">
          {sessions.map((server) => (
            <button
              key={server.id}
              type="button"
              aria-pressed={id === server.id}
              onClick={() => open(server.id)}
            >
              {server.label || server.name}
            </button>
          ))}
        </nav>
      )}
      {sessions.map((server) => (
        <div key={server.id} hidden={server.id !== id}>
          <TerminalWorkspace server={server} active={active && server.id === id} />
        </div>
      ))}
    </>
  );
}

function TerminalWorkspace({ server, active }: { server: Server; active: boolean }) {
  const close = useAppStore((s) => s.closeSsh);
  const disconnect = useAppStore((s) => s.disconnectSsh);
  const resolved = useSettings((s) => s.resolved);
  const overlayOpen = useAppStore(
    (s) => s.commandOpen || s.settingsOpen || s.composerOpen || s.createPickerOpen || s.mobileNav,
  );
  const vaultPrompt = useVault((s) => Boolean(s.prompt));
  const preferences = useSettings((s) => s.terminalAppearance);
  const setPreferences = useSettings((s) => s.setTerminalAppearance);
  const openSettings = useAppStore((s) => s.openSettingsPage);
  const [revision, setRevision] = useState(0);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const sidebarBefore = useRef<boolean | null>(null);
  const [status, setStatus] = useState<ShellStatus | "preview">("connecting");
  const [detail, setDetail] = useState("");
  const [nativeMounted, setNativeMounted] = useState(false);
  const controls = useRef<ShellControls | null>(null);
  const [viewport, setViewport] = useState<ShellViewport>({
    locked: false,
    atBottom: true,
    unread: 0,
  });
  const reportViewport = (next: ShellViewport) =>
    setViewport((previous) =>
      previous.locked === next.locked &&
      previous.atBottom === next.atBottom &&
      previous.unread === next.unread
        ? previous
        : next,
    );
  const preview = server.id === PREVIEW_ID;
  const native = Boolean(desktop()?.ssh.nativeOpen);
  const palette = useMemo(() => {
    const style =
      typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
    return terminalPalette(preferences, resolved, {
      background: style?.getPropertyValue("--color-card").trim(),
      foreground: style?.getPropertyValue("--color-ink").trim(),
    });
  }, [preferences, resolved]);
  const report = (value: ShellStatus | "preview", message = "") => {
    setStatus(value);
    setDetail(message);
  };
  // 工具栏按钮会把焦点留在网页上，操作后交还终端，接着打字仍进入命令行。
  const focusTerminal = () => {
    if (native) void desktop()?.ssh.nativeUpdate?.(server.id, { type: "focus" });
    else controls.current?.focus();
  };
  const invoke = (action: "copy" | "paste" | "latest" | "scroll-lock") => {
    if (native) void desktop()?.ssh.nativeUpdate?.(server.id, { type: action });
    else if (action === "scroll-lock") controls.current?.toggleScrollLock();
    else controls.current?.[action]();
    focusTerminal();
  };
  const send = (data: string) => {
    if (native) void desktop()?.ssh.nativeUpdate?.(server.id, { type: "input", data });
    else controls.current?.send(data);
    focusTerminal();
  };
  const zoom = (delta: number) => setPreferences({ fontSize: preferences.fontSize + delta });
  const toggleFocusMode = () => {
    const settings = useSettings.getState();
    if (!focusMode) {
      sidebarBefore.current = settings.sidebarCollapsed;
      settings.setSidebarCollapsed(true);
    } else if (sidebarBefore.current !== null) {
      settings.setSidebarCollapsed(sidebarBefore.current);
      sidebarBefore.current = null;
    }
    setFocusMode(!focusMode);
    focusTerminal();
  };
  // 离开会话时恢复进入专注模式前的导航状态。
  useEffect(() => {
    if (active || sidebarBefore.current === null) return;
    useSettings.getState().setSidebarCollapsed(sidebarBefore.current);
    sidebarBefore.current = null;
    setFocusMode(false);
  }, [active]);
  const connected = status === "open";
  function reconnect() {
    if (status === "open" && !window.confirm("重新连接会结束当前会话，继续？")) return;
    report("connecting");
    setRevision((value) => value + 1);
  }
  const label = preview
    ? "外观预览"
    : status === "open"
      ? "已连接"
      : status === "connecting"
        ? "正在连接"
        : status === "error"
          ? "连接失败"
          : "已断开";
  return (
    <section
      className="terminal-workspace"
      aria-label="终端工作区"
      data-terminal-engine={native ? "native" : "xterm"}
      data-native-mounted={nativeMounted}
      data-focus-mode={focusMode}
    >
      <div className="detail-bar">
        <button type="button" className="detail-back" onClick={close} aria-label="返回主机列表">
          <ArrowLeft aria-hidden="true" />
          <span>{t("主机列表")}</span>
        </button>
        <div className="detail-actions">
          {!preview && (
            <Button
              variant="ghost"
              size="sm"
              disabled={status === "connecting"}
              onClick={reconnect}
            >
              <RotateCw className="size-3.5" />
              {t("重连")}
            </Button>
          )}
          {!preview && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (window.confirm("断开后当前远程会话将结束，确定断开？")) disconnect(server.id);
              }}
            >
              <Unplug className="size-3.5" />
              {t("断开")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => openSettings("terminal")}>
            <Settings2 className="size-3.5" />
            {t("终端设置")}
          </Button>
        </div>
      </div>
      <header className="terminal-heading">
        <div className="min-w-0">
          <h1 className="terminal-title">
            {preview ? t("终端预览") : server.label || server.name}
          </h1>
          <p className="terminal-address">
            {preview
              ? t("字体与配色效果 · 未连接服务器")
              : `${server.username}@${server.host}:${server.port}`}
          </p>
        </div>
        <span className="terminal-status" data-status={status} title={detail}>
          <span className="status-dot" />
          {label}
        </span>
      </header>
      {status === "error" && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-line bg-card px-4 py-3 text-sm text-crit"
        >
          {detail || "连接失败，请检查服务器地址、网络与 SSH 凭据后重试。"}
        </p>
      )}
      <div
        className="terminal-surface"
        style={
          {
            "--terminal-background": palette.background,
            "--terminal-foreground": palette.foreground,
          } as CSSProperties
        }
      >
        <div className="terminal-chrome">
          <div className="terminal-chrome-title">
            <SquareTerminal aria-hidden="true" />
            <span>{preview ? t("外观预览") : `${server.username}@${server.host}`}</span>
          </div>
          <div className="terminal-tools" role="toolbar" aria-label="终端工具">
            <Tool
              label="常用命令"
              title="常用命令 · 点击插入，按回车执行"
              pressed={snippetsOpen}
              onClick={() => {
                setSnippetsOpen(!snippetsOpen);
                focusTerminal();
              }}
            >
              <Command />
              <span className="terminal-tool-text">常用命令</span>
            </Tool>
            <Tool
              label="清屏"
              title="清屏 · Ctrl+L"
              disabled={!connected}
              onClick={() => send("\x0c")}
            >
              <Eraser />
            </Tool>
            <span className="terminal-tool-sep" aria-hidden="true" />
            <Tool label="缩小字号" disabled={preferences.fontSize <= 11} onClick={() => zoom(-1)}>
              <ZoomOut />
            </Tool>
            <span className="terminal-tool-size" aria-live="polite">
              {preferences.fontSize}
            </span>
            <Tool label="放大字号" disabled={preferences.fontSize >= 22} onClick={() => zoom(1)}>
              <ZoomIn />
            </Tool>
            <span className="terminal-tool-sep" aria-hidden="true" />
            <Tool
              label="锁定滚动"
              title={viewport.locked ? "解除滚动锁定" : "锁定滚动，阅读历史输出"}
              pressed={viewport.locked}
              onClick={() => invoke("scroll-lock")}
            >
              <Lock />
            </Tool>
            <Tool
              label="复制终端内容"
              title="复制选中文字 · Ctrl+Shift+C"
              onClick={() => invoke("copy")}
            >
              <Copy />
            </Tool>
            <Tool label="粘贴到终端" title="粘贴 · Ctrl+Shift+V" onClick={() => invoke("paste")}>
              <ClipboardPaste />
            </Tool>
            <span className="terminal-tool-sep" aria-hidden="true" />
            <Tool
              label={focusMode ? "退出专注模式" : "专注模式"}
              title={focusMode ? "退出专注模式" : "专注模式 · 收起导航，放大终端"}
              pressed={focusMode}
              onClick={toggleFocusMode}
            >
              {focusMode ? <Minimize2 /> : <Maximize2 />}
            </Tool>
          </div>
        </div>
        {snippetsOpen && (
          <div className="terminal-snippets" role="group" aria-label="常用命令">
            {SNIPPETS.map((snippet) => (
              <button
                key={snippet.command}
                type="button"
                disabled={!connected}
                title={`插入 ${snippet.command}，按回车执行`}
                onClick={() => send(snippet.command)}
              >
                <span>{snippet.label}</span>
                <code>{snippet.command}</code>
              </button>
            ))}
          </div>
        )}
        <div
          className="terminal-body"
          onPointerDown={() => {
            if (!preview) focusTerminal();
          }}
        >
          {native ? (
            <NativeTerminalSurface
              key={`${server.id}:${revision}`}
              server={server}
              palette={palette}
              active={active && !overlayOpen && !vaultPrompt}
              layout={`${focusMode}:${snippetsOpen}`}
              onStatus={report}
              onMounted={setNativeMounted}
              onViewport={reportViewport}
            />
          ) : (
            <LiveShell
              key={`${server.id}:${revision}`}
              server={server}
              palette={palette}
              preview={preview || !hostBridge()}
              controls={controls}
              onStatus={report}
              onViewport={reportViewport}
            />
          )}
        </div>
      </div>
      <footer className="terminal-footer">
        <span className="flex items-center gap-2">
          {preview ? "仅预览外观，不连接服务器" : detail || "安全 SSH 会话"}
        </span>
        {(!viewport.atBottom || viewport.locked || viewport.unread > 0) && (
          <button
            type="button"
            className="terminal-latest"
            aria-label="回到最新输出"
            onClick={() => invoke("latest")}
          >
            <ArrowDown className="size-3" />
            回到最新{viewport.unread > 0 ? ` · ${viewport.unread} 行新输出` : ""}
          </button>
        )}
        <span>
          <kbd>Ctrl Shift C</kbd> 复制 · <kbd>Ctrl Shift V</kbd> 粘贴
        </span>
      </footer>
    </section>
  );
}

function NativeTerminalSurface({
  server,
  palette,
  active,
  layout,
  onStatus,
  onMounted,
  onViewport,
}: {
  server: Server;
  palette: Palette;
  active: boolean;
  layout: string;
  onStatus: (status: ShellStatus | "preview", detail?: string) => void;
  onMounted: (value: boolean) => void;
  onViewport: (value: ShellViewport) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState("正在准备终端…");
  const latest = useRef({ palette, active, onStatus, onMounted, onViewport });
  latest.current = { palette, active, onStatus, onMounted, onViewport };
  const sync = useRef<(() => void) | null>(null);
  useEffect(() => {
    const api = desktop()?.ssh;
    const element = mount.current;
    if (!api?.nativeOpen || !element) return;
    latest.current.onMounted(false);
    let disposed = false,
      started = false,
      ready = false,
      animation = 0;
    let wasVisible = false;
    const appearance = (): NativeTerminalAppearance => ({
      type: "appearance",
      background: latest.current.palette.background,
      foreground: latest.current.palette.foreground,
      colors: latest.current.palette.colors,
      fontFamily: latest.current.palette.nativeFont,
      fontSize: latest.current.palette.fontSize,
      cursorStyle: latest.current.palette.cursorStyle,
      cursorBlink: latest.current.palette.cursorBlink,
      autoFollow: latest.current.palette.autoFollow,
      scrollback: latest.current.palette.scrollback,
    });
    const bounds = (): NativeTerminalBounds => {
      const rect = element.getBoundingClientRect();
      const scale = window.devicePixelRatio;
      return {
        type: "bounds",
        x: rect.x * scale,
        y: rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
        visible:
          latest.current.active &&
          rect.width > 0 &&
          rect.height > 0 &&
          document.visibilityState === "visible",
      };
    };
    const update = () => {
      if (ready && !disposed) {
        const next = bounds();
        void api.nativeUpdate?.(server.id, next).catch(() => {});
        if (next.visible && !wasVisible)
          void api.nativeUpdate?.(server.id, { type: "focus" }).catch(() => {});
        wasVisible = next.visible;
      }
    };
    const schedule = () => {
      cancelAnimationFrame(animation);
      animation = requestAnimationFrame(update);
    };
    sync.current = () => {
      if (ready && !disposed) {
        void api.nativeUpdate?.(server.id, appearance()).catch(() => {});
        schedule();
      }
    };
    const off = api.onNativeEvent?.((event) => {
      if (disposed || event.serverId !== server.id) return;
      if (event.type === "attached") latest.current.onMounted(event.embedded === true);
      if (event.type === "viewport")
        latest.current.onViewport({
          locked: event.locked === true,
          atBottom: event.atBottom !== false,
          unread: event.unread || 0,
        });
      if (event.type === "status") {
        if (event.value === "closed") {
          latest.current.onMounted(false);
          setHint("连接已关闭，可从上方重新连接。");
        }
        if (event.value === "error") setHint(event.message || "连接失败，请检查凭据后重试。");
        latest.current.onStatus(
          event.value as ShellStatus | "preview",
          event.message || (event.elapsedMs !== undefined ? `连接用时 ${event.elapsedMs} ms` : ""),
        );
      }
    });
    void (async () => {
      if (
        server.id !== PREVIEW_ID &&
        !(await useVault.getState().require(t("连接 {0} 需要读取已保存的 SSH 凭据。", server.name)))
      ) {
        if (!disposed) latest.current.onStatus("error", "密钥库未解锁");
        return;
      }
      if (disposed) return;
      started = true;
      try {
        await api.nativeOpen!({ id: server.id }, appearance(), bounds());
        if (disposed) {
          void api.nativeClose?.(server.id);
          return;
        }
        ready = true;
        sync.current?.();
      } catch (error) {
        if (!disposed) {
          setHint(error instanceof Error ? error.message : String(error));
          latest.current.onStatus("error", error instanceof Error ? error.message : String(error));
        }
      }
    })();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      disposed = true;
      sync.current = null;
      cancelAnimationFrame(animation);
      observer.disconnect();
      off?.();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      if (started) void api.nativeClose?.(server.id);
    };
  }, [server.id, server.name]);
  useEffect(() => {
    sync.current?.();
  }, [palette, active, layout]);
  return (
    <div ref={mount} className="native-terminal-mount">
      <p className="text-meta text-muted">{hint}</p>
    </div>
  );
}
