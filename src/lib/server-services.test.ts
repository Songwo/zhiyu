import assert from "node:assert/strict";
import { test } from "node:test";
import {
  containerIssues,
  endpointState,
  isScanFresh,
  serviceStatusFromEndpoint,
  withContainerIssues,
  type ContainerInfo,
  type ServerServices,
} from "./server-services.ts";
import type { Domain, Server } from "./types.ts";

const NOW = Date.parse("2026-10-28T08:00:00.000Z");
const container = (extra: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id: "abc",
  name: "web",
  image: "nginx",
  state: "running",
  status: "Up",
  ports: [],
  ...extra,
});
const scan = (
  containers: ContainerInfo[] = [],
  extra: Partial<ServerServices> = {},
): ServerServices => ({
  collectedAt: "2026-10-28T07:55:00.000Z",
  ports: [
    { proto: "tcp", port: 22, scope: "public", address: "0.0.0.0", process: "sshd" },
    { proto: "tcp", port: 8080, scope: "public", address: "0.0.0.0", process: "docker-proxy" },
    { proto: "udp", port: 5353, scope: "public", address: "*" },
  ],
  docker: { available: true, containers },
  ...extra,
});
const host = (serviceScan?: ServerServices) => ({ id: "s1", serviceScan }) as unknown as Server;
const domain = (status: Domain["status"] = "online") =>
  ({ id: "d1", name: "blog.example.com", status }) as unknown as Domain;

test("容器问题：重启循环、异常退出、内存不足、健康检查失败、反复重启", () => {
  const issues = containerIssues(
    scan([
      container({ name: "a", state: "restarting", restartCount: 9 }),
      container({ name: "b", state: "exited", exitCode: 1 }),
      container({ name: "c", state: "exited", exitCode: 137, oomKilled: true }),
      container({ name: "d", health: "unhealthy" }),
      container({ name: "e", restartCount: 7 }),
      container({ name: "ok" }),
      container({ name: "job", state: "exited", exitCode: 0 }),
      container({ name: "created", state: "created" }),
    ]),
  );
  assert.deepEqual(
    issues.map((i) => [i.container, i.kind, i.severity]),
    [
      ["a", "restarting", "crit"],
      ["b", "crashed", "warn"],
      ["c", "oom", "crit"],
      ["d", "unhealthy", "warn"],
      ["e", "flapping", "warn"],
    ],
  );
  assert.equal(issues[1].value, 1);
  assert.deepEqual(containerIssues(undefined), []);
});

test("有容器问题时主机至少是「注意」，已经离线的不被改写", () => {
  const bad = scan([container({ state: "restarting" })]);
  assert.equal(withContainerIssues("online", bad), "warning");
  assert.equal(withContainerIssues("offline", bad), "offline");
  assert.equal(withContainerIssues("online", scan([container()])), "online");
});

test("采集结果超过 30 分钟就不再算最新", () => {
  assert.ok(isScanFresh(scan(), NOW));
  assert.ok(!isScanFresh(scan([], { collectedAt: "2026-10-28T06:00:00.000Z" }), NOW));
  assert.ok(!isScanFresh(undefined, NOW));
});

test("绑定状态：端口在监听、容器在运行、域名正常 → 正常", () => {
  const state = endpointState(
    { serverId: "s1", port: 8080, container: "web", domainId: "d1" },
    { server: host(scan([container()])), domain: domain(), now: NOW },
  );
  assert.equal(state.status, "online");
  assert.deepEqual(
    state.checks.map((c) => c.kind),
    ["port", "container", "domain"],
  );
});

test("绑定状态：端口没在监听、容器停了或不存在 → 告警；容器健康检查失败、域名快到期 → 注意", () => {
  const server = host(scan([container({ state: "exited", exitCode: 0 })]));
  assert.equal(
    endpointState({ serverId: "s1", port: 9999 }, { server, now: NOW }).status,
    "offline",
  );
  assert.equal(
    endpointState({ serverId: "s1", container: "web" }, { server, now: NOW }).status,
    "offline",
  );
  assert.equal(
    endpointState({ serverId: "s1", container: "ghost" }, { server, now: NOW }).status,
    "offline",
  );
  const unhealthy = host(scan([container({ health: "unhealthy" })]));
  assert.equal(
    endpointState({ serverId: "s1", container: "web" }, { server: unhealthy, now: NOW }).status,
    "warning",
  );
  const expiring = endpointState(
    { serverId: "s1", port: 22, domainId: "d1" },
    { server: host(scan()), domain: domain("warning"), now: NOW },
  );
  assert.equal(expiring.status, "warning");
  assert.equal(
    endpointState({ serverId: "s1", port: 5353, proto: "udp" }, { server: host(scan()), now: NOW })
      .status,
    "online",
  );
  assert.equal(
    endpointState({ serverId: "s1", port: 5353 }, { server: host(scan()), now: NOW }).status,
    "offline",
    "默认按 TCP 查",
  );
});

test("绑定状态：主机不存在、没采集过、采集过期、Docker 不可用时判断不了，不冒充正常或告警", () => {
  const endpoint = { serverId: "s1", port: 8080 };
  assert.equal(endpointState(endpoint, { server: undefined, now: NOW }).status, "unknown");
  assert.equal(endpointState(endpoint, { server: host(undefined), now: NOW }).status, "unknown");
  assert.equal(
    endpointState(endpoint, {
      server: host(scan([], { collectedAt: "2026-10-27T00:00:00.000Z" })),
      now: NOW,
    }).status,
    "unknown",
  );
  const noDocker = host(
    scan([], { docker: { available: false, reason: "没有权限", containers: [] } }),
  );
  assert.equal(
    endpointState({ serverId: "s1", container: "web" }, { server: noDocker, now: NOW }).status,
    "unknown",
  );
  // 端口检查仍然有效，即使容器信息拿不到。
  assert.equal(
    endpointState({ serverId: "s1", port: 8080, container: "web" }, { server: noDocker, now: NOW })
      .status,
    "online",
  );
});

test("服务资产状态：绑定后由采集决定，判断不了时保留手动记录的状态", () => {
  const server = host(scan([container()]));
  assert.equal(
    serviceStatusFromEndpoint({ status: "warning" }, { server, now: NOW }),
    "warning",
    "没有绑定",
  );
  assert.equal(
    serviceStatusFromEndpoint(
      { status: "warning", endpoint: { serverId: "s1", port: 8080 } },
      { server, now: NOW },
    ),
    "online",
  );
  assert.equal(
    serviceStatusFromEndpoint(
      { status: "online", endpoint: { serverId: "s1", port: 1 } },
      { server, now: NOW },
    ),
    "offline",
  );
  assert.equal(
    serviceStatusFromEndpoint(
      { status: "online", endpoint: { serverId: "gone", port: 1 } },
      { server: undefined, now: NOW },
    ),
    "online",
    "主机不在了就保留原状态",
  );
});
