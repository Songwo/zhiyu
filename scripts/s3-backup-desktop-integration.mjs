import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { s3BackupFixture, S3_TEST_ACCESS, S3_TEST_SECRET } from "./s3-backup-fixture.mjs";
import { openBackup } from "../electron/services/backup.mjs";

const root = await mkdtemp(join(tmpdir(), "zhiyu-desktop-s3-")),
  storage = await s3BackupFixture();
const env = { ...process.env, NANPAD_TEST_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
delete env.NODE_PATH;
const executablePath = resolve(process.argv[2] ?? "release/v1.17.7/win-unpacked/Zhiyu.exe");
let instance;
const errors = [],
  password = "synthetic-desktop-backup-password";
try {
  instance = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${root}`],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await instance.evaluate(({ net }) => {
    const original = net.fetch.bind(net);
    net.fetch = async (...args) => {
      try {
        return await original(...args);
      } catch (e) {
        globalThis.__s3FetchFailure = { name: e.name, message: e.message };
        throw e;
      }
    };
  });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  const result = await page.evaluate(
    async ({ endpoint, accessKeyId, secretAccessKey, password }) => {
      const api = window.sinan.backup;
      await api.s3Configure({
        provider: "minio",
        endpoint,
        accessKeyId,
        secretAccessKey,
        bucket: "desktop-backups",
        region: "us-east-1",
        prefix: "zhiyu-backups",
        pathStyle: true,
        allowInsecure: true,
      });
      const tested = await api.s3Test();
      await api.s3Configure({ enabled: true });
      await api.autoConfigure({ password, enabled: true });
      const run = await api.autoRun();
      return { tested, run, remote: await api.s3Status() };
    },
    {
      endpoint: storage.endpoint,
      accessKeyId: S3_TEST_ACCESS,
      secretAccessKey: S3_TEST_SECRET,
      password,
    },
  );
  assert.equal(result.tested.bound, true);
  assert.equal(result.run.history[0].remote, "uploaded");
  assert.equal(result.remote.history[0].state, "uploaded");
  const bytes = [...storage.objects.values()][0],
    opened = await openBackup(bytes, password);
  for (const name of opened.files.keys())
    assert.equal(
      /(^|\/)(backup-s3\.json|backup-schedule\.json|auto-backups)(\/|$)/.test(name),
      false,
      name,
    );
  assert.equal(JSON.stringify(result).includes(S3_TEST_SECRET), false);
  assert.equal(
    (await readFile(join(root, "backup-s3.json"), "utf8")).includes(S3_TEST_SECRET),
    false,
  );
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "数据", exact: true }).click();
  await settings.getByText("连接读写与清理测试已通过", { exact: true }).waitFor();
  await settings.getByRole("region", { name: "S3 云端备份", exact: true }).scrollIntoViewIfNeeded();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/s3-backup-desktop-package.png" });
  storage.behavior.putStatus = 503;
  const failure = await page.evaluate(async () => {
    try {
      await window.sinan.backup.autoRun();
      return "unexpected success";
    } catch (e) {
      return e.message;
    }
  });
  assert.match(failure, /本地备份已保存.*云端/);
  assert.equal(
    (await page.evaluate(() => window.sinan.backup.autoStatus())).history[0].remote,
    "failed",
  );
  await page.evaluate(() => window.sinan.backup.s3Disconnect());
  assert.ok(storage.objects.size > 0);
  assert.deepEqual(storage.errors, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        packagedApp: true,
        realIpc: true,
        runtimeDependencyPresent: true,
        encryptedBackupRestorable: true,
        machineCredentialsExcluded: true,
        partialFailureRecorded: true,
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      storageErrors: storage.errors,
      requests: storage.requests.map((r) => ({ method: r.method, key: r.key })),
      runtime: await instance?.evaluate(() => ({
        webCrypto: typeof globalThis.crypto,
        fetchFailure: globalThis.__s3FetchFailure,
      })),
    }),
  );
  const page = instance?.windows()[0];
  if (page && !page.isClosed()) {
    console.error((await page.locator("body").innerText()).slice(-4500));
    await page.screenshot({ path: "screenshots/s3-backup-desktop-failure.png" }).catch(() => {});
  }
  throw error;
} finally {
  await instance?.close();
  await storage.close();
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
