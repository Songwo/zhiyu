import { useMemo } from "react";
import { Boxes, ExternalLink, Network, ShieldAlert } from "lucide-react";
import { t } from "@/lib/i18n";
import {
  containerIssues,
  endpointState,
  isScanFresh,
  type ContainerInfo,
  type ContainerIssue,
  type EndpointCheck,
  type ListeningPort,
} from "@/lib/server-services";
import { useAppStore } from "@/lib/store";
import type { Server } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";
import { RefreshOneButton } from "./refresh-button";

const SCOPE_LABEL = { public: "对外", private: "内网", local: "仅本机" } as const;
const STATE_LABEL: Record<string, string> = {
  running: "运行中",
  exited: "已退出",
  restarting: "重启中",
  paused: "已暂停",
  created: "已创建",
  dead: "已损坏",
};

function issueText(issue: ContainerIssue) {
  switch (issue.kind) {
    case "restarting":
      return t("反复重启");
    case "crashed":
      return t("异常退出（退出码 {0}）", issue.value ?? 0);
    case "oom":
      return t("因内存不足被终止");
    case "unhealthy":
      return t("健康检查失败");
    default:
      return t("已重启 {0} 次", issue.value ?? 0);
  }
}

export function checkText(check: EndpointCheck): { ok: boolean | null; text: string } {
  switch (check.kind) {
    case "server-missing":
      return { ok: null, text: t("绑定的主机已不存在") };
    case "no-scan":
      return { ok: null, text: t("还没有采集过这台主机的端口与容器") };
    case "stale":
      return { ok: null, text: t("采集结果已过期，刷新后再看") };
    case "port":
      return {
        ok: check.ok,
        text: check.ok
          ? t(
              "{0} 端口 {1} 正在监听{2}",
              check.proto.toUpperCase(),
              check.port,
              check.process ? ` · ${check.process}` : "",
            )
          : t("{0} 端口 {1} 没有在监听", check.proto.toUpperCase(), check.port),
      };
    case "docker-unavailable":
      return { ok: null, text: check.reason ?? t("读不到 Docker 信息") };
    case "container-missing":
      return { ok: false, text: t("容器 {0} 不存在", check.name) };
    case "container":
      return {
        ok: check.ok,
        text: check.ok
          ? t("容器 {0} 运行中", check.name)
          : check.state === "running"
            ? t("容器 {0} 健康检查失败", check.name)
            : t("容器 {0} 未运行（{1}）", check.name, t(STATE_LABEL[check.state] ?? check.state)),
      };
    default:
      return {
        ok: check.ok,
        text: check.ok
          ? t("域名 {0} 正常", check.name)
          : t("域名 {0} 需要留意（即将到期或检查异常）", check.name),
      };
  }
}

/** 服务器详情里的「端口与容器」：这台主机上开了哪些端口、跑着哪些容器、绑定了哪些服务与域名。 */
export function ServerServicesPanel({ server }: { server: Server }) {
  const services = useAppStore((s) => s.services);
  const domains = useAppStore((s) => s.domains);
  const openComposer = useAppStore((s) => s.openComposer);
  const scan = server.serviceScan;
  const fresh = isScanFresh(scan);
  const issues = useMemo(() => containerIssues(scan), [scan]);
  const bound = useMemo(
    () => (services ?? []).filter((service) => service.endpoint?.serverId === server.id),
    [services, server.id],
  );
  const byContainerPort = useMemo(() => {
    const map = new Map<string, string>();
    for (const container of scan?.docker.containers ?? [])
      for (const port of container.ports)
        if (port.hostPort) map.set(`${port.proto}:${port.hostPort}`, container.name);
    return map;
  }, [scan]);

  return (
    <div className="space-y-6 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Boxes className="size-4 text-muted" />
            {t("端口与容器")}
          </h3>
          <p className="mt-1 text-2xs text-muted">
            {scan
              ? `${t("上次采集")} ${relativeTime(scan.collectedAt)}${fresh ? "" : ` · ${t("已过期")}`}`
              : t("还没有采集过。点右侧刷新，会通过 SSH 只读查看监听端口和 Docker 容器。")}
          </p>
        </div>
        <RefreshOneButton kind="server" id={server.id} />
      </header>

      {!!issues.length && (
        <div className="rounded-xl border border-warn/40 bg-warn/5 p-4" role="status">
          <p className="flex items-center gap-2 text-meta font-medium">
            <ShieldAlert className="size-4 text-warn" />
            {t("{0} 个容器需要处理", issues.length)}
          </p>
          <ul className="mt-2 space-y-1 text-meta">
            {issues.map((issue) => (
              <li key={`${issue.container}:${issue.kind}`}>
                <strong className="font-medium">{issue.container}</strong> · {issueText(issue)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!bound.length && (
        <section>
          <h4 className="text-meta font-semibold">{t("绑定到这台主机的服务")}</h4>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
            {bound.map((service) => {
              const state = endpointState(service.endpoint!, {
                server,
                domain: domains.find((item) => item.id === service.endpoint!.domainId),
              });
              return (
                <li key={service.id} className="space-y-1 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="text-meta font-medium underline-offset-2 hover:underline"
                      onClick={() => openComposer("service", service.id)}
                    >
                      {service.name}
                    </button>
                    <span
                      className={cn(
                        "badge",
                        state.status === "online" && "badge-valid",
                        state.status === "warning" && "badge-cooling",
                        state.status === "offline" && "badge-invalid",
                      )}
                    >
                      {state.status === "online"
                        ? t("正常")
                        : state.status === "warning"
                          ? t("注意")
                          : state.status === "offline"
                            ? t("告警")
                            : t("未知")}
                    </span>
                    {service.url && (
                      <a
                        href={service.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-2xs text-muted hover:text-ink"
                      >
                        <ExternalLink className="size-3" />
                        {service.url.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                  </div>
                  <ul className="space-y-0.5 text-2xs text-muted">
                    {state.checks.map((check, index) => {
                      const { ok, text } = checkText(check);
                      return (
                        <li key={index} className={cn(ok === false && "text-crit")}>
                          {ok === true ? "✓ " : ok === false ? "✕ " : "· "}
                          {text}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {scan && (
        <section>
          <h4 className="text-meta font-semibold">{t("Docker 容器")}</h4>
          {scan.docker.available ? (
            scan.docker.containers.length ? (
              <div className="mt-2 overflow-x-auto rounded-xl border border-line">
                <table className="svc-table">
                  <thead>
                    <tr>
                      <th>{t("容器")}</th>
                      <th>{t("状态")}</th>
                      <th>{t("端口")}</th>
                      <th>CPU</th>
                      <th>{t("内存")}</th>
                      <th>{t("重启")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scan.docker.containers.map((container) => (
                      <ContainerRow
                        key={container.id}
                        container={container}
                        problem={issues.some((issue) => issue.container === container.name)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-meta text-muted">{t("这台主机上没有容器。")}</p>
            )
          ) : (
            <p className="mt-2 text-meta text-muted">
              {scan.docker.reason ?? t("读不到 Docker 信息")}
            </p>
          )}
        </section>
      )}

      {scan && (
        <section>
          <h4 className="flex items-center gap-2 text-meta font-semibold">
            <Network className="size-3.5 text-muted" />
            {t("监听端口")}
            <span className="text-2xs font-normal text-subtle">{scan.ports.length}</span>
          </h4>
          {scan.ports.length ? (
            <div className="mt-2 overflow-x-auto rounded-xl border border-line">
              <table className="svc-table">
                <thead>
                  <tr>
                    <th>{t("端口")}</th>
                    <th>{t("范围")}</th>
                    <th>{t("进程")}</th>
                    <th>{t("关联")}</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.ports.map((port) => (
                    <PortRow
                      key={`${port.proto}:${port.port}`}
                      port={port}
                      container={byContainerPort.get(`${port.proto}:${port.port}`)}
                      services={bound
                        .filter(
                          (service) =>
                            service.endpoint?.port === port.port &&
                            (service.endpoint.proto ?? "tcp") === port.proto,
                        )
                        .map((service) => ({
                          name: service.name,
                          domain: domains.find((item) => item.id === service.endpoint?.domainId)
                            ?.name,
                        }))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-meta text-muted">
              {t("没有读到监听端口（可能没有安装 ss 或 netstat）。")}
            </p>
          )}
          <p className="mt-2 text-2xs leading-relaxed text-muted">
            {t(
              "「对外」表示监听在所有地址上，公网是否可达还取决于防火墙。当前登录用户看不到其他用户的进程名。",
            )}
          </p>
        </section>
      )}
    </div>
  );
}

function ContainerRow({ container, problem }: { container: ContainerInfo; problem: boolean }) {
  const published = container.ports.filter((port) => port.hostPort);
  return (
    <tr className={cn(problem && "svc-row-problem")}>
      <td>
        <span className="block font-medium">{container.name}</span>
        <span className="block text-2xs text-muted">{container.image}</span>
      </td>
      <td>
        <span className={cn("svc-state", `svc-state-${container.state}`)}>
          {t(STATE_LABEL[container.state] ?? container.state)}
        </span>
        {container.health && (
          <span className="block text-2xs text-muted">
            {container.health === "healthy"
              ? t("健康检查通过")
              : container.health === "starting"
                ? t("健康检查中")
                : t("健康检查失败")}
          </span>
        )}
        {container.state !== "running" && container.status && (
          <span className="block text-2xs text-muted">{container.status}</span>
        )}
      </td>
      <td className="font-mono text-2xs">
        {published.length
          ? published
              .map((port) => `${port.hostPort}→${port.containerPort}/${port.proto}`)
              .join("  ")
          : "—"}
      </td>
      <td>{container.cpu === undefined ? "—" : `${container.cpu}%`}</td>
      <td>{container.memoryUsage ?? "—"}</td>
      <td>{container.restartCount ?? "—"}</td>
    </tr>
  );
}

function PortRow({
  port,
  container,
  services,
}: {
  port: ListeningPort;
  container?: string;
  services: Array<{ name: string; domain?: string }>;
}) {
  return (
    <tr>
      <td className="font-mono">
        {port.port}
        <span className="ml-1 text-2xs text-muted">{port.proto.toUpperCase()}</span>
      </td>
      <td>
        <span className={cn("svc-scope", `svc-scope-${port.scope}`)}>
          {t(SCOPE_LABEL[port.scope])}
        </span>
      </td>
      <td className="text-meta">{port.process ?? "—"}</td>
      <td className="text-2xs text-muted">
        {[
          container && `${t("容器")} ${container}`,
          ...services.map((s) => `${s.name}${s.domain ? ` · ${s.domain}` : ""}`),
        ]
          .filter(Boolean)
          .join(" · ") || "—"}
      </td>
    </tr>
  );
}
