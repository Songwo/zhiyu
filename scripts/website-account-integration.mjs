import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "nanpad-website-account-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
try {
  instance = await electron.launch({
    args: [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  const page = await instance.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  // 测试不读取用户剪贴板，只在本次隔离页面返回空内容。
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "readText", { value: async () => "" }),
  );
  await page.getByRole("button", { name: "邮箱", exact: true }).click();
  await page.getByRole("button", { name: "添加邮箱", exact: true }).click();
  let composer = page.getByRole("dialog", { name: "邮箱", exact: true });
  await composer.getByLabel("地址", { exact: true }).fill("website-owner@example.test");
  await composer.getByLabel("所属域名", { exact: true }).fill("example.test");
  await composer.getByRole("button", { name: "添加", exact: true }).click();
  await composer.waitFor({ state: "detached" });

  await page
    .locator("aside.app-sidebar:visible")
    .getByRole("button", { name: "密钥库", exact: true })
    .click();
  await page.getByRole("button", { name: "打开分组 未分组", exact: true }).click();
  await page
    .getByRole("region", { name: "密钥分组", exact: true })
    .getByRole("button", { name: "添加密钥", exact: true })
    .click();
  composer = page.getByRole("dialog", { name: "密钥", exact: true });
  await composer.getByRole("combobox", { name: "类型", exact: true }).click();
  await page.getByRole("option", { name: "网站账号 / 密码", exact: true }).click();
  await composer.getByLabel("登录地址", { exact: true }).waitFor();
  await composer.getByRole("button", { name: /智能粘贴/ }).click();
  await composer
    .locator("textarea[placeholder]")
    .fill(
      "https://embedded-user:embedded-password@accounts.example.test/login?token=private-query#temporary-token",
    );
  await composer.getByRole("button", { name: /网站登录账号/ }).click();
  assert.equal(
    await composer.getByLabel("名称", { exact: true }).inputValue(),
    "accounts.example.test",
  );
  assert.equal(
    await composer.getByLabel("登录地址", { exact: true }).inputValue(),
    "https://accounts.example.test/login",
  );
  await composer.getByLabel("账号", { exact: true }).fill("website-test-user");
  await composer.getByLabel("密码", { exact: true }).fill("website-test-password-2026");
  await composer.locator('[name="account-note"]').fill("website-recovery-code-fixture");
  await composer.getByLabel("提示", { exact: true }).fill("个人网站账号");

  // 后端锁定后取消解锁，必须保留表单且不能保存一个没有凭据的新资产。
  await page.evaluate(() => window.sinan.vault.lock());
  await composer.getByRole("button", { name: "添加", exact: true }).click();
  let gate = page.locator(".z-gate");
  await gate.getByRole("button", { name: "取消", exact: true }).last().click();
  await gate.waitFor({ state: "detached" });
  assert.equal(await composer.isVisible(), true);
  assert.equal((await page.evaluate(() => window.sinan.store.load())).state.secrets.length, 0);
  await composer.getByRole("button", { name: "添加", exact: true }).click();
  gate = page.locator(".z-gate");
  await gate.locator('input[type="password"]').fill("integration-master-2026");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  await composer.waitFor({ state: "detached" });
  const stored = () => page.evaluate(() => window.sinan.store.load());
  let snapshot = await stored();
  const website = snapshot.state.secrets.find((item) => item.name === "accounts.example.test");
  assert.equal(website.kind, "password");
  assert.equal(website.value, "");
  const credentials = await page.evaluate(
    (id) => window.sinan.vault.get(`account:${id}`),
    website.id,
  );
  assert.equal(credentials.url, "https://accounts.example.test/login");
  assert.equal(credentials.username, "website-test-user");
  assert.equal(credentials.password, "website-test-password-2026");
  assert.equal(credentials.note, "website-recovery-code-fixture");

  const accountRow = () =>
    page.getByRole("button", { name: `查看账号与凭据 ${website.name}`, exact: true });
  await accountRow().click();
  let details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByText("website-test-user", { exact: true }).waitFor();
  assert.equal(await details.getByText("website-test-password-2026", { exact: true }).count(), 0);
  await details.getByRole("combobox", { name: "选择关联资产", exact: true }).click();
  await page
    .getByRole("option")
    .filter({ has: page.getByText("website-owner@example.test", { exact: true }) })
    .click();
  await details.getByRole("button", { name: "添加关联", exact: true }).click();
  await details.getByRole("button", { name: "解除关联", exact: true }).waitFor();
  snapshot = await stored();
  assert.equal(snapshot.state.links.length, 1);
  const mailbox = snapshot.state.mailboxes.find(
    (item) => item.address === "website-owner@example.test",
  );
  const link = snapshot.state.links[0];
  assert.deepEqual(
    new Set([`${link.from.kind}:${link.from.id}`, `${link.to.kind}:${link.to.id}`]),
    new Set([`secret:${website.id}`, `mail:${mailbox.id}`]),
  );

  await details
    .getByRole("heading", { name: "网站登录账号", exact: true })
    .scrollIntoViewIfNeeded();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/nanpad-website-account-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await details
    .getByRole("heading", { name: "网站登录账号", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "screenshots/nanpad-website-account-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page
    .locator("aside.app-sidebar:visible")
    .getByRole("button", { name: "密钥库", exact: true })
    .click();
  await page.getByRole("button", { name: "打开分组 未分组", exact: true }).click();
  await accountRow().click();
  details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByText("website-test-user", { exact: true }).waitFor();
  await details.getByRole("button", { name: "解除关联", exact: true }).waitFor();
  await details.getByRole("button", { name: "编辑", exact: true }).click();
  composer = page.getByRole("dialog", { name: "密钥", exact: true });
  await composer.getByLabel("账号", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('[name="account-username"]')?.value === "website-test-user",
  );
  assert.equal(
    await composer.getByLabel("登录地址", { exact: true }).inputValue(),
    credentials.url,
  );
  assert.equal(
    await composer.getByLabel("密码", { exact: true }).inputValue(),
    credentials.password,
  );
  await composer.getByRole("button", { name: "取消", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "detached" });

  const exportPath = join(directory, "website-assets.json");
  await instance.evaluate(({ session }, target) => {
    // 下载开始时 Windows 仍可能锁住目标文件，必须等待 Electron 确认写入完成。
    globalThis.websiteAccountExportCompletion = new Promise((resolve) => {
      const onDownload = (_event, item) => {
        item.setSavePath(target);
        item.once("done", (_doneEvent, state) => {
          clearTimeout(timeout);
          resolve(state);
        });
      };
      const timeout = setTimeout(() => {
        session.defaultSession.removeListener("will-download", onDownload);
        resolve("timeout");
      }, 30000);
      session.defaultSession.once("will-download", onDownload);
    });
  }, exportPath);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("button", { name: "导出 JSON 快照", exact: true }).click();
  const downloadState = await instance.evaluate(() => globalThis.websiteAccountExportCompletion);
  assert.equal(downloadState, "completed", "导出下载必须成功完成后才能读取文件");
  const exported = await readFile(exportPath, "utf8");
  JSON.parse(exported);
  const publicData = JSON.stringify((await stored()).state) + exported;
  for (const forbidden of [
    credentials.username,
    credentials.password,
    credentials.note,
    credentials.url,
    "embedded-user",
    "embedded-password",
    "private-query",
    "temporary-token",
  ]) {
    assert.equal(publicData.includes(forbidden), false);
  }
  assert.equal(JSON.parse(exported).links.length, 1);

  await page
    .locator("aside.app-sidebar:visible")
    .getByRole("button", { name: "锁定密钥库", exact: true })
    .click();
  await accountRow().click();
  gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.waitFor();
  assert.equal(await page.getByText(credentials.username, { exact: true }).count(), 0);
  assert.equal(await page.getByText(credentials.url, { exact: true }).count(), 0);
  await gate.getByRole("button", { name: "取消", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByRole("button", { name: "解锁查看", exact: true }).waitFor();
  assert.equal(await details.getByText(credentials.username, { exact: true }).count(), 0);
  assert.equal(await details.getByText(credentials.url, { exact: true }).count(), 0);
  await details.getByRole("button", { name: "解锁查看", exact: true }).click();
  gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill("integration-master-2026");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  await details.getByText(credentials.username, { exact: true }).waitFor();
  await details.getByRole("button", { name: "解除关联", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      isolated: true,
      websiteForm: true,
      safeUrlPaste: true,
      cancelUnlockRetainsForm: true,
      encryptedCredentials: true,
      mailboxRelation: true,
      reloadPersistence: true,
      exportExcludesCredentials: true,
      lockedDetailsHidden: true,
      desktopMobile: true,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
}
