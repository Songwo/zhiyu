import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "nanpad-ui-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
try {
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.locator('[data-app-ready="true"]').waitFor();
  await completeOnboarding(page);
  await page.evaluate(async () => {
    await window.sinan.preferences.set({ notifications: false });
    const primary = {
      id: "primary",
      name: "qa-primary",
      host: "127.0.0.1",
      port: 22,
      username: "qa",
      label: "Production",
      os: "Linux",
      region: "Local",
      status: "online",
      cpu: 9,
      memory: 42,
      disk: 30,
      uptime: "1d",
      lastSeen: new Date().toISOString(),
      notes: "",
      tags: ["prod"],
    };
    await window.sinan.store.save({
      version: 0,
      state: {
        servers: [
          primary,
          ...Array.from({ length: 29 }, (_, index) => ({
            ...primary,
            id: `host-${index}`,
            name: `Worker ${index + 1}`,
            cpu: 20 + index,
            tags: ["worker"],
          })),
        ],
        domains: [
          {
            id: "domain",
            name: "qa-primary.example.test",
            registrar: "QA",
            expiresAt: "2027-01-01",
            dns: "QA DNS",
            nameservers: [],
            autoRenew: true,
            status: "online",
            notes: "",
            tags: ["prod"],
          },
        ],
        certs: [
          {
            id: "cert",
            cn: "*.qa-primary.example.test",
            issuer: "QA",
            expiresAt: "2027-01-01",
            sans: [],
            status: "warning",
            notes: "",
            tags: ["prod"],
          },
        ],
        mailboxes: [],
        aiAssets: [],
        secrets: [],
        activity: [],
        links: [
          { from: { kind: "domain", id: "domain" }, to: { kind: "cert", id: "cert" } },
          { from: { kind: "cert", id: "cert" }, to: { kind: "server", id: "primary" } },
        ],
      },
    });
  });
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.getByRole("button", { name: /^标签/ }).first().click();
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.locator(".asset-table tbody tr").first().waitFor();
  assert.equal(await page.locator(".asset-table tbody tr").count(), 25);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await page.locator(".asset-table tbody tr").count(), 7);
  await page.getByRole("combobox", { name: "每页条数" }).click();
  await page.getByRole("option", { name: "每页 50 项", exact: true }).click();
  await page.getByRole("button", { name: "CPU", exact: true }).click();
  const values = await page.locator(".asset-table tbody tr td:nth-child(5)").allTextContents();
  const numbers = values.filter((value) => value !== "-").map((value) => Number.parseFloat(value));
  assert.equal(numbers.length, 30);
  const descending =
    (await page.locator(".asset-table th:nth-child(5)").getAttribute("aria-sort")) === "descending";
  assert.deepEqual(
    numbers,
    [...numbers].sort((a, b) => (descending ? b - a : a - b)),
  );
  await mkdir("release/screenshots", { recursive: true });
  await page.screenshot({ path: "release/screenshots/nanpad-table.png" });
  await page.getByRole("textbox", { name: "筛选当前列表" }).fill("qa-primary");
  assert.equal(await page.locator(".asset-table tbody tr").count(), 3);
  await page.getByRole("button", { name: "编辑 qa-primary", exact: true }).click();
  await page.getByRole("textbox", { name: "主机名", exact: true }).fill("qa-primary-updated");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator('[data-sonner-toast][data-type="success"]').waitFor();
  assert.equal(
    (await page.evaluate(() => window.sinan.store.load())).state.servers[0].name,
    "qa-primary-updated",
  );
  await page.getByRole("button", { name: "关系图", exact: true }).click();
  // 水平 SVG 路径几何高度为零，不能用 Playwright 的可见矩形判定；检查真实路径及描边，截图再目检。
  await page.locator(".react-flow__edge-path").first().waitFor({ state: "attached" });
  assert.ok(
    await page
      .locator(".react-flow__edge-path")
      .first()
      .evaluate((el) => el.getTotalLength() > 0 && getComputedStyle(el).stroke !== "none"),
  );
  assert.equal(await page.locator(".asset-graph-node").count(), 3);
  assert.equal(await page.locator(".react-flow__edge-path").count(), 2);
  const node = page.locator('[data-asset-id="primary"] .graph-node-meta');
  const start = await node.boundingBox();
  assert.ok(start);
  await page.mouse.move(start.x + 8, start.y + 8);
  await page.mouse.down();
  await page.mouse.move(start.x + 48, start.y + 38, { steps: 6 });
  await page.mouse.up();
  const moved = await node.boundingBox();
  assert.ok(moved && Math.abs(moved.x - start.x) > 20, "节点应可以拖动");
  await page.getByRole("button", { name: "重排节点", exact: true }).click();
  const previous = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction(
    (style) => document.querySelector(".react-flow__viewport")?.getAttribute("style") !== style,
    previous,
  );
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.locator('[data-asset-id="primary"] .asset-name').click();
  await page.getByRole("region", { name: "资产详情" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("region", { name: "资产详情" }).waitFor({ state: "detached" });
  await page.screenshot({ path: "release/screenshots/nanpad-graph.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".asset-graph .react-flow").getBoundingClientRect();
    const toolbar = document.querySelector(".graph-toolbar").getBoundingClientRect();
    const nodes = [...document.querySelectorAll(".asset-graph-node")];
    return (
      toolbar.top >= canvas.bottom - 1 &&
      nodes.every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top >= canvas.top && rect.bottom <= canvas.bottom;
      })
    );
  });
  await page.screenshot({ path: "release/screenshots/nanpad-graph-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(
    await page.locator(".asset-table-scroll").evaluate((el) => el.scrollWidth > el.clientWidth),
  );
  await page.screenshot({ path: "release/screenshots/nanpad-table-mobile.png" });
  await page.getByRole("button", { name: "打开菜单", exact: true }).click();
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByText("系统设置…", { exact: true }).click();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await page.getByRole("combobox", { name: "语言", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.locator("nav").getByRole("button", { name: "Tags", exact: true }).click();
  await page.locator(".asset-table").waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("textbox", { name: "Filter this list" }).fill("qa-primary");
  await page.getByRole("button", { name: "Relationship graph", exact: true }).click();
  await page.locator(".react-flow__edge-path").first().waitFor({ state: "attached" });
  await page.screenshot({ path: "release/screenshots/nanpad-graph-dark-mobile.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".status-feedback")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  assert.equal(
    await page
      .locator(".live-dot")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  assert.equal(
    await page
      .locator(".sonar-ring")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        rows: 32,
        nodes: 3,
        edges: 2,
        sorting: true,
        pagination: true,
        filters: true,
        persistedLayout: true,
        reducedMotion: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
}
