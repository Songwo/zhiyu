import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { webResearchFixture } from "./web-research-fixture.mjs";
import { s3BackupFixture, S3_TEST_ACCESS, S3_TEST_SECRET } from "./s3-backup-fixture.mjs";
import { openBackup } from "../electron/services/backup.mjs";

const storage = await s3BackupFixture();
const f = await webResearchFixture({ built: true });
const browser = await chromium.launch(),
  errors = [];
const backupPassword = "synthetic-independent-backup-password";
const rpc = async (channel, input) => {
  const r = await f.rpc(channel, input ? [input] : []);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
};
await mkdir("screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: "zh-CN",
  });
  await context.addCookies([{ name: "zhiyu_session", value: f.cookie.split("=")[1], url: f.base }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.base);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.getByRole("button", { name: "账号与设置", exact: true }).click();
  await page.getByRole("menuitem", { name: "系统设置…", exact: true }).click();
  await page.getByRole("button", { name: "数据", exact: true }).click();
  const auto = page.getByRole("region", { name: "自动备份", exact: true });
  await auto.getByRole("checkbox", { name: /我允许服务器加密保管自动备份密码/ }).check();
  await auto.getByLabel("自动备份密码", { exact: true }).fill(backupPassword);
  await auto.getByRole("button", { name: "保存密码", exact: true }).click();
  await auto.getByText("自动备份密码已由服务器密钥加密保存。", { exact: false }).waitFor();
  const s3 = page.getByRole("region", { name: "S3 云端备份", exact: true });
  await s3.getByRole("combobox", { name: "存储类型", exact: true }).click();
  await page.getByRole("option", { name: "MinIO", exact: true }).click();
  await s3.getByLabel("Endpoint", { exact: true }).fill(storage.endpoint);
  await s3.getByLabel("Bucket", { exact: true }).fill("synthetic-backups");
  await s3.getByLabel("Access Key ID", { exact: true }).fill(S3_TEST_ACCESS);
  await s3.getByLabel("Secret Access Key", { exact: true }).fill(S3_TEST_SECRET);
  await s3.locator("summary").first().click();
  await s3.getByRole("checkbox", { name: /允许可信内网 HTTP/ }).check();
  assert.equal(
    await s3.getByRole("button", { name: "测试并绑定", exact: true }).isDisabled(),
    true,
    "未同意服务器存储前禁止保存",
  );
  await s3.getByRole("checkbox", { name: /我允许可信部署服务器加密保管 S3 凭据/ }).check();
  await s3.getByRole("button", { name: "测试并绑定", exact: true }).click();
  await s3.getByText("连接读写与清理测试已通过", { exact: true }).waitFor();
  assert.equal(await s3.getByLabel("Secret Access Key", { exact: true }).inputValue(), "");
  await auto.getByRole("button", { name: "立即备份", exact: true }).click();
  await page.getByText("已完成一次自动备份", { exact: true }).waitFor();
  await s3.getByText("云端备份记录", { exact: true }).waitFor();
  const status = await rpc("backup:s3-status");
  assert.equal(status.history[0].state, "uploaded");
  const data = [...storage.objects.values()][0];
  assert.ok(data.subarray(0, 8).equals(Buffer.from("ZHIYUBAK")));
  const opened = await openBackup(data, backupPassword);
  assert.equal(opened.preview.kind, "auto");
  assert.equal(data.includes(S3_TEST_SECRET), false);
  assert.equal(JSON.stringify(status).includes(S3_TEST_SECRET), false);
  const schedule = await rpc("backup:auto-status");
  assert.equal(schedule.history[0].remote, "uploaded");
  storage.behavior.putStatus = 503;
  await auto.getByRole("button", { name: "立即备份", exact: true }).click();
  await auto
    .getByRole("alert")
    .filter({ hasText: /本地备份已保存.*云端/ })
    .waitFor();
  assert.equal((await rpc("backup:auto-status")).history[0].remote, "failed");
  await page.screenshot({ path: "screenshots/web-s3-backup-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "设置分类", exact: true }).click();
  await page.getByRole("option", { name: "数据", exact: true }).click();
  await s3.getByRole("button", { name: "解除绑定", exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "screenshots/web-s3-backup-mobile.png" });
  await s3.getByRole("button", { name: "解除绑定", exact: true }).click();
  await s3.getByText("已解除绑定；云端已有备份会保留。", { exact: true }).waitFor();
  assert.equal((await rpc("backup:s3-status")).hasCredentials, false);
  assert.ok(storage.objects.size > 0, "解绑不删除已上传备份");
  assert.deepEqual(storage.errors, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        realHttpSigV4: true,
        explicitConsent: true,
        encryptedBackupRestorable: true,
        credentialsExcludedFromDto: true,
        partialFailureRecorded: true,
        mobileSettingsReachable: true,
        preservedRemoteFiles: true,
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const page of browser.contexts().flatMap((c) => c.pages()))
    console.error((await page.locator("body").innerText()).slice(-6000));
  throw error;
} finally {
  await browser.close();
  await f.close();
  await storage.close();
}
