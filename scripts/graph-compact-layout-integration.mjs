import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { universalRelationFixture } from "./universal-relations-fixture.mjs";
import { chooseOption } from "./select-helper.mjs";
import { navigateDesktop } from "./navigation-helper.mjs";

// 在独立浏览器资料中验收原版图谱组件，只使用合成资产。
const url = new URL(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:53633/");
assert.equal(url.hostname, "127.0.0.1");
const { snapshot, documents } = universalRelationFixture();
documents[0].bindings = [{ kind: "server", id: "server-a" }];
snapshot.links.push(
  { from: { kind: "mail", id: "mail-a" }, to: { kind: "server", id: "server-a" } },
  { from: { kind: "mail", id: "mail-a" }, to: { kind: "secret", id: "secret-a" } },
  { from: { kind: "mail", id: "mail-a" }, to: { kind: "ai", id: "ai-a" } },
  { from: { kind: "server", id: "server-a" }, to: { kind: "domain", id: "domain-a" } },
);
for (const server of snapshot.servers)
  Object.assign(server, {
    demo: true,
    collect: false,
    sshConfigured: false,
    cpu: 0,
    memory: 0,
    disk: 0,
    port: 22,
    username: "tester",
    os: "Linux",
    region: "",
    uptime: "",
    lastSeen: "",
  });
for (const mail of snapshot.mailboxes)
  Object.assign(mail, {
    address: `${mail.id}@example.test`,
    kind: "mailbox",
    domain: "example.test",
    usedMb: 0,
    quotaMb: 0,
  });
// 通用关系夹具面向纯逻辑；渲染真实页面时补齐各资产类型的必填展示字段。
for (const domain of snapshot.domains)
  Object.assign(domain, { registrar: "Test", nameservers: [], dns: "", expiresAt: "2029-01-01" });
for (const cert of snapshot.certs)
  Object.assign(cert, {
    cn: `${cert.id}.example.test`,
    sans: [],
    issuer: "Test",
    expiresAt: "2029-01-01",
    daysLeft: 800,
  });
for (const ai of snapshot.aiAssets)
  Object.assign(ai, { plan: "Test", monthlyUsd: 0, usagePct: 0, renewsAt: "", keyHint: "" });
for (const secret of snapshot.secrets)
  Object.assign(secret, { kind: "account", value: "", hint: "", lastRotated: "" });
const browser = await chromium.launch();
const results = [],
  errors = [];
await mkdir("screenshots", { recursive: true });
try {
  for (const theme of ["light", "dark"])
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [1024, 800],
      [390, 844],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        reducedMotion: "reduce",
        locale: "zh-CN",
      });
      await context.addInitScript(
        ({ snapshot, documents, theme }) => {
          if (localStorage.getItem("graph-compact-seeded")) return;
          localStorage.setItem("graph-compact-seeded", "1");
          localStorage.setItem(
            "sinan-assets-v1",
            JSON.stringify({ version: 0, state: { ...snapshot, view: "relations" } }),
          );
          localStorage.setItem(
            "sinan-settings-v1",
            JSON.stringify({
              version: 0,
              state: {
                theme,
                language: "zh",
                motionMode: "off",
                sidebarCollapsed: true,
                assetLayout: "graph",
              },
            }),
          );
          for (const doc of documents)
            localStorage.setItem(
              "nanpad-doc:" + doc.id,
              JSON.stringify({
                ...doc,
                content: {
                  type: "doc",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "合成布局资料" }] },
                  ],
                },
              }),
            );
        },
        { snapshot, documents, theme },
      );
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (event) => {
        if (event.type() === "error") errors.push(event.text());
      });
      await page.goto(url.href);
      await page.locator("[data-app-ready=true]").waitFor();
      await navigateDesktop(page, "资产关系图");
      try {
        await page
          .locator(".resource-graph-compact .asset-graph-node")
          .first()
          .waitFor({ timeout: 10000 });
      } catch (error) {
        await page.screenshot({ path: "screenshots/graph-compact-failure.png" });
        console.error(
          JSON.stringify({ theme, width, body: await page.locator("body").innerText(), errors }),
        );
        throw error;
      }
      const measure = async () =>
        page.evaluate(() => {
          const graph = document
            .querySelector(".resource-graph-compact .asset-graph")
            .getBoundingClientRect();
          const nav = document.querySelector('nav[aria-label="快捷导航"]');
          const navBox = nav?.getBoundingClientRect();
          const availableBottom = navBox?.height ? navBox.top : innerHeight;
          return {
            top: graph.top,
            height: graph.height,
            bottom: graph.bottom,
            availableBottom,
            viewport: innerHeight,
            overflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          };
        });
      const geometry = await measure();
      assert.equal(geometry.overflow, false, `${theme}/${width} 横向溢出`);
      assert(
        geometry.top <= (width < 640 ? 230 : 185),
        `${theme}/${width} 顶部过高：${JSON.stringify(geometry)}`,
      );
      assert(
        geometry.height >= height * 0.65,
        `${theme}/${width} 画布未占满剩余高度：${JSON.stringify(geometry)}`,
      );
      assert(
        geometry.bottom <= geometry.availableBottom + 1,
        `${theme}/${width} 图谱底部操作被挤出窗口：${JSON.stringify(geometry)}`,
      );
      await page.getByRole("button", { name: "图谱说明", exact: true }).click();
      await page.getByRole("heading", { name: "图谱说明", exact: true }).waitFor();
      assert(Math.abs((await measure()).top - geometry.top) < 1, "打开帮助不应挤压画布");
      await page.keyboard.press("Escape");
      await chooseOption(
        page,
        page.getByRole("combobox", { name: "聚焦关联资源", exact: true }),
        "mail-a@example.test",
      );
      await page.getByRole("button", { name: "链路详情", exact: true }).waitFor();
      assert.equal(await page.locator(".resource-chain-details").count(), 0, "聚焦后详情默认收起");
      await page.getByRole("button", { name: "链路详情", exact: true }).click();
      await page.locator(".resource-chain-details").waitFor();
      await page.getByRole("button", { name: "链路详情", exact: true }).click();
      await page.getByRole("button", { name: "查看全部资源", exact: true }).click();
      await page.getByRole("button", { name: "纵向布局", exact: true }).click();
      await page.locator(".react-flow__handle-bottom").first().waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "纵向布局", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await page.getByRole("button", { name: "横向布局", exact: true }).click();
      await page.locator(".react-flow__handle-right").first().waitFor();
      if (theme === "light" && width === 1440) {
        const linksBefore = await page.evaluate(() =>
          JSON.stringify(JSON.parse(localStorage.getItem("sinan-assets-v1")).state.links),
        );
        await page.getByRole("button", { name: "连线配色", exact: true }).click();
        const appearancePanel = page.locator(".graph-appearance-panel");
        await appearancePanel
          .getByRole("textbox", { name: "普通关联颜色代码", exact: true })
          .fill("#d23b43");
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".react-flow__edge-path")].some(
            (path) => getComputedStyle(path).stroke === "rgb(210, 59, 67)",
          ),
        );
        await chooseOption(
          page,
          appearancePanel.getByRole("combobox", { name: "配色依据", exact: true }),
          "按起始资源类型",
        );
        await appearancePanel
          .getByRole("textbox", { name: "服务器颜色代码", exact: true })
          .waitFor();
        await chooseOption(
          page,
          appearancePanel.getByRole("combobox", { name: "配色依据", exact: true }),
          "按关联类型",
        );
        await appearancePanel.getByRole("slider", { name: "连线粗细", exact: true }).press("End");
        await appearancePanel
          .getByRole("checkbox", { name: "显示配色图例", exact: true })
          .uncheck();
        await page.locator(".graph-color-legend").waitFor({ state: "hidden" });
        await appearancePanel.getByRole("checkbox", { name: "显示配色图例", exact: true }).check();
        await appearancePanel.getByRole("button", { name: "关闭配色设置", exact: true }).click();
        const point = await page
          .locator(".react-flow__edge-path")
          .first()
          .evaluate((path) => {
            const p = path
              .getPointAtLength(Math.min(12, path.getTotalLength() / 4))
              .matrixTransform(path.getScreenCTM());
            return { x: p.x, y: p.y };
          });
        await page.mouse.click(point.x, point.y);
        assert.equal(
          await page.locator('.asset-graph-node[data-connection-highlighted="true"]').count(),
          2,
          "只高亮选中连线两端，不把其他邻居混入",
        );
        assert.equal(await appearancePanel.count(), 0, "单击只查看高亮，不弹出配色面板遮挡资产");
        await page.getByRole("button", { name: "调整选中连线配色", exact: true }).click();
        await appearancePanel
          .getByRole("textbox", { name: "单条连线颜色代码", exact: true })
          .fill("#ee8800");
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".react-flow__edge-path")].some(
            (path) => getComputedStyle(path).stroke === "rgb(238, 136, 0)",
          ),
        );
        const persisted = await page.evaluate(
          () => JSON.parse(localStorage.getItem("sinan-settings-v1")).state.graphAppearance,
        );
        assert.equal(Object.keys(persisted.overrides).length, 1);
        assert.equal(persisted.width, 5);
        await page.reload();
        await page.locator("[data-app-ready=true]").waitFor();
        await navigateDesktop(page, "资产关系图");
        await page.locator(".asset-graph-node").first().waitFor();
        assert.deepEqual(
          await page.evaluate(
            () => JSON.parse(localStorage.getItem("sinan-settings-v1")).state.graphAppearance,
          ),
          persisted,
          "刷新应保留分组颜色、线宽、图例与单条颜色",
        );
        assert.equal(
          await page.evaluate(() =>
            JSON.stringify(JSON.parse(localStorage.getItem("sinan-assets-v1")).state.links),
          ),
          linksBefore,
          "配色不能改动关联数据",
        );
        await page.getByRole("button", { name: "连线配色", exact: true }).click();
        await appearancePanel.getByRole("button", { name: "恢复默认配色", exact: true }).click();
        await appearancePanel.getByRole("button", { name: "关闭配色设置", exact: true }).click();
        // 在实际允许动态效果时验证呼吸高亮，再动态切换系统减少动画和单独开关。
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() => {
          const saved = JSON.parse(localStorage.getItem("sinan-settings-v1"));
          saved.state.motionMode = "full";
          localStorage.setItem("sinan-settings-v1", JSON.stringify(saved));
        });
        await page.reload();
        await page.locator("[data-app-ready=true]").waitFor();
        await navigateDesktop(page, "资产关系图");
        await page.locator(".asset-graph-node").first().waitFor();
        const selectConnection = async () => {
          await page.getByRole("button", { name: "适应画布", exact: true }).click();
          await page.waitForTimeout(250);
          const point = await page
            .locator(".react-flow__edge-path")
            .first()
            .evaluate((path) => {
              const p = path
                .getPointAtLength(Math.min(12, path.getTotalLength() / 4))
                .matrixTransform(path.getScreenCTM());
              return { x: p.x, y: p.y };
            });
          await page.mouse.click(point.x, point.y);
          await page.getByRole("button", { name: "清除关联高亮", exact: true }).waitFor();
        };
        await selectConnection();
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.asset-graph-node[data-connection-pulse="true"]').length ===
            2,
        );
        assert.equal(await page.locator(".graph-edge-active").count(), 1);
        await page.waitForFunction(() =>
          [
            ...document.querySelectorAll(
              ".react-flow__edge:not(.graph-edge-active) .react-flow__edge-path",
            ),
          ].every((path) => Number(getComputedStyle(path).opacity) <= 0.15),
        );
        const selectedIds = await page
          .locator('.asset-graph-node[data-connection-highlighted="true"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-asset-id")).sort());
        assert.equal(
          await page
            .locator('.asset-graph-node[data-connection-highlighted="true"]')
            .first()
            .evaluate((node) => getComputedStyle(node, "::after").animationName),
          "graph-connection-breathe",
        );
        assert(
          await page
            .locator(".react-flow__node")
            .evaluateAll((nodes) =>
              nodes.some((node) => Number(getComputedStyle(node).opacity) < 0.4),
            ),
          "其他资产应淡化",
        );
        await page.getByRole("button", { name: "纵向布局", exact: true }).click();
        await page.locator(".react-flow__handle-bottom").first().waitFor();
        assert.deepEqual(
          await page
            .locator('.asset-graph-node[data-connection-highlighted="true"]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-asset-id")).sort()),
          selectedIds,
          "横纵切换保留同一条关联的端点",
        );
        await page.getByRole("button", { name: "横向布局", exact: true }).click();
        await page.locator(".react-flow__handle-right").first().waitFor();
        await page.getByRole("button", { name: "定位选中关联", exact: true }).click();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.asset-graph-node[data-connection-pulse="true"]').length ===
            0,
        );
        assert.equal(
          await page.locator('.asset-graph-node[data-connection-highlighted="true"]').count(),
          2,
          "减少动画仍保留静态高亮",
        );
        assert.equal(
          await page
            .locator('.asset-graph-node[data-connection-highlighted="true"]')
            .first()
            .evaluate((node) => getComputedStyle(node, "::after").animationName),
          "none",
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.getByRole("button", { name: "调整选中连线配色", exact: true }).click();
        await appearancePanel
          .getByRole("checkbox", { name: "选中资产动态高亮", exact: true })
          .uncheck();
        await appearancePanel.getByRole("button", { name: "关闭配色设置", exact: true }).click();
        assert.equal(
          await page.locator('.asset-graph-node[data-connection-pulse="true"]').count(),
          0,
        );
        await page.getByRole("button", { name: "清除关联高亮", exact: true }).click();
        assert.equal(
          await page.locator('.asset-graph-node[data-connection-highlighted="true"]').count(),
          0,
        );
        await selectConnection();
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "清除关联高亮", exact: true })
          .waitFor({ state: "hidden" });
        const ids = await page
          .locator(".react-flow__node")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")).sort());
        await page.getByRole("button", { name: "导航小地图", exact: true }).click();
        await page.locator(".react-flow__minimap").waitFor();
        await page.getByRole("button", { name: "全屏查看图谱", exact: true }).click();
        await page.waitForFunction(() =>
          document.fullscreenElement?.classList.contains("asset-graph"),
        );
        await page.getByRole("button", { name: "连线配色", exact: true }).click();
        await chooseOption(
          page,
          page
            .locator(".graph-appearance-panel")
            .getByRole("combobox", { name: "配色依据", exact: true }),
          "统一颜色",
        );
        await chooseOption(
          page,
          page
            .locator(".graph-appearance-panel")
            .getByRole("combobox", { name: "配色依据", exact: true }),
          "按关联类型",
        );
        await page.getByRole("button", { name: "关闭配色设置", exact: true }).click();
        await chooseOption(
          page,
          page.getByRole("combobox", { name: "布局方式", exact: true }),
          "按类型分组",
        );
        await chooseOption(
          page,
          page.getByRole("combobox", { name: "布局方式", exact: true }),
          "关系分层",
        );
        assert.deepEqual(
          await page
            .locator(".react-flow__node")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")).sort()),
          ids,
          "切换布局不改变节点集合",
        );
        await page.getByRole("button", { name: "退出图谱全屏", exact: true }).click();
        await page.waitForFunction(() => !document.fullscreenElement);
        await page.getByRole("button", { name: "按原尺寸查看", exact: true }).click();
        await page.waitForFunction(() =>
          document.querySelector(".react-flow__viewport").style.transform.includes("scale(1)"),
        );
        await page.getByRole("button", { name: "适应画布", exact: true }).click();
        await page.locator('.asset-graph-node[data-asset-id="server-a"]').hover();
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".react-flow__edge-path")].some(
            (path) => Number(getComputedStyle(path).opacity) < 0.2,
          ),
        );
        await page.getByRole("button", { name: "重排节点", exact: true }).click();
        await page.getByRole("button", { name: "导航小地图", exact: true }).click();
      }
      const viewport = page.locator(".asset-graph .react-flow__viewport");
      const before = await viewport.getAttribute("style");
      await page.getByRole("button", { name: "放大", exact: true }).click();
      await page.waitForFunction(
        (old) =>
          document.querySelector(".asset-graph .react-flow__viewport").getAttribute("style") !==
          old,
        before,
      );
      await page.getByRole("button", { name: "适应画布", exact: true }).click();
      await page.screenshot({ path: `screenshots/graph-compact-${theme}-${width}.png` });
      results.push({ theme, width, ...geometry });
      await context.close();
    }
  assert.deepEqual(errors, []);
  await writeFile(
    "screenshots/graph-compact-receipt.json",
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: results.length, results, errors }, null, 2));
} finally {
  await browser.close();
}
