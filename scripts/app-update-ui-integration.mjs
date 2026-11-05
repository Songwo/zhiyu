import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const origin = process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8856";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 900, height: 650 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}/__updater-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="root"></main></body></html>',
    }),
  );
  await page.goto(`${origin}/__updater-test`);
  await page.evaluate(async () => {
    window.__state = {
      state: "outdated",
      current: "1.3.1",
      latest: "1.4.0",
      page: "https://github.com/Songwo/zhiyu/releases/latest",
    };
    window.__installs = 0;
    window.__saveFails = true;
    window.sinan = {
      checkUpdate: async () => window.__state,
      updates: {
        status: async () => window.__state,
        onStatus: (handler) => {
          window.__listener = handler;
          return () => {
            window.__listener = null;
          };
        },
        download: async () => {
          window.__state = { ...window.__state, state: "downloading", progress: 42 };
          window.__listener(window.__state);
          await new Promise((done) => {
            window.__finish = done;
          });
          window.__state = { ...window.__state, state: "downloaded", progress: 100 };
          window.__listener(window.__state);
          return window.__state;
        },
        install: async () => {
          window.__installs++;
          return { ...window.__state, state: "installing" };
        },
      },
      documents: {
        save: async (document) => {
          if (window.__saveFails) throw Error("隔离测试：文档保存失败");
          window.__saved = document;
          return document;
        },
      },
    };
    const RefreshRuntime = (await import("/@react-refresh")).default;
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { AppUpdatePanel } = await import("/src/components/app-update-panel.tsx");
    const entry = performance
      .getEntriesByType("resource")
      .find((item) => item.name.includes("/src/lib/documents.ts"));
    const { useDocuments } = await import(entry.name);
    useDocuments.setState({
      status: { "doc-updater": "dirty" },
      drafts: {
        "doc-updater": {
          id: "doc-updater",
          title: "更新前的草稿",
          content: { type: "doc", content: [] },
          bindings: [],
        },
      },
    });
    ReactDOM.createRoot(document.getElementById("root")).render(
      React.createElement(AppUpdatePanel),
    );
  });
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await page.getByText("正在下载更新 42%", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "检查更新", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("progressbar").getAttribute("value"), "42");
  await page.evaluate(() => window.__finish());
  await page.getByRole("button", { name: "重启并安装", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "文档保存失败" }).waitFor();
  assert.equal(await page.evaluate(() => window.__installs), 0);
  await mkdir("screenshots", { recursive: true });
  await page.evaluate(() => {
    window.__saveFails = false;
  });
  await page.screenshot({ path: "screenshots/updater-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "screenshots/updater-mobile.png" });
  await page.getByRole("button", { name: "重启并安装", exact: true }).click();
  await page.getByText("正在重启安装，请稍候…", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__installs), 1);
  assert.equal(await page.evaluate(() => window.__saved.title), "更新前的草稿");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      progress: true,
      saveFailureBlocksInstall: true,
      successfulSaveBeforeInstall: true,
      mobileNoOverflow: true,
      isolated: true,
    }),
  );
} finally {
  await browser.close();
}
