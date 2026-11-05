import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebBackups } from "../selfhost/backups.mjs";
import { createServerSecureStorage } from "../selfhost/secure-storage.mjs";
import { S3Backups } from "../electron/services/backup-s3.mjs";
import { BackupScheduler } from "../electron/services/backup-schedule.mjs";

test("Web 自动备份须有效会话和明确服务器保管同意；停服不接受新调用", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-web-backup-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let active = true;
  const service = createWebBackups({
    serverDir: root,
    secureStorage: createServerSecureStorage(join(root, "key")),
    produceBackup: async () => Buffer.from("ZHIYUBAK-synthetic"),
    sessionActive: (key) => active && key === "session",
  });
  const call = (channel, input) =>
    service.call(channel, input ? [input] : [], { sessionKey: "session" });
  await assert.rejects(service.call("backup:auto-status", [], {}), /登录已过期/);
  await assert.rejects(call("backup:auto-configure", { password: "synthetic-password" }), /先同意/);
  await call("backup:auto-configure", {
    password: "synthetic-password",
    enabled: true,
    allowServerStorage: true,
  });
  assert.equal((await call("backup:auto-status")).hasPassword, true);
  assert.equal(
    (await readFile(join(root, "backup-schedule.json"), "utf8")).includes("synthetic-password"),
    false,
  );
  active = false;
  await assert.rejects(call("backup:auto-configure", { enabled: false }), /登录已过期/);
  service.start();
  service.stop();
  active = true;
  await assert.rejects(call("backup:auto-status"), /登录已过期/);
});

test("队列和文件写入期间会话失效，自动密码与 S3 凭据均不可落盘", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-backup-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createServerSecureStorage(join(root, "key"));
  const scheduler = new BackupScheduler({
    file: join(root, "schedule.json"),
    secureStorage: storage,
    run: async () => Buffer.from(""),
  });
  const remote = new S3Backups({ file: join(root, "s3.json"), secureStorage: storage });
  const input = {
    provider: "s3",
    endpoint: "https://s3.example.test",
    bucket: "backups",
    region: "auto",
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic-private",
  };
  for (const [service, config, name] of [
    [scheduler, { password: "synthetic-password" }, "schedule.json"],
    [remote, input, "s3.json"],
  ]) {
    let checks = 0;
    await assert.rejects(
      service.configure(config, () => {
        if (++checks === 3) throw new Error("会话已失效");
      }),
      /会话已失效/,
    );
    await assert.rejects(readFile(join(root, name)), { code: "ENOENT" });
    assert.equal(
      (await readdir(root)).some((n) => n.endsWith(".tmp")),
      false,
    );
  }
  remote.stop();
});
