import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { MetricsStore } from "../electron/services/metrics.mjs";
import { completeOnboarding } from "./onboarding-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "nanpad-desktop-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
let instance;
try {
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await completeOnboarding(page);
  await page.getByRole("button", { name: "添加资产", exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  // 测试资产及曲线只写入本次创建的临时目录。必须在下方 capabilities 检查
  // （首次 bridge.metrics.list）之前写入：0.9.0 起 MetricsStore 的解析结果
  // 常驻内存，进程缓存了旧文件后就再也看不到外部写入。
  const samples = new MetricsStore(join(directory, "metrics.json"));
  for (let i = 0; i < 8; i++)
    await samples.record("qa-host", {
      at: new Date(Date.now() - (8 - i) * 60000).toISOString(),
      cpu: 20 + i * 5,
      memory: 40 + i,
      disk: 30,
    });
  const capabilities = await page.evaluate(async () => {
    const bridge = window.sinan;
    const info = await bridge.info();
    const prefs = await bridge.preferences.get();
    await Promise.all([
      bridge.preferences.set({ notifications: false }),
      bridge.preferences.set({ closeToTray: true }),
      bridge.preferences.set({ locale: "en" }),
    ]);
    const saved = await bridge.preferences.get();
    const history = await bridge.metrics.list("missing", 0);
    let rejected = false;
    try {
      await bridge.sftp.list("missing", "/");
    } catch {
      rejected = true;
    }
    return { version: info.version, prefs, saved, history, rejected };
  });
  assert.equal(capabilities.version, JSON.parse(await readFile("package.json", "utf8")).version);
  assert.equal(capabilities.saved.notifications, false);
  assert.equal(capabilities.saved.closeToTray, true);
  assert.equal(capabilities.saved.locale, "en");
  assert.deepEqual(capabilities.history, []);
  assert.equal(capabilities.rejected, true);
  await page.evaluate(async () =>
    window.sinan.store.save({
      version: 0,
      state: {
        servers: [
          {
            id: "qa-host",
            name: "QA local host",
            label: "QA",
            host: "127.0.0.1",
            port: 22,
            username: "test",
            os: "Linux",
            region: "Local",
            tags: [],
            status: "online",
            cpu: 55,
            memory: 47,
            disk: 30,
            uptime: "1d",
            lastSeen: new Date().toISOString(),
            notes: "",
          },
        ],
        domains: [
          {
            id: "qa-domain",
            name: "qa.example.test",
            registrar: "QA",
            expiresAt: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            dns: "QA",
            nameservers: [],
            autoRenew: false,
            status: "warning",
            tags: [],
            notes: "",
          },
        ],
        certs: [],
        mailboxes: [],
        aiAssets: [],
        secrets: [],
        links: [],
        activity: [],
      },
    }),
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await navigateDesktop(page, "服务器");
  await page.locator('[data-asset-id="qa-host"]').click();
  await page.locator(".metric-history .recharts-line-curve").first().waitFor();
  assert.equal(await page.locator(".metric-history .recharts-line-curve").count(), 3);
  await page.getByRole("button", { name: "管理关联", exact: true }).click();
  await page.getByRole("combobox", { name: "选择关联资产" }).click();
  await page
    .getByRole("option")
    .filter({ has: page.getByText("qa.example.test", { exact: true }) })
    .click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  await page.getByRole("button", { name: "解除关联", exact: true }).waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "域名qa.example.test", exact: false })
    .click();
  await page.getByRole("button", { name: "解除关联", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const calendarPath = join(directory, "reminders.ics");
  await instance.evaluate(({ session }, target) => {
    session.defaultSession.once("will-download", (_event, item) => item.setSavePath(target));
  }, calendarPath);
  await page.getByRole("button", { name: "导出提醒日历" }).click();
  let exported = false;
  for (let i = 0; i < 100; i++) {
    try {
      exported = (await readFile(calendarPath, "utf8")).includes("END:VCALENDAR");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exported) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(exported, "日历文件应完成下载");
  assert.match(await readFile(calendarPath, "utf8"), /BEGIN:VEVENT/);
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await navigateDesktop(page, "服务器");
  await page.locator('[data-asset-id="qa-host"]').click();
  await page.getByRole("button", { name: "解除关联", exact: true }).click();
  assert.equal((await page.evaluate(() => window.sinan.store.load())).state.links.length, 0);
  await page.screenshot({ path: "release/screenshots/nanpad-desktop-metrics.png" });
  await page.keyboard.press("Escape");
  const native = await instance.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.close();
    return {
      hidden: !window.isVisible(),
      destroyed: window.isDestroyed(),
      menu: Boolean(Menu.getApplicationMenu()),
    };
  });
  assert.ok(!native.destroyed && native.hidden, "关闭窗口应驻留托盘");
  await mkdir("release/screenshots", { recursive: true });
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.screenshot({ path: "release/screenshots/nanpad-desktop-native.png" });
  assert.deepEqual(errors, []);
  const persisted = JSON.parse(await readFile(join(directory, "preferences.json"), "utf8"));
  assert.equal(persisted.notifications, false);
  assert.equal(persisted.locale, "zh");
  console.log(JSON.stringify({ ok: true, native, capabilities, consoleErrors: errors }, null, 2));
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
}
