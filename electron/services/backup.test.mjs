import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackupError,
  PENDING_DIRECTORY,
  SNAPSHOT_DIRECTORY,
  applyPendingRestore,
  collectFiles,
  createBackup,
  isBackupPath,
  openBackup,
  pruneAutoBackups,
  stageRestore,
} from "./backup.mjs";
import { BackupScheduler } from "./backup-schedule.mjs";

const PASSWORD = "backup-password-for-test";
const MARKER = "unique-asset-marker-7f3c";

/** 每台"电脑"一把不同的系统密钥：A 加密的内容 B 解不开。 */
function systemStorage(machine, { usable = true } = {}) {
  return {
    isEncryptionAvailable: () => usable,
    getSelectedStorageBackend: () => (usable ? "dpapi" : "basic_text"),
    encryptString: (value) =>
      Buffer.from(`${machine}:${Buffer.from(value, "utf8").toString("base64")}`),
    decryptString: (buffer) => {
      const text = Buffer.from(buffer).toString();
      if (!text.startsWith(`${machine}:`)) throw new Error("Error while decrypting the ciphertext");
      return Buffer.from(text.slice(machine.length + 1), "base64").toString("utf8");
    },
  };
}

async function tempDir(t, name) {
  const directory = await mkdtemp(join(tmpdir(), `zhiyu-backup-${name}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function put(root, path, content) {
  const target = join(root, ...path.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

/** 模拟一个真实资料目录：应用数据、Chromium 缓存、临时文件与本机缓存混在一起。 */
async function seedDataDirectory(root, storage) {
  const assets = {
    state: {
      servers: [{ id: "srv-1", name: MARKER, host: "10.0.0.1" }],
      services: [{ id: "svc-1" }, { id: "svc-2" }],
      domains: [],
      secrets: [{ id: "sec-1" }],
    },
    version: 0,
  };
  await put(root, "assets.json", JSON.stringify(assets));
  await put(root, "vault.enc", JSON.stringify({ v: 2, records: { "ssh:srv-1": {}, "x:1": {} } }));
  await put(root, "preferences.json", JSON.stringify({ locale: "zh" }));
  await put(root, "profile.json", JSON.stringify({ name: "Tester" }));
  await put(root, "usage-history.json", "{}");
  await put(root, "documents/doc-a.json", JSON.stringify({ title: "A" }));
  await put(root, "documents/doc-b.json", JSON.stringify({ title: "B" }));
  await put(
    root,
    "agent-config.json",
    JSON.stringify({
      baseUrl: "https://api.example.com/v1",
      encryptedKey: storage.encryptString("sk-model-key").toString("base64"),
    }),
  );
  await put(
    root,
    "integrations.json",
    JSON.stringify({
      v: 1,
      connections: [
        {
          id: "cf-1",
          provider: "cloudflare",
          name: "CF",
          encryptedToken: storage.encryptString("cloudflare-token-0001").toString("base64"),
        },
      ],
    }),
  );
  await put(root, "main-identity.enc", storage.encryptString(JSON.stringify({ version: 1 })));
  // 以下都不应进入备份
  await put(root, "Cache/Cache_Data/data_0", "chromium cache");
  await put(root, "GPUCache/index", "gpu");
  await put(root, "Local Storage/leveldb/000003.log", "leveldb");
  await put(root, "Preferences", "{}");
  await put(root, "Local State", "{}");
  await put(root, "assets.json.backup", "old");
  await put(root, "assets.json.tmp", "half");
  await put(root, "local-usage.json", JSON.stringify({ version: 2, machine: "source" }));
  await put(root, "local-usage.json.v1-abc.backup.json", "migration");
  await put(root, "backup-schedule.json", "{}");
  await put(root, "documents/doc-c.json.tmp", "half");
  await put(root, "restore-snapshots/20260101-000000/assets.json", "older snapshot");
}

test("打包只收应用资料，排除 Chromium 缓存、临时文件、本机缓存与恢复快照", async (t) => {
  const root = await tempDir(t, "collect");
  await seedDataDirectory(root, systemStorage("A"));
  assert.deepEqual(await collectFiles(root), [
    "agent-config.json",
    "assets.json",
    "documents/doc-a.json",
    "documents/doc-b.json",
    "integrations.json",
    "main-identity.enc",
    "preferences.json",
    "profile.json",
    "usage-history.json",
    "vault.enc",
  ]);
  for (const path of ["../evil.json", "/etc/passwd", "documents/../x.json", "a\\b.json", "Cache/x"])
    assert.equal(isBackupPath(path), false, path);
});

test("备份文件是密文：魔数与头部之外看不到资产、清单、时间或凭据", async (t) => {
  const root = await tempDir(t, "encrypt");
  const storage = systemStorage("A");
  await seedDataDirectory(root, storage);
  const { data, preview } = await createBackup({
    root,
    password: PASSWORD,
    appVersion: "1.7.4",
    secureStorage: storage,
  });
  assert.equal(data.subarray(0, 8).toString("ascii"), "ZHIYUBAK");
  const text = data.toString("latin1");
  for (const secret of [
    MARKER,
    "sk-model-key",
    "cloudflare-token",
    "assets.json",
    "1.7.4",
    "Tester",
  ])
    assert.equal(text.includes(secret), false, secret);
  const header = JSON.parse(data.subarray(12, 12 + data.readUInt32BE(8)).toString("utf8"));
  assert.deepEqual(Object.keys(header).sort(), ["check", "format", "iv", "kdf", "salt", "v"]);
  assert.equal(preview.summary.assetTotal, 4);
  assert.equal(preview.summary.documents, 2);
  assert.equal(preview.summary.vaultRecords, 2);
  assert.equal(preview.secure.count, 3);
  // 每次备份使用新的盐和 IV，同样内容的两份备份密文不同。
  const again = await createBackup({ root, password: PASSWORD });
  assert.notDeepEqual(again.data.subarray(0, 200), data.subarray(0, 200));
});

test("备份密码过短被拒绝", async (t) => {
  const root = await tempDir(t, "short");
  await assert.rejects(createBackup({ root, password: "short" }), /至少 10 位/);
});

test("往返恢复：新电脑的资料被整体替换，原资料移入快照，本机缓存保持不动", async (t) => {
  const source = await tempDir(t, "source");
  const target = await tempDir(t, "target");
  const machineA = systemStorage("A");
  const machineB = systemStorage("B");
  await seedDataDirectory(source, machineA);
  // 目标电脑已有自己的资料，其中 extra.json 不在备份里。
  await put(target, "assets.json", JSON.stringify({ state: { servers: [] }, version: 0 }));
  await put(target, "extra.json", "only on target");
  await put(target, "documents/doc-old.json", "old doc");
  await put(target, "local-usage.json", JSON.stringify({ machine: "target" }));
  await put(target, "Cache/data", "target cache");

  const { data } = await createBackup({
    root: source,
    password: PASSWORD,
    appVersion: "1.7.4",
    secureStorage: machineA,
    now: new Date("2026-10-20T08:00:00Z"),
  });
  const backup = await openBackup(data, PASSWORD);
  assert.equal(backup.preview.appVersion, "1.7.4");
  assert.equal(backup.preview.createdAt, "2026-10-20T08:00:00.000Z");
  assert.equal(backup.preview.summary.assets.services, 2);

  const staged = await stageRestore({
    root: target,
    backup,
    secureStorage: machineB,
    now: new Date(2026, 9, 21, 9, 30, 0),
  });
  assert.deepEqual(staged, { files: 10, secureRestored: 3, secureSkipped: false });
  // 暂存阶段不触碰当前资料。
  assert.equal(await readFile(join(target, "extra.json"), "utf8"), "only on target");

  const outcome = await applyPendingRestore(target);
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.snapshot, `${SNAPSHOT_DIRECTORY}/20261021-093000`);

  for (const path of ["assets.json", "vault.enc", "profile.json", "documents/doc-a.json"])
    assert.deepEqual(
      await readFile(join(target, ...path.split("/"))),
      await readFile(join(source, ...path.split("/"))),
      path,
    );
  // 系统保护的凭据已由 B 机重新加密，B 机可以解开。
  const agent = JSON.parse(await readFile(join(target, "agent-config.json"), "utf8"));
  assert.equal(agent.baseUrl, "https://api.example.com/v1");
  assert.equal(machineB.decryptString(Buffer.from(agent.encryptedKey, "base64")), "sk-model-key");
  const integrations = JSON.parse(await readFile(join(target, "integrations.json"), "utf8"));
  assert.equal(
    machineB.decryptString(Buffer.from(integrations.connections[0].encryptedToken, "base64")),
    "cloudflare-token-0001",
  );
  assert.equal(
    machineB.decryptString(await readFile(join(target, "main-identity.enc"))),
    JSON.stringify({ version: 1 }),
  );

  const snapshot = join(target, SNAPSHOT_DIRECTORY, "20261021-093000");
  assert.equal(await readFile(join(snapshot, "extra.json"), "utf8"), "only on target");
  assert.equal(await readFile(join(snapshot, "documents", "doc-old.json"), "utf8"), "old doc");
  assert.deepEqual((await readdir(join(target, "documents"))).sort(), ["doc-a.json", "doc-b.json"]);
  await assert.rejects(readFile(join(target, "extra.json")), { code: "ENOENT" });
  assert.equal(
    await readFile(join(target, "local-usage.json"), "utf8"),
    JSON.stringify({ machine: "target" }),
  );
  assert.equal(await readFile(join(target, "Cache", "data"), "utf8"), "target cache");
  await assert.rejects(readdir(join(target, PENDING_DIRECTORY)), { code: "ENOENT" });
  // 没有待恢复内容时启动不做任何事。
  assert.equal(await applyPendingRestore(target), null);
});

test("未包含系统凭据时保留原密文；本机无安全存储时跳过而不是写入明文", async (t) => {
  const source = await tempDir(t, "nosecure");
  const machineA = systemStorage("A");
  await seedDataDirectory(source, machineA);
  const original = await readFile(join(source, "agent-config.json"));

  const plain = await openBackup(
    (await createBackup({ root: source, password: PASSWORD })).data,
    PASSWORD,
  );
  assert.equal(plain.preview.secure.included, false);
  const targetA = await tempDir(t, "nosecure-a");
  assert.equal(
    (await stageRestore({ root: targetA, backup: plain, secureStorage: machineA })).secureRestored,
    0,
  );
  await applyPendingRestore(targetA);
  assert.deepEqual(await readFile(join(targetA, "agent-config.json")), original);

  const full = await openBackup(
    (await createBackup({ root: source, password: PASSWORD, secureStorage: machineA })).data,
    PASSWORD,
  );
  const targetB = await tempDir(t, "nosecure-b");
  const result = await stageRestore({
    root: targetB,
    backup: full,
    secureStorage: systemStorage("B", { usable: false }),
  });
  assert.equal(result.secureSkipped, true);
  await applyPendingRestore(targetB);
  const restored = await readFile(join(targetB, "agent-config.json"), "utf8");
  assert.equal(restored.includes("sk-model-key"), false);
  assert.deepEqual(Buffer.from(restored), original);
});

test("本机已无法解密的凭据不会中断备份，只在预览中列出", async (t) => {
  const root = await tempDir(t, "undecryptable");
  await seedDataDirectory(root, systemStorage("OTHER"));
  const { preview } = await createBackup({
    root,
    password: PASSWORD,
    secureStorage: systemStorage("A"),
  });
  assert.equal(preview.secure.count, 0);
  assert.deepEqual(preview.secure.failed.sort(), [
    "agent-config.json",
    "integrations.json",
    "main-identity.enc",
  ]);
});

test("错误密码被识别为密码错误，且不暴露任何内容", async (t) => {
  const root = await tempDir(t, "wrong");
  await seedDataDirectory(root, systemStorage("A"));
  const { data } = await createBackup({ root, password: PASSWORD });
  for (const password of ["backup-password-for-tesT", "", undefined])
    await assert.rejects(openBackup(data, password), (error) => {
      assert.ok(error instanceof BackupError);
      assert.equal(error.code, "PASSWORD");
      return true;
    });
});

test("篡改密文、头部或截断文件都会被拒绝", async (t) => {
  const root = await tempDir(t, "tamper");
  await seedDataDirectory(root, systemStorage("A"));
  const { data } = await createBackup({ root, password: PASSWORD });
  const headerEnd = 12 + data.readUInt32BE(8);
  const expectCode = (code) => (error) => {
    assert.ok(error instanceof BackupError, String(error));
    assert.equal(error.code, code);
    return true;
  };

  const body = Buffer.from(data);
  body[headerEnd + 10] ^= 0x01;
  await assert.rejects(openBackup(body, PASSWORD), expectCode("CORRUPT"));

  const tag = Buffer.from(data);
  tag[tag.length - 1] ^= 0x80;
  await assert.rejects(openBackup(tag, PASSWORD), expectCode("CORRUPT"));

  // 头部作为附加认证数据：换掉正文 IV 也无法通过认证。
  const header = JSON.parse(data.subarray(12, headerEnd).toString("utf8"));
  const forgedIv = Buffer.from(header.iv, "base64");
  forgedIv[0] ^= 0xff;
  const forgedHeader = Buffer.from(JSON.stringify({ ...header, iv: forgedIv.toString("base64") }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(forgedHeader.length);
  const forged = Buffer.concat([
    data.subarray(0, 8),
    length,
    forgedHeader,
    data.subarray(headerEnd),
  ]);
  await assert.rejects(openBackup(forged, PASSWORD), expectCode("CORRUPT"));

  await assert.rejects(
    openBackup(data.subarray(0, data.length - 40), PASSWORD),
    expectCode("CORRUPT"),
  );
  await assert.rejects(openBackup(Buffer.from('{"state":{}}'), PASSWORD), expectCode("FORMAT"));

  // 更新版本格式给出升级提示，而不是笼统的损坏。
  const future = Buffer.from(JSON.stringify({ ...header, v: 99 }));
  length.writeUInt32BE(future.length);
  await assert.rejects(
    openBackup(
      Buffer.concat([data.subarray(0, 8), length, future, data.subarray(headerEnd)]),
      PASSWORD,
    ),
    expectCode("VERSION"),
  );
});

test("暂存未完成时启动丢弃暂存区，当前资料不变", async (t) => {
  const root = await tempDir(t, "incomplete");
  await put(root, "assets.json", "current");
  await put(root, `${PENDING_DIRECTORY}/files/assets.json`, "half staged");
  assert.deepEqual(await applyPendingRestore(root), { status: "discarded" });
  assert.equal(await readFile(join(root, "assets.json"), "utf8"), "current");
  await assert.rejects(readdir(join(root, PENDING_DIRECTORY)), { code: "ENOENT" });
});

test("替换中断后重放：不覆盖快照里的原资料，并完成剩余文件", async (t) => {
  const source = await tempDir(t, "replay-source");
  await seedDataDirectory(source, systemStorage("A"));
  const backup = await openBackup(
    (await createBackup({ root: source, password: PASSWORD })).data,
    PASSWORD,
  );
  const root = await tempDir(t, "replay");
  await put(root, "assets.json", "original assets");
  await put(root, "profile.json", "original profile");
  await stageRestore({ root, backup, now: new Date(2026, 0, 2, 3, 4, 5) });

  // 模拟第一阶段只移走了 assets.json 就断电，随后应用又写出了新的 assets.json。
  const snapshot = join(root, SNAPSHOT_DIRECTORY, "20260102-030405");
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, "assets.json"), "original assets");
  await writeFile(join(root, "assets.json"), "written after crash");

  const outcome = await applyPendingRestore(root);
  assert.equal(outcome.status, "applied");
  assert.equal(await readFile(join(snapshot, "assets.json"), "utf8"), "original assets");
  assert.equal(await readFile(join(snapshot, "profile.json"), "utf8"), "original profile");
  assert.deepEqual(
    await readFile(join(root, "assets.json")),
    await readFile(join(source, "assets.json")),
  );
});

test("恢复快照只保留最近几份", async (t) => {
  const root = await tempDir(t, "snapshots");
  for (const stamp of ["20260101-000000", "20260102-000000", "20260103-000000"])
    await put(root, `${SNAPSHOT_DIRECTORY}/${stamp}/assets.json`, stamp);
  const backup = await openBackup(
    (await createBackup({ root, password: PASSWORD })).data,
    PASSWORD,
  );
  await stageRestore({ root, backup, now: new Date(2026, 0, 4) });
  await applyPendingRestore(root, { keepSnapshots: 2 });
  assert.deepEqual((await readdir(join(root, SNAPSHOT_DIRECTORY))).sort(), [
    "20260103-000000",
    "20260104-000000",
  ]);
});

test("自动备份清理只删除自己命名的文件", async (t) => {
  const directory = await tempDir(t, "prune");
  for (const day of ["01", "02", "03", "04"])
    await put(directory, `zhiyu-auto-202610${day}-120000.zhiyu-backup`, day);
  await put(directory, "知屿备份-20261001-1200.zhiyu-backup", "manual");
  await put(directory, "notes.txt", "keep");
  const removed = await pruneAutoBackups(directory, 2);
  assert.deepEqual(removed.sort(), [
    "zhiyu-auto-20261001-120000.zhiyu-backup",
    "zhiyu-auto-20261002-120000.zhiyu-backup",
  ]);
  assert.deepEqual((await readdir(directory)).sort(), [
    "notes.txt",
    "zhiyu-auto-20261003-120000.zhiyu-backup",
    "zhiyu-auto-20261004-120000.zhiyu-backup",
    "知屿备份-20261001-1200.zhiyu-backup",
  ]);
});

test("自动备份：按周期运行、保留最近 N 份，密码由系统加密保存", async (t) => {
  const root = await tempDir(t, "schedule-data");
  const target = await tempDir(t, "schedule-target");
  await seedDataDirectory(root, systemStorage("A"));
  let clock = new Date(2026, 9, 20, 8, 0, 0).getTime();
  const passwords = [];
  const scheduler = new BackupScheduler({
    file: join(root, "backup-schedule.json"),
    secureStorage: systemStorage("A"),
    now: () => clock,
    run: async (password) => {
      passwords.push(password);
      return (await createBackup({ root, password, kind: "auto" })).data;
    },
  });
  await assert.rejects(scheduler.configure({ enabled: true }), /文件夹/);
  await scheduler.setDirectory(target);
  await assert.rejects(scheduler.configure({ enabled: true }), /密码/);
  await assert.rejects(scheduler.configure({ intervalHours: 5 }), /周期/);
  await assert.rejects(scheduler.configure({ keep: 0 }), /1–30/);
  const status = await scheduler.configure({
    password: PASSWORD,
    enabled: true,
    intervalHours: 24,
    keep: 2,
  });
  assert.equal(status.enabled, true);
  assert.equal(status.passwordReadable, true);
  assert.equal(
    (await readFile(join(root, "backup-schedule.json"), "utf8")).includes(PASSWORD),
    false,
  );

  assert.equal(await scheduler.tick(), true);
  assert.equal(await scheduler.tick(), false, "周期未到不重复运行");
  for (let day = 1; day <= 3; day += 1) {
    clock += 24 * 60 * 60 * 1000;
    assert.equal(await scheduler.tick(), true);
  }
  const files = (await readdir(target)).sort();
  assert.deepEqual(files, [
    "zhiyu-auto-20261022-080000.zhiyu-backup",
    "zhiyu-auto-20261023-080000.zhiyu-backup",
  ]);
  assert.deepEqual(new Set(passwords), new Set([PASSWORD]));
  const restored = await openBackup(await readFile(join(target, files[1])), PASSWORD);
  assert.equal(restored.preview.kind, "auto");
  assert.equal(restored.preview.secure.included, false);
  const after = await scheduler.status();
  assert.equal(after.lastFile, files[1]);
  assert.equal(after.lastError, null);
});

test("自动备份：密码在本机无法读取时记录错误并稍后重试", async (t) => {
  const root = await tempDir(t, "schedule-foreign");
  const target = await tempDir(t, "schedule-foreign-target");
  const file = join(root, "backup-schedule.json");
  // 资料从 A 机恢复到 B 机：保存的密码是 A 机的系统密文。
  const fromA = new BackupScheduler({
    file,
    secureStorage: systemStorage("A"),
    run: async () => Buffer.alloc(0),
  });
  await fromA.setDirectory(target);
  await fromA.configure({ password: PASSWORD, enabled: true });

  let clock = Date.now();
  let runs = 0;
  const onB = new BackupScheduler({
    file,
    secureStorage: systemStorage("B"),
    now: () => clock,
    run: async () => {
      runs += 1;
      return Buffer.from("never");
    },
  });
  const status = await onB.status();
  assert.equal(status.hasPassword, true);
  assert.equal(status.passwordReadable, false);
  await onB.tick();
  assert.equal(runs, 0);
  assert.match((await onB.status()).lastError, /重新设置/);
  assert.deepEqual(await readdir(target), []);
  clock += 10 * 60 * 1000;
  assert.equal(await onB.tick(), false, "失败后一小时内不重试");
  await onB.configure({ password: PASSWORD });
  clock += 60 * 60 * 1000;
  assert.equal(await onB.tick(), true);
  assert.equal(runs, 1);
});
