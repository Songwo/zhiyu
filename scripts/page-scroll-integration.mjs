import assert from "node:assert/strict";
import { expandNavigationGroups } from "./navigation-helper.mjs";
import { chromium } from "playwright";

// 独立浏览器上下文与合成服务器，不读取桌面资料，也不连接远端主机。
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  locale: "zh-CN",
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
const scroller = () => page.locator("main").locator("../..");
const position = () => scroller().evaluate((element) => element.scrollTop);
const bottom = () =>
  scroller().evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
try {
  await page.addInitScript(() => {
    localStorage.setItem(
      "sinan-settings-v1",
      JSON.stringify({ version: 0, state: { language: "zh", assetLayout: "cards" } }),
    );
  });
  await page.goto(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8080");
  await page.locator('[data-app-ready="true"]').waitFor();
  await expandNavigationGroups(page);
  await page.evaluate(async () => {
    const { useAppStore } = await import(
      performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("/src/lib/store.ts")).name
    );
    window.__scrollStore = useAppStore;
    useAppStore.setState({
      servers: Array.from({ length: 18 }, (_, index) => ({
        id: `scroll-server-${index}`,
        name: `合成滚动服务器 ${index + 1}`,
        host: `scroll-${index}.example.test`,
        port: 22,
        username: "",
        label: "",
        os: "Linux",
        region: "",
        status: "offline",
        cpu: 0,
        memory: 0,
        disk: 0,
        uptime: "未采集",
        lastSeen: "",
        tags: [],
        notes: "",
        sshConfigured: false,
      })),
    });
    // 仅替换统计桥，渲染真实用量长页面；持久化仍在隔离浏览器内。
    window.sinan = {
      win: {
        state: async () => ({ platform: "win32", maximized: false }),
        onMaximized: () => () => {},
      },
      usage: {
        list: async () => ({ sources: [], records: [] }),
        localStatus: async () => ({ enabled: false, intervalMs: 10000, sources: [] }),
        onChanged: () => () => {},
      },
    };
  });
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  await navigation.getByRole("button", { name: "用量记录", exact: true }).click();
  await page.getByRole("button", { name: "连接用量来源", exact: true }).waitFor();
  const usageBottom = await bottom();
  assert.ok(usageBottom > 100, "用量页确实滚动到底部，才能验证跨页面污染");
  await navigation.getByRole("button", { name: "服务器", exact: true }).click();
  await page.getByText("合成滚动服务器 1", { exact: true }).waitFor();
  assert.equal(await position(), 0, "用量页底部切换到服务器必须从顶部开始");

  const serverBottom = await bottom();
  assert.ok(serverBottom > 100, "服务器列表有真实可滚动内容");
  await page.evaluate(() => {
    window.__scrollStore.getState().patchServerMetrics("scroll-server-0", { cpu: 42, memory: 33 });
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await position(), serverBottom, "当前页面指标刷新保持阅读位置");

  await navigation.getByRole("button", { name: "用量记录", exact: true }).click();
  await page.getByRole("button", { name: "连接用量来源", exact: true }).waitFor();
  assert.equal(await position(), 0, "已加载过的用量页再次进入仍从顶部开始");
  await bottom();
  await navigation.getByRole("button", { name: "服务器", exact: true }).click();
  await page.getByText("合成滚动服务器 1", { exact: true }).waitFor();
  assert.equal(await position(), 0, "缓存视图之间重复导航不会继承滚动位置");
  const unchangedPosition = await bottom();
  await page.evaluate(() => window.__scrollStore.getState().setView("servers"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await position(), unchangedPosition, "仍在当前视图时不强制重置阅读位置");
  await page.evaluate(() => window.__scrollStore.getState().setView("usage"));
  await page.getByRole("button", { name: "连接用量来源", exact: true }).waitFor();
  assert.equal(await position(), 0, "命令面板等程序化导航使用同一归零规则");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      usageBottom,
      serverBottom,
      resetOnNavigation: true,
      retainedOnRefresh: true,
      pageErrors: errors,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      pageErrors: errors,
      body: (await page.locator("body").innerText()).slice(-3000),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
