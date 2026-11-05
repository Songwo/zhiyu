import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { S3Backups, normalizeS3Backup } from "./backup-s3.mjs";
import { createBackup, openBackup, collectFiles } from "./backup.mjs";
import { BackupScheduler } from "./backup-schedule.mjs";
import { createServerSecureStorage } from "../../selfhost/secure-storage.mjs";
import {
  s3BackupFixture,
  S3_TEST_ACCESS,
  S3_TEST_SECRET,
} from "../../scripts/s3-backup-fixture.mjs";

async function rig(t) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-s3-test-")),
    s3 = await s3BackupFixture();
  const storage = createServerSecureStorage(join(root, "secure.key"));
  const service = new S3Backups({ file: join(root, "backup-s3.json"), secureStorage: storage });
  const config = {
    provider: "minio",
    endpoint: s3.endpoint,
    allowInsecure: true,
    pathStyle: true,
    region: "us-east-1",
    bucket: "fixture-backups",
    prefix: "zhiyu-backups",
    accessKeyId: S3_TEST_ACCESS,
    secretAccessKey: S3_TEST_SECRET,
  };
  t.after(async () => {
    service.stop();
    await s3.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, s3, service, storage, config };
}
test("S3 配置验证拒绝凭据 URL、错误 Bucket、前缀穿越及未确认 HTTP", () => {
  const good = {
    provider: "s3",
    endpoint: "https://storage.example.test",
    bucket: "my-backups",
    prefix: "zhiyu",
    region: "auto",
  };
  assert.equal(normalizeS3Backup(good).endpoint, good.endpoint);
  for (const bad of [
    { endpoint: "https://user:pass@storage.test" },
    { endpoint: "https://storage.test/?token=secret" },
    { endpoint: "http://storage.test" },
    { bucket: "../etc" },
    { prefix: "some/../other" },
    { region: "auto\r\nHeader:bad" },
  ])
    assert.throws(() => normalizeS3Backup({ ...good, ...bad }));
});
test("真实 HTTP：签名、探测、加密上传、独立前缀保留策略及解除绑定", async (t) => {
  const f = await rig(t);
  await f.service.configure(f.config);
  assert.equal(
    (await readFile(join(f.root, "backup-s3.json"), "utf8")).includes(S3_TEST_SECRET),
    false,
  );
  await assert.rejects(f.service.configure({ enabled: true }), /测试并绑定/);
  assert.equal((await f.service.test()).bound, true);
  assert.equal(f.s3.objects.size, 0);
  await f.service.configure({ enabled: true });
  await writeFile(
    join(f.root, "assets.json"),
    JSON.stringify({ servers: [{ id: "private-host", password: "opaque-test-data" }] }),
  );
  const { data } = await createBackup({
    root: f.root,
    password: "synthetic-backup-password",
    kind: "auto",
  });
  assert.equal((await collectFiles(f.root)).includes("backup-s3.json"), false);
  f.s3.objects.set("/fixture-backups/unrelated/user-file", Buffer.from("keep"));
  for (let i = 1; i <= 3; i++) await f.service.upload(data, `zhiyu-auto-test-${i}.zhiyu-backup`, 2);
  assert.equal(f.s3.objects.size, 3);
  assert.equal(f.s3.objects.has("/fixture-backups/unrelated/user-file"), true);
  const cloud = [...f.s3.objects.entries()].find(([key]) =>
    key.endsWith("zhiyu-auto-test-3.zhiyu-backup"),
  )[1];
  assert.equal(cloud.includes("opaque-test-data"), false);
  assert.equal((await openBackup(cloud, "synthetic-backup-password")).preview.kind, "auto");
  assert.equal((await f.service.status()).history.filter((r) => r.state === "uploaded").length, 2);
  assert.equal(JSON.stringify(await f.service.status()).includes(S3_TEST_SECRET), false);
  assert.deepEqual(f.s3.errors, []);
  await f.service.disconnect();
  assert.equal((await f.service.status()).hasCredentials, false);
  assert.equal(f.s3.objects.size, 3);
});
test("探测失败、重定向、上传失败均不冒充成功，也不泄漏上游正文", async (t) => {
  const f = await rig(t);
  await f.service.configure(f.config);
  f.s3.behavior.putStatus = 403;
  await assert.rejects(f.service.test(), /HTTP 403/);
  assert.equal((await f.service.status()).bound, false);
  f.s3.behavior.putStatus = 200;
  f.s3.behavior.redirect = true;
  await assert.rejects(f.service.test(), /HTTP 307/);
  f.s3.behavior.redirect = false;
  await f.service.test();
  await f.service.configure({ enabled: true });
  f.s3.behavior.headWrongSize = true;
  await assert.rejects(
    f.service.upload(Buffer.from("ZHIYUBAK-synthetic"), "sample.zhiyu-backup", 1),
    /S3/,
  );
  assert.equal((await f.service.status()).history[0].state, "failed");
  assert.ok((await f.service.status()).lastError);
  assert.equal(f.s3.errors.length, 0);
});
test("本地成功但 S3 失败会保留加密文件并明确记录部分失败", async (t) => {
  const f = await rig(t);
  await f.service.configure(f.config);
  await f.service.test();
  await f.service.configure({ enabled: true });
  f.s3.behavior.putStatus = 503;
  const scheduler = new BackupScheduler({
    file: join(f.root, "backup-schedule.json"),
    secureStorage: f.storage,
    run: async () => Buffer.from("ZHIYUBAK-fixture-encrypted"),
    upload: (data, name, keep) => f.service.upload(data, name, keep),
  });
  await scheduler.setDirectory(join(f.root, "cache"));
  await scheduler.configure({ password: "synthetic-backup-password" });
  await assert.rejects(scheduler.runNow(), /本地备份已保存.*云端/);
  const status = await scheduler.status();
  assert.equal(status.lastRunAt, null);
  assert.ok(status.lastLocalRunAt);
  assert.equal(status.history[0].remote, "failed");
  assert.equal(
    (await readFile(join(f.root, "cache", status.lastFile))).toString(),
    "ZHIYUBAK-fixture-encrypted",
  );
});
test("更换 Endpoint 必须重新输入凭据，不能把旧凭据自动发送给新地址", async (t) => {
  const f = await rig(t);
  await f.service.configure(f.config);
  await assert.rejects(
    f.service.configure({
      ...f.config,
      endpoint: "https://other-storage.example.test",
      accessKeyId: "",
      secretAccessKey: "",
    }),
    /重新输入/,
  );
  assert.equal(f.s3.requests.length, 0);
});
test("R2 与 OSS 兼容端点：区域、虚拟主机寻址和 OSS 必需请求头", async (t) => {
  const f = await rig(t);
  for (const provider of ["r2", "oss"]) {
    const endpoint =
      provider === "r2"
        ? "https://synthetic.r2.cloudflarestorage.com"
        : "https://s3.oss-cn-hangzhou.aliyuncs.com";
    const service = new S3Backups({
      file: join(f.root, `${provider}-config.json`),
      secureStorage: f.storage,
      fetchImpl: (url, options) => {
        const u = new URL(url);
        assert.equal(u.protocol, "https:");
        if (provider === "oss") {
          assert.equal(u.hostname, "fixture-backups.s3.oss-cn-hangzhou.aliyuncs.com");
          assert.equal(options.headers["x-oss-s3-compat"], "true");
          assert.equal(options.headers["x-oss-content-sha256"], "UNSIGNED-PAYLOAD");
        }
        return new Promise((resolve, reject) => {
          // 保留签名使用的原始 Host；Node fetch 会覆盖此头，故用真实 HTTP 转发。
          const req = request(
            f.s3.endpoint + u.pathname,
            {
              method: options.method,
              headers: { ...options.headers, host: u.host },
              signal: options.signal,
            },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () =>
                resolve(
                  new Response(
                    options.method === "HEAD" || res.statusCode === 204
                      ? null
                      : Buffer.concat(chunks),
                    { status: res.statusCode, headers: res.headers },
                  ),
                ),
              );
            },
          );
          req.on("error", reject);
          req.end(options.body);
        });
      },
    });
    await service.configure({
      ...f.config,
      provider,
      endpoint,
      allowInsecure: false,
      pathStyle: provider === "r2",
      region: provider === "r2" ? "auto" : "us-east-1",
    });
    assert.equal((await service.test()).bound, true);
    service.stop();
  }
  assert.deepEqual(f.s3.errors, []);
});
