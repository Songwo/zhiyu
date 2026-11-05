import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { s3BackupFixture, S3_TEST_ACCESS, S3_TEST_SECRET } from "./s3-backup-fixture.mjs";
import { openBackup } from "../electron/services/backup.mjs";

const root = await mkdtemp(join(tmpdir(), "zhiyu-desktop-s3-")),
  storage = await s3BackupFixture();
const env = { ...process.env, NANPAD_TEST_DATA_DIR: root, NANPAD_DISABLE_GPU: "1" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
delete env.NODE_PATH;
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const executablePath = resolve(process.argv[2] ?? `release/v${version}/win-unpacked/Zhiyu.exe`);
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
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "数据", exact: true }).click();
  const s3 = settings.getByRole("region", { name: "S3 云端备份", exact: true });
  await s3.getByRole("combobox", { name: "存储类型", exact: true }).click();
  await page.getByRole("option", { name: "MinIO", exact: true }).click();
  await s3.getByLabel("Endpoint", { exact: true }).fill(storage.endpoint);
  await s3.getByLabel("Bucket", { exact: true }).fill("desktop-backups");
  await s3.getByLabel("Access Key ID", { exact: true }).fill(S3_TEST_ACCESS);
  await s3.getByLabel("Secret Access Key", { exact: true }).fill(S3_TEST_SECRET);
  await s3.locator("summary").first().click();
  await s3.getByRole("checkbox", { name: /允许可信内网 HTTP/ }).check();
  await s3.getByRole("button", { name: "测试并绑定", exact: true }).click();
  await page.waitForFunction(() => {
    const region = document.querySelector('[aria-label="S3 云端备份"]');
    return region?.querySelector('[role="alert"]') || region?.textContent.includes("S3 已绑定");
  });
  assert.deepEqual(
    await s3.getByRole("alert").allTextContents(),
    [],
    "桌面设置不能把 Web 专用同意字段作为 S3 连接参数",
  );
  await s3.getByText("S3 已绑定，后续自动备份会上传加密文件。", { exact: true }).waitFor();
  assert.equal(await s3.getByLabel("Secret Access Key", { exact: true }).inputValue(), "");
  const toggle = s3.getByRole("checkbox", { name: "自动备份同时上传 S3", exact: true });
  await toggle.uncheck();
  await page.waitForFunction(async () => !(await window.sinan.backup.s3Status()).enabled);
  await toggle.check();
  await page.waitForFunction(async () => (await window.sinan.backup.s3Status()).enabled);
  const result = await page.evaluate(async (password) => {
    const api = window.sinan.backup,
      tested = await api.s3Status();
    await api.autoConfigure({ password, enabled: true });
    const run = await api.autoRun();
    return { tested, run, remote: await api.s3Status() };
  }, password);
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
  await settings.getByText("连接读写与清理测试已通过", { exact: true }).waitFor();
  await settings.getByRole("region", { name: "S3 云端备份", exact: true }).scrollIntoViewIfNeeded();
  await mkdir("screenshots", { recursive: true });
  // Windows 的遮挡窗口可能不响应 CDP 截图；原生接口保持捕获期间唤醒。
  const screenshot = await instance.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    return image.toPNG().toString("base64");
  });
  assert.ok(screenshot.length > 1000);
  await writeFile("screenshots/s3-backup-desktop-package.png", Buffer.from(screenshot, "base64"));
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
        desktopUiBindingAndToggle: true,
        softwareRendering: true,
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
    await page
      .screenshot({ path: "screenshots/s3-backup-desktop-failure.png", timeout: 5000 })
      .catch(() => {});
  }
  throw error;
} finally {
  await instance?.close();
  await storage.close();
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
