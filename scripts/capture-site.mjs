import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { demoSnapshot } from "../electron/services/demo.mjs";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

// 独立浏览器上下文只加载示例资料，不连接桌面桥接、私人账号或本机日志。
const origin = new URL(checkedUrl(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8080/")).origin;
const browser = await chromium.launch();
const passwordsOnly = process.argv.includes("--passwords-only");
const outputDirectory = process.env.NANPAD_SITE_CAPTURE_DIR ?? "site";
const output = (name) =>
  checkedOutputPath(join(outputDirectory, `${name}.png`), [
    resolve("site"),
    resolve("screenshots"),
    resolve("release"),
  ]);
output("passwords");
await mkdir(outputDirectory, { recursive: true });
const errors = [];
const modules = {};
const captured = [];
const snapshot = demoSnapshot();
const containerPort = { hostIp: "0.0.0.0", hostPort: 8080, containerPort: 80, proto: "tcp" };
snapshot.servers[0].serviceScan = {
  collectedAt: new Date().toISOString(),
  ports: [
    { proto: "tcp", address: "0.0.0.0", scope: "public", port: 8080, process: "docker-proxy" },
  ],
  docker: {
    available: true,
    containers: [
      {
        id: "demo-container-web",
        name: "starbridge-web",
        image: "nginx:stable",
        state: "running",
        status: "Up",
        health: "healthy",
        restartCount: 0,
        ports: [containerPort],
      },
    ],
  },
};
snapshot.services = [
  {
    id: "demo-gallery-web",
    name: "星桥商城前台",
    category: "custom",
    status: "online",
    provider: "本地演示",
    url: "https://starbridge.example",
    notes: "公开展示用的示例服务",
    tags: ["演示"],
    endpoint: { serverId: snapshot.servers[0].id, port: 8080, container: "starbridge-web" },
  },
  ...[
    ["projects", "星桥项目 · 支付卡", "Visa", "4242", "2028-02"],
    ["subscriptions", "订阅服务 · 月度支出", "Mastercard", "0183", "2028-06"],
    ["travel", "差旅预算 · 备用卡", "银联", "6208", "2028-10"],
  ].map(([id, name, network, last4, expiryMonth]) => ({
    id: `demo-gallery-card-${id}`,
    name,
    category: "custom",
    status: "online",
    provider: "演示发卡方",
    url: "",
    notes: "仅展示卡片资料与到期日",
    tags: ["演示"],
    card: { kind: "payment", network, last4, expiryMonth },
  })),
];
let page;
try {
  const context = await browser.newContext({
    viewport: { width: 1480, height: 940 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.fulfill({ status: 204, body: "" }),
  );
  await context.addInitScript((snapshot) => {
    localStorage.setItem("sinan-assets-v1", JSON.stringify({ state: snapshot, version: 0 }));
    localStorage.setItem(
      "sinan-settings-v1",
      JSON.stringify({ state: { theme: "light", locale: "zh", assetLayout: "cards" }, version: 0 }),
    );
  }, snapshot);
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const capture = async (name) => {
    await page.screenshot({ path: output(name), animations: "disabled" });
    captured.push(name);
  };
  // 跟随 Vite 的实际模块地址，避免 HMR 时间戳产生第二份状态实例。
  page.on("request", (request) => {
    const url = new URL(request.url());
    const name = /\/src\/lib\/(profile|store|documents|settings)\.ts$/.exec(url.pathname)?.[1];
    if (name && url.origin === origin) modules[name] = request.url();
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.ok(modules.profile && modules.store, "未找到开发版的工作区状态模块");
  await page.evaluate(async (paths) => {
    window.__siteModules = paths;
    const { useProfile } = await import(paths.profile);
    useProfile.setState({ profile: { name: "知屿演示空间", ready: true, vaultExists: false } });
  }, modules);
  await page.getByText("知屿演示空间", { exact: true }).waitFor();
  if (!passwordsOnly) {
    await capture("overview");
    const setTheme = (theme) =>
      page.evaluate(async (next) => {
        const { useSettings } = await import(window.__siteModules.settings);
        useSettings.getState().setTheme(next);
      }, theme);
    await setTheme("dark");
    await page.locator('html[data-theme="dark"]').waitFor({ state: "attached" });
    await capture("overview-dark");
    await setTheme("light");
    await page.locator('html[data-theme="light"]').waitFor({ state: "attached" });
    await page.getByRole("button", { name: "新建资产", exact: true }).first().click();
    const picker = page.getByRole("dialog", { name: "选择资产类型", exact: true });
    await picker.getByRole("heading", { name: "从常用订阅开始" }).scrollIntoViewIfNeeded();
    await capture("onboarding");
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "hidden" });
    await page.evaluate(async () => {
      const { useDocuments } = await import(window.__siteModules.documents);
      const { useAppStore } = await import(window.__siteModules.store);
      const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
      const heading = (text) => ({
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text }],
      });
      for (const title of ["账号与订阅整理", "域名续费记录", "项目资料索引"]) {
        await useDocuments.getState().create([], {
          title,
          content: { type: "doc", content: [paragraph("示例资料，用于展示文档整理与阅读界面。")] },
        });
      }
      await useDocuments.getState().create([{ kind: "server", id: "demo-server-0" }], {
        title: "星桥项目 · 部署与维护手册",
        content: {
          type: "doc",
          content: [
            paragraph(
              "一份连起主机、域名与日常维护的项目笔记。本文使用演示资产，不包含真实连接信息。",
            ),
            heading("工作空间概览"),
            paragraph(
              "香港节点承载应用服务，新加坡节点负责数据库与缓存。相关资产与说明保存在同一工作空间，需要时可直接回到资产记录。",
            ),
            heading("每周维护清单"),
            {
              type: "bulletList",
              content: [
                "核对域名与证书的到期提醒。",
                "检查备份是否完成，并记录恢复演练结果。",
                "查看资源与用量趋势，更新本周的维护记录。",
              ].map((text) => ({ type: "listItem", content: [paragraph(text)] })),
            },
            heading("账号与使用说明"),
            paragraph(
              "密码保存在独立的加密凭据中，文档记录用途与操作步骤。将账号关联到说明，下次使用时就能一起找到。",
            ),
            { type: "blockquote", content: [paragraph("让记录留在资产旁，让下一次查找更轻松。")] },
          ],
        },
      });
      useAppStore.getState().setView("docs");
    });
    await page.getByRole("button", { name: "编辑文档", exact: true }).waitFor();
    await capture("documents");
    await page.evaluate(async () => {
      const { useAppStore } = await import(window.__siteModules.store);
      const { useSettings } = await import(window.__siteModules.settings);
      useAppStore.getState().setView("servers");
      useSettings.getState().setAssetLayout("table");
    });
    await page.locator('tr[data-asset-id="demo-server-0"]').waitFor();
    await capture("table");
    await page.evaluate(async () => {
      const { useAppStore } = await import(window.__siteModules.store);
      const { useSettings } = await import(window.__siteModules.settings);
      useSettings.getState().setAssetLayout("cards");
      useAppStore.getState().setExpanded({ kind: "server", id: "demo-server-0" });
    });
    const details = page.getByRole("region", { name: "资产详情", exact: true });
    await details.getByRole("region", { name: "关联资产", exact: true }).waitFor();
    await capture("detail");
    await details.getByRole("button", { name: /端口与容器/ }).click();
    await details.getByText("starbridge-web", { exact: true }).first().waitFor();
    await capture("services");

    const openView = (view) =>
      page.evaluate(async (next) => {
        const { useAppStore } = await import(window.__siteModules.store);
        useAppStore.getState().setView(next);
      }, view);
    await openView("renewals");
    const calendar = page.getByRole("region", { name: "续费日历", exact: true });
    await calendar.waitFor();
    const renewalDays = calendar.getByRole("button", { name: /项续费/ });
    if ((await renewalDays.count()) === 0)
      await calendar.getByRole("button", { name: "下个月", exact: true }).click();
    await renewalDays.first().click();
    await capture("renewals");
    await openView("relations");
    const graph = page.getByRole("region", { name: "资产关系图", exact: true });
    await graph.locator(".asset-graph-node").first().waitFor();
    await graph.getByRole("button", { name: "适应画布", exact: true }).click();
    await capture("relations");
    await openView("cards");
    await page.locator('[data-asset-id="demo-gallery-card-projects"]').waitFor();
    await capture("cards");
    await page.evaluate(async () => {
      const records = Array.from({ length: 7 }, (_, index) => {
        const date = new Date();
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() - 6 + index);
        return ["文档整理 · 示例", "编程助手 · 示例"].map((name, sourceIndex) => ({
          kind: "tokens",
          sourceId: `demo-api-${sourceIndex}`,
          sourceName: name,
          key: `demo-${index}-${sourceIndex}`,
          label: "示例 API 用量",
          model: "示例模型",
          bucketStart: date.toISOString(),
          checkedAt: date.toISOString(),
          input: [12000, 18000, 9000, 27000, 21000, 33000, 24000][index] * (sourceIndex + 1),
          output: [2300, 3100, 1800, 4800, 3400, 5200, 4100][index],
          cached: 1200 * (index + 1),
        }));
      }).flat();
      window.sinan = {
        win: {
          state: async () => ({ platform: "win32", maximized: false }),
          onMaximized: () => () => {},
        },
        usage: { list: async () => ({ sources: [], records }), localStatus: async () => null },
      };
      const { useAppStore } = await import(window.__siteModules.store);
      useAppStore.getState().setView("usage");
    });
    await page.getByRole("region", { name: "用量图表", exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll(".recharts-bar-rectangle path").length > 0,
    );
    await page.getByRole("region", { name: "用量图表", exact: true }).scrollIntoViewIfNeeded();
    await capture("usage");
  }
  await page.evaluate(async () => {
    // 仅模拟系统文件选择后的无密码预览，实际界面仍由应用组件渲染。
    // 不在网页中创建、读取或写入真实凭据，也不调用本机桌面服务。
    window.sinan = {
      ...window.sinan,
      win: {
        state: async () => ({ platform: "win32", maximized: false }),
        onMaximized: () => () => {},
      },
      vault: { status: async () => ({ exists: true, unlocked: true }) },
      onVaultChanged: () => () => {},
      passwords: {
        previewImport: async () => ({
          ticket: "synthetic-site-preview",
          total: 6,
          added: 3,
          duplicates: 2,
          conflicts: 1,
          invalid: 0,
          rows: [
            {
              title: "星桥 · 个人账号",
              url: "https://starbridge.example",
              username: "personal@example.test",
              status: "new",
            },
            {
              title: "星桥 · 工作账号",
              url: "https://starbridge.example",
              username: "work@example.test",
              status: "new",
            },
            {
              title: "云端笔记",
              url: "https://notes.example.test",
              username: "reader@example.test",
              status: "new",
            },
            {
              title: "项目协作",
              url: "https://team.example.test",
              username: "owner@example.test",
              status: "duplicate",
            },
            {
              title: "设计资料",
              url: "https://design.example.test",
              username: "designer@example.test",
              status: "duplicate",
            },
            {
              title: "研发平台",
              url: "https://dev.example.test",
              username: "developer@example.test",
              status: "conflict",
            },
          ],
        }),
        cancelImport: async () => {},
      },
    };
    const { useAppStore } = await import(window.__siteModules.store);
    useAppStore.getState().setView("vault");
  });
  const browserPasswords = page.getByRole("button", { name: "浏览器密码", exact: true });
  await browserPasswords.waitFor();
  if (!passwordsOnly) await capture("vault");
  await browserPasswords.click();
  const transfer = page.getByRole("dialog", { name: "浏览器密码", exact: true });
  await transfer.getByRole("button", { name: "选择 CSV 文件", exact: true }).click();
  await transfer.getByRole("button", { name: "导入 3 个账号", exact: true }).waitFor();
  assert.equal(await transfer.getByRole("row").count(), 7);
  assert.equal(await transfer.locator('input[type="password"]').count(), 0);
  await capture("passwords");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      screenshots: captured,
      synthetic: true,
      privateData: false,
      pageErrors: errors,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      pageErrors: errors,
      captured,
      visibleText: await page
        ?.locator("body")
        .innerText({ timeout: 2_000 })
        .catch(() => null),
    }),
  );
  await page
    ?.screenshot({ path: "screenshots/site-capture-failure.png", timeout: 2_000 })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
