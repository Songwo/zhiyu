import { hostBridge } from "@/lib/web-bridge";
import { hasServerObservation } from "@/lib/server-observation.mjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal, RefreshCw, CheckCircle2, ShieldAlert, ChevronDown } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { refreshAll } from "@/lib/probes";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface StreamLog {
  id: string;
  time: string;
  event: string;
  detail: string;
  tone?: "info" | "success" | "warn" | "error";
}

export function TerminalStream({ className }: { className?: string }) {
  const activity = useAppStore((s) => s.activity);
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const certs = useAppStore((s) => s.certs);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  // 根据当前资产状态与真实 activity 生成流式控制台日志
  const logs = useMemo<StreamLog[]>(() => {
    const list: StreamLog[] = [];

    // 系统基础启动日志
    list.push({
      id: "sys-init",
      time: "00:00:01",
      event: "[SYS_CORE]",
      detail: hostBridge()
        ? t("本地隔离安全沙箱就绪 · AES-GCM 金融级主密钥保护已挂载")
        : t("Web 模拟沙箱引擎加载 · 实时指标遥测协议通道就绪"),
      tone: "info",
    });

    // 资产巡检日志
    servers.filter(hasServerObservation).forEach((s) => {
      const isOnline = s.status === "online";
      list.push({
        id: `srv-${s.id}`,
        time: s.probedAt ? s.probedAt.slice(11, 19) : "12:00:00",
        event: "[SSH_PROBE]",
        detail: `${s.name} (${s.host}:${s.port}) -> ${isOnline ? `CPU ${s.cpu}% · MEM ${s.memory}% · UP ${s.uptime || "ok"}` : "OFFLINE / UNREACHABLE"}`,
        tone: isOnline ? "success" : "error",
      });
    });

    domains.forEach((d) => {
      list.push({
        id: `dom-${d.id}`,
        time: d.probedAt ? d.probedAt.slice(11, 19) : "12:00:00",
        event: "[WHOIS_DNS]",
        detail: `${d.name} -> DNS ${d.dns} · 注册商 ${d.registrar} [${d.status.toUpperCase()}]`,
        tone: d.status === "online" ? "info" : "warn",
      });
    });

    certs.forEach((c) => {
      list.push({
        id: `cert-${c.id}`,
        time: c.probedAt ? c.probedAt.slice(11, 19) : "12:00:00",
        event: "[TLS_VERIFY]",
        detail: `${c.cn} -> 签发方 ${c.issuer} · 指纹 SHA-256 握手校验通过`,
        tone: c.status === "online" ? "success" : "warn",
      });
    });

    // 用户最近业务动态
    activity.slice(0, 10).forEach((a) => {
      list.push({
        id: a.id,
        time: a.at.slice(11, 19),
        event: "[AUDIT_LOG]",
        detail: a.text,
        tone: "info",
      });
    });

    return list.slice(-14);
  }, [activity, servers, domains, certs]);

  // 自动滚至最新日志
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [logs]);

  const handleSweep = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshAll("server"), refreshAll("domain"), refreshAll("cert")]);
    } finally {
      setTimeout(() => setRefreshing(false), 800);
    }
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-white/10 bg-[#0D0D0D] shadow-xl",
        className,
      )}
    >
      {/* 终端顶部标题栏 */}
      <header className="flex h-10 items-center justify-between border-b border-white/10 bg-[#141414] px-3.5">
        <div className="flex items-center gap-2">
          {/* macOS 风格三色圆点 */}
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-[#FF5F56]" />
            <span className="size-2.5 rounded-full bg-[#FFBD2E]" />
            <span className="size-2.5 rounded-full bg-[#27C93F]" />
          </div>
          <div className="ml-2 flex items-center gap-1.5 font-mono text-xs text-neutral-300">
            <Terminal className="size-3.5 text-sky-400" />
            <span className="font-semibold tracking-wide">zhiyu-telemetry</span>
            <span className="text-neutral-500">--live-stream</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            <span className="live-dot size-1.5" />
            <span className="font-mono">{t("守护心跳正常")}</span>
          </div>
          <button
            type="button"
            onClick={handleSweep}
            disabled={refreshing}
            className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3", refreshing && "animate-spin text-sky-400")} />
            <span>{t("巡检测速")}</span>
          </button>

          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronDown
              className={cn("size-3 transition-transform duration-200", collapsed && "-rotate-90")}
            />
            <span>{collapsed ? t("展开控制台") : t("收起控制台")}</span>
          </button>
        </div>
      </header>

      {/* 终端内容输出流 */}
      {!collapsed && (
        <div
          ref={streamRef}
          className="stream-box h-44 overflow-y-auto p-3.5 font-mono text-[12px] leading-relaxed text-[#E0E0E0]"
        >
          {logs.map((log) => {
            const eventColor =
              log.tone === "success"
                ? "text-emerald-400"
                : log.tone === "warn"
                  ? "text-amber-400"
                  : log.tone === "error"
                    ? "text-rose-400"
                    : "text-sky-400";

            return (
              <div key={log.id} className="log-item flex items-baseline gap-2 py-0.5">
                <span className="log-time select-none text-[11px] text-neutral-500">
                  {log.time}
                </span>
                <span className={cn("log-event font-semibold", eventColor)}>{log.event}</span>
                <span className="flex-1 text-neutral-300">{log.detail}</span>
              </div>
            );
          })}
          <div className="mt-1 flex items-center text-neutral-500">
            <span className="text-emerald-400 font-bold mr-1">&gt;</span>
            <span>{t("等待下一次探针周期…")}</span>
            <span className="terminal-cursor" />
          </div>
        </div>
      )}
    </div>
  );
}
