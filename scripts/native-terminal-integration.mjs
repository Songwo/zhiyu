import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { _electron as electron } from "playwright";
import ssh2 from "ssh2";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 只连接本机临时 SSH 服务与隔离密钥库，不读取用户的服务器和凭据。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-native-e2e-"));
const clients = new Set();
let instance,
  shells = 0;
let heartbeatCount = 0,
  testStream;
let typedInput = "";
const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const server = new ssh2.Server(
  {
    hostKeys: [key],
    debug: (line) => {
      if (line.includes("Inbound: GLOBAL_REQUEST (keepalive@openssh.com)")) heartbeatCount++;
    },
  },
  (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) =>
      ctx.method === "password" && ctx.password === "local-fixture" ? ctx.accept() : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty());
        session.on("window-change", (acceptChange) => acceptChange?.());
        session.on("shell", (acceptShell) => {
          shells++;
          const stream = acceptShell();
          testStream = stream;
          stream.on("data", (data) => { typedInput += data.toString(); });
          stream.write("\x1b[32m本机 SSH 集成测试已连接\x1b[0m\r\n");
        });
      }),
    );
  },
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
try {
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  const page = await instance.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  await completeOnboarding(page);
  async function configureTerminal(entries) {
    await page.getByRole("button", { name: "终端设置", exact: true }).click();
    // 原生子窗口通过异步管道隐藏；等它完成，避免尚在处理的焦点消息关闭下拉框。
    await page.waitForFunction(() => {
      const layouts = new Map();
      for (const event of window.nativeEvents || []) {
        if (event.type === "layout") layouts.set(event.serverId, event.visible);
        else if (event.type === "status" && event.value === "closed")
          layouts.delete(event.serverId);
      }
      return [...layouts.values()].every((visible) => !visible);
    });
    for (const [label, option] of entries) {
      await page.getByRole("combobox", { name: label, exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    }
    await page.screenshot({ path: "screenshots/terminal-settings-page.png" });
    await page.getByRole("button", { name: "返回终端", exact: true }).click();
  }
  await page.evaluate(
    async ({ port }) => {
      const bridge = window.sinan;
      if (!bridge.ssh.nativeOpen) throw new Error("缺少原生入口");
      const snapshot = await bridge.store.load();
      await bridge.store.save({
        ...snapshot,
        state: {
          ...snapshot.state,
          servers: [
            {
              id: "qa-native",
              name: "native-test",
              label: "本机测试",
              host: "127.0.0.1",
              port,
              username: "tester",
              status: "offline",
              sshConfigured: true,
              collect: true,
              tags: [],
              os: "Linux",
              region: "Local",
              notes: "本机临时 SSH 服务",
            },
          ],
        },
      });
      await bridge.vault.set("ssh:qa-native", { kind: "password", password: "local-fixture" });
      const saved = await bridge.store.load();
      await bridge.store.save({
        ...saved,
        state: {
          ...saved.state,
          servers: [
            ...saved.state.servers,
            {
              ...saved.state.servers[0],
              id: "qa-native-b",
              name: "native-test-b",
              label: "第二本机测试",
            },
          ],
        },
      });
      await bridge.vault.set("ssh:qa-native-b", { kind: "password", password: "local-fixture" });
    },
    { port: server.address().port },
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page
    .locator("nav")
    .getByRole("button", { name: /^服务器/ })
    .click();
  await page.locator('[data-asset-id="qa-native"]').click();
  await page.evaluate(() => {
    window.nativeEvents = [];
    window.sinan.ssh.onNativeEvent((event) => window.nativeEvents.push(event));
  });
  await page.getByRole("button", { name: "玻璃终端", exact: true }).click();
  for (let i = 0; i < 150 && !shells; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(shells, 1, "点击服务器应启动 C# 窗口并建立真实 SSH 会话");
  await page.locator('[data-native-mounted="true"]').waitFor();
  const attached = await page.evaluate(() =>
    window.nativeEvents.find((event) => event.type === "attached"),
  );
  const parentHandle = await instance.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(),
  );
  assert.equal(attached.parentHandle, parentHandle, "原生控件必须嵌入本应用主窗口");
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setAlwaysOnTop(true); window.show(); window.focus();
  });
  await page.waitForFunction(() => window.nativeEvents.some((event) =>
    event.type === "layout" && event.visible && event.width > 200));
  await new Promise((r) => setTimeout(r, 500));
  const inputResult = spawnSync(resolve("release/native-terminal/terminal-tests.exe"),
    ["--type-native", attached.childHandle], { windowsHide: true, encoding: "utf8" });
  assert.equal(inputResult.status, 0, inputResult.stderr);
  for (let i = 0; i < 50 && !typedInput; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(typedInput.replace(/[\r\n]/g, "").length > 0, "实际点击原生输出区后，物理键盘文字必须到达 SSH: " + inputResult.stdout);
  assert.equal(
    await page.locator(".glass-terminal").count(),
    0,
    "Windows 原生入口不再渲染网页弹窗",
  );
  await configureTerminal([["终端配色", "暖纸护眼"]]);
  await configureTerminal([["终端字体", "Consolas"]]);
  await configureTerminal([["终端字号", "18 px"]]);
  await configureTerminal([
    ["光标闪烁", "常亮"],
    ["历史输出行数", "1000 行"],
  ]);
  await page.waitForFunction(() =>
    window.nativeEvents.some(
      (event) =>
        event.type === "appearance" && event.fontSize === 18 && event.background === "#f5f1e7",
    ),
  );
  await page
    .locator("nav")
    .getByRole("button", { name: /^资产总览/ })
    .first()
    .click();
  await page.waitForFunction(
    () => window.nativeEvents.filter((event) => event.type === "layout").at(-1)?.visible === false,
  );
  await page.locator("nav").getByRole("button", { name: /^终端/ }).first().click();
  await page.waitForFunction(
    () => window.nativeEvents.filter((event) => event.type === "layout").at(-1)?.visible === true,
  );
  assert.equal(shells, 1, "切换页面保留原有连接");
  await page.getByRole("button", { name: "锁定滚动", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.nativeEvents
        .filter((event) => event.serverId === "qa-native" && event.type === "viewport")
        .at(-1)?.locked === true,
  );
  testStream.write(
    Array.from(
      { length: 2400 },
      (_, i) => `\x1b[32m[log ${i + 1}]\x1b[0m background output\r\n`,
    ).join(""),
  );
  await page.waitForFunction(() => {
    const view = window.nativeEvents
      .filter((event) => event.serverId === "qa-native" && event.type === "viewport")
      .at(-1);
    return view?.history === 1000 && view.unread > 2000 && view.offset > 0;
  });
  await page.getByRole("button", { name: "返回主机列表", exact: true }).click();
  await page.locator('[data-terminal-server="qa-native"]').click();
  await page.locator('[data-native-mounted="true"]').waitFor();
  assert.equal(shells, 1, "离开终端列表再返回，应复用原 SSH 和历史输出");
  assert.equal(
    (
      await page.evaluate(() =>
        window.nativeEvents.filter(
          (event) => event.serverId === "qa-native" && event.type === "attached",
        ),
      )
    ).length,
    1,
    "返回时不得重建原生输出控件",
  );
  await page.getByRole("button", { name: "返回主机列表", exact: true }).click();
  await page.locator('[data-terminal-server="qa-native-b"]').click();
  for (let i = 0; i < 100 && shells < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shells, 2, "打开另一台主机可并行保留两个会话");
  await page
    .getByRole("navigation", { name: "终端会话", exact: true })
    .getByRole("button", { name: "本机测试", exact: true })
    .click();
  assert.equal(
    await page.locator('[data-native-mounted="true"]:visible').count(),
    1,
    "只显示当前主机的原生输出区",
  );
  await page
    .getByRole("navigation", { name: "终端会话", exact: true })
    .getByRole("button", { name: "第二本机测试", exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "断开", exact: true }).click();
  for (let i = 0; i < 100 && clients.size > 1; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clients.size, 1, "断开第二会话不影响第一会话");
  await page.locator('[data-terminal-server="qa-native"]').click();
  const trayState = await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.close();
    return { hidden: !window.isVisible(), destroyed: window.isDestroyed() };
  });
  assert.deepEqual(trayState, { hidden: true, destroyed: false });
  const beforeHeartbeat = heartbeatCount;
  for (let i = 0; i < 260 && heartbeatCount <= beforeHeartbeat; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(heartbeatCount > beforeHeartbeat, "窗口驻留托盘时，服务器必须收到真实 SSH 保活请求");
  assert.equal(clients.size, 1, "托盘驻留期间保留原连接");
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
  });
  await page.getByRole("button", { name: "回到最新输出", exact: true }).click();
  await page.waitForFunction(() => {
    const view = window.nativeEvents
      .filter((event) => event.serverId === "qa-native" && event.type === "viewport")
      .at(-1);
    return view?.atBottom === true && view.locked === false && view.unread === 0;
  });
  await page.getByRole("button", { name: "系统设置…", exact: true }).click();
  await page.waitForFunction(
    () => window.nativeEvents.filter((event) => event.type === "layout").at(-1)?.visible === false,
  );
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.waitForFunction(
    () => window.nativeEvents.filter((event) => event.type === "layout").at(-1)?.visible === true,
  );
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setAlwaysOnTop(true);
    window.show();
    window.focus();
  });
  await new Promise((r) => setTimeout(r, 350));
  const capture = async (name) => {
    await instance.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isMinimized()) window.restore();
      window.setAlwaysOnTop(true);
      window.show();
      window.focus();
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const captured = spawnSync(
      resolve("release/native-terminal/terminal-tests.exe"),
      ["--capture-screen", parentHandle, resolve(`screenshots/${name}.png`)],
      { windowsHide: true, encoding: "utf8" },
    );
    assert.equal(captured.status, 0, captured.stderr);
  };
  await capture("terminal-embedded-paper");
  await capture("terminal-output-scrollbar");
  assert.equal(shells, 2, "恢复窗口后不得新增 SSH 握手");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "断开", exact: true }).click();
  for (let i = 0; i < 100 && clients.size; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clients.size, 0, "显式断开结束远程会话");
  await page.locator('[data-terminal-server="qa-native"]').click();
  for (let i = 0; i < 100 && shells < 3; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shells, 3, "显式断开后再次打开应建立新连接");
  await configureTerminal([["终端配色", "跟随软件"]]);
  await configureTerminal([["终端字体", "Cascadia Mono"]]);
  await configureTerminal([["终端字号", "14 px"]]);
  await page.locator("nav").getByRole("button", { name: /^终端/ }).first().click();
  await assert.rejects(
    page.evaluate(() => window.sinan.ssh.nativeOpen({ id: "not-saved", host: "example.test" })),
    /no longer exists/,
  );
  await page.evaluate(() => window.sinan.vault.lock());
  for (let i = 0; i < 100 && clients.size; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(clients.size, 0, "锁定密钥库会关闭原生窗口和 SSH 会话");
  await page.getByRole("button", { name: "终端外观预览", exact: true }).waitFor();
  await page.getByRole("button", { name: "终端外观预览", exact: true }).click();
  await page.locator('[data-native-mounted="true"]').waitFor();
  await page.waitForFunction(() =>
    window.nativeEvents.some(
      (event) =>
        event.serverId === "__terminal_preview__" && event.type === "layout" && event.visible,
    ),
  );
  assert.equal(shells, 3, "外观预览不连接服务器，也不要求解锁密钥库");
  await new Promise((r) => setTimeout(r, 200));
  await capture("terminal-embedded-light");
  await page.getByRole("button", { name: "切换主题外观", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === "dark" &&
      window.nativeEvents
        .filter((event) => event.serverId === "__terminal_preview__" && event.type === "appearance")
        .at(-1)?.background === "#20201e",
  );
  await new Promise((r) => setTimeout(r, 200));
  await capture("terminal-embedded-follow-dark");
  await page.getByRole("button", { name: "切换主题外观", exact: true }).click();
  await configureTerminal([["终端配色", "柔和暗色"]]);
  await page.waitForFunction(() =>
    window.nativeEvents.some(
      (event) =>
        event.serverId === "__terminal_preview__" &&
        event.type === "appearance" &&
        event.background === "#242622",
    ),
  );
  await new Promise((r) => setTimeout(r, 200));
  await capture("terminal-embedded-dusk");
  const highlights = spawnSync(
    resolve("release/native-terminal/terminal-tests.exe"),
    ["--check-highlight", resolve("screenshots/terminal-embedded-dusk.png")],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(highlights.status, 0, highlights.stderr);
  assert.equal(
    JSON.parse(await page.evaluate(() => localStorage.getItem("sinan-settings-v1"))).state
      .terminalAppearance.theme,
    "dusk",
  );
  await page.getByRole("button", { name: "返回主机列表", exact: true }).click();
  await page.getByRole("button", { name: "终端外观预览", exact: true }).click();
  await page.getByRole("button", { name: "终端设置", exact: true }).click();
  assert.match(
    await page.getByRole("combobox", { name: "终端配色", exact: true }).innerText(),
    /柔和暗色/,
  );
  await page.getByRole("button", { name: "返回终端", exact: true }).click();
  assert.equal(
    await page.locator('[aria-label="终端工作区"] [role="combobox"]').count(),
    0,
    "终端页不保留外观配置控件",
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.locator("nav").getByRole("button", { name: /^终端/ }).first().click();
  await page.getByRole("button", { name: "终端外观预览", exact: true }).click();
  await page.getByRole("button", { name: "终端设置", exact: true }).click();
  assert.match(
    await page.getByRole("combobox", { name: "终端配色", exact: true }).innerText(),
    /柔和暗色/,
  );
  await page.getByRole("button", { name: "返回终端", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      embeddedNativeControl: true,
      nativeHighlightVisible: true,
      shellConnections: shells,
      backgroundHeartbeat: heartbeatCount > 0,
      historyLimit: 1000,
      resumedWithoutReconnect: true,
      webModalCount: 0,
      lockCleanup: true,
      consoleErrors: errors,
    }),
  );
  if (process.argv.includes("--show")) {
    await page.evaluate(async () => {
      const snapshot = await window.sinan.store.load();
      await window.sinan.store.save({ ...snapshot, state: { ...snapshot.state, servers: [] } });
      await window.sinan.profile.save({ name: "终端界面预览" });
      await window.sinan.vault.unlock("integration-master-2026");
    });
    await page.reload();
    await page.locator('[data-app-ready="true"]').waitFor();
    await page.locator("nav").getByRole("button", { name: /^终端/ }).first().click();
    await page.getByRole("button", { name: "终端外观预览", exact: true }).click();
    await page.locator('[data-native-mounted="true"]').waitFor();
    await configureTerminal([["终端配色", "跟随软件"]]);
    await page.getByRole("button", { name: "终端设置", exact: true }).click();
    await instance.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setAlwaysOnTop(false);
      window.focus();
    });
    console.log("PREVIEW_READY: 项目内终端外观预览已打开");
    await new Promise((resolve) => instance.process().once("exit", resolve));
  }
} catch (error) {
  const page = instance?.windows()[0];
  console.error(
    await page?.evaluate(() => ({
      events: window.nativeEvents,
      text: document.querySelector('[aria-label="终端工作区"]')?.textContent,
    })),
  );
  await page?.screenshot({ path: "screenshots/native-entry-failure.png" }).catch(() => {});
  throw error;
} finally {
  await instance?.close();
  for (const client of clients) client.end();
  await new Promise((r) => server.close(r));
  await rm(directory, { recursive: true, force: true });
}
