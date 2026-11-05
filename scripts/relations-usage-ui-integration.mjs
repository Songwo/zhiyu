import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { chooseOption } from "./select-helper.mjs";

// 真实组件与真实状态库，隔离桥只提供合成文档和统计，绝不读取用户资料。
const origin = new URL(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8080").origin;
const browser = await chromium.launch({ headless: true });
const checks = [];
const errors = [];
await mkdir("screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    reducedMotion: "reduce",
    permissions: ["local-network-access"],
  });
  await context.routeWebSocket("**/*", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const type = JSON.parse(String(message)).type;
      if (!["update", "full-reload"].includes(type)) socket.send(message);
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  async function verifyGraphRouting() {
    await page.waitForFunction(() => {
      const bounds = document.querySelector(".asset-graph").getBoundingClientRect();
      return [...document.querySelectorAll(".asset-graph-node")].every((node) => {
        const box = node.getBoundingClientRect();
        return (
          box.left >= bounds.left - 1 &&
          box.right <= bounds.right + 1 &&
          box.top >= bounds.top - 1 &&
          box.bottom <= bounds.bottom + 1
        );
      });
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const collisions = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll(".asset-graph-node")].map((node) => ({
        id: node.dataset.assetId,
        box: node.getBoundingClientRect(),
      }));
      const collisions = [];
      const frame = document.querySelector(".asset-graph").getBoundingClientRect();
      for (const path of document.querySelectorAll(".react-flow__edge-path")) {
        const bounds = path.getBoundingClientRect();
        if (
          bounds.left < frame.left - 1 ||
          bounds.right > frame.right + 1 ||
          bounds.top < frame.top - 1 ||
          bounds.bottom > frame.bottom + 1
        )
          collisions.push("连线超出画布边界");
        const length = path.getTotalLength();
        const matrix = path.getScreenCTM();
        for (let index = 1; index < 100; index++) {
          const point = path.getPointAtLength((length * index) / 100).matrixTransform(matrix);
          const hit = nodes.find(
            ({ box }) =>
              point.x > box.left + 4 &&
              point.x < box.right - 4 &&
              point.y > box.top + 4 &&
              point.y < box.bottom - 4,
          );
          if (hit) {
            collisions.push(hit.id);
            break;
          }
        }
      }
      return collisions;
    });
    assert.deepEqual(collisions, [], "关系连线不能穿过资源卡片内部");
  }
  await page.route(`${origin}/__relations-usage-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="root" style="min-height:100dvh;padding:16px;background:var(--color-canvas)"></main></body></html>',
    }),
  );
  async function mount() {
    await page.goto(`${origin}/__relations-usage-test`);
    await page.evaluate(async () => {
      const time = new Date().toISOString();
      const server = {
        id: "server-qa",
        name: "演练主机",
        label: "工作站",
        host: "qa.example.test",
        port: 22,
        username: "operator",
        os: "Linux",
        region: "本机样本",
        tags: ["演练项目"],
        status: "online",
        cpu: 12,
        memory: 24,
        disk: 18,
        uptime: "3 天",
        lastSeen: time,
        notes: "",
        probedAt: time,
      };
      const secret = (id, name, tags = []) => ({
        id,
        name,
        kind: "account",
        hint: "",
        value: "",
        lastRotated: time,
        status: "online",
        notes: "",
        tags,
      });
      const initial = {
        servers: [server],
        secrets: [
          secret("secret-qa", "演练账号", ["演练项目"]),
          secret("secret-spare", "备用账号"),
        ],
        domains: [
          {
            id: "domain-qa",
            name: "qa.example.test",
            registrar: "本机样本",
            expiresAt: "2030-01-01",
            dns: "",
            nameservers: [],
            autoRenew: true,
            status: "online",
            notes: "",
            tags: [],
          },
        ],
        mailboxes: [],
        aiAssets: [],
        certs: [],
        links: [
          { from: { kind: "server", id: server.id }, to: { kind: "secret", id: "secret-qa" } },
        ],
      };
      const initialDoc = {
        id: "doc-qa",
        title: "演练主机部署说明",
        createdAt: time,
        updatedAt: time,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "部署前检查本机样本。" }] },
          ],
        },
        bindings: [{ kind: "server", id: server.id }],
      };
      if (!localStorage.getItem("qa-document"))
        localStorage.setItem("qa-document", JSON.stringify(initialDoc));
      window.__calls = { list: 0, status: 0, remote: 0, local: 0 };
      window.__usage = {
        sources: [],
        records: [
          {
            sourceId: "local:codex",
            sourceName: "Codex",
            key: "qa-run",
            kind: "tokens",
            label: "本机演练",
            checkedAt: time,
            bucketStart: time,
            input: 1200,
            output: 300,
            cached: 200,
            model: "qa-model",
            origin: "local",
          },
        ],
      };
      window.__localStatus = {
        enabled: true,
        paused: false,
        intervalMs: 10000,
        lastScannedAt: time,
        sources: ["Codex", "Claude Code", "Grok Build", "Gemini CLI"].map((name, index) => ({
          id: ["local:codex", "local:claude", "local:grok", "local:gemini"][index],
          name,
          available: true,
          files: index ? 0 : 1,
          records: index ? 0 : 1,
          status: index ? "no-usage" : "ready",
          lastUsageAt: index ? undefined : time,
        })),
      };
      window.sinan = {
        // 远程用量刷新要求已解锁；此夹具只提供合成数据，不读取真实凭据。
        vault: { status: async () => ({ exists: true, unlocked: true }) },
        store: {
          load: async () => JSON.parse(localStorage.getItem("qa-assets") || "null"),
          save: async (value) => localStorage.setItem("qa-assets", JSON.stringify(value)),
        },
        documents: {
          list: async () => [window.__summary(JSON.parse(localStorage.getItem("qa-document")))],
          get: async () => {
            const value = JSON.parse(localStorage.getItem("qa-document"));
            if (window.__holdDocumentRead) {
              window.__holdDocumentRead = false;
              await new Promise((resolve) => {
                window.__releaseDocumentRead = resolve;
              });
            }
            return value;
          },
          save: async (value) => {
            const saved = { ...value, updatedAt: new Date().toISOString() };
            localStorage.setItem("qa-document", JSON.stringify(saved));
            return saved;
          },
        },
        usage: {
          list: async () => {
            window.__calls.list++;
            if (window.__holdUsage) {
              window.__holdUsage = false;
              await new Promise((resolve) => {
                window.__releaseUsage = resolve;
              });
            }
            if (window.__failUsage) throw new Error("合成读取失败");
            return structuredClone(window.__usage);
          },
          localStatus: async () => {
            window.__calls.status++;
            return structuredClone(window.__localStatus);
          },
          configureLocal: async ({ enabled }) => {
            window.__localStatus.enabled = enabled;
            return structuredClone(window.__localStatus);
          },
          refreshLocal: async () => {
            window.__calls.local++;
            return structuredClone(window.__localStatus);
          },
          refreshAll: async () => {
            window.__calls.remote++;
            return { failures: [] };
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
      const { AssetWorkspace } = await import("/src/components/asset-workspace.tsx");
      const { UsageWorkspace } = await import("/src/components/usage-workspace.tsx");
      const resources = performance.getEntriesByType("resource");
      const module = (path) =>
        import(resources.find((entry) => new URL(entry.name).pathname === path).name);
      const { useAppStore } = await module("/src/lib/store.ts");
      const { useSettings } = await module("/src/lib/settings.ts");
      const { useDocuments, summary } = await module("/src/lib/documents.ts");
      const { usageCache } = await module("/src/lib/usage-cache.ts");
      const { updateResourceRelation } = await import("/src/lib/resource-relation-actions.ts");
      window.__summary = summary;
      await useAppStore.persist.rehydrate();
      if (!useAppStore.getState().servers.length) useAppStore.getState().importSnapshot(initial);
      useAppStore.setState({ hydrated: true, view: "relations" });
      useSettings.getState().setLanguage("zh");
      useSettings.getState().setAssetLayout("graph");
      useSettings.getState().setTheme("light");
      await useDocuments.getState().load();
      window.__store = useAppStore;
      window.__documents = useDocuments;
      window.__updateRelation = updateResourceRelation;
      window.__usageCache = usageCache;
      const root = ReactDOM.createRoot(document.getElementById("root"));
      window.__show = (name) =>
        root.render(React.createElement(name === "usage" ? UsageWorkspace : AssetWorkspace));
      window.__show("relations");
    });
    await page.locator(".asset-graph-node").first().waitFor();
  }
  await mount();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 2);
  assert.equal(await page.locator(".asset-graph-node").count(), 5);
  assert.equal(await page.locator('[data-asset-kind="document"]').count(), 1);
  await page.evaluate(() => window.__store.getState().setView("vault"));
  await page.waitForFunction(() => document.querySelectorAll(".asset-graph-node").length === 4);
  assert.equal(await page.locator('[data-asset-kind="server"]').count(), 1);
  assert.equal(await page.locator('[data-asset-kind="document"]').count(), 1);
  await page.evaluate(() => window.__store.getState().setView("relations"));
  await page.getByRole("button", { name: "管理资源关联", exact: true }).click();
  const panel = page.getByRole("region", { name: "管理资源关联", exact: true });
  await panel.getByRole("button", { name: "新增关联", exact: true }).click();
  await chooseOption(
    page,
    panel.getByRole("combobox", { name: "起始资源" }),
    "演练主机部署说明 · 文档",
  );
  await chooseOption(page, panel.getByRole("combobox", { name: "目标资源" }), "演练账号 · 密钥");
  await panel.getByRole("button", { name: "保存关联", exact: true }).click();
  await panel.getByRole("status").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 3);
  await panel.getByRole("button", { name: /^已确认关联/ }).click();
  await panel.getByRole("button", { name: "解除 演练主机部署说明 与 演练账号 的关联" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 2);
  await panel.getByRole("button", { name: /^发现关联/ }).click();
  const suggestion = panel.locator(".resource-relation-row").filter({ hasText: "主机地址一致" });
  assert.equal(await suggestion.count(), 1);
  assert.equal(await page.locator(".react-flow__edge").count(), 2, "建议不能提前成为真实关系");
  await suggestion.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "确认选中的 1 条关联" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 3);
  await panel.getByRole("button", { name: /^已确认关联/ }).click();
  checks.push("真实关系、文档绑定、跨类型节点、管理新增与解除、建议确认后入图");
  await verifyGraphRouting();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await verifyGraphRouting();
  await page.getByRole("button", { name: "重排节点", exact: true }).click();
  await verifyGraphRouting();
  await page.screenshot({ path: "screenshots/relations-ui-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyGraphRouting();
  await page.screenshot({ path: "screenshots/relations-ui-mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
    false,
  );
  await mount();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 3);
  checks.push("刷新后关系持久化、390px 无横向溢出");

  const concurrent = await page.evaluate(async () => {
    const doc = { kind: "document", id: "doc-qa" };
    const a = { kind: "secret", id: "secret-qa" };
    const b = { kind: "secret", id: "secret-spare" };
    await Promise.all([window.__updateRelation(doc, a), window.__updateRelation(doc, b)]);
    return JSON.parse(localStorage.getItem("qa-document")).bindings;
  });
  assert.deepEqual(concurrent.map((ref) => ref.id).sort(), [
    "secret-qa",
    "secret-spare",
    "server-qa",
  ]);
  await page.evaluate(async () => {
    await window.__documents.getState().open("doc-qa");
    window.__holdDocumentRead = true;
    window.__pendingRelation = window.__updateRelation(
      { kind: "document", id: "doc-qa" },
      { kind: "secret", id: "secret-spare" },
      true,
    );
  });
  await page.waitForFunction(() => Boolean(window.__releaseDocumentRead));
  const edited = await page.evaluate(async () => {
    const previous = window.__documents.getState().drafts["doc-qa"];
    window.__documents.getState().change({
      ...previous,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "用户在异步读取期间继续编辑的内容" }],
          },
        ],
      },
    });
    window.__releaseDocumentRead();
    await window.__pendingRelation;
    return JSON.parse(localStorage.getItem("qa-document"));
  });
  assert.match(JSON.stringify(edited.content), /用户在异步读取期间继续编辑的内容/);
  assert.deepEqual(edited.bindings.map((ref) => ref.id).sort(), ["secret-qa", "server-qa"]);
  checks.push("同文档并发新增两个绑定均保留、关联读取期间编辑正文不丢失");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    const state = window.__store.getState();
    state.upsertServer({ ...state.servers[0], id: "server-second", name: "第二行主机", tags: [] });
    state.upsertDomain({
      ...state.domains[0],
      id: "domain-second",
      name: "second.example.test",
      tags: [],
    });
    const secret = { kind: "secret", id: "secret-qa" };
    const spare = { kind: "secret", id: "secret-spare" };
    const server = { kind: "server", id: "server-second" };
    const domain = { kind: "domain", id: "domain-second" };
    state.linkAssets(secret, spare);
    state.linkAssets(spare, domain);
    state.linkAssets(secret, server);
    state.linkAssets(server, domain);
  });
  await page.waitForFunction(() => document.querySelectorAll(".asset-graph-node").length === 7);
  await verifyGraphRouting();
  await page.screenshot({ path: "screenshots/relations-multirow-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyGraphRouting();
  await page.screenshot({ path: "screenshots/relations-multirow-mobile.png", fullPage: true });
  checks.push("两张同类账号、第二行跨类型、相邻不同排关系在桌面与手机均避让全部卡片");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install();
  await page.evaluate(() => window.__show("usage"));
  await page.locator(".usage-record").waitFor();
  assert.equal(await page.locator(".local-usage-panel").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__calls), {
    list: 1,
    status: 1,
    remote: 0,
    local: 0,
  });
  await page.getByRole("button", { name: "采集与监控", exact: true }).click();
  await page.getByRole("dialog", { name: "采集与监控", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭本机监控", exact: true }).click();
  await page.getByRole("button", { name: "开启本机监控", exact: true }).waitFor();
  assert.equal(await page.locator(".usage-record").count(), 1, "关闭监控必须保留已有明细");
  await page.getByRole("button", { name: "开启本机监控", exact: true }).click();
  await page.getByRole("button", { name: "关闭本机监控", exact: true }).waitFor();
  const desktopCards = await page
    .locator(".local-monitor-dialog .local-usage-source")
    .evaluateAll((cards) =>
      cards.map((card) => {
        const { x, y, width } = card.getBoundingClientRect();
        return { x, y, width };
      }),
    );
  assert.equal(desktopCards.length, 4);
  assert.ok(
    Math.abs(desktopCards[0].y - desktopCards[1].y) < 1 &&
      Math.abs(desktopCards[2].y - desktopCards[3].y) < 1,
    "桌面监控四个来源应分成两行",
  );
  assert.ok(
    Math.abs(desktopCards[0].x - desktopCards[2].x) < 1 &&
      Math.abs(desktopCards[1].x - desktopCards[3].x) < 1 &&
      desktopCards[1].x > desktopCards[0].x,
    "桌面监控来源应两列对齐",
  );
  assert.ok(
    desktopCards.every((card) => Math.abs(card.width - desktopCards[0].width) < 1),
    "桌面监控来源卡等宽",
  );
  await page.screenshot({ path: "screenshots/monitor-ui-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCards = await page
    .locator(".local-monitor-dialog .local-usage-source")
    .evaluateAll((cards) =>
      cards.map((card) => {
        const { x, y, width } = card.getBoundingClientRect();
        return { x, y, width };
      }),
    );
  assert.ok(
    mobileCards.every(
      (card, index) =>
        Math.abs(card.x - mobileCards[0].x) < 1 &&
        Math.abs(card.width - mobileCards[0].width) < 1 &&
        (!index || card.y > mobileCards[index - 1].y),
    ),
    "390px 监控来源应单列等宽排列",
  );
  await page.screenshot({ path: "screenshots/monitor-ui-mobile.png", fullPage: true });
  const dialog = await page.locator(".local-monitor-dialog").boundingBox();
  assert.ok(dialog.x >= -1 && dialog.x + dialog.width <= 391, "监控详情应适合手机宽度");
  await page.keyboard.press("Escape");
  await page.locator(".local-monitor-dialog").waitFor({ state: "detached" });
  const calls = await page.evaluate(() => ({ ...window.__calls }));
  await page.evaluate(() => window.__show("relations"));
  await page.locator(".asset-graph").waitFor();
  await page.evaluate(() => window.__show("usage"));
  await page.locator(".usage-record").waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.__calls),
    calls,
    "新鲜缓存回切不重读、不重新采集",
  );
  checks.push("监控配置收纳、开关保留历史、Escape 关闭、10秒内回切复用缓存不触发采集");
  checks.push("关系图桌面及手机连线避让资源卡、监控桌面2列与手机1列等宽对齐");
  await page.evaluate(() => window.__show("relations"));
  await page.locator(".asset-graph").waitFor();
  await page.clock.fastForward(10001);
  await page.evaluate(() => {
    window.__holdUsage = true;
    window.__show("usage");
  });
  await page.waitForFunction(() => Boolean(window.__releaseUsage));
  assert.equal(await page.locator(".usage-record").count(), 1, "过期缓存应即时展示旧明细");
  assert.equal(await page.evaluate(() => window.__calls.list), calls.list + 1);
  await page.evaluate(() => {
    window.__usage.records[0].input = 1600;
    window.__releaseUsage();
  });
  await page.waitForFunction(() =>
    document.querySelector(".usage-record").textContent.includes("1,900"),
  );
  await page.evaluate(() => {
    window.__failUsage = true;
    window.__usageCache.invalidate();
  });
  await page.clock.fastForward(10001);
  await page.getByRole("alert").filter({ hasText: "合成读取失败" }).waitFor();
  assert.equal(await page.locator(".usage-record").count(), 1, "后台读取失败不能清空已有明细");
  await page.evaluate(() => {
    window.__failUsage = false;
  });
  await page.getByRole("button", { name: "刷新全部", exact: true }).click();
  await page.waitForFunction(() => window.__calls.remote === 1 && window.__calls.local === 1);
  await page.getByRole("alert").waitFor({ state: "detached" });
  checks.push("缓存过期先展示旧数据再补读、失败保留历史、手动刷新真正重新采集");
  await page.screenshot({ path: "screenshots/usage-cache-mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
    false,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "screenshots/usage-cache-desktop.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, errors }, null, 2));
} finally {
  await browser.close();
}
