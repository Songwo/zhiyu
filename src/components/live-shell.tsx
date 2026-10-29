import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useVault } from "@/lib/vault-state";
import type { Server } from "@/lib/types";
import type { terminalPalette } from "@/lib/terminal-appearance.mjs";
import { t } from "@/lib/i18n";

export type ShellStatus = "connecting" | "open" | "closed" | "error";
export type ShellViewport = { locked: boolean; atBottom: boolean; unread: number };
export type ShellControls = {
  copy: () => void;
  paste: () => void;
  latest: () => void;
  toggleScrollLock: () => void;
  focus: () => void;
  send: (data: string) => void;
};
type Palette = ReturnType<typeof terminalPalette>;
export function LiveShell({
  server,
  palette,
  preview,
  controls,
  onStatus,
  onViewport,
}: {
  server: Server;
  palette: Palette;
  preview?: boolean;
  controls: MutableRefObject<ShellControls | null>;
  onStatus?: (status: ShellStatus | "preview", detail?: string) => void;
  onViewport?: (value: ShellViewport) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null),
    fitRef = useRef<FitAddon | null>(null);
  const latest = useRef({ palette, onStatus, onViewport });
  latest.current = { palette, onStatus, onViewport };
  const followControl = useRef<((follow: boolean) => void) | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const mount = host.current;
    if (!mount) return;
    const bridge = hostBridge();
    let disposed = false,
      sessionId: string | null = null;
    const cleanups: Array<() => void> = [];
    const report = (status: ShellStatus | "preview", detail?: string) => {
      if (!disposed) {
        latest.current.onStatus?.(status, detail);
        if (status === "error") setError(detail || "连接失败");
      }
    };
    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      if (disposed) return;
      const config = latest.current.palette;
      const term = new Xterm({
        allowTransparency: false,
        cursorBlink: config.cursorBlink,
        cursorStyle: config.cursorStyle,
        cursorInactiveStyle: "outline",
        fontFamily: config.fontFamily,
        fontSize: config.fontSize,
        lineHeight: 1.5,
        scrollback: config.scrollback,
        theme: config.xterm,
      });
      termRef.current = term;
      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(mount);
      fit.fit();
      let locked = !config.autoFollow,
        unread = 0;
      const viewport = () =>
        latest.current.onViewport?.({
          locked,
          atBottom: term.buffer.active.viewportY >= term.buffer.active.baseY,
          unread,
        });
      const resume = () => {
        locked = false;
        unread = 0;
        term.scrollToBottom();
        viewport();
      };
      followControl.current = (follow) => {
        locked = !follow;
        viewport();
      };
      const scrolling = term.onScroll(() => {
        if (!locked && term.buffer.active.viewportY >= term.buffer.active.baseY) unread = 0;
        viewport();
      });
      cleanups.push(() => scrolling.dispose());
      const outputQueue: string[] = [];
      let writing = false;
      const flushOutput = () => {
        if (disposed || writing || outputQueue.length === 0) return;
        const text = outputQueue.splice(0).join("");
        writing = true;
        const buffer = term.buffer.active,
          reading = locked || buffer.viewportY < buffer.baseY;
        const anchor = buffer.viewportY,
          base = buffer.baseY;
        term.write(text, () => {
          writing = false;
          if (disposed) return;
          const added =
            Math.max(0, term.buffer.active.baseY - base) || text.match(/\n/g)?.length || 0;
          if (reading) {
            unread += added;
            const trimmed = base >= term.options.scrollback! ? added : 0;
            term.scrollToLine(Math.max(0, anchor - trimmed));
          }
          viewport();
          flushOutput();
        });
      };
      const writeOutput = (text: string) => {
        outputQueue.push(text);
        flushOutput();
      };
      controls.current = {
        latest: resume,
        focus: () => term.focus(),
        // 与键盘输入同走 onData，未连接时自然丢弃。
        send: (data) => term.input(data),
        toggleScrollLock: () => {
          locked = !locked;
          viewport();
        },
        copy: () => {
          const selected = term.getSelection();
          if (selected)
            void navigator.clipboard
              .writeText(selected)
              .catch(() => report("error", "无法访问剪贴板，请使用系统复制快捷键。"));
        },
        paste: () => {
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (
                !text.includes("\n") ||
                window.confirm("内容包含多行，粘贴后可能执行多条命令。继续粘贴？")
              )
                term.paste(text);
            })
            .catch(() => report("error", "无法读取剪贴板，请使用系统粘贴快捷键。"));
        },
      };
      viewport();
      term.attachCustomKeyEventHandler((event) => {
        if (
          event.type === "keydown" &&
          event.ctrlKey &&
          event.shiftKey &&
          event.key.toLowerCase() === "c"
        ) {
          controls.current?.copy();
          return false;
        }
        if (
          event.type === "keydown" &&
          event.ctrlKey &&
          event.shiftKey &&
          event.key.toLowerCase() === "v"
        ) {
          controls.current?.paste();
          return false;
        }
        return true;
      });
      const observer = new ResizeObserver(() => {
        if (disposed) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        if (sessionId && bridge) bridge.ssh.resize(sessionId, term.cols, term.rows);
      });
      observer.observe(mount);
      cleanups.push(() => observer.disconnect());
      if (preview || !bridge) {
        term.write(
          '\x1b[90m~/workspace  $ cat deployment.ts\x1b[0m\r\n\r\n\x1b[90m// 部署配置示例\x1b[0m\r\n\x1b[35mconst\x1b[0m service = {\r\n  name: \x1b[32m"zhiyu-api"\x1b[0m,\r\n  port: \x1b[33m8080\x1b[0m,\r\n  healthy: \x1b[35mtrue\x1b[0m,\r\n};\r\n\r\n\x1b[35mawait\x1b[0m \x1b[34mdeploy\x1b[0m(service);\r\n\r\n\x1b[90m// 此处只预览外观，不执行命令或连接服务器。\x1b[0m\r\n',
        );
        report("preview");
        return;
      }
      report("connecting");
      term.writeln(t("正在连接 {0}@{1}:{2} …", server.username, server.host, server.port));
      if (
        !(await useVault.getState().require(t("连接 {0} 需要读取已保存的 SSH 凭据。", server.name)))
      ) {
        report("error", "密钥库未解锁");
        return;
      }
      if (disposed) return;
      // 先订阅再连接，保留在 open 返回之前到达的欢迎消息。
      const pending: Array<{ sessionId: string; chunk: string }> = [];
      const exited = new Set<string>();
      cleanups.push(
        bridge.ssh.onData((event) => {
          if (event.sessionId === sessionId) writeOutput(event.chunk);
          else if (!sessionId && pending.length < 128) pending.push(event);
        }),
      );
      cleanups.push(
        bridge.ssh.onExit((event) => {
          if (event.sessionId !== sessionId) {
            exited.add(event.sessionId);
            return;
          }
          sessionId = null;
          report("closed", "连接已关闭");
        }),
      );
      const result = await bridge.ssh.open(
        { id: server.id, host: server.host, port: server.port, username: server.username },
        { cols: term.cols, rows: term.rows },
      );
      if (disposed) {
        void bridge.ssh.close(result.sessionId);
        return;
      }
      if (exited.has(result.sessionId)) {
        report("closed", "连接已关闭");
        return;
      }
      sessionId = result.sessionId;
      for (const event of pending) if (event.sessionId === sessionId) writeOutput(event.chunk);
      pending.length = 0;
      exited.clear();
      report("open");
      const keys = term.onData((data) => {
        if (sessionId) {
          resume();
          bridge.ssh.write(sessionId, data);
        }
      });
      cleanups.push(() => keys.dispose());
      bridge.ssh.resize(sessionId, term.cols, term.rows);
      term.focus();
    })().catch((failure: unknown) => {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (!disposed) termRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      report("error", message);
    });
    return () => {
      disposed = true;
      for (const off of cleanups) off();
      if (sessionId) void bridge?.ssh.close(sessionId);
      controls.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      followControl.current = null;
    };
  }, [server.id, server.host, server.port, server.username, server.name, preview, controls]);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = palette.xterm;
    term.options.fontFamily = palette.fontFamily;
    term.options.fontSize = palette.fontSize;
    term.options.cursorBlink = palette.cursorBlink;
    term.options.cursorStyle = palette.cursorStyle;
    term.options.scrollback = palette.scrollback;
    fitRef.current?.fit();
  }, [palette]);
  useEffect(() => {
    followControl.current?.(palette.autoFollow);
  }, [palette.autoFollow]);
  return (
    <div className="live-terminal-mount">
      <div ref={host} className="live-terminal-content" />
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
