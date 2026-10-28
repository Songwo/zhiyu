import test from "node:test";
import assert from "node:assert/strict";
import {
  SERVICES_SCRIPT,
  addressScope,
  parseContainerPorts,
  parseListeningPorts,
  parseServices,
} from "./service-monitor.mjs";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const ID_C = "c".repeat(64);

const SS = `
tcp   LISTEN 0      4096         0.0.0.0:8080       0.0.0.0:*    users:(("docker-proxy",pid=1234,fd=4))
tcp   LISTEN 0      4096            [::]:8080          [::]:*    users:(("docker-proxy",pid=1240,fd=4))
tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=812,fd=3))
tcp   LISTEN 0      128             [::]:22            [::]:*    users:(("sshd",pid=812,fd=4))
tcp   LISTEN 0      4096     127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=600,fd=14))
udp   UNCONN 0      0           127.0.0.54:53         0.0.0.0:*
tcp   LISTEN 0      511          127.0.0.1:3306       0.0.0.0:*
tcp   LISTEN 0      511       192.168.1.10:9000       0.0.0.0:*    users:(("minio",pid=77,fd=7))
tcp   ESTAB  0      0         192.168.1.10:22     192.168.1.2:50000
udp   UNCONN 0      0                    *:5353             *:*
`
  .trim()
  .split("\n");

test("监听端口：只取 LISTEN 和 UDP，IPv4 / IPv6 合并，识别暴露范围与进程", () => {
  const ports = parseListeningPorts(SS);
  const byKey = Object.fromEntries(ports.map((p) => [`${p.proto}:${p.port}`, p]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    "tcp:22",
    "tcp:3306",
    "tcp:53",
    "tcp:8080",
    "tcp:9000",
    "udp:53",
    "udp:5353",
  ]);
  assert.equal(byKey["tcp:8080"].scope, "public");
  assert.equal(byKey["tcp:8080"].process, "docker-proxy");
  assert.equal(byKey["tcp:22"].process, "sshd");
  assert.equal(byKey["tcp:3306"].scope, "local");
  assert.equal(byKey["tcp:3306"].process, undefined, "没有权限看进程时留空");
  assert.equal(byKey["tcp:53"].scope, "local", "带网卡后缀的回环地址");
  assert.equal(byKey["tcp:9000"].scope, "private");
  assert.equal(byKey["udp:5353"].scope, "public");
  assert.deepEqual(
    ports.map((p) => p.port),
    [...ports.map((p) => p.port)].sort((a, b) => a - b),
    "按端口排序",
  );
});

test("监听端口：netstat 格式也能解析，坏行被丢弃", () => {
  const ports = parseListeningPorts([
    "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd",
    "tcp6       0      0 :::80                   :::*                    LISTEN      901/nginx: master",
    "udp        0      0 0.0.0.0:68              0.0.0.0:*                           455/dhclient",
    "tcp        0      0 10.0.0.1:443            10.0.0.2:5555           ESTABLISHED 1/x",
    "garbage line",
    "tcp LISTEN 0 0 nonsense 0.0.0.0:*",
    "tcp LISTEN 0 0 0.0.0.0:99999 0.0.0.0:*",
  ]);
  assert.deepEqual(
    ports.map((p) => `${p.proto}:${p.port}`),
    ["udp:68", "tcp:80", "tcp:22"].sort(
      (a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]),
    ),
  );
  assert.equal(ports.find((p) => p.port === 22).process, "sshd");
});

test("暴露范围判定", () => {
  assert.equal(addressScope("0.0.0.0"), "public");
  assert.equal(addressScope("[::]"), "public");
  assert.equal(addressScope("*"), "public");
  assert.equal(addressScope("127.0.0.1"), "local");
  assert.equal(addressScope("::1"), "local");
  assert.equal(addressScope("172.17.0.1"), "private");
});

test("容器端口：发布与未发布、IPv4 / IPv6 去重、端口范围", () => {
  assert.deepEqual(parseContainerPorts("0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 443/tcp"), [
    { containerPort: 80, proto: "tcp", hostPort: 8080, hostIp: "0.0.0.0" },
    { containerPort: 443, proto: "tcp" },
  ]);
  assert.deepEqual(parseContainerPorts("127.0.0.1:5432->5432/tcp"), [
    { containerPort: 5432, proto: "tcp", hostPort: 5432, hostIp: "127.0.0.1" },
  ]);
  assert.deepEqual(parseContainerPorts(""), []);
  assert.deepEqual(parseContainerPorts("not a port"), []);
});

const PS = [
  {
    ID: ID_A,
    Names: "web",
    Image: "nginx:1.27",
    State: "running",
    Status: "Up 3 hours (healthy)",
    Ports: "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp",
  },
  {
    ID: ID_B,
    Names: "worker",
    Image: "app/worker:latest",
    State: "restarting",
    Status: "Restarting (1) 5 seconds ago",
    Ports: "",
  },
  {
    ID: ID_C,
    Names: "old-job",
    Image: "busybox",
    State: "exited",
    Status: "Exited (137) 2 days ago",
    Ports: "",
  },
]
  .map((row) => JSON.stringify(row))
  .join("\n");
const INSPECT = [
  `${ID_A}|0|healthy|0|false|2026-10-28T01:00:00.000000000Z`,
  `${ID_B}|14||1|false|2026-10-28T04:00:00.000000000Z`,
  `${ID_C}|0||137|true|2026-10-26T04:00:00.000000000Z`,
].join("\n");
const STATS = [
  { ID: ID_A, Name: "web", CPUPerc: "0.15%", MemPerc: "1.62%", MemUsage: "31.5MiB / 1.9GiB" },
]
  .map((row) => JSON.stringify(row))
  .join("\n");

test("整段输出：端口、容器状态、健康检查、重启次数、资源用量", () => {
  const result = parseServices(
    ["##ss", SS.join("\n"), "##docker", PS, "##inspect", INSPECT, "##stats", STATS, "##end"].join(
      "\n",
    ),
    "2026-10-28T08:00:00.000Z",
  );
  assert.equal(result.collectedAt, "2026-10-28T08:00:00.000Z");
  assert.equal(result.ports.length, 7);
  assert.equal(result.docker.available, true);
  const byName = Object.fromEntries(result.docker.containers.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName), ["old-job", "web", "worker"]);
  assert.equal(byName.web.state, "running");
  assert.equal(byName.web.health, "healthy");
  assert.equal(byName.web.cpu, 0.2, "保留一位小数");
  assert.equal(byName.web.memoryPct, 1.6);
  assert.equal(byName.web.memoryUsage, "31.5MiB");
  assert.deepEqual(byName.web.ports, [
    { containerPort: 80, proto: "tcp", hostPort: 8080, hostIp: "0.0.0.0" },
  ]);
  assert.equal(byName.web.id, "a".repeat(12));
  assert.equal(byName.worker.state, "restarting");
  assert.equal(byName.worker.restartCount, 14);
  assert.equal(byName["old-job"].exitCode, 137);
  assert.equal(byName["old-job"].oomKilled, true);
  assert.equal(byName.worker.cpu, undefined, "没有统计的容器不编造数字");
});

test("没有 Docker、没有权限、服务没运行：端口照常解析，容器列表给出原因而不是报错", () => {
  const base = ["##ss", SS.join("\n"), "##docker"];
  const none = parseServices([...base, "##nodocker", "##end"].join("\n"));
  assert.equal(none.ports.length, 7);
  assert.equal(none.docker.available, false);
  assert.match(none.docker.reason, /没有安装 Docker/);
  const denied = parseServices(
    [
      ...base,
      "##dockererror",
      "permission denied while trying to connect to the Docker daemon socket",
      "##end",
    ].join("\n"),
  );
  assert.match(denied.docker.reason, /权限/);
  const down = parseServices(
    [
      ...base,
      "##dockererror",
      "Cannot connect to the Docker daemon. Is the docker daemon running?",
      "##end",
    ].join("\n"),
  );
  assert.match(down.docker.reason, /没有运行/);
  const other = parseServices([...base, "##dockererror", "boom", "##end"].join("\n"));
  assert.match(other.docker.reason, /失败/);
});

test("远端输出当作不可信数据：控制字符、超长字段、伪造的行与重复容器都不会带进结果", () => {
  const hostile = JSON.stringify({
    ID: ID_A,
    Names: `evil\u0007\u001b[31m${"x".repeat(500)}`,
    Image: "i".repeat(1000),
    State: "RUNNING\u0000",
    Status: "s".repeat(1000),
    Ports: "999999->1/tcp, javascript:alert(1), 80/tcp",
  });
  const result = parseServices(
    [
      "##docker",
      hostile,
      "{not json",
      "[1,2]",
      JSON.stringify({ ID: "zzz", Names: "bad-id" }),
      "##inspect",
      "garbage|||",
      `${"f".repeat(64)}|x|y|z|w|v`,
      "##end",
    ].join("\n"),
  );
  assert.equal(result.docker.containers.length, 1);
  const [container] = result.docker.containers;
  assert.ok(
    container.name.length <= 80 && ![...container.name].some((char) => char.charCodeAt(0) < 32),
  );
  assert.ok(container.image.length <= 120);
  assert.ok(container.status.length <= 80);
  assert.equal(container.state, "running");
  assert.deepEqual(container.ports, [{ containerPort: 80, proto: "tcp" }]);
});

test("数量上限：端口和容器过多时截断，不会撑爆内存或界面", () => {
  const manyPorts = Array.from(
    { length: 800 },
    (_, i) => `tcp LISTEN 0 0 0.0.0.0:${i + 1} 0.0.0.0:*`,
  );
  assert.equal(parseListeningPorts(manyPorts).length, 500);
  const rows = Array.from({ length: 400 }, (_, i) =>
    JSON.stringify({
      ID: (i + 1).toString(16).padStart(64, "0"),
      Names: `c${i}`,
      Image: "x",
      State: "running",
      Status: "Up",
      Ports: "",
    }),
  ).join("\n");
  assert.equal(parseServices(["##docker", rows, "##end"].join("\n")).docker.containers.length, 300);
});

test("脚本只包含只读命令，且不含任何拼接的用户输入", () => {
  for (const forbidden of [
    "rm ",
    "kill",
    "docker rm",
    "docker stop",
    "docker restart",
    "docker exec",
    "docker run",
    "> /",
    "sudo",
    "chmod",
    "systemctl",
  ])
    assert.ok(!SERVICES_SCRIPT.includes(forbidden), forbidden);
  assert.ok(!SERVICES_SCRIPT.includes("${"), "没有模板插值");
  for (const command of ["docker ps", "docker inspect", "docker stats", "ss -H"])
    assert.ok(SERVICES_SCRIPT.includes(command), command);
});

test("系统通知：容器问题与绑定服务不可用各出一条，24 小时内同一问题只提醒一次，恢复后重新计", async () => {
  const { NotificationTracker, attentionLine, notificationCandidates } =
    await import("./notifications.mjs");
  const container = (name, extra) => ({
    id: name,
    name,
    image: "x",
    state: "running",
    status: "Up",
    ports: [],
    ...extra,
  });
  const snapshot = {
    servers: [
      {
        id: "s1",
        name: "东京主机",
        status: "online",
        serviceScan: {
          docker: {
            available: true,
            containers: [
              container("web", { state: "restarting" }),
              container("db", { state: "exited", exitCode: 1 }),
              container("ok"),
              container("job", { state: "exited", exitCode: 0 }),
            ],
          },
        },
      },
      {
        id: "s2",
        name: "暂停采集",
        collect: false,
        status: "online",
        serviceScan: {
          docker: { available: true, containers: [container("x", { state: "restarting" })] },
        },
      },
    ],
    services: [
      { id: "v1", name: "博客", status: "offline", endpoint: { serverId: "s1", port: 2368 } },
      { id: "v2", name: "手动离线", status: "offline" },
      { id: "v3", name: "正常", status: "online", endpoint: { serverId: "s1", port: 80 } },
    ],
  };
  const items = notificationCandidates(snapshot, Date.now());
  assert.deepEqual(items.map((i) => i.key).sort(), [
    "container:s1:db:crashed",
    "container:s1:web:restarting",
    "service-down:v1",
  ]);
  assert.deepEqual(
    items.map((i) => attentionLine(i)).sort(),
    [
      "东京主机: 容器 db 异常退出（退出码 1）",
      "东京主机: 容器 web 在反复重启",
      "博客: 绑定的端口或容器不可用",
    ].sort(),
  );
  assert.match(
    attentionLine(
      items.find((i) => i.key.endsWith("web:restarting")),
      true,
    ),
    /keeps restarting/,
  );
  const tracker = new NotificationTracker();
  assert.equal(tracker.take(items).length, 3);
  assert.equal(tracker.take(items).length, 0, "已提醒过");
  snapshot.servers[0].serviceScan.docker.containers[0].state = "running";
  assert.equal(tracker.take(notificationCandidates(snapshot)).length, 0);
  snapshot.servers[0].serviceScan.docker.containers[0].state = "restarting";
  assert.equal(
    tracker.take(notificationCandidates(snapshot)).length,
    1,
    "恢复后再次出问题会重新提醒",
  );
});
