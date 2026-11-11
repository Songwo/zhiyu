import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BiometricUnlock } from "./biometric-unlock.mjs";
import { Vault } from "./vault.mjs";

const MASTER = "biometric-master-for-test";

async function setup(context, { platform = "darwin", prompt = async () => {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zhiyu-biometric-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vault = new Vault(join(directory, "vault.enc"));
  await vault.create(MASTER);
  const storageKey = randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", storageKey, iv);
      return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", storageKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString();
    },
  };
  const system = { canPromptTouchID: () => true, promptTouchID: prompt };
  const biometric = new BiometricUnlock({ vault, storage, system, directory, platform });
  return { vault, biometric, directory, system };
}

test("Mac 用户主动开启后，Touch ID 成功才能解锁原有凭据", async (context) => {
  let prompts = 0;
  const { vault, biometric, directory } = await setup(context, {
    prompt: async () => {
      prompts += 1;
    },
  });
  await vault.set("account:demo", { password: "synthetic-secret" });
  assert.deepEqual(await biometric.status(), { available: true, enabled: false });
  await biometric.enable();
  const disk = await readFile(join(directory, "touch-id-key.enc"), "utf8");
  assert.equal(disk.includes(MASTER), false);
  if (process.platform !== "win32")
    assert.equal((await stat(join(directory, "touch-id-key.enc"))).mode & 0o777, 0o600);
  vault.lock();
  await biometric.unlock();
  assert.deepEqual(await vault.get("account:demo"), { password: "synthetic-secret" });
  assert.equal(prompts, 2);
  await biometric.disable();
  vault.lock();
  assert.deepEqual(await biometric.status(), { available: true, enabled: false });
  await assert.rejects(biometric.unlock(), /请先在设置中开启/);
  await vault.unlock(MASTER);
});

test("取消系统认证时保持锁定，主密码仍可解锁", async (context) => {
  const { vault, biometric, system } = await setup(context);
  await biometric.enable();
  vault.lock();
  system.promptTouchID = async () => {
    throw new Error("用户取消认证");
  };
  await assert.rejects(biometric.unlock(), /用户取消认证/);
  assert.equal(vault.unlocked, false);
  assert.deepEqual(await biometric.status(), { available: true, enabled: true });
  await vault.unlock(MASTER);
});

test("主密码变更后旧解锁材料失效并清除", async (context) => {
  const { vault, biometric, directory } = await setup(context);
  await biometric.enable();
  await vault.changePassword(MASTER, "new-biometric-master-for-test");
  vault.lock();
  assert.deepEqual(await biometric.status(), { available: true, enabled: false });
  await assert.rejects(stat(join(directory, "touch-id-key.enc")), { code: "ENOENT" });
  await vault.unlock("new-biometric-master-for-test");
});

test("系统提示期间锁屏会取消开启，不留下快捷解锁材料", async (context) => {
  let finishPrompt;
  let promptStarted;
  const started = new Promise((resolve) => {
    promptStarted = resolve;
  });
  const { vault, biometric, directory } = await setup(context, {
    prompt: () =>
      new Promise((resolve) => {
        finishPrompt = resolve;
        promptStarted();
      }),
  });
  const pending = biometric.enable();
  await started;
  vault.lock();
  finishPrompt();
  await assert.rejects(pending, /状态已变化/);
  await assert.rejects(stat(join(directory, "touch-id-key.enc")), { code: "ENOENT" });
});

test("非 Mac 系统不显示或执行 Touch ID", async (context) => {
  const { biometric } = await setup(context, { platform: "win32" });
  assert.deepEqual(await biometric.status(), { available: false, enabled: false });
  await assert.rejects(biometric.enable(), /无法使用 Touch ID/);
});

test("Touch ID 暂不可用时仍允许关闭本机快捷解锁", async (context) => {
  const { biometric, system } = await setup(context);
  await biometric.enable();
  system.canPromptTouchID = () => false;
  assert.deepEqual(await biometric.status(), { available: false, enabled: true });
  await biometric.disable();
  assert.deepEqual(await biometric.status(), { available: false, enabled: false });
});

test("系统提示期间关闭快捷解锁不会在认证返回后解锁", async (context) => {
  const { biometric, vault, system } = await setup(context);
  await biometric.enable();
  vault.lock();
  let finishPrompt;
  let promptStarted;
  const started = new Promise((resolve) => {
    promptStarted = resolve;
  });
  system.promptTouchID = () =>
    new Promise((resolve) => {
      finishPrompt = resolve;
      promptStarted();
    });
  const pending = biometric.unlock();
  await started;
  const disabling = biometric.disable();
  finishPrompt();
  await assert.rejects(pending, /状态已变化/);
  await disabling;
  assert.equal(vault.unlocked, false);
  assert.deepEqual(await biometric.status(), { available: true, enabled: false });
});
