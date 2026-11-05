import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8856";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1280, height: 900 } }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`${origin}/__background-update-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="root"></main></body></html>',
    }),
  );
  await page.goto(`${origin}/__background-update-test`);
  await page.evaluate(async () => {
    window.__installCalls = 0;
    window.sinan = {
      updates: {
        status: async () => ({ state: "current", current: "1.17.6" }),
        onStatus: (cb) => {
          window.__status = cb;
          return () => {};
        },
        install: async () => {
          window.__installCalls++;
        },
      },
    };
    const runtime = (await import("/@react-refresh")).default;
    runtime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import("/node_modules/.vite/deps/react.js")).default,
      ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { AppUpdateNotice } = await import("/src/components/app-update-notice.tsx"),
      { startUpdateNotices } = await import("/src/lib/app-updates.ts");
    startUpdateNotices();
    ReactDOM.createRoot(document.getElementById("root")).render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(AppUpdateNotice),
        React.createElement("textarea", { "aria-label": "未提交文档草稿" }),
      ),
    );
  });
  const draft = page.getByRole("textbox", { name: "未提交文档草稿", exact: true });
  await draft.fill("正在编辑中的原文和未发送命令");
  await draft.focus();
  for (const [state, progress] of [
    ["outdated", 0],
    ["downloading", 42],
    ["downloaded", 100],
  ]) {
    await page.evaluate(
      ({ state, progress }) =>
        window.__status({ state, progress, current: "1.17.6", latest: "1.17.7" }),
      { state, progress },
    );
    await page.getByLabel("版本更新提醒", { exact: true }).waitFor();
    assert.equal(
      await draft.evaluate((el) => document.activeElement === el),
      true,
      "后台事件不能抢焦点",
    );
    assert.equal(await draft.inputValue(), "正在编辑中的原文和未发送命令");
    assert.equal(await page.getByRole("dialog").count(), 0);
  }
  assert.equal(await page.evaluate(() => window.__installCalls), 0);
  await page.getByRole("button", { name: "本次暂不提醒", exact: true }).click();
  assert.equal(await page.getByLabel("版本更新提醒", { exact: true }).count(), 0);
  await page.evaluate(() => window.__status({ state: "outdated", latest: "1.17.8" }));
  await page.getByLabel("版本更新提醒", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        allBackgroundStatesPreserveFocusAndDraft: true,
        noAutomaticInstall: true,
        dismissPerVersion: true,
        noDialogs: true,
        mobileNoOverflow: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
