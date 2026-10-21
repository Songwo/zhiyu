import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 验证固定保存栏与密钥库弹窗的接力，全程只使用临时桌面数据。
const directory = await mkdtemp(join(tmpdir(), "nanpad-composer-vault-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
try {
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  const page = await instance.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 850 });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.getByRole("button", { name: "添加资产", exact: true }).click();
  await page
    .getByRole("dialog", { name: "选择资产类型", exact: true })
    .getByRole("button", { name: "添加密钥", exact: true })
    .click();
  const composer = page.getByRole("dialog", { name: "密钥", exact: true });
  await composer.getByRole("combobox", { name: "类型", exact: true }).click();
  await page.getByRole("option", { name: "网站账号 / 密码", exact: true }).click();
  await composer.getByLabel("名称", { exact: true }).fill("凭据表单回归");
  await composer.getByLabel("登录地址", { exact: true }).fill("https://accounts.example.test");
  await composer.getByLabel("账号", { exact: true }).fill("fixture-user");
  await composer.getByLabel("密码", { exact: true }).fill("fixture-password-2026");
  await page.evaluate(() => window.sinan.vault.lock());

  // Escape 与取消按钮均只退出解锁，保留草稿且不写入半成品资产。
  for (const cancel of ["Escape", "button"]) {
    await composer.getByRole("button", { name: "添加", exact: true }).click();
    const gate = page.locator(".z-gate");
    await gate.waitFor();
    if (cancel === "Escape") await page.keyboard.press("Escape");
    else await gate.getByRole("button", { name: "取消", exact: true }).last().click();
    await gate.waitFor({ state: "detached" });
    assert.equal(await composer.isVisible(), true);
    assert.equal(await composer.getByLabel("名称", { exact: true }).inputValue(), "凭据表单回归");
    // 密钥库锁定时原有安全逻辑会隐藏账号字段；下方通过解锁后的加密记录验证草稿保留。
    assert.equal(
      await composer.getByRole("button", { name: "解锁密钥库", exact: true }).isVisible(),
      true,
    );
    assert.equal((await page.evaluate(() => window.sinan.store.load())).state.secrets.length, 0);
  }

  await composer.getByRole("button", { name: "添加", exact: true }).click();
  const gate = page.locator(".z-gate");
  await gate.locator('input[type="password"]').fill("integration-master-2026");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  // 解锁弹窗是模态框，打开期间编辑器被 aria-hidden，按角色查找会提前判定已关闭；
  // 先等弹窗退出，再等表单节点本身卸载，确保保存已经完成。
  await gate.waitFor({ state: "detached" });
  await page.locator("#asset-composer-form").waitFor({ state: "detached" });
  const snapshot = await page.evaluate(() => window.sinan.store.load());
  assert.equal(snapshot.state.secrets.length, 1);
  const asset = snapshot.state.secrets[0];
  const account = await page.evaluate((id) => window.sinan.vault.get(`account:${id}`), asset.id);
  assert.equal(account.username, "fixture-user");
  assert.equal(account.password, "fixture-password-2026");
  assert.equal(JSON.stringify(snapshot.state).includes("fixture-password-2026"), false);
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.equal((await page.evaluate(() => window.sinan.store.load())).state.secrets.length, 1);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      isolated: true,
      cancelAndEscapeRetainDraft: true,
      unlockedSave: true,
      encryptedCredentials: true,
      reloadPersistence: true,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("nanpad-composer-vault-"));
  await rm(directory, { recursive: true, force: true });
}
