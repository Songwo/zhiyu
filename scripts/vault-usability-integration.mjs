import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { Vault } from "../electron/services/vault.mjs";

// 合成账号和隔离数据目录；复制动作只写测试变量，不碰系统剪贴板。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-vault-usability-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
await writeFile(
  join(directory, "local-usage.json"),
  JSON.stringify({ version: 1, enabled: false, checkpoints: [], events: [], records: [] }),
);
const fixture = {
  id: "secret-usability-web",
  name: "回归测试网站账号",
  username: "fixture@example.test",
  password: "synthetic-vault-password-2026",
  url: "https://example.test/login",
};
let instance;
let page;
try {
  // 测试按中文标签定位，固定语言，避免跟随 CI 主机的系统语言。
  instance = await electron.launch({
    args: [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  page = await instance.firstWindow();
  page.setDefaultTimeout(12000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(async (fixture) => {
    await window.sinan.vault.set(`account:${fixture.id}`, {
      kind: "account",
      username: fixture.username,
      password: fixture.password,
      url: fixture.url,
    });
    const snapshot = await window.sinan.store.load();
    snapshot.state.secrets = [
      {
        id: fixture.id,
        name: fixture.name,
        kind: "password",
        hint: "",
        value: "",
        notes: "",
        tags: [],
        status: "online",
        lastRotated: "2026-10-01",
      },
    ];
    snapshot.state.secretFolders = [];
    await window.sinan.store.save(snapshot);
    const now = new Date().toISOString();
    await window.sinan.documents.save({
      id: "doc-vault-usability",
      title: "合成账号说明",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "测试账号的操作说明。" }] }],
      },
      bindings: [],
      createdAt: now,
      updatedAt: now,
    });
  }, fixture);
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (value) => {
        window.__vaultCopied = value;
      },
    }),
  );
  const sidebar = page.locator("aside.app-sidebar:visible");
  await sidebar.getByRole("button", { name: "密钥库", exact: true }).click();
  await page.getByRole("button", { name: "打开分组 未分组", exact: true }).click();
  const row = page.getByRole("button", { name: `查看账号与凭据 ${fixture.name}`, exact: true });
  await row.waitFor();
  assert.equal(await sidebar.getByRole("button", { name: "关系图", exact: true }).count(), 0);
  assert.equal(await sidebar.getByRole("button", { name: "设置", exact: true }).count(), 0);
  const titlebar = page.locator("header.app-titlebar");
  const settings = titlebar.getByRole("button", { name: "系统设置…", exact: true });
  const settingsBox = await settings.boundingBox();
  const titlebarBox = await titlebar.boundingBox();
  assert.ok(
    settingsBox &&
      titlebarBox &&
      settingsBox.y >= titlebarBox.y &&
      settingsBox.y + settingsBox.height <= titlebarBox.y + titlebarBox.height,
    "设置回到顶部标题栏原位置",
  );
  await settings.click();
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "detached" });
  await sidebar.getByRole("button", { name: "锁定密钥库", exact: true }).click();
  await page.getByText("密钥库已锁定", { exact: true }).first().waitFor();
  await row.click();
  let gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.waitFor();
  assert.equal(await page.getByText(fixture.username, { exact: true }).count(), 0);
  await gate.getByRole("button", { name: "取消", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  let details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.waitFor();
  await details.getByRole("button", { name: "解锁查看", exact: true }).click();
  gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill("wrong-password-fixture");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.getByRole("alert").waitFor();
  assert.equal((await page.evaluate(() => window.sinan.vault.status())).unlocked, false);
  await gate.getByLabel("主密码", { exact: true }).fill("integration-master-2026");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  await details.getByText(fixture.username, { exact: true }).waitFor();
  assert.equal(await details.getByText(fixture.password, { exact: true }).count(), 0);
  await details.getByRole("button", { name: "显示", exact: true }).click();
  await details.getByText(fixture.password, { exact: true }).waitFor();
  // 外部恢复触发的内部锁定，也必须通知页面清除已显示的账号与密码。
  const originalVault = await readFile(join(directory, "vault.enc"));
  const restoredFile = join(directory, "restored.enc");
  const restoredVault = new Vault(restoredFile);
  await restoredVault.create("restored-backup-master-2026");
  await restoredVault.set(`account:${fixture.id}`, {
    kind: "account",
    username: fixture.username,
    password: fixture.password,
    url: fixture.url,
  });
  restoredVault.lock();
  await writeFile(join(directory, "vault.enc"), await readFile(restoredFile));
  assert.equal((await page.evaluate(() => window.sinan.vault.status())).unlocked, false);
  await details.getByRole("button", { name: "解锁查看", exact: true }).waitFor();
  assert.equal(await details.getByText(fixture.password, { exact: true }).count(), 0);
  assert.equal(await details.getByText(fixture.username, { exact: true }).count(), 0);
  await details.getByRole("button", { name: "解锁查看", exact: true }).click();
  gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill("restored-backup-master-2026");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  await details.getByText(fixture.username, { exact: true }).waitFor();
  await writeFile(join(directory, "vault.enc"), originalVault);
  assert.equal((await page.evaluate(() => window.sinan.vault.status())).unlocked, false);
  await details.getByRole("button", { name: "解锁查看", exact: true }).click();
  gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill("integration-master-2026");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  await details.getByRole("button", { name: "显示", exact: true }).click();
  await details.getByText(fixture.password, { exact: true }).waitFor();
  await details.getByRole("button", { name: "隐藏", exact: true }).click();
  await details.getByRole("button", { name: "复制密码", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__vaultCopied), fixture.password);
  const credentialBox = await details
    .getByRole("region", { name: "网站登录账号", exact: true })
    .boundingBox();
  assert.ok(credentialBox && credentialBox.y < 500, "网站账号凭据出现在详情靠前位置");

  // 复用现有编辑与绑定文档；保存不触发锁库、不重复询问主密码。
  await details.getByRole("button", { name: "编辑账号", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "密钥", exact: true });
  await composer.waitFor();
  await composer.getByLabel("账号", { exact: true }).fill("updated-fixture@example.test");
  await composer.getByRole("button", { name: "保存", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  assert.equal((await page.evaluate(() => window.sinan.vault.status())).unlocked, true);
  assert.equal(await page.locator(".z-gate").count(), 0);
  await row.click();
  details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByText("updated-fixture@example.test", { exact: true }).waitFor();
  await details.getByRole("button", { name: "关联已有文档", exact: true }).click();
  await details.getByRole("button", { name: "关联文档 合成账号说明", exact: true }).click();
  const linked = await page.evaluate(() => window.sinan.documents.get("doc-vault-usability"));
  assert.deepEqual(linked.bindings, [{ kind: "secret", id: fixture.id }]);
  assert.equal(JSON.stringify(linked).includes(fixture.password), false);
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/vault-usability-desktop.png" });

  // 模拟操作系统锁屏事件，确认已显示的私密值立即消失；解锁可原地继续。
  await instance.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
  await details.getByRole("button", { name: "解锁查看", exact: true }).waitFor();
  assert.equal(await details.getByText("updated-fixture@example.test", { exact: true }).count(), 0);
  await details.getByRole("button", { name: "解锁查看", exact: true }).click();
  await page.getByRole("dialog", { name: "解锁密钥库", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".z-gate").waitFor({ state: "detached" });
  assert.equal(await details.isVisible(), true, "Escape只取消解锁，不关闭原详情");
  await details.getByRole("button", { name: "解锁查看", exact: true }).click();
  gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill("integration-master-2026");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/vault-usability-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await details.getByRole("button", { name: "删除", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除账号", exact: true })
    .getByRole("button", { name: "确认删除账号", exact: true })
    .click();
  await details.waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate((id) => window.sinan.vault.get(`account:${id}`), fixture.id),
    null,
  );
  assert.equal(
    (await page.evaluate(() => window.sinan.store.load())).state.secrets.some(
      (item) => item.id === fixture.id,
    ),
    false,
  );
  assert.ok(
    await page.evaluate(() => window.sinan.documents.get("doc-vault-usability")),
    "删除账号保留关联文档",
  );
  for (const name of ["assets.json", "vault.enc"]) {
    const raw = await readFile(join(directory, name), "utf8");
    assert.equal(raw.includes(fixture.password), false);
    assert.equal(raw.includes("integration-master-2026"), false);
  }
  assert.deepEqual(errors, []);
  console.log(
    "密钥库体验集成通过：账号行、固定入口、取消/错误密码/解锁继续、显隐复制、编辑免重复解锁、绑定文档、锁屏清理和网站账号加密删除。",
  );
} catch (error) {
  await page?.screenshot({ path: "screenshots/vault-usability-failure.png" }).catch(() => {});
  throw error;
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
}
