import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 正式实例始终关闭默认采集；另用安装包内真实模块读取隔离合成文件。
// 本脚本验证打包、迁移和 IPC/图表，生产定时器由 local-usage-integration 验证。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-packaged-local-usage-"));
const collector = join(directory, "synthetic-collector");
const logs = join(collector, "logs");
const cache = join(collector, "usage.json");
const logfile = join(logs, "synthetic.jsonl");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const line = (value) => JSON.stringify(value) + "\n";
const usage = (input, output, timestamp) =>
  line({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0 },
      },
    },
  });
const localDay = (time) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
};
let instance;
const errors = [];
try {
  await mkdir(logs, { recursive: true });
  await writeFile(
    join(directory, "local-usage.json"),
    JSON.stringify({
      version: 1,
      enabled: false,
      events: [],
      checkpoints: [],
      records: [],
    }),
  );
  const firstTime = "2026-10-08T08:00:00.000Z";
  const body =
    line({ type: "session_meta", payload: { id: "packaged-session" } }) +
    line({ type: "turn_context", payload: { model: "gpt-packaged" } }) +
    usage(100, 10, firstTime) +
    usage(200, 20, "2026-10-08T12:00:00.000Z") +
    usage(300, 30, "2026-10-09T12:00:00.000Z");
  await writeFile(logfile, body);
  const fileStat = await stat(logfile);
  const session = hash("codex:packaged-session");
  const first = { input: 100, output: 10, cached: 0, cacheWrite: 0 };
  const events = [[hash(JSON.stringify(["codex", session, 0, first])), true]];
  for (let index = 1; index < 100_000; index++) events.push([hash(`synthetic-old-${index}`), true]);
  const bucketStart = localDay(firstTime);
  await writeFile(
    cache,
    JSON.stringify({
      version: 1,
      enabled: true,
      lastScannedAt: "2026-10-09T12:01:00.000Z",
      events,
      checkpoints: [
        [
          hash(`codex:${logfile}`),
          {
            offset: Buffer.byteLength(body),
            session,
            identity: hash(`${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeMs}`),
            epoch: 0,
            model: "gpt-packaged",
            skipping: false,
            total: { input: 300, output: 30, cached: 0, cacheWrite: 0 },
          },
        ],
      ],
      records: [
        [
          hash(JSON.stringify(["codex", session, "gpt-packaged", bucketStart])),
          {
            client: "codex",
            session,
            model: "gpt-packaged",
            bucketStart,
            sampleAt: firstTime,
            ...first,
          },
        ],
      ],
    }),
  );
  const env = { ...process.env };
  delete env.NANPAD_TEST_DATA_DIR;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  instance = await electron.launch({
    executablePath: resolve(process.argv[2] ?? "release/v1.7.0/win-unpacked/Zhiyu.exe"),
    args: [`--user-data-dir=${directory}`],
    env,
    locale: "zh-CN",
    timeout: 45_000,
  });
  const runtime = await instance.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const database = new DatabaseSync(":memory:");
    const version = database.prepare("SELECT sqlite_version() AS version").get().version;
    database.close();
    return {
      packaged: app.isPackaged,
      path: app.getPath("userData"),
      sqlite: version,
      version: app.getVersion(),
    };
  });
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.path, directory);
  assert.equal(runtime.version, JSON.parse(await readFile("package.json", "utf8")).version);
  const page = await instance.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-09T12:02:00Z") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal((await page.evaluate(() => window.sinan.usage.localStatus())).enabled, false);
  await completeOnboarding(page);
  const initialized = await instance.evaluate(
    async ({ app, ipcMain }, options) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(app.getAppPath() + "/package.json");
      const { LocalUsageMonitor } = require(
        app.getAppPath() + "/electron/services/local-usage.mjs",
      );
      const monitor = new LocalUsageMonitor({
        file: options.cache,
        roots: { codex: [options.logs] },
      });
      await monitor.refresh();
      globalThis.__isolatedPackagedUsage = monitor;
      ipcMain.removeHandler("usage:list");
      ipcMain.handle("usage:list", async () => ({ ok: true, data: await monitor.list() }));
      ipcMain.removeHandler("usage:local-status");
      ipcMain.handle("usage:local-status", async () => ({
        ok: true,
        data: { ...(await monitor.status()), paused: false },
      }));
      return { status: await monitor.status(), usage: await monitor.list() };
    },
    { cache, logs },
  );
  assert.equal(initialized.status.error, undefined);
  assert.equal(
    initialized.usage.records.reduce((sum, row) => sum + row.input, 0),
    300,
  );
  assert.ok(initialized.usage.records.some((row) => row.sampleAt.startsWith("2026-10-09")));
  await navigateDesktop(page, "用量记录");
  await page.locator(".usage-chart-today").getByText("100 Token", { exact: true }).waitFor();
  await appendFile(logfile, usage(350, 40, "2026-10-09T12:01:00.000Z"));
  const updated = await instance.evaluate(async ({ BrowserWindow }) => {
    const monitor = globalThis.__isolatedPackagedUsage;
    const before = monitor.recordsRevision;
    const status = await monitor.refresh();
    BrowserWindow.getAllWindows()[0].webContents.send("usage:changed", {
      recordsChanged: monitor.recordsRevision !== before,
      localStatus: { ...status, paused: false },
    });
    await monitor.refresh();
    return { status, usage: await monitor.list() };
  });
  assert.equal(updated.status.error, undefined);
  assert.equal(
    updated.usage.records.reduce((sum, row) => sum + row.input, 0),
    350,
  );
  await page.locator(".usage-chart-today").getByText("150 Token", { exact: true }).waitFor();
  const reloaded = await instance.evaluate(
    async ({ app }, options) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(app.getAppPath() + "/package.json");
      const { LocalUsageMonitor } = require(
        app.getAppPath() + "/electron/services/local-usage.mjs",
      );
      const monitor = new LocalUsageMonitor({
        file: options.cache,
        roots: { codex: [options.logs] },
      });
      await monitor.refresh();
      const result = { status: await monitor.status(), usage: await monitor.list() };
      await monitor.configure({ enabled: false });
      return result;
    },
    { cache, logs },
  );
  assert.equal(reloaded.status.error, undefined);
  assert.equal(
    reloaded.usage.records.reduce((sum, row) => sum + row.input, 0),
    350,
  );
  const pointer = JSON.parse(await readFile(cache, "utf8"));
  assert.equal(pointer.version, 2);
  const persisted = await instance.evaluate(
    (_electron, path) => {
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const state = JSON.parse(
          database.prepare("SELECT value FROM state WHERE id=1").get().value,
        );
        return {
          state,
          events: database.prepare("SELECT count(*) AS count FROM events").get().count,
        };
      } finally {
        database.close();
      }
    },
    join(collector, pointer.index),
  );
  assert.equal(persisted.events, 100_003);
  assert.equal(
    persisted.state.records.reduce((sum, [, row]) => sum + row.input, 0),
    350,
  );
  assert.equal(persisted.state.checkpoints[0][1].offset, (await stat(logfile)).size);
  assert.equal(
    JSON.parse(await readFile(join(collector, pointer.backup), "utf8")).events.length,
    100_000,
  );
  const main = JSON.parse(await readFile(join(directory, "local-usage.json"), "utf8"));
  assert.equal(main.enabled, false);
  assert.equal(main.records.length, 0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await mkdir("release/screenshots", { recursive: true });
  await page.screenshot({ path: "release/screenshots/local-usage-packaged.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      runtime,
      legacy100kMigration: true,
      droppedDaysRecovered: true,
      committedEvents: persisted.events,
      replayDeduplicated: true,
      packagedModuleIpcChart: true,
      realRootsUntouched: true,
      productionTimerTestedHere: false,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  const child = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
