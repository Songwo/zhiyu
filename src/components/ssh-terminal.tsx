import { hostBridge } from "@/lib/web-bridge";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LiveShell, type ShellStatus } from "./live-shell";
import { usePresence } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import type { Server } from "@/lib/types";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

type Line = { id: number; text: string; tone?: "dim" | "ok" | "warn" | "err" };

export function SshTerminal() {
  const id = useAppStore((s) => s.sshServerId);
  const servers = useAppStore((s) => s.servers);
  const close = useAppStore((s) => s.closeSsh);
  const server = servers.find((s) => s.id === id) ?? null;
  const { mounted, shown } = usePresence(Boolean(server), 200);
  const last = useRef(server);
  if (server) last.current = server;
  if (!mounted || !last.current) return null;
  return <TerminalWindow server={last.current} shown={shown} onClose={close} />;
}

const STATUS_TEXT: Record<ShellStatus | "sim", { label: string; dot: string }> = {
  connecting: { label: "连接中", dot: "status-dot status-dot-warn" },
  open: { label: "已连接", dot: "status-dot status-dot-ok" },
  closed: { label: "已断开", dot: "status-dot status-dot-crit" },
  error: { label: "连接失败", dot: "status-dot status-dot-crit" },
  sim: { label: "模拟会话", dot: "status-dot status-dot-ok" },
};

/**
 * The window is the same either way; only what runs inside it differs.
 *
 * On the desktop that is a real PTY over SSH. In the web preview there is no
 * main process to dial out with, so the built-in simulator stands in — same
 * chrome, same keys, clearly labelled as a simulation.
 */
function TerminalWindow({
  server,
  shown,
  onClose,
}: {
  server: Server;
  shown: boolean;
  onClose: () => void;
}) {
  // 桌面版与自托管网页版都会真正连接主机，只有纯浏览器预览是模拟会话。
  const live = Boolean(hostBridge());
  const [status, setStatus] = useState<ShellStatus>("connecting");
  const badge = STATUS_TEXT[live ? status : "sim"];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc belongs to the remote shell once it is live; the title bar closes it.
      if (e.key === "Escape" && !live) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, live]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-8">
      <button
        type="button"
        aria-label={t("关闭终端")}
        className="anim-scrim absolute inset-0 bg-ink/45 backdrop-blur-sm"
        data-shown={shown}
        onClick={onClose}
      />
      <div
        className="glass-terminal anim-panel relative z-10 flex h-[min(72vh,640px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl shadow-float"
        data-shown={shown}
      >
        <header className="drag-strip flex h-11 shrink-0 items-center gap-3 border-b border-white/10 px-4">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="size-3 rounded-full bg-crit"
              onClick={onClose}
              aria-label={t("关闭")}
            />
            <span className="size-3 rounded-full bg-warn/90" />
            <span className="size-3 rounded-full bg-ok/90" />
          </div>
          <div className="flex flex-1 items-center justify-center gap-2">
            <span className={badge.dot} />
            <span className="font-mono text-meta text-term">
              ssh {server.username}@{server.host} · {server.label}
            </span>
            <span className="text-2xs text-term/55">{t(badge.label)}</span>
          </div>
          <button
            type="button"
            className="grid size-7 place-items-center rounded-full text-term/70 transition-colors duration-150 ease-out hover:bg-white/10 hover:text-term"
            onClick={onClose}
            aria-label={t("关闭终端")}
          >
            <X className="size-3.5" />
          </button>
        </header>

        {live ? (
          <LiveShell server={server} onStatus={setStatus} />
        ) : (
          <SimShell server={server} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

/** Browser fallback: a scripted shell so the preview still demonstrates the flow. */
function SimShell({ server, onClose }: { server: Server; onClose: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  const [cwd, setCwd] = useState("/root");
  const hist = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const seq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const prompt = useMemo(
    () => `${server.username}@${server.name}:${cwd === "/root" ? "~" : cwd}#`,
    [server, cwd],
  );

  function push(text: string, tone?: Line["tone"]) {
    seq.current += 1;
    setLines((xs) => [...xs, { id: seq.current, text, tone }]);
  }

  useEffect(() => {
    let alive = true;
    const steps: [number, string, Line["tone"]?][] = [
      [120, t("OpenSSH_9.6p1 连接 {0}:{1}", server.host, server.port), "dim"],
      [380, t("解析 {0} ({1}) 完成", server.name, server.host), "dim"],
      [640, t("ECDSA 指纹 SHA256:{0}", fakeFp(server.id)), "dim"],
      [880, t("认证公钥 … 成功"), "ok"],
      [1100, `Welcome to ${server.os}  ·  ${server.region}`, "ok"],
      [1280, t("这是浏览器内的模拟会话，桌面版才会真正连出网络。"), "warn"],
    ];
    const timers = steps.map(([ms, text, tone]) =>
      window.setTimeout(() => {
        if (alive) push(text, tone);
      }, ms),
    );
    const readyT = window.setTimeout(() => {
      if (alive) setReady(true);
    }, 1480);
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      clearTimeout(readyT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines, input, ready]);

  useEffect(() => {
    field.current?.focus();
  }, []);

  function run(raw: string) {
    const cmd = raw.trim();
    push(`${prompt} ${cmd}`);
    if (!cmd) return;
    hist.current = [cmd, ...hist.current.filter((x) => x !== cmd)].slice(0, 50);
    histIdx.current = -1;

    if (cmd === "exit" || cmd === "logout") {
      push("Connection to host closed.", "dim");
      window.setTimeout(onClose, 400);
      return;
    }
    if (cmd === "clear") {
      setLines([]);
      return;
    }
    for (const line of interpret(cmd, server, cwd, setCwd)) {
      push(line.text, line.tone);
    }
  }

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-meta leading-relaxed text-term"
      onClick={() => field.current?.focus()}
    >
      {lines.map((ln) => (
        <pre
          key={ln.id}
          className={cn(
            "term-line whitespace-pre-wrap",
            ln.tone === "dim" && "text-white/45",
            ln.tone === "ok" && "text-ok",
            ln.tone === "warn" && "text-warn",
            ln.tone === "err" && "text-crit",
          )}
        >
          {ln.text}
        </pre>
      ))}

      {ready && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(input);
            setInput("");
          }}
        >
          <span className="shrink-0 text-ok">{prompt}</span>
          <input
            ref={field}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                const next = hist.current[histIdx.current + 1];
                if (next !== undefined) {
                  histIdx.current += 1;
                  setInput(next);
                }
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (histIdx.current <= 0) {
                  histIdx.current = -1;
                  setInput("");
                } else {
                  histIdx.current -= 1;
                  setInput(hist.current[histIdx.current] ?? "");
                }
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-term outline-none"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("命令")}
          />
          {!input && <span className="term-cursor" />}
        </form>
      )}
    </div>
  );
}

function interpret(
  cmd: string,
  server: Server,
  cwd: string,
  setCwd: (v: string) => void,
): { text: string; tone?: Line["tone"] }[] {
  const base = cmd.replace(/\s+/g, " ").trim();
  if (base === "help" || base === "?") {
    return [
      {
        text: [
          t("内置命令  help  clear  exit"),
          t("系统      ls  pwd  cd  whoami  hostname  uname -a  uptime"),
          t("资源      top  free -h  df -h  ps"),
          t("网络      ip addr  ping  ss -tlnp"),
          t("服务      docker ps  systemctl status nginx|postgresql"),
          t("其它      neofetch  cat /etc/os-release"),
        ].join("\n"),
        tone: "dim",
      },
    ];
  }
  if (base === "pwd") return [{ text: cwd }];
  if (base === "whoami") return [{ text: server.username }];
  if (base === "hostname") return [{ text: server.name }];
  if (base.startsWith("cd ")) {
    const arg = base.slice(3).trim() || "~";
    const next =
      arg === "~" || arg === "~/"
        ? "/root"
        : arg.startsWith("/")
          ? arg
          : `${cwd}/${arg}`.replace(/\/+/g, "/");
    setCwd(next.replace(/\/$/, "") || "/");
    return [];
  }
  if (base === "ls" || base === "ls -la" || base === "ll") {
    const long = base !== "ls";
    const rows = [
      ["drwx------", "2", server.username, "4096", ".", ""],
      ["drwxr-xr-x", "18", "root", "4096", "..", ""],
      ["-rw-------", "1", server.username, "1284", ".bash_history", ""],
      ["drwxr-xr-x", "3", server.username, "4096", "apps", ""],
      ["drwxr-xr-x", "2", server.username, "4096", "backups", ""],
      ["-rw-r--r--", "1", server.username, "512", "NOTES.md", ""],
    ];
    if (!long) return [{ text: "apps  backups  NOTES.md" }];
    return [
      {
        text: rows.map((r) => r.join("\t")).join("\n"),
        tone: "dim",
      },
    ];
  }
  if (base === "uname" || base === "uname -a") {
    return [
      {
        text: `Linux ${server.name} 6.8.0-40-generic #40 SMP ${server.os} x86_64 GNU/Linux`,
      },
    ];
  }
  if (base === "uptime") {
    return [
      {
        text: ` ${clock()} up ${server.uptime},  3 users,  load average: ${(server.cpu / 40).toFixed(2)}, ${(server.cpu / 55).toFixed(2)}, ${(server.cpu / 70).toFixed(2)}`,
      },
    ];
  }
  if (base === "free" || base === "free -h") {
    const used = Math.round((32 * server.memory) / 100);
    return [
      {
        text: `               total        used        free      available\nMem:            32Gi        ${used}Gi        ${32 - used}Gi        ${Math.max(2, 30 - used)}Gi\nSwap:          4.0Gi          0B        4.0Gi`,
      },
    ];
  }
  if (base === "df" || base === "df -h") {
    return [
      {
        text: `Filesystem      Size  Used Avail Use%\n/dev/vda1       160G   ${Math.round((160 * server.disk) / 100)}G   ${Math.round(160 * (1 - server.disk / 100))}G  ${server.disk}% /\n/dev/vdb1       2.0T   1.1T  900G  55% /data`,
      },
    ];
  }
  if (base === "top" || base === "htop" || base === "ps" || base === "ps aux") {
    return [
      {
        text: `CPU ${server.cpu}%  MEM ${server.memory}%\nPID   USER      %CPU %MEM  COMMAND\n  1   root       0.0  0.1  /sbin/init\n 412  root       1.2  0.4  nginx: master\n 880  www-data   ${(server.cpu / 4).toFixed(1)}  2.1  nginx: worker\n1422  postgres   ${(server.cpu / 6).toFixed(1)}  ${Math.max(3, server.memory / 8).toFixed(1)}  postgres: writer`,
      },
    ];
  }
  if (base.startsWith("ping")) {
    return [
      {
        text: `PING 1.1.1.1 (1.1.1.1): 56 data bytes\n64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=12.4 ms\n64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=11.9 ms\n64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=12.1 ms\n--- 1.1.1.1 ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss`,
      },
    ];
  }
  if (base === "ip addr" || base === "ip a") {
    return [
      {
        text: `2: eth0: <BROADCAST,MULTICAST,UP>\n    inet ${server.host}/24 brd ${server.host.replace(/\d+$/, "255")} scope global eth0`,
      },
    ];
  }
  if (base === "ss -tlnp" || base === "netstat -tlnp") {
    return [
      {
        text: `State  Recv-Q Send-Q Local Address\nLISTEN 0      128    0.0.0.0:22\nLISTEN 0      512    0.0.0.0:80\nLISTEN 0      512    0.0.0.0:443\nLISTEN 0      200    127.0.0.1:5432`,
      },
    ];
  }
  if (base === "docker ps") {
    return [
      {
        text: server.tags.includes("postgres")
          ? "CONTAINER ID   IMAGE          STATUS         NAMES\na91c3e0b12     postgres:16    Up 103 days    pg-primary"
          : "CONTAINER ID   IMAGE          STATUS         NAMES\n4e2b11c90a     nginx:1.27     Up 47 days     edge-proxy",
      },
    ];
  }
  if (base.startsWith("systemctl status")) {
    const svc = base.split(" ").at(-1) ?? "nginx";
    return [
      {
        text: `● ${svc}.service — loaded active running\n     Memory: 84.2M    CPU: ${Math.round(server.cpu / 3)}ms`,
        tone: "ok",
      },
    ];
  }
  if (base === "cat /etc/os-release") {
    return [{ text: `PRETTY_NAME="${server.os}"\nHOME_URL="https://sinan.local"` }];
  }
  if (base === "neofetch") {
    return [
      {
        text: [
          `        .---.        ${server.username}@${server.name}`,
          `       /     \\       OS: ${server.os}`,
          `       | o o |       Host: ${server.host}`,
          `       |  ^  |       CPU: ${server.cpu}%   MEM: ${server.memory}%`,
          `        \\___/        Disk: ${server.disk}%   Uptime: ${server.uptime}`,
          `                      Region: ${server.region}`,
        ].join("\n"),
      },
    ];
  }
  if (base.startsWith("rm ") || base.includes("reboot") || base.includes("shutdown")) {
    return [{ text: t("拒绝：演示终端禁止破坏性命令。"), tone: "err" }];
  }
  return [
    {
      text: t("command not found: {0}    输入 help 查看可用命令", base),
      tone: "err",
    },
  ];
}

function clock() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function fakeFp(id: string) {
  let h = 0;
  for (const c of id) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0") + ":" + (h ^ 0x9e3779b9).toString(16);
}
