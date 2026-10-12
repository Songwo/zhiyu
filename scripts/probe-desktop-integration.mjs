import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 本测试只使用隔离数据与临时生成的凭据；不读取用户连接、主机或文档。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-probe-e2e-"));
const binary = resolve(process.env.ZHIYU_PROBE_BINARY ?? "release/qa-probe/zhiyu-probe.exe");
const token = randomBytes(32).toString("base64url");
const tokenFile = join(directory, "admin-token");
await writeFile(tokenFile, token, { mode: 0o600 });
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const endpoint = `http://127.0.0.1:${port}`;
const processes = new Set();
function start(args) {
  const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  child.on("error", () => {});
  child.stderr.on("data", () => {});
  processes.add(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exit = once(child, "exit");
  child.kill();
  await exit;
  processes.delete(child);
}
async function waitFor(fn, timeout = 45000) {
  const until = Date.now() + timeout;
  let last;
  do {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(300);
  } while (Date.now() < until);
  throw last ?? new Error("等待探针状态超时");
}
const startServer = () =>
  start([
    "server",
    "--listen",
    `127.0.0.1:${port}`,
    "--data",
    join(directory, "probe.db"),
    "--admin-token-file",
    tokenFile,
    "--insecure",
  ]);
let server, agent, instance;
try {
  server = startServer();
  await waitFor(async () => (await fetch(endpoint + "/healthz")).ok);
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: join(directory, "desktop") };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  await mkdir(env.NANPAD_TEST_DATA_DIR, { recursive: true });
  await writeFile(
    join(env.NANPAD_TEST_DATA_DIR, "local-usage.json"),
    JSON.stringify({ version: 1, enabled: false, events: [], checkpoints: [], records: [] }),
  );
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  assert.equal(
    await instance.evaluate(({ app }) => app.getPath("userData")),
    env.NANPAD_TEST_DATA_DIR,
  );
  const page = await instance.firstWindow();
  page.setDefaultTimeout(15000);
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  const connection = await page.evaluate(async (input) => window.sinan.integrations.save(input), {
    provider: "probe",
    name: "本机真实探针验收",
    endpoint,
    allowInsecure: true,
    token,
  });
  assert.equal(JSON.stringify(connection).includes(token), false);
  const enrolled = await page.evaluate(
    (id) => window.sinan.integrations.probeEnroll(id, "合成验收主机"),
    connection.id,
  );
  await page.evaluate(
    ({ id, target }) =>
      window.sinan.integrations.probeSaveCheck(id, {
        name: "本机健康检查",
        type: "http",
        target,
        intervalSeconds: 10,
        timeoutMs: 1000,
      }),
    { id: connection.id, target: endpoint + "/healthz" },
  );
  await writeFile(
    join(directory, "agent.json"),
    JSON.stringify({
      endpoint,
      id: enrolled.id,
      secret: enrolled.secret,
      allowInsecure: true,
      intervalSeconds: 1,
    }),
    { mode: 0o600 },
  );
  agent = start(["agent", "--config", join(directory, "agent.json")]);
  const observed = await waitFor(async () => {
    const inv = await page.evaluate(
      (id) => window.sinan.integrations.inventory(id, true),
      connection.id,
    );
    return inv.resources.find(
      (r) =>
        r.host?.status === "online" && r.host.latest?.cpu != null && r.host.latest?.memory != null,
    );
  }, 60000);
  assert.equal(observed.host.id, enrolled.id);
  const check = await waitFor(async () => {
    const inv = await page.evaluate(
      (id) => window.sinan.integrations.inventory(id, true),
      connection.id,
    );
    return inv.resources.find((r) => r.check?.status === "up");
  });
  const checkHistory = await page.evaluate(
    ({ id, checkId }) => window.sinan.integrations.probeCheckHistory(id, checkId, "1h"),
    { id: connection.id, checkId: check.remoteId },
  );
  assert.ok(checkHistory.length > 0);
  assert.equal(checkHistory.at(-1).status, "up");
  const samples = await page.evaluate(
    ({ id, host }) => window.sinan.integrations.probeHistory(id, host, "1h"),
    { id: connection.id, host: enrolled.id },
  );
  assert.ok(samples.length >= 1);
  const bound = await page.evaluate((input) => window.sinan.integrations.bind(input), {
    connectionId: connection.id,
    resourceKey: observed.key,
  });
  assert.equal(bound.kind, "server");
  const snapshot = await page.evaluate(() => window.sinan.store.load());
  const state = snapshot.state ?? snapshot;
  const saved = state.servers.find((s) => s.id === bound.id);
  assert.equal(saved.integration.remoteId, enrolled.id);
  assert.equal(saved.sshConfigured, false);
  const serviceAsset = await page.evaluate((input) => window.sinan.integrations.bind(input), {
    connectionId: connection.id,
    resourceKey: check.key,
  });
  await page.getByRole("button", { name: "服务资产", exact: true }).click();
  await page.getByRole("button", { name: "查看服务 本机健康检查", exact: true }).click();
  await page
    .getByRole("dialog", { name: "资产详情", exact: true })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "服务资产", exact: true });
  await editor.getByLabel("服务名称", { exact: true }).fill("我的健康检查");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await waitFor(async () => {
    const savedSnapshot = await page.evaluate(() => window.sinan.store.load());
    const service = (savedSnapshot.state ?? savedSnapshot).services.find(
      (s) => s.id === serviceAsset.id,
    );
    if (service?.name !== "我的健康检查") return false;
    assert.equal(service.integration.remoteId, check.remoteId);
    return true;
  });
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.sinan.vault.lock());
  assert.equal(
    (await page.evaluate((id) => window.sinan.integrations.inventory(id, true), connection.id))
      .resources[0].host.status,
    "online",
  );
  const raw = await readFile(join(env.NANPAD_TEST_DATA_DIR, "integrations.json"), "utf8");
  assert.equal(raw.includes(token), false);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("settings:integrations")));
  await page.getByText("本机真实探针验收", { exact: true }).first().waitFor();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/probe-real-desktop.png" });
  await stop(server);
  server = startServer();
  await waitFor(async () => (await fetch(endpoint + "/healthz")).ok);
  const restored = await page.evaluate(
    ({ id, host }) => window.sinan.integrations.probeHistory(id, host, "24h"),
    { id: connection.id, host: enrolled.id },
  );
  assert.ok(restored.length >= samples.length);
  await page.evaluate(({ id, host }) => window.sinan.integrations.probeRevoke(id, host), {
    id: connection.id,
    host: enrolled.id,
  });
  const after = await page.evaluate(
    (id) => window.sinan.integrations.inventory(id, true),
    connection.id,
  );
  assert.equal(
    after.resources.some((r) => r.remoteId === enrolled.id),
    false,
  );
  await page.evaluate(
    ({ id, checkId }) => window.sinan.integrations.probeDeleteCheck(id, checkId),
    { id: connection.id, checkId: check.remoteId },
  );
  await page.evaluate((id) => window.sinan.integrations.remove(id), connection.id);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      realGrpc: true,
      encryptedOsConfig: true,
      vaultLockedMonitoring: true,
      historyPersists: true,
      agentRevoked: true,
      assetBound: true,
      editPreservesBinding: true,
      serviceCheck: true,
      serviceHistory: true,
      samples: samples.length,
      consoleErrors: errors,
    }),
  );
} catch (error) {
  if (instance) {
    await mkdir("screenshots", { recursive: true });
    await (
      await instance.firstWindow()
    )
      .screenshot({ path: "screenshots/probe-real-failure.png" })
      .catch(() => {});
  }
  throw error;
} finally {
  if (instance) await instance.close();
  if (agent) await stop(agent);
  for (const child of processes) await stop(child);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
