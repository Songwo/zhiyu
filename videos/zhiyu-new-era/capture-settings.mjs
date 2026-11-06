import assert from "node:assert/strict";
import { chromium } from "playwright";
import { demoSnapshot } from "../../electron/services/demo.mjs";
import { filmSnapshot, installFilmBridge } from "./demo-fixture.mjs";
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  locale: "zh-CN",
});
const origin = "http://127.0.0.1:8094";
await context.route("**/*", (route) =>
  new URL(route.request().url()).origin === origin
    ? route.continue()
    : route.fulfill({ status: 204, body: "" }),
);
const page = await context.newPage();
const errors = [];
const paths = {};
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const match = /^\/src\/lib\/(store|profile|settings)\.ts$/.exec(new URL(request.url()).pathname);
  if (match) paths[match[1]] = request.url();
});
try {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(
    async ({ paths, snapshot }) => {
      window.__filmModules = paths;
      const { useAppStore } = await import(paths.store);
      useAppStore.setState(snapshot);
      const { useProfile } = await import(paths.profile);
      useProfile.setState({ profile: { name: "星桥演示空间", ready: true, vaultExists: false } });
    },
    { paths, snapshot: filmSnapshot(demoSnapshot()) },
  );
  await installFilmBridge(page);
  await page.evaluate(async () => {
    window.sinan.agent = {
      config: async () => ({
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        hasApiKey: true,
        apiKeyReadable: true,
        topK: 6,
        maxSteps: 8,
        maxTokens: 4096,
        embeddingEnabled: false,
        embeddingBaseUrl: "http://127.0.0.1:11434/v1",
        embeddingModel: "bge-m3",
      }),
      knowledge: async () => ({
        assets: 27,
        chunks: 86,
        documents: [
          {
            id: "starbridge-manual",
            name: "星桥项目 · 部署与维护手册",
            characters: 3240,
            addedAt: "2026-11-06T00:00:00Z",
          },
        ],
      }),
    };
    window.sinan.aiAccounts = { list: async () => [], onChanged: () => () => {} };
    const { useAppStore } = await import(window.__filmModules.store);
    useAppStore.getState().openSettingsPage("agent");
  });
  await page.getByRole("textbox", { name: "API Base URL", exact: true }).waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "videos/zhiyu-new-era/assets/models.png" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshot: "models.png", errors }));
} finally {
  await browser.close();
}
