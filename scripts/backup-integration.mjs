import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 两个临时资料目录模拟两台电脑；备份文件写到第三个临时目录，不触碰真实资料。
const source = await mkdtemp(join(tmpdir(), "zhiyu-backup-source-"));
const target = await mkdtemp(join(tmpdir(), "zhiyu-backup-target-"));
const outside = await mkdtemp(join(tmpdir(), "zhiyu-backup-files-"));
const backupFile = join(outside, "integration.zhiyu-backup");
const PASSWORD = "integration-backup-2026";
const DOC_TITLE = "备份回归文档";
const errors = [];

async function launch(directory) {
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  const instance = await electron.launch({
    args: [resolve("electron/main.mjs")],
    env,
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  return { instance, page };
}

async function openDataTab(page) {
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "数据", exact: true }).click();
  return settings;
}

let current;
try {
  // —— 第一台：准备资料并通过界面创建含系统凭据的加密备份 ——
  current = await launch(source);
  let { instance, page } = current;
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(async (title) => {
    const now = new Date().toISOString();
    await window.sinan.documents.save({
      id: "doc-backup-integration",
      title,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "备份正文" }] }],
      },
      bindings: [],
      createdAt: now,
      updatedAt: now,
    });
    await window.sinan.vault.set("backup-integration:record", { password: "vault-secret-1" });
    await window.sinan.agent.saveConfig({
      baseUrl: "https://api.example.test/v1",
      model: "integration-model",
      apiKey: "sk-integration-backup-key",
    });
  }, DOC_TITLE);
  const sourceVault = await page.evaluate(() => window.sinan.vault.list());

  await instance.evaluate(
    ({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    },
    join(source, "inside.zhiyu-backup"),
  );
  let settings = await openDataTab(page);
  await settings.getByRole("button", { name: "创建加密备份…", exact: true }).click();
  await settings.getByRole("textbox", { name: "备份密码", exact: true }).fill(PASSWORD);
  await settings.getByRole("textbox", { name: "再输一次", exact: true }).fill(PASSWORD);
  await settings.getByRole("checkbox", { name: /同时包含系统保护的凭据/ }).check();
  await settings.getByRole("button", { name: "选择保存位置并备份", exact: true }).click();
  await settings.getByText("请把备份保存到资料目录之外", { exact: false }).waitFor();

  await instance.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, backupFile);
  await settings.getByRole("button", { name: "选择保存位置并备份", exact: true }).click();
  await page.getByText(/已创建加密备份 integration\.zhiyu-backup/).waitFor();
  const bytes = await readFile(backupFile);
  assert.equal(bytes.subarray(0, 8).toString("ascii"), "ZHIYUBAK");
  for (const plain of [DOC_TITLE, "sk-integration-backup-key", "vault-secret-1"])
    assert.equal(bytes.includes(Buffer.from(plain)), false, plain);
  await page.screenshot({ path: "screenshots/backup-create.png" });
  await instance.close();

  // —— 第二台：已有自己的资料，通过界面预览并恢复 ——
  current = await launch(target);
  ({ instance, page } = current);
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await instance.evaluate(({ app, dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    // 记录重启请求而不真正重启：新进程不受测试控制。关闭实例前要还原 quit。
    globalThis.restartCalls = [];
    globalThis.originalQuit = app.quit.bind(app);
    app.relaunch = () => globalThis.restartCalls.push("relaunch");
    app.quit = () => globalThis.restartCalls.push("quit");
  }, backupFile);
  settings = await openDataTab(page);
  await settings.getByRole("button", { name: "选择备份文件…", exact: true }).click();
  await settings.getByText("integration.zhiyu-backup").waitFor();
  const restorePassword = settings.getByRole("textbox", { name: "备份密码", exact: true });
  await restorePassword.fill("integration-wrong-2026");
  await settings.getByRole("button", { name: "读取备份", exact: true }).click();
  await settings.getByText("备份密码不正确。").waitFor();
  await restorePassword.fill(PASSWORD);
  await settings.getByRole("button", { name: "读取备份", exact: true }).click();
  await settings.getByText("模型 API Key").waitFor();
  const previewText = await settings.locator("dl").last().innerText();
  assert.match(previewText, /文档\s+1 篇/);
  assert.match(previewText, new RegExp(`密钥库凭据\\s+${sourceVault.length} 条`));
  await page.screenshot({ path: "screenshots/backup-restore-preview.png" });
  await settings.getByRole("button", { name: "恢复并重启", exact: true }).click();
  await page.getByText("备份已准备好，知屿即将重启并完成恢复。").waitFor();
  await page.waitForTimeout(1200);
  assert.deepEqual(await instance.evaluate(() => globalThis.restartCalls), ["relaunch", "quit"]);
  await stat(join(target, ".restore-pending", "ready.json"));
  await instance.evaluate(({ app }) => {
    app.quit = globalThis.originalQuit;
  });
  await instance.close();

  // —— 重启：启动早期完成替换，原资料留在快照里 ——
  current = await launch(target);
  ({ instance, page } = current);
  await page.locator('[data-app-ready="true"]').waitFor();
  const restored = await page.evaluate(async () => ({
    info: await window.sinan.backup.info(),
    documents: (await window.sinan.documents.list()).map((doc) => doc.title),
    vault: await window.sinan.vault.list(),
    agent: await window.sinan.agent.config(),
  }));
  assert.equal(restored.info.lastRestore.status, "applied");
  assert.ok(restored.documents.includes(DOC_TITLE));
  assert.deepEqual([...restored.vault].sort(), [...sourceVault].sort());
  assert.equal(restored.agent.hasApiKey, true);
  assert.equal(restored.agent.apiKeyReadable, true);
  const snapshots = await readdir(join(target, "restore-snapshots"));
  assert.equal(snapshots.length, 1);
  await stat(join(target, "restore-snapshots", snapshots[0], "vault.enc"));

  // —— 自动备份：选择文件夹、保存密码、立即备份 ——
  const autoDirectory = await mkdtemp(join(tmpdir(), "zhiyu-backup-auto-"));
  await instance.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, autoDirectory);
  settings = await openDataTab(page);
  await settings.getByText(/上次启动已从备份恢复/).waitFor();
  const autoToggle = settings.getByRole("checkbox", { name: "启用自动备份" });
  // 尚未选择文件夹时启用会失败，勾选状态必须还原。
  await autoToggle.click();
  await settings.getByText("请先选择备份文件夹。").waitFor();
  assert.equal(await autoToggle.isChecked(), false);
  await settings.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await settings.getByText(autoDirectory).waitFor();
  await settings.getByRole("textbox", { name: "自动备份密码", exact: true }).fill(PASSWORD);
  await settings.getByRole("button", { name: "保存密码", exact: true }).click();
  await settings.getByText("自动备份密码已由系统加密保存在本机。").waitFor();
  await autoToggle.check();
  await page.waitForFunction(async () => (await window.sinan.backup.autoStatus()).enabled);
  await settings.getByRole("button", { name: "立即备份", exact: true }).click();
  await page.getByText("已完成一次自动备份").waitFor();
  const autoFiles = await readdir(autoDirectory);
  assert.equal(autoFiles.length, 1);
  assert.match(autoFiles[0], /^zhiyu-auto-\d{8}-\d{6}\.zhiyu-backup$/);
  await settings.getByText(/上次：/).waitFor();
  await page.screenshot({ path: "screenshots/backup-auto.png" });
  await instance.close();
  await rm(autoDirectory, { recursive: true, force: true });
  current = null;

  assert.deepEqual(errors, []);
  console.log(
    "backup integration: create, wrong password, preview, restore and auto backup passed",
  );
} finally {
  await current?.instance.close().catch(() => {});
  for (const directory of [source, target, outside])
    await rm(directory, { recursive: true, force: true }).catch(() => {});
}
