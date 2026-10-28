import type { Domain, Server, ServiceAsset, Status } from "./types.ts";

/** SSH 采集到的监听端口与 Docker 容器（electron/services/service-monitor.mjs 的输出）。 */
export type PortScope = "public" | "local" | "private";
export interface ListeningPort {
  proto: "tcp" | "udp";
  port: number;
  scope: PortScope;
  address: string;
  process?: string;
  pid?: number;
}
export interface ContainerPort {
  containerPort: number;
  proto: string;
  hostPort?: number;
  hostIp?: string;
}
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health?: "healthy" | "unhealthy" | "starting";
  restartCount?: number;
  exitCode?: number;
  oomKilled?: boolean;
  startedAt?: string;
  cpu?: number;
  memoryPct?: number;
  memoryUsage?: string;
  ports: ContainerPort[];
}
export interface ServerServices {
  collectedAt: string;
  ports: ListeningPort[];
  docker: { available: boolean; reason?: string; containers: ContainerInfo[] };
}

/** 超过这个时间没有刷新，采集结果就不再当作「现在的状态」。 */
export const SCAN_STALE_MS = 30 * 60_000;

export type {
  ContainerIssue,
  ContainerIssueKind,
} from "../../electron/services/service-monitor.mjs";
export { containerIssues } from "../../electron/services/service-monitor.mjs";
import { containerIssues } from "../../electron/services/service-monitor.mjs";

/** 主机状态：有容器问题时至少是「注意」，不因此把整台主机标成离线。 */
export function withContainerIssues(status: Status, scan?: ServerServices | null): Status {
  return status === "online" && containerIssues(scan).length ? "warning" : status;
}

export function isScanFresh(scan: ServerServices | undefined | null, now = Date.now()) {
  return !!scan && now - Date.parse(scan.collectedAt) <= SCAN_STALE_MS;
}

/** 服务资产绑定的位置：哪台主机、哪个端口、哪个容器、对外用哪个域名。 */
export interface ServiceEndpoint {
  serverId: string;
  port?: number;
  proto?: "tcp" | "udp";
  container?: string;
  domainId?: string;
}

export type EndpointCheck =
  | { kind: "server-missing" }
  | { kind: "no-scan" }
  | { kind: "stale" }
  | { kind: "port"; port: number; proto: "tcp" | "udp"; ok: boolean; process?: string }
  | { kind: "docker-unavailable"; reason?: string }
  | { kind: "container-missing"; name: string }
  | { kind: "container"; name: string; ok: boolean; state: string; health?: string }
  | { kind: "domain"; name: string; ok: boolean; status: Status };

export interface EndpointState {
  status: Status | "unknown";
  checks: EndpointCheck[];
}

/** 根据最近一次采集判断绑定的端口、容器、域名是否都正常。 */
export function endpointState(
  endpoint: ServiceEndpoint,
  context: { server?: Server; domain?: Domain; now?: number },
): EndpointState {
  const checks: EndpointCheck[] = [];
  const { server, domain } = context;
  if (!server) return { status: "unknown", checks: [{ kind: "server-missing" }] };
  const scan = server.serviceScan;
  if (!scan) return { status: "unknown", checks: [{ kind: "no-scan" }] };
  if (!isScanFresh(scan, context.now)) return { status: "unknown", checks: [{ kind: "stale" }] };

  let offline = false;
  let warning = false;
  let unknown = false;
  if (endpoint.port) {
    const proto = endpoint.proto ?? "tcp";
    const hit = scan.ports.find((p) => p.port === endpoint.port && p.proto === proto);
    checks.push({ kind: "port", port: endpoint.port, proto, ok: !!hit, process: hit?.process });
    if (!hit) offline = true;
  }
  if (endpoint.container) {
    if (!scan.docker.available) {
      checks.push({ kind: "docker-unavailable", reason: scan.docker.reason });
      unknown = true;
    } else {
      const found = scan.docker.containers.find((c) => c.name === endpoint.container);
      if (!found) {
        checks.push({ kind: "container-missing", name: endpoint.container });
        offline = true;
      } else {
        const running = found.state === "running";
        const bad = !running || found.health === "unhealthy";
        checks.push({
          kind: "container",
          name: found.name,
          ok: !bad,
          state: found.state,
          health: found.health,
        });
        if (!running) offline = true;
        else if (found.health === "unhealthy") warning = true;
      }
    }
  }
  if (domain) {
    const bad = domain.status !== "online";
    checks.push({ kind: "domain", name: domain.name, ok: !bad, status: domain.status });
    if (bad) warning = true;
  }
  // 只绑了主机、没有端口 / 容器 / 域名可检查时，没有依据给出状态。
  if (!checks.length) return { status: "unknown", checks };
  const status = offline
    ? "offline"
    : warning
      ? "warning"
      : unknown && !checks.some((c) => c.kind === "port")
        ? "unknown"
        : "online";
  return { status, checks };
}

/** 服务资产应当呈现的状态：绑定后由采集结果决定，判断不了（没采集、已过期）时保留手动记录的状态。 */
export function serviceStatusFromEndpoint(
  service: Pick<ServiceAsset, "endpoint" | "status">,
  context: { server?: Server; domain?: Domain; now?: number },
): Status {
  if (!service.endpoint) return service.status;
  const state = endpointState(service.endpoint, context);
  return state.status === "unknown" ? service.status : state.status;
}
