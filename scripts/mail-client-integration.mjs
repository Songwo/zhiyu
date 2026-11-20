import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { chooseOption } from "./select-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "nanpad-mail-ui-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
try {
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const pageErrors = [];
  const imageRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://images.example.test/**", async (route) => {
    imageRequests.push(route.request().url());
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  });
  await page.setViewportSize({ width: 1280, height: 960 });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(async () => {
    const saved = await window.sinan.store.load();
    saved.state.mailFolders = [
      { id: "work", name: "工作邮箱", color: "blue" },
      { id: "personal", name: "生活邮箱", color: "green" },
    ];
    saved.state.mailboxes = Array.from({ length: 9 }, (_, index) => ({
      id: `mail-${index}`,
      address: `account${index}@example.test`,
      domain: "example.test",
      kind: "mailbox",
      tags: [],
      status: "online",
      notes: "",
      usedMb: 0,
      quotaMb: 1000,
      folderId: index < 4 ? "work" : index < 7 ? "personal" : undefined,
      imap: { host: "imap.example.test", port: 993, secure: true },
      smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
    }));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d");
    context.fillStyle = "#3973b7";
    context.fillRect(0, 0, 96, 96);
    context.fillStyle = "#ffffff";
    context.font = "bold 36px sans-serif";
    context.textAlign = "center";
    context.fillText("AP", 48, 61);
    saved.state.mailboxes[0].imageDataUrl = canvas.toDataURL("image/png");
    await window.sinan.store.save(saved);
    await window.sinan.vault.set("account:mail-0", {
      username: "account0@example.test",
      password: "fixture-password",
    });
  });
  // UI 测试替换涉及网络的 IPC，草稿、凭据和资产持久化仍走真实主进程；协议解析另有服务测试。
  await instance.evaluate(({ ipcMain }) => {
    let seen = false;
    globalThis.mailUiTestSent = [];
    const summary = (uid = 10) => ({
      uid,
      subject: {
        10: "Weekly delivery",
        11: "产品设计评审 · 九月迭代",
        12: "Release notes",
        13: "周五会议安排",
        14: "本月服务账单",
        15: "安全登录通知",
      }[uid],
      from: [{ name: "Product Team", address: "team@example.test" }],
      to: [{ name: "", address: "account0@example.test" }],
      date: "2026-09-09T01:00:00Z",
      seen,
      size: 200,
    });
    const methods = {
      folders: () => [
        { path: "INBOX", name: "Inbox", specialUse: null },
        { path: "Sent", name: "Sent", specialUse: "\\Sent" },
      ],
      messages: async (_id, options) => {
        await new Promise((resolve) => setTimeout(resolve, 650));
        return {
          items: options.unseen && seen ? [] : [10, 11, 12, 13, 14, 15].map(summary),
          total: 6,
          page: 0,
          folder: options.folder,
          uidValidity: "123",
        };
      },
      read: async (_id, selection) => {
        await new Promise((resolve) => setTimeout(resolve, 650));
        return {
          ...summary(selection.uid),
          text:
            selection.uid === 12
              ? "## Release notes\n\n![Release preview](https://images.example.test/markdown.png)"
              : "## 本周交付进展\n\nPrivate weekly delivery body.\n\n**评审结论已确认**，下周进入发布验收。\n\n- 邮件工作台布局调整\n- 本地分组检索接入\n- 头像与正文图片验证\n\n| 阶段 | 状态 |\n| --- | --- |\n| 设计评审 | 已确认 |\n| 发布验收 | 进行中 |\n\n> Do not send this content to AI.",
          ...(selection.uid === 11
            ? {
                html: '<h2>九月迭代设计评审</h2><p>邮件工作台的<strong>阅读布局与头像</strong>已经进入验收。</p><ul><li>账号按文件夹收纳</li><li>正文和附件按需读取</li></ul><table><tr><th>负责人</th><th>进度</th></tr><tr><td>Product Team</td><td>待发布</td></tr></table><img alt="设计预览" data-mail-remote-src="https://images.example.test/design.png"><p>感谢参与本轮评审。</p>',
              }
            : {}),
          messageId: `<message-${selection.uid}@example.test>`,
          replyTo: [{ name: "", address: "team@example.test" }],
          cc: [],
          attachments: [],
        };
      },
      seen: async (_id, _selection, value) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        seen = value;
        return true;
      },
      send: (_id, value) => {
        globalThis.mailUiTestSent.push(value);
        return { messageId: "<sent@example.test>", accepted: [value.to], rejected: [] };
      },
    };
    for (const [name, method] of Object.entries(methods)) {
      ipcMain.removeHandler(`mail-client:${name}`);
      ipcMain.handle(`mail-client:${name}`, async (_event, ...args) => ({
        ok: true,
        data: await method(...args),
      }));
    }
  });
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.getByRole("button", { name: "邮箱", exact: true }).click();
  await page.getByRole("button", { name: "打开文件夹 工作邮箱", exact: true }).waitFor();
  assert.equal(await page.locator("[data-mailbox-id]").count(), 0);
  await page.getByPlaceholder("筛选当前列表", { exact: true }).fill("工作邮箱");
  assert.equal(
    await page.getByRole("button", { name: "打开文件夹 工作邮箱", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "打开文件夹 生活邮箱", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "打开文件夹 工作邮箱", exact: true }).click();
  assert.equal(await page.locator("[data-mailbox-id]").count(), 4);
  await page.getByRole("button", { name: "返回文件夹", exact: true }).click();
  await page.getByPlaceholder("筛选当前列表", { exact: true }).fill("");
  await page.screenshot({ path: "screenshots/nanpad-v060-mail-folders.png" });
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  await editor.getByRole("textbox", { name: "文件夹名称", exact: true }).fill("项目通知");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "打开文件夹 未分组", exact: true }).click();
  await page.getByRole("checkbox", { name: "全选", exact: true }).check();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "移动到文件夹", exact: true }),
    "项目通知",
  );
  await page.getByText("没有匹配的邮箱。", { exact: true }).waitFor();
  const snapshot = await page.evaluate(() => window.sinan.store.load());
  const folder = snapshot.state.mailFolders.find((item) => item.name === "项目通知");
  assert.equal(snapshot.state.mailboxes.filter((item) => item.folderId === folder.id).length, 2);
  await page.getByRole("button", { name: "返回文件夹", exact: true }).click();
  await page.getByRole("button", { name: "打开文件夹 工作邮箱", exact: true }).click();
  await page
    .locator('[data-mailbox-id="mail-0"]')
    .getByRole("button", { name: /account0@example.test/ })
    .filter({ has: page.locator("span.font-medium") })
    .click();
  const reader = page.getByRole("dialog", { name: "account0@example.test", exact: true });
  await reader.getByRole("status", { name: "正在读取邮件", exact: true }).waitFor();
  await page.screenshot({ path: "screenshots/nanpad-v060-mail-loading.png" });
  await reader.getByRole("button", { name: "查看邮件 Weekly delivery", exact: true }).click();
  await reader.getByText(/Private weekly delivery body/).waitFor();
  assert.equal(await reader.getByRole("heading", { name: "本周交付进展", exact: true }).count(), 1);
  assert.equal(await reader.locator(".markdown-body table").count(), 1);
  await reader.getByRole("button", { name: "原文", exact: true }).click();
  assert.ok((await reader.locator("pre").innerText()).includes("## 本周交付进展"));
  await reader.getByRole("button", { name: "排版", exact: true }).click();
  await reader.getByRole("button", { name: "编辑发件人头像", exact: true }).click();
  const avatarDialog = page.getByRole("dialog", { name: "发件人头像", exact: true });
  const avatar = await page.evaluate(
    async () => (await window.sinan.store.load()).state.mailboxes[0].imageDataUrl,
  );
  await avatarDialog.locator('input[type="file"]').setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(avatar.split(",")[1], "base64"),
  });
  await avatarDialog.getByRole("button", { name: "更换图片", exact: true }).waitFor();
  await avatarDialog.getByRole("button", { name: "保存", exact: true }).click();
  await avatarDialog.waitFor({ state: "detached" });
  assert.ok(
    await reader
      .getByRole("button", { name: "编辑发件人头像", exact: true })
      .locator("img")
      .evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  assert.equal(
    (await page.evaluate(() => window.sinan.store.load())).state.mailboxes[0].senderAvatars[0]
      .address,
    "team@example.test",
  );
  // 模拟一次磁盘写入失败，确认编辑器不会把未保存头像留在资产状态中。
  await instance.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get("store:save");
    let failNext = true;
    ipcMain.removeHandler("store:save");
    ipcMain.handle("store:save", (...args) => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: "Avatar save fixture failure" };
      }
      return handler(...args);
    });
  });
  await reader.getByRole("button", { name: "编辑发件人头像", exact: true }).click();
  await avatarDialog.getByRole("button", { name: "移除图片", exact: true }).click();
  await avatarDialog.getByRole("button", { name: "保存", exact: true }).click();
  await avatarDialog
    .getByRole("alert")
    .filter({ hasText: "Avatar save fixture failure" })
    .waitFor();
  await avatarDialog.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(
    await reader
      .getByRole("button", { name: "编辑发件人头像", exact: true })
      .locator("img")
      .count(),
    1,
  );
  assert.equal(
    (await page.evaluate(() => window.sinan.store.load())).state.mailboxes[0].senderAvatars.length,
    1,
  );
  await reader
    .getByRole("button", { name: "查看邮件 产品设计评审 · 九月迭代", exact: true })
    .click();
  await reader.getByRole("heading", { name: "九月迭代设计评审", exact: true }).waitFor();
  assert.equal(imageRequests.length, 0);
  await page.screenshot({ path: "screenshots/nanpad-v060-mail-rich-html.png" });
  await reader.getByRole("button", { name: "加载本封图片", exact: true }).click();
  await reader
    .getByRole("img", { name: "设计预览", exact: true })
    .evaluate((image) => image.decode());
  assert.ok(imageRequests.includes("https://images.example.test/design.png"));
  const requestCount = imageRequests.length;
  await reader.getByRole("button", { name: "查看邮件 Release notes", exact: true }).click();
  await reader.getByRole("button", { name: "加载本封图片", exact: true }).waitFor();
  assert.equal(imageRequests.length, requestCount);
  async function setAutomaticImages(enabled) {
    await reader.getByRole("button", { name: "关闭邮件窗口", exact: true }).click();
    await reader.waitFor({ state: "detached" });
    await page.locator("#primary-navigation .sidebar-profile-trigger").click();
    await page.locator("button.sidebar-menu-item").filter({ hasText: "系统设置…" }).click();
    const panel = page.locator(".settings-page-panel");
    await panel.getByRole("button", { name: "存储", exact: true }).click();
    const toggle = panel.getByRole("checkbox", { name: "自动加载邮件外部图片", exact: true });
    assert.equal(await toggle.isChecked(), !enabled);
    await toggle.setChecked(enabled);
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("sinan-settings-v1")).state.autoLoadMailImages,
      ),
      enabled,
    );
    await page.getByRole("button", { name: "返回", exact: true }).click();
    const mailbox = page.locator('[data-mailbox-id="mail-0"]');
    if (!(await mailbox.isVisible()))
      await page.getByRole("button", { name: "打开文件夹 工作邮箱", exact: true }).click();
    await mailbox
      .getByRole("button", { name: /account0@example.test/ })
      .filter({ has: page.locator("span.font-medium") })
      .click();
    await reader.getByRole("button", { name: "查看邮件 Release notes", exact: true }).click();
  }
  await setAutomaticImages(true);
  const body = reader.getByRole("region", { name: "邮件正文", exact: true });
  const remoteImage = body.locator('img[src^="https://images.example.test/"]');
  await remoteImage.first().evaluate((image) => image.decode());
  assert.ok(imageRequests.length > requestCount);
  await reader.getByRole("button", { name: "隐藏外部图片", exact: true }).click();
  await remoteImage.first().waitFor({ state: "detached" });
  await setAutomaticImages(false);
  await reader.getByRole("button", { name: "加载本封图片", exact: true }).waitFor();
  assert.equal(await remoteImage.count(), 0);
  await reader.getByRole("button", { name: "查看邮件 Weekly delivery", exact: true }).click();
  await reader.getByRole("heading", { name: "本周交付进展", exact: true }).waitFor();
  await reader.getByRole("button", { name: "标为已读", exact: true }).click();
  assert.ok(await reader.getByRole("combobox", { name: "邮件文件夹", exact: true }).isDisabled());
  await reader.getByRole("button", { name: "标为未读", exact: true }).waitFor();
  await reader.getByRole("button", { name: "邮箱头像与分组", exact: true }).click();
  const accountEditor = page.getByRole("dialog", { name: "邮箱头像与分组", exact: true });
  await chooseOption(
    page,
    accountEditor.getByRole("combobox", { name: "所属文件夹", exact: true }),
    "生活邮箱",
  );
  await accountEditor.getByRole("button", { name: "保存", exact: true }).click();
  await accountEditor.waitFor({ state: "detached" });
  assert.equal(
    (await page.evaluate(() => window.sinan.store.load())).state.mailboxes[0].folderId,
    "personal",
  );
  await page.screenshot({ path: "screenshots/nanpad-v060-mail-reader.png" });
  await reader.getByRole("button", { name: "回复", exact: true }).click();
  assert.equal(
    await reader.getByRole("textbox", { name: "收件人", exact: true }).inputValue(),
    "team@example.test",
  );
  await reader
    .getByRole("textbox", { name: "邮件正文", exact: true })
    .fill("Private draft for integration verification");
  await reader.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByText("草稿已加密保存", { exact: true }).waitFor();
  const persisted = await readFile(join(directory, "assets.json"), "utf8");
  const encrypted = await readFile(join(directory, "vault.enc"), "utf8");
  assert.ok(!persisted.includes("Private draft"));
  assert.ok(!encrypted.includes("Private draft"));
  await reader.getByRole("button", { name: "发送", exact: true }).click();
  assert.equal(await instance.evaluate(() => globalThis.mailUiTestSent.length), 0);
  await reader.getByRole("button", { name: "确认发送", exact: true }).click();
  await page.getByText("邮件已提交给 SMTP 服务器", { exact: true }).waitFor();
  assert.equal(await instance.evaluate(() => globalThis.mailUiTestSent.length), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("邮件已提交给 SMTP 服务器", { exact: true }).waitFor({ state: "hidden" });
  await page.screenshot({ path: "screenshots/nanpad-v060-mail-reader-mobile.png" });
  await reader.getByRole("button", { name: "写邮件", exact: true }).click();
  const sendBox = await reader.getByRole("button", { name: "发送", exact: true }).boundingBox();
  assert.ok(sendBox && sendBox.y >= 0 && sendBox.y + sendBox.height <= 844);
  await page.screenshot({ path: "screenshots/nanpad-v060-mail-compose-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => window.sinan.vault.lock());
  await reader.waitFor({ state: "detached" });
  assert.equal(await page.getByText(/Private weekly delivery body/).count(), 0);
  await page.getByRole("button", { name: "返回文件夹", exact: true }).click();
  await page.screenshot({ path: "screenshots/nanpad-v060-mail-folders-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.reload();
  await page.getByRole("button", { name: "邮箱", exact: true }).click();
  await page.getByRole("button", { name: "打开文件夹 项目通知", exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify({
      ok: true,
      collapsedFolders: true,
      createAndMove: true,
      readMessage: true,
      markdownAndHtml: true,
      customSenderAvatar: true,
      failedAvatarSaveRollsBack: true,
      folderNameSearch: true,
      directFolderEditor: true,
      remoteImagesBlockedByDefault: true,
      imageConsentScopedToMessage: true,
      automaticRemoteImageSetting: true,
      markRead: true,
      reply: true,
      encryptedDraft: true,
      explicitSendConfirmation: true,
      mailNetworkBoundary: "IPC fixture",
      lockClearsReader: true,
      mobileOverflow: false,
      reloadPersistence: true,
      pageErrors,
    }),
  );
} finally {
  if (instance) await instance.close();
  await rm(directory, { recursive: true, force: true });
}
