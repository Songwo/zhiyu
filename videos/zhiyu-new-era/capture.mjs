import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { demoSnapshot } from "../../electron/services/demo.mjs";
import { filmSnapshot, installFilmBridge } from "./demo-fixture.mjs";

// 仅在隔离浏览器中装入合成资料，不连接用户桌面桥接或外部服务。
const output = resolve("videos/zhiyu-new-era/assets");
await mkdir(`${output}/raw`, { recursive: true });
const origin = "http://127.0.0.1:8094";
const browser = await chromium.launch();
const errors = [];
const modules = {};
const shots = [];
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  recordVideo: { dir: `${output}/raw`, size: { width: 1600, height: 1000 } },
});
await context.route("**/*", (route) =>
  new URL(route.request().url()).origin === origin
    ? route.continue()
    : route.fulfill({ status: 204, body: "" }),
);
await context.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem(
    "sinan-settings-v1",
    JSON.stringify({
      state: {
        theme: "light",
        language: "zh",
        motionMode: "full",
        assetLayout: "cards",
        quickStartHidden: true,
      },
      version: 0,
    }),
  );
});
const epoch = Date.now();
const page = await context.newPage();
const recording = page.video();
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  const match = /^\/src\/lib\/(profile|store|documents|settings)\.ts$/.exec(url.pathname);
  if (match) modules[match[1]] = request.url();
});
try {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator('[data-app-ready="true"]').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !!document.querySelector("nav"));
  await page.evaluate(
    async ({ paths, snapshot }) => {
      window.__filmModules = paths;
      const { useAppStore } = await import(paths.store);
      const { useProfile } = await import(paths.profile);
      const { useSettings } = await import(paths.settings);
      useAppStore.setState({ ...snapshot, view: "overview" });
      useProfile.setState({ profile: { name: "星桥演示空间", ready: true, vaultExists: false } });
      useSettings.setState({
        theme: "light",
        resolved: "light",
        motionMode: "full",
        quickStartHidden: true,
      });
      const { useDocuments } = await import(paths.documents);
      const p = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
      const h = (text) => ({
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text }],
      });
      await useDocuments.getState().create(
        [
          { kind: "server", id: "demo-server-0" },
          { kind: "domain", id: "demo-domain-1" },
        ],
        {
          title: "星桥项目 · 部署与维护手册",
          content: {
            type: "doc",
            content: [
              p("将主机、域名与维护记录连接起来。本文与所有资产均为演示资料。"),
              h("项目架构"),
              p(
                "香港 API 节点承载应用，新加坡主库保存业务资料。服务通过 api.starbridge.example 对外提供访问。",
              ),
              h("每周维护清单"),
              {
                type: "bulletList",
                content: [
                  "核对域名与证书到期日。",
                  "检查容器健康状态与主机负载。",
                  "验证加密备份，记录恢复演练结果。",
                ].map((text) => ({ type: "listItem", content: [p(text)] })),
              },
              h("账号与订阅"),
              p(
                "运维邮箱保存服务通知。模型订阅、号码、支付卡各自记录用途与费用。敏感信息保存在加密密钥库。",
              ),
            ],
          },
        },
      );
    },
    { paths: modules, snapshot: filmSnapshot(demoSnapshot()) },
  );
  await page.getByText("星桥演示空间", { exact: true }).waitFor();
  const view = async (id) => {
    await page.evaluate(async (next) => {
      const { useAppStore } = await import(window.__filmModules.store);
      useAppStore.getState().setExpanded(null);
      useAppStore.getState().closeSettingsPage();
      useAppStore.getState().setSettingsOpen(false);
      useAppStore.getState().setView(next);
    }, id);
    await page.waitForTimeout(1200);
  };
  const shot = async (name, action, duration = 4000) => {
    const start = (Date.now() - epoch) / 1000;
    if (action) await action();
    await page.waitForTimeout(duration);
    await page.screenshot({ path: `${output}/${name}.png` });
    shots.push({ name, start, duration: (Date.now() - epoch) / 1000 - start });
    console.log(`Captured ${name}`);
  };
  await shot("overview", null, 1500);
  await view("docs");
  await shot("documents", null, 1600);
  await shot(
    "documents-edit",
    async () => {
      const edit = page.getByRole("button", { name: "编辑文档", exact: true });
      if (await edit.count()) await edit.click();
    },
    2200,
  );
  await view("servers");
  await shot("servers", null, 1600);
  await shot(
    "server-detail",
    async () => {
      const card = page.locator('[data-asset-id="demo-server-0"]').first();
      if (await card.count()) await card.click();
    },
    2200,
  );
  await shot(
    "server-containers",
    async () => {
      await page.getByRole("button", { name: "端口与容器", exact: true }).click();
    },
    2600,
  );
  await page.keyboard.press("Escape");
  await view("domains");
  await shot("domains", null, 1600);
  await view("services");
  await shot("services", null, 1600);
  await view("relations");
  await shot("relations", null, 2400);
  await view("cards");
  await shot("cards", null, 1600);
  await shot(
    "card-front",
    async () => {
      await page
        .getByRole("button", { name: "查看卡片 星桥项目支出卡", exact: true })
        .first()
        .click();
    },
    1600,
  );
  await shot(
    "card-flip",
    async () => {
      await page.getByRole("button", { name: "翻到背面", exact: true }).click();
    },
    1200,
  );
  await shot("card-back", null, 1200);
  await shot(
    "card-return",
    async () => {
      await page.getByRole("button", { name: "翻回正面", exact: true }).click();
    },
    1200,
  );
  await view("esims");
  await shot("esims", null, 1600);
  await view("phones");
  await shot("phones", null, 1600);
  await view("ai");
  await shot("ai", null, 1800);
  await view("mail");
  await shot("mail", null, 1600);
  await view("renewals");
  await shot("renewals", null, 1600);
  await view("usage");
  await shot("usage", null, 1600);
  await view("agent");
  await shot("agent", null, 1800);
  await installFilmBridge(page);
  await view("docs");
  await shot(
    "jev-open",
    async () => {
      await page.getByRole("button", { name: "Jev 文档提示", exact: true }).click();
      await page
        .getByRole("checkbox", { name: "允许本次将当前文档段落发送给 TypeSafe 分析", exact: true })
        .check();
    },
    1000,
  );
  await shot(
    "jev-process",
    async () => {
      await page.getByRole("button", { name: "分析当前文档", exact: true }).click();
    },
    2500,
  );
  await page.waitForFunction(() => document.querySelectorAll("[data-jev-rule]").length >= 2);
  await shot("jev-highlight", null, 1500);
  await shot(
    "jev-underline",
    async () => {
      await page.evaluate(() => {
        window.__filmAnalysis.mode = "underline";
        window.dispatchEvent(new Event("zhiyu:analysis-settings"));
      });
    },
    1000,
  );
  await page.getByRole("button", { name: "关闭分析面板", exact: true }).click();
  await page.getByRole("button", { name: "联网检索", exact: true }).click();
  const exa = page.getByRole("dialog", { name: "Exa 联网检索", exact: true });
  await exa
    .getByRole("textbox", { name: "联网检索问题", exact: true })
    .fill("如何排查 Docker 容器反复重启，并核对 HTTPS 证书续期？");
  await shot("exa-query", null, 1000);
  await shot(
    "exa-progress",
    async () => {
      await exa.getByRole("button", { name: "开始检索", exact: true }).click();
    },
    2200,
  );
  await exa.getByText("Docker restart policies", { exact: true }).waitFor();
  await shot("exa-results", null, 1800);
  await exa.locator(".research-results").scrollIntoViewIfNeeded();
  await shot("exa-results-detail", null, 1200);
  await exa.screenshot({ path: `${output}/exa-results-dialog.png` });
  await exa.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(async () => {
    const { useAppStore } = await import(window.__filmModules.store);
    useAppStore.getState().openSettingsPage("ai");
  });
  await shot("models", null, 1000);
  assert.deepEqual(errors, []);
  await context.close();
  await recording.saveAs(`${output}/workflow.webm`);
  await writeFile(
    `${output}/capture.json`,
    JSON.stringify(
      { synthetic: true, privateData: false, viewport: [1600, 1000], shots, errors },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
