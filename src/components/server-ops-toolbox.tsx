import {
  Check,
  Copy,
  Cpu,
  Flame,
  Network,
  Play,
  ShieldAlert,
  SquareTerminal,
  Terminal,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { useAppStore } from "@/lib/store";
import type { Server } from "@/lib/types";
import { t } from "@/lib/i18n";

interface OpsCommand {
  category: string;
  title: string;
  cmd: string;
  desc: string;
}

export function ServerOpsToolbox({ server }: { server: Server }) {
  const openSsh = useAppStore((s) => s.openSsh);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const commands: OpsCommand[] = [
    {
      category: "Xray / 代理运维",
      title: "查看 Xray 状态与实时日志",
      cmd: "systemctl status xray --no-pager -l && journalctl -u xray -n 30 --no-pager",
      desc: "检查 VLESS/Reality 服务端运行健康度与最新连接记录",
    },
    {
      category: "Xray / 代理运维",
      title: "热重启 Xray 代理内核",
      cmd: "systemctl restart xray && systemctl is-active xray",
      desc: "重载入站配置或 Reality 密钥后快速平滑重启",
    },
    {
      category: "Docker 容器编排",
      title: "查看活跃容器与端口映射",
      cmd: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
      desc: "一目了然列出全部 Docker 容器运行状态与暴露端口",
    },
    {
      category: "Docker 容器编排",
      title: "一键清理无用镜像与悬挂缓存",
      cmd: "docker system prune -af --volumes",
      desc: "安全释放主机上未使用的 Docker 镜像、悬挂层与卷占用",
    },
    {
      category: "网络与端口监控",
      title: "查看监听端口与关联进程",
      cmd: "ss -tulpn | grep -E 'LISTEN|443|80|22'",
      desc: "排查 443、80、22 等关键业务端口是否正常绑定",
    },
    {
      category: "网络与端口监控",
      title: "实时连接与并发连接统计",
      cmd: "netstat -ant | awk '{print $6}' | sort | uniq -c | sort -n",
      desc: "统计 ESTABLISHED、TIME_WAIT 等 TCP 会话连接分布",
    },
    {
      category: "系统资源与负载",
      title: "内存、虚拟缓存与磁盘空间",
      cmd: "free -h && echo '--- Disk ---' && df -h -x tmpfs -x devtmpfs",
      desc: "实时核验主机内存占用与硬盘分区剩余容量",
    },
    {
      category: "系统资源与负载",
      title: "高占用 CPU / 内存进程排行",
      cmd: "ps aux --sort=-%cpu | head -n 8",
      desc: "抓取排名前列的高算力消耗进程列表",
    },
    {
      category: "防火墙与安全审计",
      title: "查看 UFW 防火墙规则与编号",
      cmd: "ufw status numbered",
      desc: "核验入站白名单策略与端口放行详情",
    },
    {
      category: "防火墙与安全审计",
      title: "Fail2ban 防爆破封禁状态",
      cmd: "fail2ban-client status sshd",
      desc: "查看 SSH 暴力破解尝试次数与已被临时封禁的黑客 IP",
    },
  ];

  async function copyCommand(cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      toast.success(t("已复制命令到剪贴板"));
      setTimeout(() => setCopiedCmd(null), 1800);
    } catch {
      toast.error(t("复制失败"));
    }
  }

  function launchInTerminal(cmd: string) {
    // Copy first then launch SSH
    navigator.clipboard.writeText(cmd).catch(() => {});
    openSsh(server.id);
    toast.success(t("已复制命令并开启玻璃终端，可直接右键粘贴执行"));
  }

  return (
    <div className="space-y-6 p-5">
      {/* Top Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink">
            <Wrench className="size-4 text-muted" />
            {t("服务器运维指令工具箱")}
          </h3>
          <p className="mt-1 text-2xs text-muted">
            {t(
              "预设 Xray 代理、Docker 编排、网络端口、安全防火墙等高频运维诊断命令，支持一键复制与在终端直达执行",
            )}
          </p>
        </div>

        <Button variant="outline" size="sm" onClick={() => openSsh(server.id)}>
          <SquareTerminal className="size-3.5" />
          {t("开启玻璃终端")}
        </Button>
      </header>

      {/* Commands Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {commands.map((item, idx) => {
          const isCopied = copiedCmd === item.cmd;
          return (
            <div
              key={idx}
              className="rounded-xl border border-line bg-card p-3.5 flex flex-col justify-between transition-all hover:border-line-focus hover:shadow-subtle"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="badge badge-tag-mock font-mono text-[10px]">
                    {t(item.category)}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => copyCommand(item.cmd)}
                      title={t("复制命令")}
                      aria-label={t("复制命令")}
                      className="size-7 text-muted hover:text-ink"
                    >
                      {isCopied ? (
                        <Check className="size-3 text-ok" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => launchInTerminal(item.cmd)}
                      title={t("在玻璃终端中运行")}
                      className="size-7 text-muted hover:text-ink"
                    >
                      <Terminal className="size-3" />
                    </Button>
                  </div>
                </div>

                <div className="mt-2 text-xs font-semibold text-ink">{t(item.title)}</div>
                <p className="mt-0.5 text-[11px] text-muted leading-snug">{t(item.desc)}</p>
              </div>

              <div className="mt-2.5 rounded-lg border border-line/60 bg-surface-subtle/80 p-2 font-mono text-[11px] text-ink select-all overflow-x-auto whitespace-nowrap">
                <code>{item.cmd}</code>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
