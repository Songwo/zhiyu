import {
  createDisplayController,
  initialWindowBounds,
  readZoomPercent,
  zoomCommandForKey,
} from "./services/display.mjs";
import {
  windowsAppId,
  initializeAppIdentity,
  migrateLegacyWindowsShortcut,
  portableDataDirectory,
} from "./services/windows-identity.mjs";
import { ImageBed } from "./services/image-bed.mjs";
import { Integrations, INTEGRATION_METHODS } from "./services/integrations.mjs";
import { checkNode } from "./services/node-check.mjs";
import { UsageStore } from "./services/usage.mjs";
import { V2raynUsage } from "./services/v2rayn-usage.mjs";
import { createRefreshBatch } from "./services/refresh-batch.mjs";
import { LocalUsageMonitor } from "./services/local-usage.mjs";
import { DocumentsStore } from "./services/documents.mjs";
import { WorkspaceActions } from "./services/workspace-actions.mjs";
import electronUpdater from "electron-updater";
import { DesktopUpdater } from "./services/app-updater.mjs";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Menu,
  net,
  Tray,
  nativeImage,
  Notification,
  safeStorage,
  screen,
  powerMonitor,
} from "electron";
import { X509Certificate, randomUUID } from "node:crypto";
import { CaptureQueue } from "./services/browser-capture.mjs";
import { ExtensionBridge } from "./services/extension-bridge.mjs";
import { BrowserPasswords } from "./services/browser-passwords.mjs";
import { saveBrowserDocument } from "./services/browser-documents.mjs";
import { readFileSync, renameSync } from "node:fs";
import { readFile, writeFile, rename, mkdir, stat, readdir, rm, open } from "node:fs/promises";
import { basename, dirname, join, posix, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SshManager } from "./services/ssh.mjs";
import { probeCertificate, probeDomain } from "./services/net-probe.mjs";
import { MAIL_PROVIDERS, providerForAddress, testMailbox } from "./services/mail.mjs";
import { MailboxService, validateMailboxConnection } from "./services/mailbox-service.mjs";
import { MailPushService } from "./services/mail-push.mjs";
import { MailClient, validateSmtp } from "./services/mail-client.mjs";
import { OAUTH_PROVIDERS, signIn as oauthSignIn } from "./services/oauth.mjs";
import { readOAuthClientFile } from "./services/oauth-client-file.mjs";
import { Vault, vaultPath } from "./services/vault.mjs";
import { MetricsStore } from "./services/metrics.mjs";
import { notificationCandidates, NotificationTracker } from "./services/notifications.mjs";
import { AgentService } from "./services/agent-service.mjs";
import { ProfileService } from "./services/profile.mjs";
import {
  createImageNormalizer,
  normalizeSnapshotImages,
  inspectRaster,
} from "./services/image-data.mjs";
import { AiAccounts } from "./services/ai-accounts.mjs";
import { IdentityAccounts } from "./services/identity-accounts.mjs";
import { MainIdentityService } from "./services/main-identity.mjs";
import { identityPostsDocument } from "./services/identity-documents.mjs";
import { AccountTotp } from "./services/account-totp.mjs";
import { DocumentAccountImports } from "./services/document-account-imports.mjs";
import { parseDocumentAccounts } from "./services/document-accounts.mjs";
import { readMonitorMinutes, validateMonitorMinutes } from "./services/server-monitor.mjs";
import { mergeDemo, DEMO_KNOWLEDGE } from "./services/demo.mjs";
import {
  BACKUP_EXTENSION,
  applyPendingRestore,
  assertBackupPassword,
  backupStamp,
  createBackup,
  openBackup,
  readBackupFile,
  secureStorageUsable,
  stageRestore,
  writeBackupFile,
} from "./services/backup.mjs";
import { BackupScheduler } from "./services/backup-schedule.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const normalizeImage = createImageNormalizer(nativeImage);

// 固定旧资料路径后再设置系统显示名，防止任务栏和通知重新生成旧 Nanpad 入口。
const portableDirectory = portableDataDirectory({ packaged: app.isPackaged });
let PORTABLE = false;
try {
  PORTABLE = initializeAppIdentity(app, {
    testDataDirectory: process.env.NANPAD_TEST_DATA_DIR,
    portableDirectory,
  }).portable;
} catch (error) {
  if (!portableDirectory) throw error;
  dialog.showErrorBox(
    "知屿便携版无法启动",
    [
      `无法写入资料目录：${portableDirectory}`,
      "请把便携版解压到可写入的位置（例如 D:\\Zhiyu 或 U 盘），不要放在 C:\\Program Files 等受保护目录。",
      error.message,
    ].join("\n\n"),
  );
  process.exit(1);
}
// 驱动不兼容时可显式启用软件渲染，默认保留硬件加速。
if (process.env.NANPAD_DISABLE_GPU === "1") app.disableHardwareAcceleration();

/**
 * Our version, not Electron's.
 *
 * `app.getVersion()` reads the package.json next to the entry point; launched
 * as `electron electron/main.mjs` there isn't one, and it happily reports the
 * runtime's version instead. Read the real manifest — it ships inside the asar
 * too, so the packaged build takes the same path.
 */
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version;
  } catch {
    return app.getVersion();
  }
})();
// Only `npm run desktop` sets this. Without it — packaged, or a bare
// `electron .` — the window loads the built renderer, never a dev server that
// may not be running.
const DEV_URL = process.env.SINAN_DEV_URL || null;

/** @type {BrowserWindow | null} */
let win = null;
let vault = null;
let ssh = null;
let metrics;
let agent;
let aiAccounts;
let identities;
let mainIdentity;
let accountTotp;
let documentAccounts;
let mailboxes;
let mailClient;
let mailPush;
let extensionBridge;
let browserPasswords;
let assetWrites = Promise.resolve();
const recoveredAccounts = new Map();
let tray = null;
let quitting = false;
let notificationTimer;
let mailPushTimer;
let currentSnapshot = {};
// 启动时替换资料的结果，供设置页和启动提示展示。
let restoreOutcome = null;
let restartingForRestore = false;
let preferences = {
  closeToTray: true,
  notifications: true,
  locale: "zh",
  zoomPercent: 100,
  serverMonitorMinutes: 5,
};
const tracker = new NotificationTracker();
const writes = new Map();
const captures = new CaptureQueue();
function acceptCapture(argv) {
  for (const value of argv) {
    if (captures.add(value)) emit("capture:changed", {});
  }
}
acceptCapture(process.argv);
app.on("open-url", (event, url) => {
  event.preventDefault();
  acceptCapture([url]);
  showWindow();
});
let preferenceWrites = Promise.resolve();
const displayController = createDisplayController({
  read: () => preferences.zoomPercent,
  save: (zoomPercent) => savePreferences({ zoomPercent }),
  apply: (zoomPercent) => {
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoomPercent / 100);
  },
  publish: (state) => emit("display:changed", state),
});

function stepDisplayZoom(command) {
  void displayController.step(command).catch((error) => {
    emit("display:error", { message: String(error.message) });
  });
}

/** 订阅账号作为用量来源时的名称，与成功采集时 `recordAccount` 写入的一致。 */
function oauthSourceMeta(account) {
  return account
    ? { type: "oauth", name: `${account.provider} · ${account.email || account.accountId}` }
    : { type: "oauth" };
}

function savePreferences(patch) {
  const task = preferenceWrites.then(async () => {
    const next = { ...preferences, ...patch };
    await writeJson(join(app.getPath("userData"), "preferences.json"), next);
    preferences = next;
    updateTray();
    Menu.setApplicationMenu(buildMenu());
    return preferences;
  });
  preferenceWrites = task.catch(() => {});
  return task;
}

function stopPrivateTasks() {
  browserPasswords?.clear();
  extensionBridge?.revoke();
  mailPush?.stop();
  mailboxes?.stop();
  mailClient?.stop();
  agent?.close();
}

function lockVault() {
  return vault?.lock();
}

function assertPublicVaultRecord(id) {
  if (typeof id !== "string" || !id) throw new Error("凭据标识不正确。");
  if (["identity-config:", "identity-auth:", "totp:"].some((prefix) => id.startsWith(prefix)))
    throw new Error("请通过身份或动态验证码面板管理此凭据。");
  if (id === "notification:mail-push") {
    throw new Error("请通过邮件推送设置管理此凭据。");
  }
  if (id.startsWith("mail-draft:")) throw new Error("请通过写信窗口管理邮件草稿。");
  if (id.startsWith("ssh-host:"))
    throw new Error("主机指纹由 SSH 连接校验管理，请在资产的 SSH 凭据面板重置。");
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    void createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
}

function notifyAttention() {
  if (!preferences.notifications || !Notification.isSupported()) return;
  const items = tracker.take(notificationCandidates(currentSnapshot));
  if (!items.length) return;
  const en = preferences.locale === "en";
  const notification = new Notification({
    title: en ? "Zhiyu: assets need attention" : "知屿：资产需要留意",
    body: items
      .slice(0, 5)
      .map(
        (item) =>
          `${item.name}: ${item.reason === "offline" ? (en ? "Connection failed" : "连接失败") : item.days <= 0 ? (en ? "Expired" : "已到期") : en ? `Expires in ${item.days} days` : `${item.days} 天后到期`}`,
      )
      .join("\n"),
  });
  notification.on("click", () => {
    showWindow();
    emit("app:attention", { kind: items[0].kind, id: items[0].id });
  });
  notification.show();
}

function updateTray() {
  if (!tray) return;
  const en = preferences.locale === "en";
  tray.setToolTip("知屿 Zhiyu");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: en ? "Open Zhiyu" : "打开知屿", click: showWindow },
      {
        label: en ? "Lock vault" : "锁定密钥库",
        click: lockVault,
      },
      { type: "separator" },
      { label: en ? "Quit" : "退出", click: () => app.quit() },
    ]),
  );
}

function savedServer(id) {
  const server = currentSnapshot.servers?.find((x) => x.id === id);
  if (!server) throw new Error("Server no longer exists");
  if (server.demo) throw new Error("演示主机不允许进行真实连接。");
  return { id: server.id, host: server.host, port: server.port, username: server.username };
}

function dataFile() {
  return join(app.getPath("userData"), "assets.json");
}

function enqueueAssets(work) {
  const task = assetWrites.then(work);
  assetWrites = task.catch(() => {});
  return task;
}

function mutateWorkspaceAssets(mutate) {
  return enqueueAssets(async () => {
    const before = currentSnapshot;
    const next = mutate(before);
    await writeJson(dataFile(), { state: next, version: 0 });
    currentSnapshot = next;
    emit("assets:changed", { before, snapshot: next });
    return { before, snapshot: next };
  });
}

async function mergeBrowserAssets(snapshot) {
  if (!recoveredAccounts.size) return snapshot;
  const ids = new Set(await vault.list());
  for (const id of recoveredAccounts.keys())
    if (!ids.has("account:" + id)) recoveredAccounts.delete(id);
  const secrets = snapshot.secrets ?? [];
  return {
    ...snapshot,
    secrets: [
      ...secrets,
      ...[...recoveredAccounts.values()].filter(
        (item) => !secrets.some((entry) => entry.id === item.id),
      ),
    ],
  };
}

async function publishBrowserAssets(assets) {
  if (!assets.length) return;
  for (const asset of assets) recoveredAccounts.set(asset.id, asset);
  await enqueueAssets(async () => {
    const next = await mergeBrowserAssets(currentSnapshot);
    await writeJson(dataFile(), { state: next, version: 0 });
    currentSnapshot = next;
  });
  emit("passwords:changed", assets);
}

function unlockedSession() {
  if (!vault?.unlocked) throw new Error("请先解锁密钥库。");
  const session = vault.session;
  return () => {
    if (!vault.unlocked || vault.session !== session)
      throw new Error("密钥库会话已失效，请重新操作。");
  };
}

function conversationsFile() {
  return join(app.getPath("userData"), "conversations.json");
}

/** Write JSON without ever leaving a half-written file behind. */
function writeJson(file, value) {
  const content = JSON.stringify(value, null, 2);
  const task = (writes.get(file) ?? Promise.resolve()).then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
    return true;
  });
  writes.set(
    file,
    task.catch(() => {}),
  );
  return task;
}

async function createWindow() {
  win = new BrowserWindow({
    ...initialWindowBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea),
    show: false,
    backgroundColor: "#0e1114",
    // 窗口和托盘使用 PNG；ICO 用于 Windows 可执行文件及安装快捷方式。
    icon: app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(here, "../build/icon.png"),
    // The app paints its own chrome. macOS keeps its traffic lights — they are
    // a platform convention people reach for by muscle memory — while Windows
    // and Linux get in-app controls that share the rest of the UI's hover
    // language instead of the OS's grey caption squares.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { frame: false }),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge and ipcRenderer, which work under
      // the sandbox; keeping it on means a compromised renderer starts from a
      // smaller world even before process isolation is considered.
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
      zoomFactor: preferences.zoomPercent / 100,
    },
  });

  if (process.platform === "win32") {
    win.setAppDetails({
      appId: windowsAppId(app.isPackaged),
      appIconPath: app.isPackaged
        ? join(process.resourcesPath, "zhiyu.ico")
        : join(here, "../build/icon.ico"),
      appIconIndex: 0,
      relaunchCommand: app.isPackaged
        ? `"${process.execPath}"`
        : `"${process.execPath}" "${join(here, "main.mjs")}"`,
      relaunchDisplayName: "知屿 Zhiyu",
    });
  }

  // 菜单、键盘与触控板共用设置档位，系统 DPI 继续由 Electron 处理。
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const command = zoomCommandForKey(input);
    if (!command) return;
    event.preventDefault();
    stepDisplayZoom(command);
  });
  win.webContents.on("zoom-changed", (_event, direction) => stepDisplayZoom(direction));
  win.webContents.on("did-finish-load", () => {
    win?.webContents.setZoomFactor(preferences.zoomPercent / 100);
  });

  win.once("ready-to-show", () => {
    if (!process.env.NANPAD_TEST_DATA_DIR) win?.show();
  });
  win.on("close", (event) => {
    if (!quitting && preferences.closeToTray && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });

  // The maximise button has two shapes; keep the renderer in step with reality
  // rather than with what it last asked for.
  const pushMaximized = () => emit("window:maximized", { maximized: Boolean(win?.isMaximized()) });
  win.on("maximize", pushMaximized);
  win.on("unmaximize", pushMaximized);
  win.on("enter-full-screen", pushMaximized);
  win.on("leave-full-screen", pushMaximized);

  // External links belong in the user's browser, never in the app frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Same rule for in-page navigation: a `location.href = …` from Markdown,
  // a stray dependency or an injected script must not carry the preload bridge
  // off the app's own origin. The app never navigates on its own — desktop
  // development may still move within the Vite server's origin, but a packaged
  // build only ever shows the one bundled page.
  win.webContents.on("will-navigate", (event, url) => {
    if (url === win?.webContents.getURL()) return;
    if (DEV_URL && sameOrigin(url, DEV_URL)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  // 渲染页面仅放行智能粘贴和凭据复制需要的剪贴板权限，拒绝其余设备权限。
  const RENDERER_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write"]);
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(RENDERER_PERMISSIONS.has(permission)),
  );
  ses.setPermissionCheckHandler((_contents, permission) => RENDERER_PERMISSIONS.has(permission));

  if (DEV_URL) {
    await win.loadURL(DEV_URL);
  } else {
    await win.loadFile(join(here, "../dist-desktop/index.html"));
  }
  if (!process.env.NANPAD_TEST_DATA_DIR) {
    win?.restore();
    win?.show();
    win?.setAlwaysOnTop(true);
    win?.focus();
    win?.setAlwaysOnTop(false);
  }
}

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** `new URL().origin` comparison that never throws on malformed urls. */
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Wrap a handler so the renderer always gets `{ok}` or `{ok:false, error}`. */
function isMainFrame(event) {
  return Boolean(
    win &&
    !win.isDestroyed() &&
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame,
  );
}

function handle(channel, fn, mainWindowOnly = true) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (mainWindowOnly && !isMainFrame(event)) {
        throw new Error("此操作仅允许在应用主窗口中执行。");
      }
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });
}

function registerIpc() {
  const integrations = new Integrations({
    file: join(app.getPath("userData"), "integrations.json"),
    secureStorage: safeStorage,
    fetchImpl: (...args) => net.fetch(...args),
    mutateAssets: mutateWorkspaceAssets,
  });
  for (const method of INTEGRATION_METHODS)
    handle("integrations:" + method, (...args) => integrations[method](...args));
  app.once("before-quit", () => integrations.stop());
  const images = new ImageBed({
    file: join(app.getPath("userData"), "image-bed.json"),
    secureStorage: safeStorage,
    fetchImpl: (...args) => net.fetch(...args),
    decode: (value) => !nativeImage.createFromDataURL(value).isEmpty(),
  });
  for (const method of ["status", "configure", "upload"])
    handle("images:" + method, (...args) => images[method](...args));
  handle("nodes:check", checkNode);
  const documents = new DocumentsStore(join(app.getPath("userData"), "documents"));
  for (const method of ["list", "get", "save", "remove"])
    handle("documents:" + method, async (...args) => {
      const result = await documents[method](...args);
      if (method === "save") emit("documents:changed", { document: result });
      if (method === "remove") emit("documents:changed", { removedId: args[0] });
      return result;
    });
  handle("capture:list", () => captures.list());
  handle("capture:discard", (id) => {
    captures.discard(id);
  });
  vault = new Vault(vaultPath(app.getPath("userData")));
  // 外部恢复与写入冲突也会自动锁库，必须清理会话并通知界面隐藏已读取的凭据。
  vault.onLock(() => {
    stopPrivateTasks();
    emit("vault:changed", {});
  });
  documentAccounts = new DocumentAccountImports({
    vault,
    documents,
    getAssets: () => currentSnapshot,
    publishAssets: publishBrowserAssets,
    parse: parseDocumentAccounts,
  });
  handle("document-accounts:preview", (id) => documentAccounts.preview(id));
  handle("document-accounts:cancel", (ticket) => documentAccounts.cancel(ticket));
  handle("document-accounts:commit", async (input) => {
    const { document, ...result } = await documentAccounts.commit(input);
    if (document) emit("documents:changed", { document });
    return result;
  });
  accountTotp = new AccountTotp({ vault, getAssets: () => currentSnapshot });
  for (const method of ["status", "configure", "code", "remove"])
    handle("totp:" + method, (...args) => accountTotp[method](...args));
  identities = new IdentityAccounts({
    vault,
    fetchImpl: (...args) => net.fetch(...args),
    openExternal: (url) => shell.openExternal(url),
    getAssets: () => currentSnapshot,
  });
  for (const method of [
    "config",
    "configure",
    "start",
    "status",
    "cancel",
    "get",
    "refresh",
    "loadPosts",
    "disconnect",
  ])
    handle("identities:" + method, (...args) => identities[method](...args));
  handle("identities:commit", (input) =>
    enqueueAssets(async () => {
      const assertCurrent = unlockedSession();
      if (
        input?.folderId &&
        !currentSnapshot.secretFolders?.some((folder) => folder.id === input.folderId)
      )
        throw new Error("所选分组已不存在，请重新选择。");
      const result = await identities.commit(input);
      assertCurrent();
      recoveredAccounts.set(result.asset.id, result.asset);
      const before = currentSnapshot;
      const existing = before.secrets?.find((item) => item.id === result.asset.id);
      const asset = existing ? { ...existing, identityProvider: "linuxdo" } : result.asset;
      const next = {
        ...before,
        secrets: existing
          ? before.secrets.map((item) => (item.id === asset.id ? asset : item))
          : [...(before.secrets ?? []), asset],
      };
      await writeJson(dataFile(), { state: next, version: 0 });
      currentSnapshot = next;
      emit("assets:changed", { before, snapshot: next });
      assertCurrent();
      return { ...result, asset };
    }),
  );
  handle("identities:save-posts", async (input) => {
    const assertCurrent = unlockedSession();
    const account = await identities.get(input?.assetId);
    assertCurrent();
    const result = await identities.readPosts(input?.assetId, input?.postIds, {
      force: input?.force === true,
    });
    assertCurrent();
    if (!result.items.length) return { documentId: null, imported: 0, errors: result.errors };
    const doc = identityPostsDocument(account, result.items);
    const saved = await documents.save(doc, { assertCurrent });
    emit("documents:changed", { document: saved });
    assertCurrent();
    return { documentId: saved.id, imported: result.items.length, errors: result.errors };
  });
  browserPasswords = new BrowserPasswords({
    vault,
    getAssets: () => currentSnapshot.secrets ?? [],
  });
  extensionBridge = new ExtensionBridge({
    isUnlocked: () => Boolean(vault?.unlocked),
    accounts: {
      listForOrigin: (url) => browserPasswords.listForOrigin(url),
      getForOrigin: (id, url) => browserPasswords.getForOrigin(id, url),
      saveCapture: async (capture, assertCurrent) => {
        const result = await browserPasswords.saveCapture(capture, assertCurrent);
        await publishBrowserAssets(result.assets);
        return result;
      },
    },
    saveDocument: async (input, assertCurrent) => {
      const result = await saveBrowserDocument(documents, input, assertCurrent);
      emit("documents:changed", { document: await documents.get(result.id) });
      return result;
    },
    // 手动发送仍聚焦窗口引导确认；自动采集在用户浏览网页时到达，只更新待确认数，不抢前台。
    onCapture: (item) => {
      if (item?.source !== "auto") showWindow();
    },
    onChange: () => emit("extension:changed", {}),
    // 测试进程使用随机端口，避免连接用户正在运行的桌面端。
    ...((!app.isPackaged && process.env.NANPAD_TEST_DATA_DIR) ||
    process.argv.some((arg) => arg.startsWith("--user-data-dir="))
      ? { port: 0 }
      : {}),
  });
  handle("extension:status", () => extensionBridge.status());
  handle("extension:pair", async () => {
    await extensionBridge.start();
    return extensionBridge.beginPairing();
  });
  handle("extension:revoke", () => extensionBridge.revoke());
  handle("extension:list", () => extensionBridge.list());
  handle("extension:take", (id) => extensionBridge.take(id));
  handle("extension:discard", (id) => extensionBridge.discard(id));
  handle("passwords:preview-import", async () => {
    const assertCurrent = unlockedSession();
    const selected = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "浏览器密码 CSV", extensions: ["csv"] }],
    });
    assertCurrent();
    if (selected.canceled || !selected.filePaths[0]) return null;
    const file = await open(selected.filePaths[0], "r");
    try {
      const limit = 10 * 1024 * 1024;
      if (!(await file.stat()).isFile() || (await file.stat()).size > limit)
        throw new Error("请选择不超过 10 MiB 的密码 CSV 文件。");
      const buffer = Buffer.alloc(limit + 1);
      let total = 0;
      try {
        while (total < buffer.length) {
          const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
          if (!bytesRead) break;
          total += bytesRead;
        }
        assertCurrent();
        if (total > limit) throw new Error("密码 CSV 不能超过 10 MiB。");
        const csv = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
        return await browserPasswords.preview(csv);
      } finally {
        buffer.fill(0);
      }
    } finally {
      await file.close();
    }
  });
  handle("passwords:commit-import", async (ticket) => {
    const result = await browserPasswords.commit(ticket);
    await publishBrowserAssets(result.assets);
    return result;
  });
  handle("passwords:cancel-import", (ticket) => browserPasswords.cancel(ticket));
  handle("passwords:export-csv", async () => {
    const assertCurrent = unlockedSession();
    const confirm = await dialog.showMessageBox(win, {
      type: "warning",
      title: "导出浏览器密码",
      message: "CSV 将包含未加密的网址、账号和密码。",
      detail:
        "请仅用于 Chrome / Edge 密码导入，不要发给他人或用表格软件打开；导入完成后删除此文件。",
      buttons: ["取消", "继续导出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    assertCurrent();
    if (confirm.response !== 1) return null;
    const selected = await dialog.showSaveDialog(win, {
      defaultPath: "知屿-浏览器密码.csv",
      filters: [{ name: "浏览器密码 CSV", extensions: ["csv"] }],
    });
    assertCurrent();
    if (selected.canceled || !selected.filePath) return null;
    const pathFromData = relative(app.getPath("userData"), selected.filePath);
    if (!pathFromData.startsWith("..") && !isAbsolute(pathFromData))
      throw new Error("请将 CSV 保存到资料目录之外。");
    const result = await browserPasswords.exportCsv();
    assertCurrent();
    const temporary = selected.filePath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, result.csv, { encoding: "utf8", flag: "wx", mode: 0o600 });
      assertCurrent();
      renameSync(temporary, selected.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return { count: result.count };
  });
  mainIdentity = new MainIdentityService({
    file: join(app.getPath("userData"), "main-identity.enc"),
    safeStorage,
    fetchImpl: (...args) => net.fetch(...args),
    openExternal: (url) => shell.openExternal(url),
    normalizeImage: (value) => {
      if (value === "" || value === null || value === undefined) return "";
      const match =
        typeof value === "string" &&
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
      if (!match || value.length > 1_500_000) throw new Error("身份头像格式无效或文件过大。");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== match[2])
        throw new Error("身份头像格式无效或文件过大。");
      const size = inspectRaster(bytes, match[1]);
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error("身份头像无法解码。");
      const ratio = Math.min(1, 512 / Math.max(size.width, size.height));
      const normalized = image.resize({
        width: Math.max(1, Math.round(size.width * ratio)),
        height: Math.max(1, Math.round(size.height * ratio)),
        quality: "best",
      });
      return normalizeImage(`data:image/png;base64,${normalized.toPNG().toString("base64")}`);
    },
  });
  for (const method of [
    "get",
    "availability",
    "start",
    "status",
    "cancel",
    "bind",
    "preferences",
    "refresh",
    "disconnect",
    "loadPosts",
  ])
    handle("main-identity:" + method, (...args) => mainIdentity[method](...args));
  handle("main-identity:save-posts", async (input) => {
    const identity = await mainIdentity.get();
    const session = mainIdentity.captureSession();
    const assertCurrent = () => mainIdentity.assertCurrent(session);
    assertCurrent();
    const result = await mainIdentity.readPosts(input?.postIds, { force: input?.force === true });
    assertCurrent();
    if (!result.items.length) return { documentId: null, imported: 0, errors: result.errors };
    const doc = identityPostsDocument({ profile: identity.profile }, result.items);
    // 主身份不属于账号资产，不能创建指向不存在账号的文档关联。
    doc.bindings = [];
    const saved = await documents.save(doc, { assertCurrent });
    emit("documents:changed", { document: saved });
    return { documentId: saved.id, imported: result.items.length, errors: result.errors };
  });
  const profile = new ProfileService(
    join(app.getPath("userData"), "profile.json"),
    vault,
    normalizeImage,
  );
  profile.setIdentitySource(mainIdentity);
  handle("profile:get", () => profile.get());
  handle("profile:save", async (value) => {
    const result = await profile.save(value);
    if (vault.unlocked) await publishBrowserAssets(await browserPasswords.managedAssets());
    return result;
  });
  aiAccounts = new AiAccounts({
    vault,
    openExternal: (url) => shell.openExternal(url),
    fetchImpl: (...args) => net.fetch(...args),
  });
  handle("ai-accounts:list", () => aiAccounts.list());
  handle("ai-accounts:start", (provider) => aiAccounts.start(provider));
  handle("ai-accounts:status", (id) => aiAccounts.status(id));
  handle("ai-accounts:finish", (id, code) => aiAccounts.finish(id, code));
  handle("ai-accounts:cancel", (id) => aiAccounts.cancel(id));
  const usage = new UsageStore(join(app.getPath("userData"), "usage-history.json"), vault);
  const v2raynUsage = new V2raynUsage({
    configFile: join(app.getPath("userData"), "v2rayn-usage.json"),
    ...(process.env.NANPAD_TEST_DATA_DIR ? { discoverDirectories: async () => [] } : {}),
  });
  handle("usage:v2rayn-status", (force) => v2raynUsage.status({ force: force === true }));
  handle("usage:v2rayn-directory", async () => {
    const selection = await dialog.showOpenDialog(win, {
      title: "选择 v2rayN 程序所在文件夹",
      properties: ["openDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return v2raynUsage.selectDirectory(selection.filePaths[0]);
  });
  handle("usage:subscription-details", (id) => usage.subscriptionDetails(id));
  const localUsage = new LocalUsageMonitor({
    file: join(app.getPath("userData"), "local-usage.json"),
    // 隔离测试只能读取自身数据目录内的合成日志，不触碰用户日志。
    ...(!app.isPackaged && process.env.NANPAD_TEST_DATA_DIR
      ? {
          roots: {
            codex: [join(app.getPath("userData"), "qa-logs", "codex")],
            claude: [join(app.getPath("userData"), "qa-logs", "claude")],
            grok: [join(app.getPath("userData"), "qa-logs", "grok")],
            gemini: [join(app.getPath("userData"), "qa-logs", "gemini")],
          },
        }
      : {}),
  });
  const localStatus = async () => {
    const status = await localUsage.status();
    return { ...status, paused: false };
  };
  const refreshLocalUsage = async () => {
    const before = localUsage.recordsRevision;
    const status = await localUsage.refresh();
    emit("usage:changed", {
      recordsChanged: before !== localUsage.recordsRevision,
      localStatus: { ...status, paused: false },
    });
    return status;
  };
  handle("usage:list", async () => {
    const [remote, local] = await Promise.all([usage.list(), localUsage.list()]);
    const recordedLocal = new Set(local.records.map((row) => row.sourceId));
    return {
      sources: [
        ...remote.sources,
        ...local.sources.filter((source) => recordedLocal.has(source.id)),
      ],
      records: [...remote.records, ...local.records],
    };
  });
  handle("usage:local-status", localStatus);
  handle("usage:local-configure", async (input) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "enabled") ||
      typeof input.enabled !== "boolean"
    )
      throw new Error("监控设置只接受开启或关闭，不接受日志路径。");
    await localUsage.configure({ enabled: input.enabled });
    if (input.enabled) await refreshLocalUsage();
    else emit("usage:changed", { recordsChanged: false, localStatus: await localStatus() });
    return localStatus();
  });
  handle("usage:local-refresh", async () => {
    await refreshLocalUsage();
    return localStatus();
  });
  const localTimer = setInterval(() => {
    void refreshLocalUsage().catch(() => {});
  }, 10_000);
  localTimer.unref();
  void refreshLocalUsage().catch(() => {});
  app.once("before-quit", () => clearInterval(localTimer));
  for (const method of ["add", "update", "remove", "refresh"])
    handle("usage:" + method, async (...args) => {
      try {
        return await usage[method](...args);
      } finally {
        emit("usage:changed", { recordsChanged: true });
      }
    });
  handle("ai-accounts:refresh", async (id) => {
    try {
      const account = await aiAccounts.refresh(id);
      await usage.recordAccount(account);
      return account;
    } catch (error) {
      const account = (await aiAccounts.list().catch(() => [])).find((item) => item.id === id);
      await usage.markFailure("oauth:" + id, error.message, oauthSourceMeta(account));
      throw error;
    } finally {
      emit("usage:changed", { recordsChanged: true });
    }
  });
  const refreshUsage = createRefreshBatch(async (force) => {
    if (!vault.unlocked) throw new Error("请先解锁密钥库");
    const failures = [];
    const state = await usage.list();
    for (const source of state.sources.filter((s) => s.type !== "oauth")) {
      try {
        await usage.refresh(source.id, { force });
      } catch (e) {
        failures.push(source.name + "：" + e.message);
      }
    }
    for (const account of await aiAccounts.list()) {
      try {
        await usage.recordAccount(await aiAccounts.refresh(account.id));
      } catch (e) {
        await usage.markFailure("oauth:" + account.id, e.message, oauthSourceMeta(account));
        failures.push(account.provider + "：" + e.message);
      }
    }
    emit("usage:changed", { recordsChanged: true });
    return { failures };
  });
  handle("usage:refresh-all", () => refreshUsage(true));
  const usageTimer = setInterval(() => {
    if (
      vault.unlocked &&
      BrowserWindow.getAllWindows().some((w) => w.isVisible() && !w.isMinimized())
    )
      void refreshUsage(false).catch(() => {});
  }, 300000);
  usageTimer.unref();
  app.once("before-quit", () => clearInterval(usageTimer));
  handle("ai-accounts:remove", (id) => aiAccounts.remove(id));
  app.once("before-quit", () => aiAccounts.stop());
  // Host key pins live in the vault: they are not secret, but the GCM auth
  // tag makes the TOFU record tamper-evident, and SSH already requires the
  // vault unlocked to read credentials.
  ssh = new SshManager(emit, {
    get: async (host, port) => {
      if (!vault.unlocked) throw new Error("密钥库已锁定，无法校验主机指纹；请先解锁密钥库。");
      const record = await vault.get(hostKeyId(host, port));
      return typeof record?.fingerprint === "string" ? record.fingerprint : null;
    },
    set: async (host, port, fingerprint) => {
      if (!vault.unlocked) throw new Error("密钥库已锁定，无法记录主机指纹；请先解锁密钥库。");
      await vault.set(hostKeyId(host, port), { fingerprint });
    },
    remove: async (host, port) => {
      await vault.remove(hostKeyId(host, port));
    },
  });
  metrics = new MetricsStore(join(app.getPath("userData"), "metrics.json"));
  mailboxes = new MailboxService({
    directory: app.getPath("userData"),
    vault,
    getSnapshot: () => currentSnapshot,
  });
  mailPush = new MailPushService({
    vault,
    getSnapshot: () => currentSnapshot,
    checkMailbox: (id, options) => mailboxes.check(id, options),
    fetchImpl: (...args) => net.fetch(...args),
  });
  handle("mailboxes:check", (id) => mailboxes.check(id));
  handle("mailboxes:validate", (connection) => validateMailboxConnection(connection));
  mailClient = new MailClient({ vault, getSnapshot: () => currentSnapshot });
  handle("mail-client:folders", (id) => mailClient.folders(id));
  handle("mail-client:messages", (id, options) => mailClient.messages(id, options));
  handle("mail-client:read", (id, selection) => mailClient.read(id, selection));
  handle("mail-client:seen", (id, selection, seen) => mailClient.seen(id, selection, seen));
  handle("mail-client:send", (id, draft) => mailClient.send(id, draft));
  handle("mail-client:draft", (id) => mailClient.draft(id));
  handle("mail-client:save-draft", (id, draft) => mailClient.saveDraft(id, draft));
  handle("mail-client:validate-smtp", (value) => validateSmtp(value));
  handle("mail-client:pick-attachments", async () => {
    if (!vault.unlocked) throw new Error("请先解锁密钥库");
    const selected = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
    });
    if (selected.canceled) return [];
    if (selected.filePaths.length > 5) throw new Error("最多添加 5 个附件");
    const items = [];
    let total = 0;
    for (const path of selected.filePaths) {
      const metadata = await stat(path);
      total += metadata.size;
      if (!metadata.isFile() || total > 8 * 1024 * 1024)
        throw new Error("附件总大小不能超过 8 MiB");
      const content = await readFile(path);
      if (content.length !== metadata.size) throw new Error("附件已变化，请重新选择");
      items.push({ name: path.split(/[\\/]/).pop(), base64: content.toString("base64") });
    }
    if (!vault.unlocked) throw new Error("密钥库已锁定");
    return items;
  });
  handle("mail-client:download", async (id, selection, index) => {
    const attachment = await mailClient.attachment(id, selection, index);
    const target = await dialog.showSaveDialog(win, { defaultPath: attachment.name });
    if (target.canceled || !target.filePath) return false;
    if (!vault.unlocked) throw new Error("密钥库已锁定");
    await writeFile(target.filePath, attachment.content);
    return true;
  });
  handle("mail-push:config", () => mailPush.config());
  handle("mail-push:save", (input) => mailPush.save(input));
  handle("mail-push:test", () => mailPush.test());
  // —— 存储管理（0.9.0）：只统计与清理缓存，永远不触碰资产、密钥库与凭据文件本体。 ——
  const STORAGE_FILES = [
    "assets.json",
    "vault.enc",
    "conversations.json",
    "metrics.json",
    "rag-index.json",
    "knowledge.json",
    "profile.json",
    "agent-config.json",
    "mailbox-baselines.json",
  ];
  const CHROMIUM_CACHE_DIRS = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnWebGPUCache",
    "DawnGraphiteCache",
    "ShaderCache",
    "Shared Dictionary",
  ];
  async function dirSize(path) {
    let total = 0;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) total += await dirSize(child);
      else {
        try {
          total += (await stat(child)).size;
        } catch {
          /* 文件竞争删除时跳过 */
        }
      }
    }
    return total;
  }
  handle("storage:stats", async () => {
    const root = app.getPath("userData");
    const files = {};
    for (const name of STORAGE_FILES) {
      try {
        files[name] = (await stat(join(root, name))).size;
      } catch {
        files[name] = 0;
      }
    }
    const dirs = {};
    let cacheTotal = 0;
    for (const dir of CHROMIUM_CACHE_DIRS) {
      const size = await dirSize(join(root, dir));
      dirs[dir] = size;
      cacheTotal += size;
    }
    return {
      files,
      cache: { dirs, total: cacheTotal },
      mail: mailClient?.cacheStats() ?? { folders: 0, pages: 0, messages: 0, bytes: 0 },
    };
  });
  handle("storage:clear", async (scope) => {
    if (scope === "mail") {
      mailClient?.clearCaches();
      return "mail";
    }
    if (scope === "chromium") {
      const root = app.getPath("userData");
      // 运行中删除缓存目录是安全的：Chromium 会在需要时自动重建。
      for (const dir of CHROMIUM_CACHE_DIRS)
        await rm(join(root, dir), { recursive: true, force: true }).catch(() => {});
      return "chromium";
    }
    throw new Error("未知的清理范围");
  });
  const workspaceActions = new WorkspaceActions({
    getSnapshot: () => currentSnapshot,
    documents,
    mutateAssets: mutateWorkspaceAssets,
  });
  agent = new AgentService({
    directory: app.getPath("userData"),
    secureStorage: safeStorage,
    getSnapshot: () => currentSnapshot,
    workspaceActions,
    workspaceDocuments: {
      list: () => documents.listMetadata(),
      get: (id) => documents.get(id),
    },
    checkMailbox: (id, options) => mailboxes.check(id, options),
    emit: (event) => emit("agent:event", event),
  });
  handle("agent:apply-proposal", async (id) => {
    if (typeof id !== "string" || id.length > 100) throw new Error("修改建议标识无效。");
    const result = await workspaceActions.apply(id);
    if (result.document) emit("documents:changed", { document: result.document });
    return result;
  });
  handle("agent:discard-proposal", (id) => {
    if (typeof id !== "string" || id.length > 100) throw new Error("修改建议标识无效。");
    return workspaceActions.discard(id);
  });
  handle("agent:config", () => agent.config());
  handle("agent:save-config", (config) => agent.saveConfig(config));
  handle("agent:models", () => agent.models());
  handle("agent:test", () => agent.test());
  handle("agent:run", (request) => agent.run(request));
  handle("agent:cancel", (id) => agent.cancel(id));
  handle("agent:knowledge", () => agent.knowledge());
  handle("agent:rebuild", () => agent.rebuild());
  handle("agent:remove-document", (id) => agent.removeDocument(id));
  handle("agent:import-document", async () => {
    const selected = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Text / Markdown", extensions: ["txt", "md"] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const file = selected.filePaths[0];
    const { stat } = await import("node:fs/promises");
    if ((await stat(file)).size > 512000) throw new Error("知识文档不能超过 500 KB。");
    return agent.addDocument(file.split(/[\\/]/).pop(), await readFile(file, "utf8"));
  });
  handle("store:add-demo", async () => {
    if (app.isPackaged) throw new Error("生产版本不提供演示数据导入。");
    // 与当前磁盘内容合并；重复导入保留原记录及其修改。
    const saved = JSON.parse(
      await readFile(dataFile(), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      }),
    );
    const next = mergeDemo(saved.state ?? saved);
    await agent.addDocument("星桥商城演示运维手册.md", DEMO_KNOWLEDGE);
    await writeJson(dataFile(), { ...saved, state: next, version: saved.version ?? 0 });
    currentSnapshot = next;
    return next;
  });
  handle("display:get", () => displayController.get(), true);
  handle("display:set", (value) => displayController.set(value), true);
  handle("preferences:get", () => ({
    ...preferences,
    notificationSupported: Notification.isSupported(),
    trayAvailable: Boolean(tray),
  }));
  handle("preferences:set", (patch) => {
    const safe = {};
    if (patch && Object.hasOwn(patch, "serverMonitorMinutes"))
      safe.serverMonitorMinutes = validateMonitorMinutes(patch.serverMonitorMinutes);
    if (typeof patch?.closeToTray === "boolean") safe.closeToTray = patch.closeToTray;
    if (typeof patch?.notifications === "boolean") safe.notifications = patch.notifications;
    if (patch?.locale === "zh" || patch?.locale === "en") safe.locale = patch.locale;
    return savePreferences(safe);
  });
  handle("metrics:list", (id, since) => metrics.list(id, Number.isFinite(since) ? since : 0));
  handle("sftp:list", async (id, path) =>
    ssh.sftp.list(savedServer(id), await vault.get(credentialId(id)), path),
  );
  handle("sftp:download", async (id, path) => {
    const target = savedServer(id);
    const credential = await vault.get(credentialId(id));
    const result = await dialog.showSaveDialog(win, { defaultPath: posix.basename(path) });
    if (result.canceled || !result.filePath) return false;
    return ssh.sftp.download(target, credential, path, result.filePath);
  });

  handle("app:info", async () => ({
    platform: process.platform,
    arch: process.arch,
    version: APP_VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
    portable: PORTABLE,
  }));

  const updateEngine = electronUpdater.autoUpdater;
  updateEngine.setFeedURL({
    provider: "github",
    owner: "Songwo",
    repo: "zhiyu",
    private: false,
    releaseType: "release",
  });
  if (process.platform === "win32" && app.isPackaged && !PORTABLE)
    updateEngine.installDirectory = dirname(process.execPath);
  const updates = new DesktopUpdater({
    engine: updateEngine,
    current: APP_VERSION,
    supported: app.isPackaged && process.platform === "win32",
    // 便携版只检查新版本，由用户下载新压缩包覆盖，不运行安装器。
    manual: PORTABLE,
    publish: (state) => emit("app:update-status", state),
    prepare: async () => {
      await Promise.all([assetWrites, preferenceWrites, ...writes.values(), localUsage.queue]);
    },
  });
  // ---- encrypted backup ---------------------------------------------------
  const userData = app.getPath("userData");
  const say = (zh, en) => (preferences.locale === "en" ? en : zh);
  const insideUserData = (path) => {
    const fromData = relative(userData, path);
    return !fromData.startsWith("..") && !isAbsolute(fromData);
  };
  // 各存储都用"临时文件 + 改名"原子写入；打包前等排队中的写入落盘，读到的就是一致的最新版本。
  const flushWrites = async () => {
    await Promise.all([
      assetWrites,
      preferenceWrites,
      ...writes.values(),
      localUsage.queue,
      profile.queue,
      agent.writes,
    ]);
    await Promise.all([documents.listMetadata().catch(() => {}), vault.status().catch(() => {})]);
  };
  let backupBusy = false;
  const exclusiveBackup = async (work) => {
    if (restartingForRestore) throw new Error("正在重启以完成恢复，请稍候。");
    if (backupBusy) throw new Error("另一个备份或恢复操作正在进行，请稍候。");
    backupBusy = true;
    try {
      return await work();
    } finally {
      backupBusy = false;
    }
  };
  const produceBackup = async ({ password, includeSecure, kind }) => {
    await flushWrites();
    return createBackup({
      root: userData,
      password,
      appVersion: APP_VERSION,
      kind,
      secureStorage: includeSecure ? safeStorage : null,
    });
  };
  const backupSchedule = new BackupScheduler({
    file: join(userData, "backup-schedule.json"),
    secureStorage: safeStorage,
    // 自动备份无人值守，不解密系统保护的凭据；需要时由用户手动创建完整备份。
    run: (password) =>
      exclusiveBackup(
        async () => (await produceBackup({ password, includeSecure: false, kind: "auto" })).data,
      ),
  });
  backupSchedule.start();
  app.once("before-quit", () => backupSchedule.stop());
  handle("backup:info", () => ({
    lastRestore: restoreOutcome,
    secureAvailable: secureStorageUsable(safeStorage),
  }));
  handle("backup:create", (input) =>
    exclusiveBackup(async () => {
      assertBackupPassword(input?.password);
      const includeSecure = input?.includeSecure === true;
      if (includeSecure && !vault.unlocked)
        throw new Error("包含系统保护的凭据前，请先解锁密钥库。");
      if (includeSecure && !secureStorageUsable(safeStorage))
        throw new Error("系统加密存储不可用，无法读取系统保护的凭据。");
      const assertCurrent = includeSecure ? unlockedSession() : () => {};
      const selected = await dialog.showSaveDialog(win, {
        title: say("保存加密备份", "Save encrypted backup"),
        defaultPath: join(
          app.getPath("documents"),
          `${say("知屿备份", "zhiyu-backup")}-${backupStamp()}.${BACKUP_EXTENSION}`,
        ),
        filters: [{ name: say("知屿加密备份", "Zhiyu backup"), extensions: [BACKUP_EXTENSION] }],
      });
      if (selected.canceled || !selected.filePath) return null;
      if (insideUserData(selected.filePath))
        throw new Error("请把备份保存到资料目录之外，例如另一块磁盘或 U 盘。");
      assertCurrent();
      const { data, preview } = await produceBackup({
        password: input.password,
        includeSecure,
        kind: "manual",
      });
      assertCurrent();
      await writeBackupFile(selected.filePath, data);
      return { file: basename(selected.filePath), preview };
    }),
  );
  const restoreTickets = new Map();
  const restorePath = (ticket) => {
    const item = restoreTickets.get(ticket);
    if (!item || item.expiresAt < Date.now()) {
      restoreTickets.delete(ticket);
      throw new Error("请重新选择备份文件。");
    }
    return item.path;
  };
  handle("backup:pick", async () => {
    const selected = await dialog.showOpenDialog(win, {
      title: say("选择知屿备份", "Choose a Zhiyu backup"),
      properties: ["openFile"],
      filters: [{ name: say("知屿加密备份", "Zhiyu backup"), extensions: [BACKUP_EXTENSION] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const path = selected.filePaths[0];
    const info = await stat(path);
    // 渲染进程只拿到票据，恢复时读取的始终是用户在对话框里选中的文件。
    const ticket = randomUUID();
    restoreTickets.clear();
    restoreTickets.set(ticket, { path, expiresAt: Date.now() + 15 * 60_000 });
    return { ticket, file: basename(path), size: info.size };
  });
  handle("backup:inspect", async (ticket, password) => {
    const backup = await openBackup(await readBackupFile(restorePath(ticket)), password);
    return backup.preview;
  });
  handle("backup:cancel", (ticket) => {
    restoreTickets.delete(ticket);
  });
  handle("backup:restore", (ticket, password) =>
    exclusiveBackup(async () => {
      const backup = await openBackup(await readBackupFile(restorePath(ticket)), password);
      await flushWrites();
      const result = await stageRestore({ root: userData, backup, secureStorage: safeStorage });
      restoreTickets.clear();
      restartingForRestore = true;
      // 先把结果返回给界面，再退出；替换在下次启动、任何服务读取资料之前完成。
      setTimeout(() => {
        lockVault();
        app.relaunch();
        app.quit();
      }, 800);
      return result;
    }),
  );
  handle("backup:auto-status", () => backupSchedule.status());
  handle("backup:auto-configure", (input) => backupSchedule.configure(input));
  handle("backup:auto-directory", async () => {
    const selected = await dialog.showOpenDialog(win, {
      title: say("选择自动备份文件夹", "Choose the auto-backup folder"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    if (insideUserData(selected.filePaths[0]))
      throw new Error("请选择资料目录之外的文件夹，例如另一块磁盘或网盘同步目录。");
    return backupSchedule.setDirectory(selected.filePaths[0]);
  });
  handle("backup:auto-run", () => backupSchedule.runNow());

  handle("app:check-update", () => updates.check());
  handle("app:update-status", () => updates.status());
  handle("app:download-update", () => updates.download());
  handle("app:install-update", () => updates.install());
  handle("shell:open-path", async (target) => {
    const allowed = app.getPath("userData");
    // Only ever open our own data directory — never a path the page chose.
    if (target !== "userData") throw new Error("不允许打开该路径");
    const err = await shell.openPath(allowed);
    if (err) throw new Error(err);
    return true;
  });

  // ---- assets on disk -----------------------------------------------------
  handle("store:load", async () => {
    await assetWrites;
    try {
      return normalizeSnapshotImages(JSON.parse(await readFile(dataFile(), "utf8")), {
        strict: false,
        normalize: normalizeImage,
      });
    } catch {
      return null;
    }
  });
  handle("store:save", (snapshot) =>
    enqueueAssets(async () => {
      const normalized = normalizeSnapshotImages(snapshot, { normalize: normalizeImage });
      const next = await mergeBrowserAssets(normalized?.state ?? normalized ?? {});
      for (const mailbox of next.mailboxes ?? []) {
        if (mailbox.imap) mailbox.imap = validateMailboxConnection(mailbox.imap);
        if (mailbox.smtp) mailbox.smtp = validateSmtp(mailbox.smtp);
      }
      await writeJson(dataFile(), normalized?.state ? { ...normalized, state: next } : next);
      currentSnapshot = next;
      notifyAttention();
      return true;
    }),
  );
  handle("store:load-conversations", async () => {
    try {
      return JSON.parse(await readFile(conversationsFile(), "utf8"));
    } catch {
      return null;
    }
  });
  handle("store:save-conversations", (value) => writeJson(conversationsFile(), value));

  // ---- vault --------------------------------------------------------------
  handle("vault:status", () => vault.status());
  handle("vault:create", (master) => vault.create(master));
  handle("vault:unlock", async (master) => {
    const result = await vault.unlock(master);
    await publishBrowserAssets(await browserPasswords.managedAssets());
    await publishBrowserAssets(await identities.managedAssets());
    return result;
  });
  handle("vault:lock", lockVault);
  handle("vault:change-password", (oldMaster, newMaster) =>
    vault.changePassword(oldMaster, newMaster),
  );
  handle("vault:set", async (id, secret) => {
    assertPublicVaultRecord(id);
    if (id.startsWith("account:")) {
      const assertCurrent = unlockedSession();
      const previous = await vault.get(id);
      assertCurrent();
      if (previous?._browserAsset && secret && typeof secret === "object")
        secret = { ...secret, _browserAsset: previous._browserAsset };
    }
    return vault.set(id, secret);
  });
  handle("vault:get", (id) => {
    assertPublicVaultRecord(id);
    return vault.get(id);
  });
  handle("vault:remove", async (id) => {
    assertPublicVaultRecord(id);
    if (id.startsWith("account:secret-linuxdo-")) {
      await identities.remove(id.slice("account:".length));
      recoveredAccounts.delete(id.slice("account:".length));
      return;
    }
    if (id.startsWith("account:")) {
      const assetId = id.slice("account:".length);
      const result = await vault.removeMany([id, `totp:${assetId}`]);
      recoveredAccounts.delete(assetId);
      return result;
    }
    return vault.remove(id);
  });
  handle("vault:list", () => vault.list());

  // ---- ssh ----------------------------------------------------------------
  handle("ssh:open", async (target, size) =>
    ssh.openShell(savedServer(target.id), await vault.get(credentialId(target.id)), size),
  );
  handle("ssh:probe", async (target) => {
    const probe = await ssh.probe(savedServer(target.id), await vault.get(credentialId(target.id)));
    try {
      await metrics.record(target.id, probe);
      emit("metrics:updated", { id: target.id });
    } catch (err) {
      emit("metrics:error", { id: target.id, error: String(err.message) });
    }
    return probe;
  });
  // The credential form tests what is on screen, which is not saved yet.
  handle("ssh:test", (target, credential) => ssh.test(target, credential));
  // A deliberately reinstalled server changes its host key, which TOFU then
  // refuses; this is the user's conscious acceptance of the new key.
  handle("ssh:reset-host-key", async (target) => {
    if (!target || typeof target.host !== "string" || !target.host.trim()) {
      throw new Error("主机地址不正确。");
    }
    await ssh.resetHostKey({
      host: target.host,
      port: Number(target.port) || 22,
      username: target.username,
    });
    return { ok: true };
  });
  handle("ssh:close", (sessionId) => {
    ssh.close(sessionId);
    return true;
  });
  ipcMain.on("ssh:write", (event, sessionId, data) => {
    if (isMainFrame(event) && vault.unlocked) ssh.write(sessionId, data);
  });
  ipcMain.on("ssh:resize", (event, sessionId, cols, rows) => {
    if (isMainFrame(event)) ssh.resize(sessionId, cols, rows);
  });

  // ---- mailboxes ----------------------------------------------------------
  handle("mail:providers", async () => MAIL_PROVIDERS);
  handle("mail:guess", async (address) => providerForAddress(address));
  handle("mail:test", (options) => testMailbox(options));
  handle("mail:oauth-providers", async () =>
    Object.fromEntries(
      Object.entries(OAUTH_PROVIDERS).map(([id, p]) => [
        id,
        {
          label: p.label,
          usesSecret: p.usesSecret,
          scopes: p.scopes,
          consoleUrl: p.consoleUrl,
          setupNote: p.setupNote,
        },
      ]),
    ),
  );
  handle("mail:oauth-sign-in", (options) => oauthSignIn(options));
  // Google hands you a client_secret_*.json; reading it beats retyping two
  // opaque strings, and the values never touch the renderer's disk.
  handle("dialog:pick-json", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "选择 OAuth 客户端 JSON",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readOAuthClientFile(result.filePaths[0]);
  });

  // ---- network probes -----------------------------------------------------
  handle("domain:probe", (name) => probeDomain(name));
  handle("cert:probe", (host, port, servername) => probeCertificate(host, port, servername));
  handle("cert:parse-pem", async (pem) => {
    const cert = new X509Certificate(pem);
    // X509Certificate hands back an RFC 2253 string; pull the two fields the
    // cards actually show rather than parsing the whole DN.
    const field = (dn, key) => new RegExp(`${key}=([^,\\r\\n]+)`).exec(dn)?.[1]?.trim();
    const cn = field(cert.subject, "CN");
    const issuer = field(cert.issuer, "O") ?? field(cert.issuer, "CN");
    return {
      cn: cn ?? "",
      issuer: issuer ?? "",
      validFrom: new Date(cert.validFrom).toISOString(),
      expiresAt: new Date(cert.validTo).toISOString(),
      sans: (cert.subjectAltName ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^DNS:/, ""))
        .filter(Boolean),
      serial: cert.serialNumber,
    };
  });

  // ---- window controls ----------------------------------------------------
  handle("window:state", async () => ({
    maximized: Boolean(win?.isMaximized()),
    platform: process.platform,
  }));
  ipcMain.on("window:minimize", (event) => {
    if (isMainFrame(event)) win.minimize();
  });
  ipcMain.on("window:close", (event) => {
    if (isMainFrame(event)) win.close();
  });
  ipcMain.on("window:toggle-maximize", (event) => {
    if (!isMainFrame(event)) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  handle("shell:open-external", async (url) => {
    if (!/^https?:\/\//.test(url)) throw new Error("只允许打开 http(s) 链接");
    await shell.openExternal(url);
    return true;
  });
}

export const credentialId = (serverId) => `ssh:${serverId}`;

/** Vault key for a server's pinned host key fingerprint — must match the renderer. */
export const hostKeyId = (host, port) =>
  `ssh-host:${String(host).trim().toLowerCase()}:${Number(port) || 22}`;

// One window per launch; a second instance just focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    acceptCapture(argv);
    showWindow();
  });

  app.whenReady().then(async () => {
    // 便携版不写注册表，保持“解压即用、删除即走”。
    if (
      app.isPackaged &&
      !PORTABLE &&
      !process.argv.some((arg) => arg.startsWith("--user-data-dir="))
    )
      app.setAsDefaultProtocolClient("nanpad");
    app.setAppUserModelId(windowsAppId(app.isPackaged));
    // 必须先于读取偏好、资产和创建任何服务：此时没有进程持有资料文件。
    try {
      restoreOutcome = await applyPendingRestore(app.getPath("userData"));
    } catch (error) {
      restoreOutcome = { status: "failed", message: String(error?.message ?? error) };
      console.error("backup:restore", error);
    }
    if (
      process.platform === "win32" &&
      !PORTABLE &&
      !process.env.NANPAD_TEST_DATA_DIR &&
      !process.argv.some((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="))
    ) {
      try {
        await migrateLegacyWindowsShortcut({
          programsDirectory: join(app.getPath("appData"), "Microsoft/Windows/Start Menu/Programs"),
          backupDirectory: join(app.getPath("userData"), "shortcut-backups"),
          readShortcut: (path) => shell.readShortcutLink(path),
        });
      } catch (error) {
        console.warn("windows-shortcut:migration", error.message);
      }
    }
    try {
      const saved = JSON.parse(
        await readFile(join(app.getPath("userData"), "preferences.json"), "utf8"),
      );
      for (const key of ["closeToTray", "notifications"])
        if (typeof saved[key] === "boolean") preferences[key] = saved[key];
      if (["zh", "en"].includes(saved.locale)) preferences.locale = saved.locale;
      preferences.zoomPercent = readZoomPercent(saved.zoomPercent);
      preferences.serverMonitorMinutes = readMonitorMinutes(saved.serverMonitorMinutes);
    } catch (err) {
      if (err.code !== "ENOENT") console.error("preferences:load", err.message);
    }
    try {
      const saved = JSON.parse(await readFile(dataFile(), "utf8"));
      currentSnapshot = saved?.state ?? saved ?? {};
    } catch (err) {
      if (err.code !== "ENOENT") console.error("assets:load", err.message);
    }
    Menu.setApplicationMenu(buildMenu());
    registerIpc();
    // 操作系统锁屏或休眠立即锁库；恢复后由用户重新解锁。
    powerMonitor.on("lock-screen", lockVault);
    powerMonitor.on("suspend", lockVault);
    await extensionBridge.start();
    try {
      const iconPath = app.isPackaged
        ? join(process.resourcesPath, "icon.png")
        : join(here, "../build/icon.png");
      const icon = nativeImage.createFromPath(iconPath);
      tray = new Tray(process.platform === "win32" ? icon : icon.resize({ width: 20, height: 20 }));
      tray.on("double-click", showWindow);
      tray.on("click", showWindow);
      updateTray();
    } catch (err) {
      console.error("tray:create", err.message);
    }
    await createWindow();
    if (
      restoreOutcome &&
      restoreOutcome.status !== "discarded" &&
      !process.env.NANPAD_TEST_DATA_DIR
    )
      void showRestoreOutcome(restoreOutcome);
    notificationTimer = setInterval(notifyAttention, 60_000);
    mailPushTimer = setInterval(() => void mailPush.tick(), 60_000);
    notifyAttention();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on("window-all-closed", () => {
    ssh?.closeAll();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    stopPrivateTasks();
    identities?.stop();
    mainIdentity?.stop();
    documentAccounts?.stop();
    void extensionBridge?.stop();
    quitting = true;
    clearInterval(notificationTimer);
    clearInterval(mailPushTimer);
    ssh?.closeAll();
    tray?.destroy();
    tray = null;
  });
}

function showRestoreOutcome(outcome) {
  const en = preferences.locale === "en";
  const where = join(app.getPath("userData"), outcome.snapshot ?? "");
  if (outcome.status === "applied")
    return dialog.showMessageBox(win, {
      type: "info",
      title: en ? "Restored from backup" : "已从备份恢复",
      message: en ? "Your data was restored from the backup." : "资料已从备份恢复。",
      detail: en
        ? `Unlock the vault with the master password that was in use when the backup was made.\n\nThe data you had before restoring is kept in:\n${where}`
        : `请使用创建备份时的主密码解锁密钥库。\n\n恢复前的资料已保存在：\n${where}`,
      buttons: [en ? "OK" : "知道了"],
      noLink: true,
    });
  return dialog.showMessageBox(win, {
    type: "error",
    title: en ? "Restore incomplete" : "恢复未完成",
    message: en ? "The backup could not be applied." : "备份未能完整替换当前资料。",
    detail: en
      ? `${outcome.message}\n\nNothing was deleted: earlier data is in the restore-snapshots folder and the prepared files are in .restore-pending inside the data folder. Restart Zhiyu to retry.`
      : `${outcome.message}\n\n没有删除任何资料：原资料在资料目录的 restore-snapshots 中，待恢复的文件在 .restore-pending 中。重新启动知屿会继续尝试。`,
    buttons: [en ? "OK" : "知道了"],
    noLink: true,
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const label = (zh, en) => (preferences.locale === "en" ? en : zh);
  return Menu.buildFromTemplate([
    ...(isMac
      ? [
          {
            label: "知屿 Zhiyu",
            submenu: [
              {
                label: label("关于知屿 Zhiyu", "About Zhiyu"),
                click: () => {
                  app.setAboutPanelOptions({ applicationName: "知屿 Zhiyu" });
                  app.showAboutPanel();
                },
              },
              { type: "separator" },
              { role: "services", label: label("服务", "Services") },
              { type: "separator" },
              { role: "hide", label: label("隐藏知屿 Zhiyu", "Hide Zhiyu") },
              { role: "hideOthers", label: label("隐藏其他应用", "Hide Others") },
              { role: "unhide", label: label("显示全部", "Show All") },
              { type: "separator" },
              { role: "quit", label: label("退出知屿 Zhiyu", "Quit Zhiyu") },
            ],
          },
        ]
      : []),
    {
      label: label("文件", "File"),
      submenu: [
        {
          label: label("锁定密钥库", "Lock vault"),
          click: lockVault,
        },
        { type: "separator" },
        isMac
          ? { role: "close", label: label("关闭窗口", "Close window") }
          : { role: "quit", label: label("退出", "Quit") },
      ],
    },
    { label: label("编辑", "Edit"), role: "editMenu" },
    {
      label: label("视图", "View"),
      submenu: [
        { role: "reload", label: label("重新载入", "Reload") },
        // DevTools stay available in development only: in a packaged build the
        // renderer can be walked into from the console, and the preload bridge
        // reaches straight into the vault.
        ...(app.isPackaged
          ? []
          : [{ role: "toggleDevTools", label: label("开发者工具", "Developer tools") }]),
        { type: "separator" },
        {
          label: label("实际大小", "Actual size"),
          accelerator: "CmdOrCtrl+0",
          click: () => stepDisplayZoom("reset"),
        },
        {
          label: label("放大", "Zoom in"),
          accelerator: "CmdOrCtrl+Plus",
          click: () => stepDisplayZoom("in"),
        },
        {
          label: label("缩小", "Zoom out"),
          accelerator: "CmdOrCtrl+-",
          click: () => stepDisplayZoom("out"),
        },
        { type: "separator" },
        { role: "togglefullscreen", label: label("全屏", "Full screen") },
      ],
    },
    {
      label: label("帮助", "Help"),
      submenu: [
        {
          label: label("项目主页", "Project homepage"),
          click: () => shell.openExternal("https://github.com/Songwo/zhiyu"),
        },
      ],
    },
  ]);
}
