/**
 * 服务器上的监听端口和 Docker 容器状态：通过 SSH 执行一段固定的只读脚本，再解析输出。
 *
 * 脚本里没有任何用户输入，只读 `ss` / `netstat` 与 `docker ps / inspect / stats`，不会改动主机。
 * 远端的输出一律当作不可信数据：控制字符过滤、长度与数量限制，解析不了的行直接丢弃。
 * 没装 Docker、没有权限或命令失败都不算错误，只在结果里写明原因，指标采集不受影响。
 */

export const SERVICES_TIMEOUT = 25_000;
const MAX_PORTS = 500;
const MAX_CONTAINERS = 300;
const MAX_CONTAINER_PORTS = 40;

/** 一次往返取回端口与容器信息。分段标记之间的内容各自解析。 */
export const SERVICES_SCRIPT = `
set +e
echo '##ss'
if command -v ss >/dev/null 2>&1; then
  ss -H -tulnp 2>/dev/null || ss -H -tuln 2>/dev/null
elif command -v netstat >/dev/null 2>&1; then
  netstat -tulnp 2>/dev/null | tail -n +3 || netstat -tuln 2>/dev/null | tail -n +3
fi
echo '##docker'
if command -v docker >/dev/null 2>&1; then
  out=$(docker ps -a --no-trunc --format '{{json .}}' 2>&1)
  if [ $? -ne 0 ]; then
    echo '##dockererror'
    printf '%s\\n' "$out" | head -c 300
  else
    printf '%s\\n' "$out"
    ids=$(docker ps -aq --no-trunc 2>/dev/null)
    echo '##inspect'
    [ -n "$ids" ] && docker inspect --format '{{.Id}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.StartedAt}}' $ids 2>/dev/null
    echo '##stats'
    docker stats --no-stream --no-trunc --format '{{json .}}' 2>/dev/null
  fi
else
  echo '##nodocker'
fi
echo '##end'
`;

/** @param {unknown} value @param {number} [max] @returns {string} */
const clean = (value, max = 160) =>
  typeof value === "string"
    ? [...value]
        .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
        .join("")
        .slice(0, max)
    : "";
/** @param {number} value */
const finiteNumber = (value) => (Number.isFinite(value) ? value : undefined);
/** @param {unknown} text */
const percent = (text) => {
  const value = Number.parseFloat(String(text ?? "").replace("%", ""));
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined;
};

/** 按 `##name` 分段。 */
/** @param {unknown} text */
function sections(text) {
  /** @type {Record<string, string[]>} */
  const out = {};
  let current = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const marker = /^##([a-z]+)$/.exec(line.trim());
    if (marker) {
      current = marker[1];
      out[current] = [];
    } else if (current) out[current].push(line);
  }
  return out;
}

/** @param {string} address @returns {"public" | "local" | "private"} */
export function addressScope(address) {
  const host = String(address)
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  if (host === "*" || host === "0.0.0.0" || host === "::" || host === "") return "public";
  if (host === "::1" || host.startsWith("127.")) return "local";
  return "private";
}

/** 拆 `ss` / `netstat` 里的本地地址：`0.0.0.0:22`、`[::]:22`、`*:80`、`127.0.0.53%lo:53`。 */
/** @param {string} text */
function splitAddress(text) {
  const index = text.lastIndexOf(":");
  if (index < 0) return null;
  const port = Number(text.slice(index + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { address: text.slice(0, index), port };
}
/** @param {string} text */
function processOf(text) {
  const ss = /\(\("([^"]{1,64})",pid=(\d+)/.exec(text);
  if (ss) return { process: clean(ss[1], 64), pid: Number(ss[2]) };
  const netstat = /(\d+)\/([^\s]{1,64})\s*$/.exec(text);
  if (netstat) return { process: clean(netstat[2], 64), pid: Number(netstat[1]) };
  return {};
}

/** 监听端口：同协议同端口的 IPv4 / IPv6 / 多地址合并成一条，对外暴露优先。 */
/** @param {string[]} lines @returns {import("../../src/lib/server-services").ListeningPort[]} */
export function parseListeningPorts(lines) {
  const byKey = new Map();
  /** @type {Record<string, number>} */
  const rank = { public: 2, private: 1, local: 0 };
  for (const raw of lines) {
    const parts = raw.trim().split(/\s+/);
    const proto = parts[0]?.startsWith("tcp") ? "tcp" : parts[0]?.startsWith("udp") ? "udp" : null;
    if (!proto) continue;
    // ss: Netid State Recv-Q Send-Q Local Peer [Process]；netstat: Proto Recv-Q Send-Q Local Foreign [State] [PID/Program]
    const isNetstat = /^\d+$/.test(parts[1] ?? "");
    const local = splitAddress(parts[isNetstat ? 3 : 4] ?? "");
    if (!local) continue;
    const state = isNetstat ? parts[5] : parts[1];
    if (proto === "tcp" && !/^(LISTEN)$/i.test(state ?? "")) continue;
    const key = `${proto}:${local.port}`;
    const scope = addressScope(local.address);
    const entry = {
      proto,
      port: local.port,
      scope,
      address: clean(local.address, 64),
      ...processOf(raw),
    };
    const known = byKey.get(key);
    if (!known) byKey.set(key, entry);
    else {
      if (rank[scope] > rank[known.scope]) Object.assign(known, { scope, address: entry.address });
      if (!known.process && entry.process)
        Object.assign(known, { process: entry.process, pid: entry.pid });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
    .slice(0, MAX_PORTS);
}

/** `0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 443/tcp`。 */
/** @param {unknown} text @returns {import("../../src/lib/server-services").ContainerPort[]} */
export function parseContainerPorts(text) {
  const seen = new Set();
  const out = [];
  for (const piece of String(text ?? "").split(",")) {
    const match = /^\s*(?:(.+):(\d+)->)?(\d+)(?:-(\d+))?\/(tcp|udp)\s*$/.exec(piece);
    if (!match) continue;
    /** @type {import("../../src/lib/server-services").ContainerPort} */
    const entry = { containerPort: Number(match[3]), proto: match[5] };
    if (match[2]) {
      entry.hostPort = Number(match[2]);
      entry.hostIp = clean(match[1].replace(/^\[|\]$/g, ""), 64);
    }
    const key = `${entry.proto}:${entry.hostPort ?? "-"}:${entry.containerPort}`;
    if (seen.has(key)) continue; // IPv4 / IPv6 各发布一次，只留一条
    seen.add(key);
    out.push(entry);
    if (out.length >= MAX_CONTAINER_PORTS) break;
  }
  return out;
}

/** @param {string} line @returns {Record<string, any> | null} */
const json = (line) => {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/** 把 docker ps / inspect / stats 三段合并成容器列表。 */
/** @param {{ ps?: string[], inspect?: string[], stats?: string[] }} input @returns {import("../../src/lib/server-services").ContainerInfo[]} */
export function parseContainers({ ps = [], inspect = [], stats = [] }) {
  const details = new Map();
  for (const line of inspect) {
    const [id, restarts, health, exitCode, oom, startedAt] = line.trim().split("|");
    if (!/^[0-9a-f]{12,64}$/.test(id ?? "")) continue;
    details.set(id, {
      restartCount: finiteNumber(Number.parseInt(restarts, 10)),
      health: ["healthy", "unhealthy", "starting"].includes(health) ? health : undefined,
      exitCode: finiteNumber(Number.parseInt(exitCode, 10)),
      oomKilled: oom === "true" ? true : undefined,
      startedAt: /^\d{4}-\d{2}-\d{2}T/.test(startedAt ?? "") ? startedAt : undefined,
    });
  }
  const usage = new Map();
  for (const line of stats) {
    const row = json(line);
    if (!row) continue;
    const memory = String(row.MemUsage ?? "")
      .split("/")[0]
      .trim();
    const entry = {
      cpu: percent(row.CPUPerc),
      memoryPct: percent(row.MemPerc),
      memoryUsage: memory ? clean(memory, 24) : undefined,
    };
    for (const key of [row.ID, row.Container, row.Name]) if (key) usage.set(String(key), entry);
  }
  const containers = [];
  for (const line of ps) {
    const row = json(line);
    const id = String(row?.ID ?? "");
    if (!row || !/^[0-9a-f]{12,64}$/.test(id)) continue;
    const name = clean(String(row.Names ?? "").split(",")[0], 80) || id.slice(0, 12);
    const detail = details.get(id) ?? [...details].find(([key]) => key.startsWith(id))?.[1] ?? {};
    const live = usage.get(id) ?? usage.get(id.slice(0, 12)) ?? usage.get(name) ?? {};
    containers.push({
      id: id.slice(0, 12),
      name,
      image: clean(row.Image, 120),
      state: clean(String(row.State ?? "").toLowerCase(), 24) || "unknown",
      status: clean(row.Status, 80),
      ...detail,
      ...live,
      ports: parseContainerPorts(row.Ports),
    });
    if (containers.length >= MAX_CONTAINERS) break;
  }
  return containers.sort((a, b) => a.name.localeCompare(b.name));
}

const FLAPPING = 5;

/**
 * @typedef {"restarting" | "crashed" | "oom" | "unhealthy" | "flapping"} ContainerIssueKind
 * @typedef {{ kind: ContainerIssueKind, container: string, severity: "warn" | "crit", value?: number }} ContainerIssue
 */

/**
 * 需要人处理的容器问题：重启循环、异常退出、内存不足被杀、健康检查失败、反复重启。
 * 正常退出（退出码 0）的一次性任务容器不算问题。界面和系统通知共用这一份判断。
 * @param {{ docker?: { containers?: any[] } } | null | undefined} scan
 * @returns {ContainerIssue[]}
 */
export function containerIssues(scan) {
  /** @type {ContainerIssue[]} */
  const issues = [];
  for (const c of scan?.docker?.containers ?? []) {
    if (c.state === "restarting")
      issues.push({
        kind: "restarting",
        container: c.name,
        severity: "crit",
        value: c.restartCount,
      });
    else if (c.state === "exited" || c.state === "dead") {
      if (c.oomKilled) issues.push({ kind: "oom", container: c.name, severity: "crit" });
      else if (c.exitCode !== undefined && c.exitCode !== 0)
        issues.push({ kind: "crashed", container: c.name, severity: "warn", value: c.exitCode });
    } else if (c.state === "running") {
      if (c.health === "unhealthy")
        issues.push({ kind: "unhealthy", container: c.name, severity: "warn" });
      else if ((c.restartCount ?? 0) >= FLAPPING)
        issues.push({
          kind: "flapping",
          container: c.name,
          severity: "warn",
          value: c.restartCount,
        });
    }
  }
  return issues;
}

/** 解析 SERVICES_SCRIPT 的输出。 */
/** @param {unknown} text @param {string} [at] @returns {import("../../src/lib/server-services").ServerServices} */
export function parseServices(text, at = new Date().toISOString()) {
  const part = sections(text);
  const result = {
    collectedAt: at,
    ports: parseListeningPorts(part.ss ?? []),
    /** @type {import("../../src/lib/server-services").ServerServices["docker"]} */
    docker: { available: false, containers: [] },
  };
  if (part.nodocker) result.docker.reason = "这台主机没有安装 Docker";
  else if (part.dockererror) {
    const message = clean((part.dockererror ?? []).join(" "), 200);
    result.docker.reason = /permission denied/i.test(message)
      ? "当前登录用户没有权限访问 Docker（需要加入 docker 组）"
      : /cannot connect|is the docker daemon running/i.test(message)
        ? "Docker 服务没有运行"
        : "读取 Docker 失败";
  } else if (part.docker) {
    result.docker = {
      available: true,
      containers: parseContainers({
        ps: (part.docker ?? []).filter((line) => line.trim().startsWith("{")),
        inspect: part.inspect ?? [],
        stats: part.stats ?? [],
      }),
    };
  }
  return result;
}
