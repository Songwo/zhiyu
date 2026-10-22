import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const origin = new URL(process.env.DEV_URL ?? "http://127.0.0.1:8080").origin;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [];
const pageErrors = [];
let failure;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.fulfill({ status: 204, body: "" }),
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(async () => {
    const entry = performance
      .getEntriesByType("resource")
      .find((item) => item.name.includes("/src/lib/store.ts"));
    const { useAppStore } = await import(entry.name);
    window.__documentQaStore = useAppStore;
    window.__legacyMarkdown =
      "# 原始运维资料\n```bash\nprintf hello\n```\n[文档](https://example.test/docs)";
    useAppStore.setState({
      view: "servers",
      servers: [
        {
          id: "qa-document-host",
          name: "文档回归主机",
          host: "example.test",
          port: 22,
          username: "qa",
          label: "QA",
          os: "Linux",
          region: "QA",
          status: "online",
          cpu: 0,
          memory: 0,
          disk: 0,
          uptime: "1d",
          lastSeen: new Date().toISOString(),
          tags: [],
          notes: "",
          docs: window.__legacyMarkdown,
        },
      ],
      expanded: {
        kind: "server",
        id: "qa-document-host",
        origin: { x: 100, y: 100, w: 400, h: 200 },
      },
    });
  });
  await page.getByRole("region", { name: "资产详情", exact: true }).waitFor();
  // 详情在主内容区内打开：列表隐藏但保留，入场动画结束后卡片完全显示。
  assert.equal(await page.locator(".workspace-view").getAttribute("hidden"), "");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".asset-detail .detail-block")].every(
      (el) => getComputedStyle(el).opacity === "1",
    ),
  );
  checks.push("详情在页面内打开，入场动画结束后完全显示");
  await page.getByRole("button", { name: "服务文档", exact: true }).click();
  await page
    .getByRole("button", { name: "迁移并编辑旧文档", exact: true })
    .click({ timeout: 3000 });
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await page.getByRole("textbox", { name: "文档标题", exact: true }).waitFor();
  assert.match(
    await page.getByRole("textbox", { name: "文档正文", exact: true }).innerText(),
    /printf hello/,
  );
  assert.equal(
    await page.getByRole("button", { name: "插入图片", exact: true }).innerText(),
    "插入图片",
  );
  const original = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem(
        Object.keys(localStorage).find((key) => key.startsWith("nanpad-doc:doc-legacy-server-")),
      ),
    ),
  );
  assert.equal(
    original.content.content[0].content[0].text,
    await page.evaluate(() => window.__legacyMarkdown),
  );
  await page.getByRole("textbox", { name: "文档标题", exact: true }).fill("修改后的运维记录");
  await page.getByRole("button", { name: /^关联与设置/ }).click();
  await page.locator(".document-bindings input[type=checkbox]").first().uncheck();
  await page.waitForFunction(() => {
    const document = JSON.parse(
      localStorage.getItem(
        Object.keys(localStorage).find((key) => key.startsWith("nanpad-doc:doc-legacy-server-")),
      ),
    );
    return document.title === "修改后的运维记录" && document.bindings.length === 0;
  });
  checks.push("Markdown原文迁移、修改和解绑自动保存");
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.__documentQaStore.setState({
      view: "servers",
      expanded: {
        kind: "server",
        id: "qa-document-host",
        origin: { x: 100, y: 100, w: 400, h: 200 },
      },
    }),
  );
  await page.getByRole("button", { name: "服务文档", exact: true }).click();
  await page.getByRole("button", { name: "迁移并编辑旧文档", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".document-reading-title")?.textContent === "修改后的运维记录",
  );
  await page.getByRole("button", { name: /^关联与设置/ }).click();
  assert.equal(
    await page.locator(".document-bindings input[type=checkbox]").first().isChecked(),
    false,
  );
  assert.equal(
    await page.evaluate(
      () => Object.keys(localStorage).filter((key) => key.startsWith("nanpad-doc:")).length,
    ),
    1,
  );
  assert.equal(
    await page.evaluate(
      () => window.__documentQaStore.getState().servers[0].docs === window.__legacyMarkdown,
    ),
    true,
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  // 页面选择本就不持久化，刷新后从导航重新打开文档，验证的是资料保存。
  await page.getByRole("button", { name: "文档资产", exact: true }).click();
  await page.locator(".document-list-item").filter({ hasText: "修改后的运维记录" }).click();
  assert.equal(
    await page.getByRole("heading", { name: "修改后的运维记录", exact: true }).innerText(),
    "修改后的运维记录",
  );
  checks.push("重复迁移不覆盖编辑或解绑，刷新内容仍在");

  // 独立挂载真实文档编辑器，固定图床桥接仅验证UI失败/重试，不请求真实图床。
  const imagePage = await context.newPage();
  imagePage.on("pageerror", (error) => pageErrors.push(error.message));
  await imagePage.route(`${origin}/__ui-regression/documents`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="document-test-root" style="height:100dvh"></main></body></html>',
    }),
  );
  await imagePage.goto(`${origin}/__ui-regression/documents`);
  const raster = await imagePage.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 20;
    canvas.height = 20;
    canvas.getContext("2d").fillRect(0, 0, 20, 20);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await imagePage.route("https://zensimagebed.pages.dev/qa-document-*.png", (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(raster, "base64") }),
  );
  await imagePage.evaluate(async () => {
    let enabled = true;
    window.__imageUploadNames = [];
    window.sinan = {
      images: {
        status: async () => ({
          configured: true,
          enabled,
          origin: "https://zensimagebed.pages.dev",
        }),
        configure: async (input) => {
          enabled = input.enabled;
          return { configured: true, enabled, origin: "https://zensimagebed.pages.dev" };
        },
        upload: async (input) => {
          window.__imageUploadNames.push(input.filename);
          if (window.__failMigration) throw new Error("隔离回归：迁移上传失败");
          if (window.__imageUploadNames.length === 2) throw new Error("隔离回归：第二张上传失败");
          return {
            url: `https://zensimagebed.pages.dev/qa-document-${window.__imageUploadNames.length}.png`,
            key: "qa",
            filename: input.filename,
            size: 100,
          };
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
    const { DocumentsWorkspace } = await import("/src/components/documents-workspace.tsx");
    const entry = performance
      .getEntriesByType("resource")
      .find((item) => item.name.includes("/src/lib/documents.ts"));
    const { useDocuments } = await import(entry.name);
    window.__documentImageStore = useDocuments;
    await useDocuments.getState().create([], {
      title: "图片回归文档",
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    ReactDOM.createRoot(document.getElementById("document-test-root")).render(
      React.createElement(DocumentsWorkspace),
    );
  });
  await imagePage.getByRole("button", { name: /^关联与设置/ }).click();
  await imagePage.getByText("图片保存到图床：", { exact: false }).waitFor();
  await imagePage.keyboard.press("Escape");
  await imagePage.getByRole("button", { name: "编辑文档", exact: true }).click();
  await imagePage.locator('input[type="file"]').setInputFiles(
    ["first.png", "second.png", "third.png"].map((name) => ({
      name,
      mimeType: "image/png",
      buffer: Buffer.from(raster, "base64"),
    })),
  );
  await imagePage.getByRole("button", { name: "重试未完成的图片", exact: true }).waitFor();
  assert.equal(await imagePage.locator(".document-prose img").count(), 1);
  await imagePage.getByRole("button", { name: "重试未完成的图片", exact: true }).click();
  await imagePage.waitForFunction(
    () => document.querySelectorAll(".document-prose img").length === 3,
  );
  assert.deepEqual(await imagePage.evaluate(() => window.__imageUploadNames), [
    "first.png",
    "second.png",
    "second.png",
    "third.png",
  ]);
  await imagePage.waitForFunction(() => {
    const store = window.__documentImageStore.getState();
    return store.status[store.selected] === "saved";
  });
  checks.push("图片部分失败保留成功项，重试不重复插入");
  await imagePage.getByRole("button", { name: /^关联与设置/ }).click();
  await imagePage.getByRole("button", { name: "图床上传已启用", exact: false }).click();
  await imagePage.getByRole("checkbox", { name: "新图片上传至我的图床", exact: true }).uncheck();
  await imagePage.getByRole("button", { name: "保存图床设置", exact: true }).click();
  await imagePage.getByText("图片嵌入本机文档", { exact: true }).waitFor();
  await imagePage.keyboard.press("Escape");
  await imagePage.locator('input[type="file"]').setInputFiles({
    name: "local.png",
    mimeType: "image/png",
    buffer: Buffer.from(raster, "base64"),
  });
  await imagePage.waitForFunction(
    () => document.querySelectorAll(".document-prose img").length === 4,
  );
  assert.equal(await imagePage.evaluate(() => window.__imageUploadNames.length), 4);
  await imagePage.waitForFunction(() => {
    const store = window.__documentImageStore.getState();
    return store.status[store.selected] === "saved";
  });
  assert.match(
    await imagePage.locator(".document-prose img").last().getAttribute("src"),
    /^data:image\/png;/,
  );
  checks.push("修改图床设置立即更新位置，本地插图不调用图床");
  await imagePage.getByRole("button", { name: /^关联与设置/ }).click();
  const information = imagePage.getByRole("dialog", { name: "文档信息", exact: true });
  await information.getByRole("button", { name: "本地嵌入", exact: true }).click();
  await information.getByRole("checkbox", { name: "新图片上传至我的图床", exact: true }).check();
  await information.getByRole("button", { name: "保存图床设置", exact: true }).click();
  await imagePage.evaluate(() => {
    window.__failMigration = true;
  });
  await information.getByRole("button", { name: "将内嵌图片迁移到图床", exact: true }).click();
  await information
    .getByRole("alert")
    .filter({ hasText: "隔离回归：迁移上传失败" })
    .waitFor({ timeout: 5000 });
  await imagePage.evaluate(() => {
    window.__failMigration = false;
  });
  await information.getByRole("button", { name: "继续迁移内嵌图片", exact: true }).click();
  await imagePage.waitForFunction(() =>
    Array.from(document.querySelectorAll(".document-prose img")).every((img) =>
      img.getAttribute("src").startsWith("https://"),
    ),
  );
  checks.push("迁移失败在当前弹窗反馈且可直接重试");
  assert.deepEqual(pageErrors, []);
  checks.push("无未捕获页面异常");
} catch (error) {
  failure = String(error.stack ?? error);
  throw error;
} finally {
  await mkdir("release/screenshots", { recursive: true });
  await writeFile(
    "release/screenshots/documents-v110-report.json",
    JSON.stringify(
      { ok: !failure, checks, pageErrors, failure, imageBridge: "固定样本；未请求真实图床" },
      null,
      2,
    ),
  );
  await browser.close();
}
console.log(JSON.stringify({ ok: true, checks }, null, 2));
