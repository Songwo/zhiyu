import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DesktopUpdater, verifyInstaller } from "./app-updater.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhiyu-updater-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, "Nanpad-9.0.0-setup.exe");
  const content = Buffer.from("synthetic installer bytes, never executed");
  await writeFile(file, content);
  const expected = {
    url: "Nanpad-9.0.0-setup.exe",
    size: content.length,
    sha512: createHash("sha512").update(content).digest("base64"),
  };
  const engine = new EventEmitter();
  engine.checkForUpdates = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "9.0.0", files: [expected] },
  });
  engine.downloadUpdate = async () => [file];
  let installs = 0;
  engine.quitAndInstall = (silent, restart) => {
    assert.ok(silent && restart);
    installs++;
  };
  const updater = new DesktopUpdater({ engine, current: "1.4.0", supported: true });
  return { updater, engine, file, expected, installs: () => installs };
}
test("检查不会自动下载，完整下载校验后才允许安装", async (t) => {
  const { updater, engine, installs } = await fixture(t);
  assert.equal(engine.autoDownload, false);
  assert.equal(engine.autoInstallOnAppQuit, false);
  assert.equal((await updater.install()).state, "error");
  assert.equal((await updater.check()).state, "outdated");
  assert.equal((await updater.download()).state, "downloaded");
  let prepared = false;
  updater.prepare = async () => {
    prepared = true;
  };
  assert.equal((await updater.install()).state, "installing");
  assert.equal(prepared, true);
  await new Promise((done) => setTimeout(done, 350));
  assert.equal(installs(), 1);
});
test("文件篡改、大小异常和无校验信息均拒绝执行", async (t) => {
  const { updater, file, expected, installs } = await fixture(t);
  await updater.check();
  await updater.download();
  await writeFile(file, Buffer.alloc(expected.size));
  assert.equal((await updater.install()).state, "error");
  assert.match(updater.status().reason, /校验失败/);
  assert.equal(installs(), 0);
  await assert.rejects(verifyInstaller(file, { ...expected, size: 1 }), /大小/);
  await assert.rejects(verifyInstaller(file, {}), /校验/);
});
test("下载失败可重试，重复下载合并为一次，进度可恢复读取", async (t) => {
  const { updater, engine, file } = await fixture(t);
  await updater.check();
  engine.downloadUpdate = async () => {
    throw new Error("测试网络中断");
  };
  assert.equal((await updater.download()).state, "error");
  let calls = 0;
  let finish;
  engine.downloadUpdate = async () => {
    calls++;
    await new Promise((resolveDownload) => {
      finish = resolveDownload;
    });
    return [file];
  };
  const first = updater.download();
  const second = updater.download();
  assert.equal(first, second);
  engine.emit("download-progress", { percent: 30, transferred: 30, total: 100 });
  assert.equal(updater.status().progress, 30);
  finish();
  await first;
  assert.equal(calls, 1);
  assert.equal(updater.status().state, "downloaded");
});
test("开发环境与无更新不允许下载；保存失败阻止安装", async (t) => {
  const { updater, engine, installs } = await fixture(t);
  updater.supported = false;
  assert.equal((await updater.check()).state, "unavailable");
  assert.equal((await updater.download()).state, "error");
  updater.supported = true;
  await updater.check();
  await updater.download();
  updater.prepare = async () => {
    throw Error("保存失败");
  };
  assert.equal((await updater.install()).state, "error");
  assert.equal(installs(), 0);
  engine.checkForUpdates = async () => ({
    isUpdateAvailable: false,
    updateInfo: { version: "1.4.0" },
  });
  assert.equal((await updater.check()).state, "current");
  assert.equal((await updater.download()).state, "error");
});

test("便携版只检查新版本，拒绝下载和运行安装器", async (t) => {
  const { engine, installs } = await fixture(t);
  const updater = new DesktopUpdater({ engine, current: "1.4.0", supported: true, manual: true });
  assert.equal(updater.status().manual, true);
  assert.equal((await updater.check()).state, "outdated");
  const downloaded = await updater.download();
  assert.equal(downloaded.state, "error");
  assert.match(downloaded.reason, /便携/);
  assert.equal((await updater.install()).state, "error");
  await new Promise((done) => setTimeout(done, 350));
  assert.equal(installs(), 0);
});
