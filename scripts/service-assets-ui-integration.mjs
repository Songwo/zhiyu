import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { chooseOption } from "./select-helper.mjs";

// 新浏览器上下文；仅使用合成服务与账号，不访问真实凭据或探测服务器。
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "zh-CN",
  viewport: { width: 1440, height: 960 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
try {
  await page.addInitScript(() =>
    localStorage.setItem(
      "sinan-settings-v1",
      JSON.stringify({
        state: { language: "zh", theme: "light", sidebarCollapsed: true },
        version: 0,
      }),
    ),
  );
  await page.goto("http://127.0.0.1:8080");
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(async () => {
    const { useAppStore, snapshotOf } = await import(
      performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("/src/lib/store.ts")).name
    );
    window.__serviceStore = useAppStore;
    window.__serviceSnapshot = snapshotOf;
    useAppStore.getState().importSnapshot({
      servers: [],
      domains: [],
      mailboxes: [],
      aiAssets: [],
      secrets: [
        {
          id: "service-account",
          name: "合成服务账号",
          kind: "account",
          tags: [],
          value: "",
          hint: "",
          status: "online",
          notes: "",
          lastRotated: "2026-10-08",
        },
      ],
      certs: [],
    });
    useAppStore.getState().setView("services");
  });
  await page.getByRole("button", { name: "添加服务", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "服务资产", exact: true });
  await editor.getByLabel("服务名称", { exact: true }).fill("合成边缘服务");
  await chooseOption(
    page,
    editor.getByRole("combobox", { name: "资产类型" }),
    "Cloudflare Workers",
  );
  await editor.getByLabel("服务网址", { exact: true }).fill("https://fixture.workers.dev/");
  await editor.getByLabel("提供方", { exact: true }).fill("Cloudflare");
  await editor.getByLabel("标签（逗号分隔）", { exact: true }).fill("合成项目");
  await editor.getByLabel("说明", { exact: true }).fill("部署入口和运行说明，仅供合成测试。");
  assert.equal(await editor.getByLabel("密码", { exact: true }).count(), 0);
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "查看服务 合成边缘服务", exact: true }).click();
  let details = page.getByRole("region", { name: "资产详情", exact: true });
  await chooseOption(page, details.getByRole("combobox", { name: "选择关联资产" }), "合成服务账号");
  await details.getByRole("button", { name: "添加关联", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.__serviceStore.getState().links[0].from.kind),
    "service",
  );
  await details.getByRole("button", { name: "新建文档", exact: true }).click();
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await page.getByRole("textbox", { name: "文档标题", exact: true }).fill("服务操作手册");
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  await page.evaluate(async () => {
    const { useDocuments } = await import(
      performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("/src/lib/documents.ts")).name
    );
    await useDocuments.getState().flush(useDocuments.getState().selected);
    window.__serviceStore.getState().setView("services");
  });
  await page.getByRole("button", { name: "查看服务 合成边缘服务", exact: true }).click();
  details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByText("服务操作手册", { exact: true }).waitFor();
  await details.getByRole("button", { name: "编辑", exact: true }).click();
  editor = page.getByRole("dialog", { name: "服务资产", exact: true });
  await editor.getByLabel("服务名称", { exact: true }).fill("合成博客服务");
  await chooseOption(page, editor.getByRole("combobox", { name: "资产类型" }), "个人博客");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "查看服务 合成博客服务", exact: true }).waitFor();
  const exported = await page.evaluate(() =>
    window.__serviceSnapshot(window.__serviceStore.getState()),
  );
  assert.equal(exported.services[0].name, "合成博客服务");
  assert.equal(exported.services[0].category, "blog");
  assert.equal(exported.links.length, 1);
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(async () => {
    const { useAppStore } = await import(
      performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("/src/lib/store.ts")).name
    );
    window.__serviceStore = useAppStore;
    useAppStore.getState().setView("services");
  });
  await page.getByRole("button", { name: "查看服务 合成博客服务", exact: true }).waitFor();
  await page.getByRole("button", { name: "关系图", exact: true }).click();
  await page.locator('.asset-graph-node[data-asset-kind="service"]').waitFor();
  assert.ok(await page.locator('.asset-graph-node[data-asset-kind="document"]').count());
  assert.ok(await page.locator('.asset-graph-node[data-asset-kind="secret"]').count());
  await page.getByRole("button", { name: "卡片视图", exact: true }).click();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/service-assets-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/service-assets-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "查看服务 合成博客服务", exact: true }).click();
  details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByRole("button", { name: "删除", exact: true }).click();
  await details.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__serviceStore.getState().services.length), 0);
  assert.equal(await page.evaluate(() => window.__serviceStore.getState().links.length), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        createEditReloadDelete: true,
        accountAndDocumentLinks: true,
        relationGraph: true,
        export: true,
        mobileOverflow: false,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
