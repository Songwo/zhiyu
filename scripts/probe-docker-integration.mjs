import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 独立执行的 Docker 验收；只创建合成数据，不读取现有连接或操作用户容器。
const docker =
  process.env.ZHIYU_DOCKER_BINARY ??
  (process.platform === "win32"
    ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe"
    : "docker");
const binary = resolve(
  process.env.ZHIYU_PROBE_BINARY ??
    `release/qa-probe/zhiyu-probe${process.platform === "win32" ? ".exe" : "-linux-amd64"}`,
);
const image = process.env.ZHIYU_PROBE_DOCKER_IMAGE ?? "zhiyu-probe:qa";
const helperImage = "golang:1.27.2-bookworm";
const runId = `zhiyu-probe-qa-${Date.now()}-${randomBytes(4).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), "zhiyu-probe-docker-"));
const token = randomBytes(32).toString("base64url");
const containers = new Set();
const volumes = new Set();
const children = new Set();
let networkCreated = false;
let verdict;
let failure;
const cleanupErrors = [];

async function command(args) {
  const child = spawn(docker, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const [code] = await once(child, "close");
  assert.equal(code, 0, `docker ${args[0]} failed: ${output}`);
  return output.trim();
}
async function waitFor(fn, label, timeout = 45000) {
  const until = Date.now() + timeout;
  let last;
  do {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(350);
  } while (Date.now() < until);
  throw new Error(`${label} timed out`, { cause: last });
}
async function stopAgent(child) {
  if (!children.has(child)) return;
  children.delete(child);
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill();
  await ended;
}
async function agent(config, name) {
  const configPath = join(directory, `${name}.json`);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(binary, ["agent", "--config", configPath], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (data) => (logs += data));
  child.on("error", () => {});
  children.add(child);
  return { child, logs: () => logs };
}

try {
  await command(["info", "--format", "{{.OSType}}"]);
  if (process.env.ZHIYU_PROBE_SKIP_DOCKER_BUILD !== "1") {
    console.log("Building probe Dockerfile...");
    await command(["build", "-t", image, "services/probe"]);
  }
  await command(["network", "create", runId]);
  networkCreated = true;
  for (const suffix of ["private", "data", "target-data"]) {
    const name = `${runId}-${suffix}`;
    await command(["volume", "create", name]);
    volumes.add(name);
  }
  await writeFile(join(directory, "admin-token"), token, { mode: 0o600 });
  // Windows bind mount 不具备 POSIX 权限，因此在隔离卷内准备 0600、UID 10001 的凭据。
  const initializer = `${runId}-init`;
  containers.add(initializer);
  await command([
    "run",
    "--name",
    initializer,
    "--network",
    "none",
    "--read-only",
    "--mount",
    `type=volume,source=${runId}-private,target=/private`,
    "--mount",
    `type=bind,source=${directory},target=/input,readonly`,
    helperImage,
    "sh",
    "-eu",
    "-c",
    `umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Zhiyu-Docker-QA-CA -keyout /private/ca.key -out /private/ca.crt
openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout /private/tls.key -out /private/server.csr
printf '%s\\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' > /private/server.ext
openssl x509 -req -in /private/server.csr -CA /private/ca.crt -CAkey /private/ca.key -CAcreateserial -days 1 -extfile /private/server.ext -out /private/tls.crt
cp /input/admin-token /private/admin-token
chmod 700 /private
chmod 600 /private/*
chown -R 10001:10001 /private`,
  ]);
  const caPath = join(directory, "ca.crt");
  await command(["cp", `${initializer}:/private/ca.crt`, caPath]);
  await command(["rm", initializer]);
  containers.delete(initializer);
  const ca = await readFile(caPath);

  const restrictions = [
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1.0",
    "--network",
    runId,
    "--mount",
    `type=volume,source=${runId}-private,target=/run/zhiyu,readonly`,
  ];
  const server = `${runId}-server`;
  const target = `${runId}-target`;
  const portReservation = createServer();
  portReservation.listen(0, "127.0.0.1");
  await once(portReservation, "listening");
  const port = portReservation.address().port;
  await new Promise((done) => portReservation.close(done));
  containers.add(server);
  await command([
    "run",
    "-d",
    "--name",
    server,
    ...restrictions,
    "-p",
    `127.0.0.1:${port}:8008`,
    "--mount",
    `type=volume,source=${runId}-data,target=/data`,
    image,
  ]);
  containers.add(target);
  await command([
    "run",
    "-d",
    "--name",
    target,
    ...restrictions,
    "--mount",
    `type=volume,source=${runId}-target-data,target=/data`,
    image,
    "server",
    "--listen",
    "0.0.0.0:8008",
    "--data",
    "/data/probe.db",
    "--admin-token-file",
    "/run/zhiyu/admin-token",
    "--insecure",
  ]);
  const [inspection] = JSON.parse(await command(["inspect", server]));
  assert.equal(inspection.State.Running, true, await command(["logs", server]));
  assert.equal(inspection.Config.User, "10001:10001");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.ok(inspection.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(inspection.NetworkSettings.Ports["8008/tcp"][0].HostPort, String(port));
  const endpoint = `https://127.0.0.1:${port}`;
  function api(path, { method = "GET", body, credential = token, ...tls } = {}) {
    return new Promise((resolveResult, reject) => {
      const req = request(
        endpoint + path,
        {
          ca,
          method,
          timeout: 5000,
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          ...tls,
        },
        (response) => {
          let raw = "";
          response.on("data", (data) => (raw += data));
          response.on("end", () => {
            try {
              resolveResult({ status: response.statusCode, data: raw ? JSON.parse(raw) : null });
            } catch (error) {
              reject(error);
            }
          });
          response.on("error", reject);
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("request timeout")));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const health = () => api("/healthz").then((r) => r.status === 200);
  await waitFor(health, "TLS server health");
  assert.equal((await api("/api/v1/hosts", { credential: "incorrect-credential" })).status, 401);
  await assert.rejects(api("/healthz", { ca: undefined }), (error) =>
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"].includes(error.code),
  );
  await assert.rejects(api("/healthz", { servername: "wrong.example.test" }), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
  });
  const enrolledResponse = await api("/api/v1/hosts", {
    method: "POST",
    body: { name: "Docker TLS 验收主机" },
  });
  assert.equal(enrolledResponse.status, 201);
  const enrolled = enrolledResponse.data;
  const agentConfig = { endpoint, ...enrolled, intervalSeconds: 1, caFile: caPath };
  const incorrect = await agent(
    { ...agentConfig, secret: randomBytes(32).toString("base64url") },
    "incorrect-agent",
  );
  await waitFor(
    () => incorrect.logs().includes("disconnected; retrying"),
    "agent credential rejection",
  );
  assert.equal((await api("/api/v1/hosts")).data[0].lastSeen, null);
  await stopAgent(incorrect.child);
  const nativeAgent = await agent(agentConfig, "native-agent");
  const online = await waitFor(
    async () => {
      const hosts = (await api("/api/v1/hosts")).data;
      return hosts.find(
        (host) =>
          host.id === enrolled.id &&
          host.status === "online" &&
          host.latest?.cpu != null &&
          host.latest?.memory != null,
      );
    },
    "native agent TLS metrics",
    60000,
  );
  assert.equal(online.os, process.platform === "win32" ? "windows" : process.platform);
  const originalHistory = (await api(`/api/v1/hosts/${enrolled.id}/history?range=1h`)).data;
  assert.ok(originalHistory.length > 0);
  console.log("TLS verification, non-root container and native agent metrics passed.");

  const checkIds = [];
  for (const type of ["http", "tcp"]) {
    const result = await api("/api/v1/checks", {
      method: "POST",
      body: {
        name: `${type.toUpperCase()} Docker 验收`,
        type,
        target: type === "http" ? `http://${target}:8008/healthz` : `${target}:8008`,
        intervalSeconds: 10,
        timeoutMs: 1000,
      },
    });
    assert.equal(result.status, 200);
    checkIds.push(result.data.id);
  }
  const checksHave = (status) =>
    api("/api/v1/checks").then(
      ({ data }) => data.length === 2 && data.every((check) => check.status === status),
    );
  await waitFor(() => checksHave("up"), "HTTP/TCP healthy checks");
  for (const id of checkIds) {
    const history = (await api(`/api/v1/checks/${id}/history?range=24h`)).data;
    assert.ok(history.length > 0);
    assert.equal(history.at(-1).status, "up");
  }
  await command(["stop", "--time", "5", target]);
  await waitFor(() => checksHave("down"), "HTTP/TCP outage detection");
  for (const id of checkIds) {
    const history = (await api(`/api/v1/checks/${id}/history?range=24h`)).data;
    assert.equal(history.at(-1).status, "down");
  }
  await command(["start", target]);
  await waitFor(() => checksHave("up"), "HTTP/TCP recovery");
  await stopAgent(nativeAgent.child);
  const persistedHistory = (await api(`/api/v1/hosts/${enrolled.id}/history?range=1h`)).data;
  const persistedChecks = await Promise.all(
    checkIds.map((id) => api(`/api/v1/checks/${id}/history?range=1h`).then((r) => r.data)),
  );
  await command(["restart", "--time", "5", server]);
  const [restarted] = JSON.parse(await command(["inspect", server]));
  assert.equal(restarted.State.Running, true, await command(["logs", server]));
  assert.equal(restarted.NetworkSettings.Ports["8008/tcp"][0].HostPort, String(port));
  await waitFor(health, "container restart");
  assert.deepEqual(
    (await api(`/api/v1/hosts/${enrolled.id}/history?range=1h`)).data,
    persistedHistory,
  );
  for (let index = 0; index < checkIds.length; index++) {
    const history = (await api(`/api/v1/checks/${checkIds[index]}/history?range=1h`)).data;
    assert.ok(history.length >= persistedChecks[index].length);
    assert.equal(history.at(-1).status, "up");
  }
  const reconnectedAgent = await agent(agentConfig, "reconnected-agent");
  await waitFor(async () => {
    const host = (await api("/api/v1/hosts")).data.find((v) => v.id === enrolled.id);
    return host?.status === "online" && host.lastSeen > persistedHistory.at(-1).at;
  }, "agent reconnect after server restart");
  const beforeReconnect = (await api("/api/v1/hosts")).data[0].lastSeen;
  // 保留同一个 Agent 进程，再次重启服务端以验证自动重连。
  await command(["restart", "--time", "5", server]);
  await waitFor(health, "second container restart");
  await waitFor(async () => {
    const host = (await api("/api/v1/hosts")).data.find((v) => v.id === enrolled.id);
    const connections = reconnectedAgent.logs().match(/agent: connected/g) ?? [];
    return host?.status === "online" && host.lastSeen > beforeReconnect && connections.length >= 2;
  }, "native agent automatic reconnect");
  const disconnectsBeforeRevoke = (reconnectedAgent.logs().match(/disconnected; retrying/g) ?? [])
    .length;
  assert.equal((await api(`/api/v1/hosts/${enrolled.id}`, { method: "DELETE" })).status, 204);
  await waitFor(
    () =>
      (reconnectedAgent.logs().match(/disconnected; retrying/g) ?? []).length >
      disconnectsBeforeRevoke,
    "live agent credential revocation",
  );
  assert.deepEqual((await api("/api/v1/hosts")).data, []);
  assert.deepEqual((await api(`/api/v1/hosts/${enrolled.id}/history?range=1h`)).data, []);
  await stopAgent(reconnectedAgent.child);
  const logs = await command(["logs", server]);
  for (const secret of [token, enrolled.secret]) assert.equal(logs.includes(secret), false);
  verdict = {
    ok: true,
    dockerImage: image,
    nonRoot: true,
    readOnlyRoot: true,
    capabilitiesDropped: true,
    tlsCertificateVerified: true,
    wrongCaRejected: true,
    wrongHostnameRejected: true,
    nativeAgentGrpc: true,
    wrongCredentialsRejected: true,
    httpTcpChecks: true,
    outageAndRecovery: true,
    historyPersistsAfterRestart: true,
    agentAutomaticallyReconnects: true,
    agentRevoked: true,
  };
} catch (error) {
  failure = error;
} finally {
  async function cleanup(action, missing) {
    try {
      await action();
    } catch (error) {
      if (!missing?.test(error.message)) cleanupErrors.push(error);
    }
  }
  // 一项失败仍继续删除其他资源，尤其是本机临时凭据；只忽略资源已不存在。
  for (const child of children) await cleanup(() => stopAgent(child));
  for (const name of containers)
    await cleanup(() => command(["rm", "-f", name]), /No such container/i);
  for (const name of volumes)
    await cleanup(() => command(["volume", "rm", name]), /no such volume/i);
  if (networkCreated)
    await cleanup(() => command(["network", "rm", runId]), /network .* not found/i);
  // directory 由 mkdtemp 返回，确认在临时目录内后才递归清理。
  await cleanup(async () => {
    assert.equal(
      resolve(directory).startsWith(
        resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
      ),
      true,
    );
    await rm(directory, { recursive: true, force: true });
  });
  if (!cleanupErrors.length)
    console.log("Removed this run's containers, network, volumes and temporary credentials.");
}
if (cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors],
    "Some test resources could not be removed; inspect the collected cleanup errors",
  );
if (failure) throw failure;
console.log(JSON.stringify({ ...verdict, testResourcesRemoved: true }));
