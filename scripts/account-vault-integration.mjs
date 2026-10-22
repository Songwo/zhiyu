import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 仅启动临时工作区，不读取真实用户的库、文档或剪贴板。
const directory = await mkdtemp(join(tmpdir(), "nanpad-account-vault-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
const fixture = {
  name: "Apple ID 资料回归",
  username: "account-owner-unique@example.test",
  password: "account-initial-password-2026",
  replacement: "account-replacement-password-2026",
  url: "https://account.example.test/private-login",
  note: "account-sensitive-recovery-code-2026",
};
let instance;
try {
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  const page = await instance.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  const stored = () => page.evaluate(() => window.sinan.store.load());
  const mockClipboard = () =>
    page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (value) => {
          window.__accountCopied = value;
        },
      });
      Object.defineProperty(navigator.clipboard, "readText", {
        configurable: true,
        value: async () => "",
      });
    });
  await mockClipboard();
  await page
    .locator("aside:visible nav")
    .getByRole("button", { name: /^密钥库/ })
    .click();

  // 让 Alice 的真实 IPC 写入挂起；关闭后打开 Bob，旧完成不能保存元数据或关闭 Bob。
  for (const lockAfterWrite of [false, true]) {
    await instance.evaluate(({ ipcMain }, lockAfterWrite) => {
      const original = ipcMain._invokeHandlers.get("vault:set");
      globalThis.accountOriginalSetHandler = original;
      let started, release, completed;
      globalThis.accountDelayedStarted = new Promise((resolve) => {
        started = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      globalThis.accountDelayedRelease = release;
      globalThis.accountDelayedCompleted = new Promise((resolve) => {
        completed = resolve;
      });
      ipcMain.removeHandler("vault:set");
      ipcMain.handle("vault:set", async (event, id, record) => {
        if (record.username !== "alice-delayed@example.test") return original(event, id, record);
        globalThis.accountDelayedId = id;
        started();
        await gate;
        const result = await original(event, id, record);
        if (lockAfterWrite) await ipcMain._invokeHandlers.get("vault:lock")(event);
        completed();
        return result;
      });
    }, lockAfterWrite);
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    let pendingComposer = page.getByRole("dialog", { name: "账号密码", exact: true });
    await pendingComposer.getByLabel("显示名称", { exact: true }).fill("Alice 已取消保存");
    await pendingComposer.getByLabel("账户名", { exact: true }).fill("alice-delayed@example.test");
    await pendingComposer.getByLabel("密码", { exact: true }).fill("alice-delayed-password");
    await pendingComposer.getByRole("button", { name: "添加", exact: true }).click();
    await instance.evaluate(() =>
      Promise.race([
        globalThis.accountDelayedStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("延迟写入没有启动")), 5000)),
      ]),
    );
    await pendingComposer.getByRole("button", { name: "取消", exact: true }).click();
    await pendingComposer.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    pendingComposer = page.getByRole("dialog", { name: "账号密码", exact: true });
    await pendingComposer.getByLabel("显示名称", { exact: true }).fill("Bob 未保存草稿");
    await pendingComposer.getByLabel("账户名", { exact: true }).fill("bob-draft@example.test");
    await pendingComposer.getByLabel("密码", { exact: true }).fill("bob-draft-password");
    const delayedId = await instance.evaluate(async () => {
      globalThis.accountDelayedRelease();
      await globalThis.accountDelayedCompleted;
      return globalThis.accountDelayedId;
    });
    if (lockAfterWrite) {
      await page.waitForFunction(async () =>
        (await window.sinan.store.load()).state.secrets.some(
          (secret) => secret.name === "Alice 已取消保存",
        ),
      );
    } else
      await page.waitForFunction(
        async (id) => !(await window.sinan.vault.list()).includes(id),
        delayedId,
      );
    assert.equal(await pendingComposer.isVisible(), true);
    assert.equal(
      await pendingComposer.getByLabel("显示名称", { exact: true }).inputValue(),
      "Bob 未保存草稿",
    );
    if (!lockAfterWrite)
      assert.equal(
        await pendingComposer.getByLabel("密码", { exact: true }).inputValue(),
        "bob-draft-password",
      );
    assert.equal(
      (await stored()).state.secrets.some((secret) => secret.name === "Alice 已取消保存"),
      lockAfterWrite,
    );
    if (lockAfterWrite) {
      await pendingComposer.getByRole("button", { name: "解锁密钥库", exact: true }).click();
      await page
        .locator(".z-gate")
        .locator('input[type="password"]')
        .fill("integration-master-2026");
      await page.locator(".z-gate").getByRole("button", { name: "解锁", exact: true }).click();
      await page.locator(".z-gate").waitFor({ state: "detached" });
      assert.equal(
        (await page.evaluate((id) => window.sinan.vault.get(id), delayedId)).username,
        "alice-delayed@example.test",
      );
    }
    await pendingComposer.getByRole("button", { name: "取消", exact: true }).click();
    await pendingComposer.waitFor({ state: "detached" });
    await instance.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("vault:set");
      ipcMain.handle("vault:set", globalThis.accountOriginalSetHandler);
    });
    if (lockAfterWrite) {
      await page.getByRole("button", { name: "打开分组 未分组", exact: true }).click();
      await page
        .getByRole("checkbox", { name: "选择密钥 Alice 已取消保存", exact: true })
        .locator("..")
        .getByRole("button", { name: "查看账号与凭据 Alice 已取消保存", exact: true })
        .click();
      const recoverable = page.getByRole("region", { name: "资产详情", exact: true });
      await recoverable.getByText("alice-delayed@example.test", { exact: true }).waitFor();
      await recoverable.getByRole("button", { name: "删除", exact: true }).click();
      await page
        .getByRole("dialog", { name: "删除账号", exact: true })
        .getByRole("button", { name: "确认删除账号", exact: true })
        .click();
      await recoverable.waitFor({ state: "detached" });
      assert.equal(await page.evaluate((id) => window.sinan.vault.get(id), delayedId), null);
    }
  }

  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  let composer = page.getByRole("dialog", { name: "账号密码", exact: true });
  await composer.getByLabel("显示名称", { exact: true }).fill(fixture.name);
  assert.equal(await composer.getByLabel("提示", { exact: true }).count(), 0);
  assert.equal(await composer.getByLabel("说明", { exact: true }).count(), 0);
  await composer.getByLabel("账户名", { exact: true }).fill(fixture.username);
  await composer.getByLabel("密码", { exact: true }).fill(fixture.password);
  await composer.getByLabel("登录网址", { exact: true }).fill(fixture.url);
  await composer.getByLabel("敏感备注", { exact: true }).fill(fixture.note);
  await composer.getByRole("button", { name: "添加", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  await page.waitForFunction(
    (name) =>
      window.sinan.store
        .load()
        .then((snapshot) => snapshot.state.secrets.some((secret) => secret.name === name)),
    fixture.name,
  );
  const account = (await stored()).state.secrets.find((secret) => secret.name === fixture.name);
  assert.equal(account.kind, "account");
  for (const field of ["hint", "value", "notes"]) assert.equal(account[field], "");
  const credential = () =>
    page.evaluate((id) => window.sinan.vault.get(`account:${id}`), account.id);
  assert.equal((await credential()).username, fixture.username);
  assert.equal((await credential()).password, fixture.password);

  // 准备一个已有文档；关联只增加资产引用，不复制账号字段。
  await page.evaluate(async () => {
    const now = new Date().toISOString();
    await window.sinan.documents.save({
      id: "doc-account-existing-fixture",
      title: "已有注册资料",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "账号注册说明（示例）" }] }],
      },
      bindings: [],
      createdAt: now,
      updatedAt: now,
    });
  });
  async function openAccount() {
    await page
      .locator("aside:visible nav")
      .getByRole("button", { name: /^密钥库/ })
      .click();
    const group = page.getByRole("button", { name: "打开分组 未分组", exact: true });
    const row = page.getByRole("checkbox", { name: `选择密钥 ${fixture.name}`, exact: true });
    await group.or(row).first().waitFor();
    if (await group.isVisible()) await group.click();
    await page
      .getByRole("checkbox", { name: `选择密钥 ${fixture.name}`, exact: true })
      .locator("..")
      .getByRole("button", { name: `查看账号与凭据 ${fixture.name}`, exact: true })
      .click();
    const details = page.getByRole("region", { name: "资产详情", exact: true });
    await details.waitFor();
    return details;
  }
  let details = await openAccount();
  await details.getByText(fixture.username, { exact: true }).waitFor();
  await details.getByRole("button", { name: "复制账户名", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__accountCopied), fixture.username);
  await details.getByRole("button", { name: "复制密码", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__accountCopied), fixture.password);
  assert.equal(await details.getByText(fixture.password, { exact: true }).count(), 0);

  await details.getByRole("button", { name: "编辑账号", exact: true }).click();
  composer = page.getByRole("dialog", { name: "账号密码", exact: true });
  await page.waitForFunction(
    () =>
      document.querySelector('[name="account-username"]')?.value ===
      "account-owner-unique@example.test",
  );
  assert.equal(await composer.getByLabel("密码", { exact: true }).inputValue(), "");
  await composer.getByLabel("敏感备注", { exact: true }).fill(fixture.note + "-updated");
  await composer.getByRole("button", { name: "保存", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  assert.equal((await credential()).password, fixture.password);
  assert.equal((await credential()).note, fixture.note + "-updated");

  details = await openAccount();
  await details.getByRole("button", { name: "编辑账号", exact: true }).click();
  composer = page.getByRole("dialog", { name: "账号密码", exact: true });
  await composer.getByLabel("密码", { exact: true }).fill(fixture.replacement);
  await composer.getByRole("button", { name: "保存", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  assert.equal((await credential()).password, fixture.replacement);

  details = await openAccount();
  const documents = details.getByRole("region", { name: "账号资料", exact: true });
  await documents.getByRole("button", { name: "关联已有文档", exact: true }).click();
  await documents.getByRole("button", { name: "关联文档 已有注册资料", exact: true }).click();
  await documents.getByText("账号注册说明（示例）", { exact: true }).waitFor();
  let linked = await page.evaluate(() =>
    window.sinan.documents.get("doc-account-existing-fixture"),
  );
  assert.deepEqual(linked.bindings, [{ kind: "secret", id: account.id }]);
  for (const value of Object.values(fixture).filter((value) => value !== fixture.name))
    assert.equal(JSON.stringify(linked).includes(value), false);
  await documents.getByRole("button", { name: "解除关联 已有注册资料", exact: true }).click();
  await documents
    .getByRole("button", { name: "解除关联 已有注册资料", exact: true })
    .waitFor({ state: "detached" });
  linked = await page.evaluate(() => window.sinan.documents.get("doc-account-existing-fixture"));
  assert.deepEqual(linked.bindings, []);
  assert.equal(linked.title, "已有注册资料");
  await documents.getByRole("button", { name: "关联已有文档", exact: true }).click();
  await documents.getByRole("button", { name: "关联文档 已有注册资料", exact: true }).click();
  await documents.getByRole("button", { name: /已有注册资料.*打开/ }).click();
  await details.waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "已有注册资料", exact: true }).waitFor();
  await page.getByRole("button", { name: /^关联与设置/ }).click();
  await page.getByRole("button", { name: `打开资产 ${fixture.name}`, exact: true }).click();
  details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByText(fixture.username, { exact: true }).waitFor();
  await details
    .getByRole("region", { name: "账号资料", exact: true })
    .getByRole("button", { name: "新建文档", exact: true })
    .click();
  await details.waitFor({ state: "detached" });
  await page.getByRole("heading", { name: `${fixture.name} · 账号资料`, exact: true }).waitFor();
  const createdDocument = (await page.evaluate(() => window.sinan.documents.list())).find(
    (doc) => doc.title === "Apple ID 资料回归 · 账号资料",
  );
  assert.deepEqual(createdDocument.bindings, [{ kind: "secret", id: account.id }]);

  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await mockClipboard();
  details = await openAccount();
  await details.getByText(fixture.username, { exact: true }).waitFor();
  await mkdir(resolve("screenshots"), { recursive: true });
  await page.screenshot({ path: "screenshots/account-vault-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await details.getByRole("heading", { name: "账号密码", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "screenshots/account-vault-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.evaluate(() => window.sinan.vault.lock());
  await details.getByRole("button", { name: "解锁查看", exact: true }).waitFor();
  for (const value of [fixture.username, fixture.url, fixture.note + "-updated"]) {
    assert.equal(await details.getByText(value, { exact: true }).count(), 0);
  }
  await details.getByRole("button", { name: "解锁查看", exact: true }).click();
  await page.locator(".z-gate").locator('input[type="password"]').fill("integration-master-2026");
  await page.locator(".z-gate").getByRole("button", { name: "解锁", exact: true }).click();
  await details.getByText(fixture.username, { exact: true }).waitFor();

  // 锁库清除正在编辑的敏感草稿，重新解锁回填的是已保存版本。
  await details.getByRole("button", { name: "编辑账号", exact: true }).click();
  composer = page.getByRole("dialog", { name: "账号密码", exact: true });
  await composer.getByLabel("账户名", { exact: true }).fill("unsaved-sensitive-username");
  await composer.getByLabel("密码", { exact: true }).fill("unsaved-sensitive-password");
  await page.evaluate(() => window.sinan.vault.lock());
  await composer.getByRole("button", { name: "解锁密钥库", exact: true }).waitFor();
  assert.equal(await details.getByText(fixture.username, { exact: true }).count(), 0);
  assert.equal(await composer.locator('[name="account-password"]').count(), 0);
  await composer.getByRole("button", { name: "解锁密钥库", exact: true }).click();
  const gate = page.locator(".z-gate");
  await gate.locator('input[type="password"]').fill("integration-master-2026");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await gate.waitFor({ state: "detached" });
  await page.waitForFunction(
    () =>
      document.querySelector('[name="account-username"]')?.value ===
      "account-owner-unique@example.test",
  );
  assert.equal(await composer.getByLabel("密码", { exact: true }).inputValue(), "");
  await composer.getByRole("button", { name: "取消", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  await details.waitFor({ state: "detached" });

  const exportPath = join(directory, "export.json");
  await instance.evaluate(({ session }, target) => {
    globalThis.accountExportCompletion = new Promise((resolve) => {
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
  assert.equal(await instance.evaluate(() => globalThis.accountExportCompletion), "completed");
  const exported = await readFile(exportPath, "utf8");
  assert.ok(JSON.parse(exported).secrets.some((secret) => secret.id === account.id));
  const publicData =
    (await readFile(join(directory, "assets.json"), "utf8")) +
    exported +
    JSON.stringify(await page.evaluate(() => window.sinan.documents.list()));
  const vaultFile = await readFile(join(directory, "vault.enc"), "utf8");
  for (const sensitive of [
    fixture.username,
    fixture.password,
    fixture.replacement,
    fixture.url,
    fixture.note,
    "unsaved-sensitive-username",
    "unsaved-sensitive-password",
  ]) {
    assert.equal(publicData.includes(sensitive), false, "普通资产与导出不得包含凭据");
    assert.equal(vaultFile.includes(sensitive), false, "凭据落盘必须是密文");
  }

  details = await openAccount();
  await page.evaluate(() => window.sinan.vault.lock());
  await details.getByRole("button", { name: "解锁查看", exact: true }).waitFor();
  await details.getByRole("button", { name: "删除", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除账号", exact: true })
    .getByRole("button", { name: "确认删除账号", exact: true })
    .click();
  await page.locator(".z-gate").getByRole("button", { name: "取消", exact: true }).last().click();
  assert.ok((await stored()).state.secrets.some((secret) => secret.id === account.id));
  await details.getByRole("button", { name: "删除", exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除账号", exact: true })
    .getByRole("button", { name: "确认删除账号", exact: true })
    .click();
  await page.locator(".z-gate").locator('input[type="password"]').fill("integration-master-2026");
  await page.locator(".z-gate").getByRole("button", { name: "解锁", exact: true }).click();
  // Radix解锁层会暂时从可访问树隐藏底层详情，必须先等解锁结束再判断删除完成。
  await page.locator(".z-gate").waitFor({ state: "detached" });
  await details.waitFor({ state: "detached" });
  assert.equal(await credential(), null);
  await page.waitForFunction(
    (id) =>
      window.sinan.store
        .load()
        .then((snapshot) => !snapshot.state.secrets.some((secret) => secret.id === id)),
    account.id,
  );
  assert.equal((await page.evaluate(() => window.sinan.documents.list())).length, 2);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      isolated: true,
      accountCreated: true,
      delayedSaveCannotCloseNextDraft: true,
      cancelledCleanupFailureLeavesManageableAccount: true,
      passwordPreservedWhenBlank: true,
      passwordUpdated: true,
      encryptedOnly: true,
      lockedDraftCleared: true,
      copyActions: true,
      bindUnbindExistingDocument: true,
      bidirectionalNavigation: true,
      createAccountDocument: true,
      exportExcludesCredentials: true,
      lockedDeleteCancelPreservesAccount: true,
      deletedCredentialWithDocumentsRetained: true,
      desktopMobile: true,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("nanpad-account-vault-"));
  await rm(directory, { recursive: true, force: true });
}
