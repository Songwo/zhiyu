import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { expandNavigationGroups } from "./navigation-helper.mjs";
import { chooseOption } from "./select-helper.mjs";

// 本机合成供应商 + 真实 Electron 密钥存储、IPC、文档与渲染；不接触私人资料或真实付费 Key。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-document-ai-"));
let instance;
let requests = 0;
const provider = createServer(async (req, res) => {
  assert.equal(req.url, "/v1/systemone");
  assert.equal(req.headers.authorization, "Bearer synthetic-typesafe-key");
  let text = "";
  for await (const part of req) text += part;
  const input = JSON.parse(text);
  requests++;
  await new Promise((resolve) => setTimeout(resolve, 350));
  const choice = input.state.includes("证书")
    ? "warning"
    : input.state.includes("配置")
      ? "important"
      : "none";
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      model: "jev-latest",
      answers: { category: { type: "choice", choice, confidence: 0.94 } },
      usage: { input_tokens: 40, output_tokens: 3 },
    }),
  );
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
try {
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  delete env.NODE_PATH;
  const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  instance = await electron.launch({
    cwd: process.env.NANPAD_QA_APP_CWD ?? process.cwd(),
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...(executablePath ? [] : [resolve("electron/main.mjs")]),
      `--user-data-dir=${directory}`,
    ],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await instance.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1360, 900);
    win.webContents.setBackgroundThrottling(false);
    win.showInactive();
  });
  await completeOnboarding(page);
  await expandNavigationGroups(page);
  await instance.evaluate(
    async ({ ipcMain, safeStorage, BrowserWindow, app, net }, { file, url }) => {
      const requireModule = process
        .getBuiltinModule("module")
        .createRequire(`${app.getAppPath()}/package.json`);
      const { DocumentAnalysisService } = requireModule(
        `${app.getAppPath()}/${app.isPackaged ? "electron/" : ""}services/document-analysis.mjs`,
      );
      const service = new DocumentAnalysisService({
        file,
        secureStorage: safeStorage,
        baseUrl: url,
        fetchImpl: (...args) => net.fetch(...args),
        emit: (event) =>
          BrowserWindow.getAllWindows()[0].webContents.send("document-analysis:event", event),
      });
      for (const method of ["config", "saveConfig", "models", "run", "cancel"]) {
        ipcMain.removeHandler(`document-analysis:${method}`);
        ipcMain.handle(`document-analysis:${method}`, async (_event, ...args) => {
          try {
            return { ok: true, data: await service[method](...args) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        });
      }
    },
    {
      file: join(directory, "document-analysis.json"),
      url: `http://127.0.0.1:${provider.address().port}`,
    },
  );
  const markdown = "# 合成部署手册\n\n明天之前必须更新服务证书。\n\n这是服务运行所需的关键配置。\n";
  await page.evaluate(
    async (markdown) =>
      window.sinan.documents.save({
        id: "doc-jev-original",
        title: "原文高亮回归",
        markdown,
        content: { type: "doc", content: [] },
        bindings: [],
      }),
    markdown,
  );
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "模型与知识库", exact: true }).click();
  await page.getByRole("checkbox", { name: "启用 Jev 文档分析", exact: true }).check();
  await page.getByLabel("Jev API Key", { exact: true }).fill("synthetic-typesafe-key");
  await chooseOption(page, page.getByRole("combobox", { name: "阅读字号", exact: true }), "18px");
  await page.getByRole("button", { name: "保存 Jev 设置", exact: true }).click();
  await page.getByText("Jev 设置已保存", { exact: true }).waitFor();
  const configText = await readFile(join(directory, "document-analysis.json"), "utf8");
  assert.ok(!configText.includes("synthetic-typesafe-key"));
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "文档资产", exact: true })
    .click();
  await page.locator(".document-list-item").filter({ hasText: "原文高亮回归" }).click();
  await page.getByRole("button", { name: "Jev 文档提示", exact: true }).click();
  const panel = page.getByRole("region", { name: "Jev 分析面板", exact: true });
  await panel
    .getByRole("checkbox", { name: "允许本次将当前文档段落发送给 TypeSafe 分析", exact: true })
    .check();
  const before = await page.evaluate(() => window.sinan.documents.get("doc-jev-original"));
  const countBefore = (await page.evaluate(() => window.sinan.documents.list())).length;
  await panel.getByRole("button", { name: "分析当前文档", exact: true }).click();
  await panel.getByText("分析第 2 / 3 段", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-jev-rule]").length === 2);
  await panel.locator("details:not([open])").waitFor();
  await panel.getByText("查看分析过程", { exact: true }).click();
  await panel.getByText("生成文档提示", { exact: true }).waitFor();
  await panel.getByText("查看分析过程", { exact: true }).click();
  assert.equal(requests, 3);
  assert.deepEqual(
    await page.evaluate(() => window.sinan.documents.get("doc-jev-original")),
    before,
  );
  assert.equal(
    (await page.evaluate(() => window.sinan.documents.list())).length,
    countBefore,
    "分析不能新建提取文档",
  );
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/document-jev-highlight.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: "screenshots/document-jev-mobile-dark.png" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1360, height: 900 });
  const initialRequests = requests;
  await page.evaluate(async () => {
    const config = await window.sinan.documentAnalysis.config();
    await window.sinan.documentAnalysis.saveConfig({ ...config, mode: "underline" });
    window.dispatchEvent(new Event("zhiyu:analysis-settings"));
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-jev-mode="underline"]').length === 2,
  );
  assert.equal(requests, initialRequests, "改变样式不能再次消耗分析请求");
  await panel.getByRole("button", { name: "关闭分析面板", exact: true }).click();
  assert.equal(await page.locator("[data-jev-rule]").count(), 0);
  // 未配置检索服务与身份过期必须分别提示，不能把站点配置问题引导成重新登录。
  for (const [message, needsLogin] of [
    ["联网检索服务尚未升级或配置，未产生积分支付。", false],
    ["联网检索需要先在个人资料中使用 Linux.do 登录。", true],
  ]) {
    await instance.evaluate(({ ipcMain }, error) => {
      for (const method of ["quota", "records"]) {
        ipcMain.removeHandler(`research:${method}`);
        ipcMain.handle(`research:${method}`, () => ({ ok: false, error }));
      }
    }, message);
    await page.getByRole("button", { name: "联网检索", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Exa 联网检索", exact: true });
    await dialog.getByText(message, { exact: true }).waitFor();
    assert.equal(
      await dialog
        .getByRole("button", { name: "前往个人资料检查 Linux.do 登录", exact: true })
        .count(),
      needsLogin ? 1 : 0,
    );
    if (!needsLogin)
      await dialog
        .getByText(
          "这是站点服务配置问题，无需重新登录。维护者需升级登录服务并配置 Exa；配置完成后点击刷新检索额度。",
          { exact: true },
        )
        .waitFor();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }
  // Exa 额度界面采用明示的合成 IPC 响应，仅验证渲染；真实 HTTP 记账在 research-service.test.mjs。
  await instance.evaluate(({ ipcMain }) => {
    const quota = {
      configured: true,
      freeRemaining: 37,
      freeUsed: 13,
      freeLimit: 50,
      paidRemaining: 99,
      paidTotal: 100,
      paidUsed: 1,
      price: "10.00",
      purchaseUnits: 100,
      paymentConfigured: true,
      purchaseGuardConfigured: false,
      exaStatus: "unverified",
      balanceKnown: false,
      pendingJobId: null,
    };
    const entries = [
      {
        id: "purchase:synthetic",
        jobId: "synthetic",
        kind: "purchase",
        query: null,
        state: "paid",
        source: "purchase",
        consumed: 0,
        units: 100,
        amount: "10.00",
        createdAt: Date.now(),
        paidAt: Date.now(),
        tradeNo: "SYNTHETIC-ORDER-ONLY",
      },
    ];
    for (const [method, data] of [
      ["quota", quota],
      ["records", { entries, nextOffset: null }],
    ]) {
      ipcMain.removeHandler(`research:${method}`);
      ipcMain.handle(`research:${method}`, () => ({ ok: true, data }));
    }
  });
  await page.getByRole("button", { name: "联网检索", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Exa 联网检索", exact: true });
  await search.getByText("累计已用 13 次", { exact: true }).waitFor();
  await search.getByText("累计购买 100 次，已用 1 次", { exact: true }).waitFor();
  await search.getByRole("button", { name: "购买与消耗记录", exact: true }).click();
  await search.getByText("订单号：SYNTHETIC-ORDER-ONLY", { exact: true }).waitFor();
  await page.screenshot({ path: "screenshots/research-wallet-records.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: "screenshots/research-wallet-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "TypeSafe official protocol via local HTTP provider",
          "OS-protected API key",
          "per-paragraph live progress",
          "highlights on original document",
          "no extracted document created",
          "source unchanged",
          "style switch needs no extra API call",
          "closing clears visual marks",
          "free and purchased wallet display",
          "purchase audit record",
          "server setup errors do not request a new login",
          "mobile and clean console",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await instance?.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
