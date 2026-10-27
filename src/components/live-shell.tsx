import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { useVault } from "@/lib/vault-state";
import type { Server } from "@/lib/types";
import { t } from "@/lib/i18n";

export type ShellStatus = "connecting" | "open" | "closed" | "error";

/** The palette the glass window is built around, handed to xterm verbatim. */
const THEME = {
  background: "#00000000",
  foreground: "#d7dbdf",
  cursor: "#c8e64a",
  cursorAccent: "#0c0c0e",
  selectionBackground: "rgba(255,255,255,0.22)",
  black: "#2b2f33",
  red: "#f4212e",
  green: "#00ba7c",
  yellow: "#ffad1f",
  blue: "#63a4ff",
  magenta: "#c58af9",
  cyan: "#4dd0e1",
  white: "#d7dbdf",
  brightBlack: "#6b7480",
  brightRed: "#ff6b74",
  brightGreen: "#4ade80",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

/**
 * A real PTY on a real host.
 *
 * xterm and its stylesheet are imported dynamically: the same component tree is
 * built for the web preview, where there is no bridge to talk to and no reason
 * to ship a terminal emulator in the bundle.
 */
export function LiveShell({
  server,
  onStatus,
}: {
  server: Server;
  onStatus?: (status: ShellStatus, detail?: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ShellStatus>("connecting");
  const [detail, setDetail] = useState<string | null>(null);
  const requireVault = useVault((s) => s.require);

  useEffect(() => {
    const bridge = hostBridge();
    const mount = host.current;
    if (!bridge || !mount) return;

    let disposed = false;
    let term: Terminal | null = null;
    let sessionId: string | null = null;
    const cleanups: Array<() => void> = [];

    const report = (s: ShellStatus, d?: string) => {
      if (disposed) return;
      setStatus(s);
      setDetail(d ?? null);
      onStatus?.(s, d);
    };

    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      if (disposed) return;

      term = new Xterm({
        allowTransparency: true,
        convertEol: false,
        cursorBlink: true,
        fontFamily: '"IBM Plex Mono", ui-monospace, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.45,
        letterSpacing: 0,
        scrollback: 5000,
        theme: THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(mount);
      fit.fit();
      term.writeln(
        t("\u001b[2m正在连接 {0}@{1}:{2} …\u001b[0m", server.username, server.host, server.port),
      );

      // Opening a session needs the stored credential, which needs the vault.
      if (!(await requireVault(t("连接 {0} 需要读取已保存的 SSH 凭据。", server.name)))) {
        if (disposed) return;
        term.writeln(t("\r\n\u001b[33m已取消：密钥库未解锁。\u001b[0m"));
        report("error", t("密钥库未解锁"));
        return;
      }
      if (disposed) return;

      try {
        const res = await bridge.ssh.open(
          { id: server.id, host: server.host, port: server.port, username: server.username },
          { cols: term.cols, rows: term.rows },
        );
        sessionId = res.sessionId;
        report("open");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!disposed) term.writeln(`\r\n\x1b[31m${msg}\x1b[0m`);
        report("error", msg);
        return;
      }

      cleanups.push(
        bridge.ssh.onData(({ sessionId: id, chunk }) => {
          if (id === sessionId) term?.write(chunk);
        }),
      );
      cleanups.push(
        bridge.ssh.onExit(({ sessionId: id }) => {
          if (id !== sessionId) return;
          sessionId = null;
          term?.writeln(t("\r\n\u001b[2m连接已关闭。\u001b[0m"));
          report("closed");
        }),
      );

      const keys = term.onData((data) => {
        if (sessionId) bridge.ssh.write(sessionId, data);
      });
      cleanups.push(() => keys.dispose());

      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // The window can be mid-transition; the next observation refits.
          return;
        }
        if (sessionId && term) bridge.ssh.resize(sessionId, term.cols, term.rows);
      });
      ro.observe(mount);
      cleanups.push(() => ro.disconnect());

      term.focus();
    })();

    return () => {
      disposed = true;
      for (const off of cleanups) off();
      if (sessionId) void bridge.ssh.close(sessionId);
      term?.dispose();
    };
    // One session per host per open; re-running on every render would dial again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={host} className="absolute inset-0 px-3 py-2" />
      {status === "error" && detail && (
        <div className="pointer-events-none absolute inset-x-4 bottom-4 rounded-lg bg-crit/90 px-3 py-2 text-meta text-card">
          {detail}
        </div>
      )}
    </div>
  );
}
