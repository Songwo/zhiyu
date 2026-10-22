import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium, _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { chooseOption } from "./select-helper.mjs";
import { captureUrl } from "../electron/services/browser-capture.mjs";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
const extension = resolve(`release/v${version}/zhiyu-browser-extension`);
const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
assert.equal(manifest.version, version);
assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage", "tabs"]);
assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
// 1.3.0 自动助手：tabs 仅核对目标页及导航，令牌仍只在扩展上下文流转。
assert.equal(manifest.background?.service_worker, "background.mjs");
assert.deepEqual(manifest.content_scripts, [
  {
    matches: ["http://*/*", "https://*/*"],
    js: ["companion-fields.js", "companion.mjs", "submit-capture.mjs"],
    run_at: "document_idle",
  },
]);
const directory = await mkdtemp(join(tmpdir(), "nanpad-extension-"));
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = pathname === "/" ? "popup.html" : pathname.slice(1);
  const types = {
    "popup.html": "text/html",
    "popup.mjs": "text/javascript",
    "browser-capture.mjs": "text/javascript",
    "form-capture.mjs": "text/javascript",
    "bridge-config.mjs": "text/javascript",
    "popup.css": "text/css",
    "icon.png": "image/png",
  };
  if (/^icons\/[a-z-]+\.svg$/.test(file)) types[file] = "image/svg+xml";
  if (!types[file]) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.setHeader("Content-Type", types[file]);
    res.end(await readFile(join(extension, file)));
  } catch {
    res.writeHead(500);
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser, instance;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NANPAD_EXTENSION_BROWSER_PATH
      ? { executablePath: process.env.NANPAD_EXTENSION_BROWSER_PATH }
      : {}),
  });
  const popup = await browser.newPage({ viewport: { width: 360, height: 500 } });
  await popup.addInitScript(() => {
    window.chrome = {
      tabs: {
        query: async () => [
          {
            id: 12,
            title: "示例网站",
            url: location.search
              ? "chrome://settings"
              : "https://user:private@example.test/reset/private?token=private#private",
          },
        ],
        get: async () => ({
          id: 12,
          title: "示例网站",
          url: "https://user:private@example.test/reset/private?token=private#private",
        }),
        create: async (value) => {
          window.captureResult = { ...value };
        },
      },
      scripting: { executeScript: async () => [{ result: [] }] },
      storage: {
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        // 弹窗启动时会读取「自动采集」开关偏好。
        local: { get: async () => ({}) },
      },
    };
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await popup.goto(base);
  await popup.getByRole("button", { name: "仅记录站点并打开知屿" }).click();
  await popup.getByRole("status").filter({ hasText: "已请求打开知屿" }).waitFor();
  const result = await popup.evaluate(() => window.captureResult);
  assert.ok(!result.url.includes("private"));
  await popup.screenshot({ path: "screenshots/nanpad-v070-extension-site.png" });
  await popup.goto(`${base}/?blocked=1`);
  await popup.getByRole("status").filter({ hasText: "请在 HTTP" }).waitFor();
  assert.equal(
    await popup.getByRole("button", { name: "仅记录站点并打开知屿" }).isDisabled(),
    true,
  );
  await browser.close();
  browser = null;

  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  instance = await electron.launch({
    args: [resolve("electron/main.mjs"), result.url],
    env,
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 960 });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.getByRole("button", { name: "邮箱", exact: true }).click();
  await page.getByRole("button", { name: "添加邮箱", exact: true }).click();
  let composer = page.getByRole("dialog", { name: "邮箱", exact: true });
  await composer.getByLabel("地址", { exact: true }).fill("owner@example.test");
  await composer.getByLabel("所属域名", { exact: true }).fill("example.test");
  await composer.getByRole("button", { name: "添加", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "填写账号并保存" }).click();
  composer = page.getByRole("dialog", { name: "密钥", exact: true });
  assert.equal(
    await composer.getByLabel("登录地址", { exact: true }).inputValue(),
    "https://example.test/",
  );
  await composer.getByLabel("账号", { exact: true }).fill("integration-user");
  await composer.getByLabel("密码", { exact: true }).fill("private-fixture-password");
  await chooseOption(
    page,
    composer.getByRole("combobox", { name: "注册邮箱", exact: true }),
    "owner@example.test",
  );
  await instance.evaluate(
    ({ app }, url) => app.emit("second-instance", {}, [url]),
    captureUrl({ url: "https://second.test", title: "第二个站点" }),
  );
  assert.equal(await composer.getByLabel("账号", { exact: true }).inputValue(), "integration-user");
  await composer.getByRole("button", { name: "添加", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  const saved = await page.evaluate(() => window.sinan.store.load());
  const website = saved.state.secrets[0];
  assert.equal(website.kind, "password");
  assert.equal(saved.state.links.length, 1);
  assert.ok(!JSON.stringify(saved).includes("private-fixture-password"));
  assert.equal(
    (await page.evaluate((id) => window.sinan.vault.get(`account:${id}`), website.id)).password,
    "private-fixture-password",
  );
  await page.getByText("第二个站点", { exact: true }).waitFor();
  await page.getByRole("button", { name: "忽略网站", exact: true }).click();

  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "标签", exact: true })
    .click();
  await page.getByRole("button", { name: "批量整理", exact: true }).click();
  let organizer = page.getByRole("dialog", { name: "批量整理", exact: true });
  await organizer.getByLabel("选择搜索结果", { exact: false }).check();
  await organizer.getByLabel("批量标签", { exact: true }).fill("项目 A，个人");
  await page.screenshot({ path: "screenshots/nanpad-v040-organizer.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/nanpad-v040-organizer-mobile.png" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await organizer.getByRole("button", { name: "应用到所选资产" }).click();
  await organizer.waitFor({ state: "detached" });
  assert.deepEqual((await page.evaluate(() => window.sinan.store.load())).state.secrets[0].tags, [
    "项目 A",
    "个人",
  ]);
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.getByRole("button", { name: "批量整理", exact: true }).click();
  organizer = page.getByRole("dialog", { name: "批量整理", exact: true });
  await organizer.getByLabel("搜索资产名称或类型").fill("示例网站");
  await organizer.getByLabel("选择搜索结果", { exact: false }).check();
  await chooseOption(page, organizer.getByRole("combobox", { name: "标签操作" }), "移除标签");
  await organizer.getByLabel("批量标签").fill("个人");
  await organizer.getByRole("button", { name: "应用到所选资产" }).click();
  await organizer.waitFor({ state: "detached" });
  const after = (await page.evaluate(() => window.sinan.store.load())).state;
  assert.deepEqual(after.secrets[0].tags, ["项目 A"]);
  assert.deepEqual(after.mailboxes[0].tags, ["项目 A", "个人"]);
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.locator(`[data-asset-id="${website.id}"] .asset-name`).click();
  const details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByRole("button", { name: "解除关联", exact: true }).click();
  assert.equal((await page.evaluate(() => window.sinan.store.load())).state.links.length, 0);
  await details.getByRole("button", { name: "搜索与多选关联" }).click();
  await details.getByLabel("搜索资产名称或类型").fill("owner");
  await details.getByLabel("选择搜索结果", { exact: false }).check();
  await details.getByRole("button", { name: "添加所选关联" }).click();
  assert.equal((await page.evaluate(() => window.sinan.store.load())).state.links.length, 1);
  await details.getByRole("button", { name: "解除关联", exact: true }).click();
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "关系图", exact: true }).click();
  await page.getByText(/ 0 条已确认关联$/).waitFor();
  await page.getByRole("button", { name: "连接资产", exact: true }).click();
  const source = page.locator(`[data-asset-id="${website.id}"] .react-flow__handle.source`);
  const target = page.locator(
    `[data-asset-id="${after.mailboxes[0].id}"] .react-flow__handle.target`,
  );
  const a = await source.boundingBox(),
    b = await target.boundingBox();
  assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(
    async () => (await window.sinan.store.load()).state.links.length === 1,
  );
  await page.getByText(/ 1 条已确认关联$/).waitFor();
  await page.waitForFunction(() => {
    const graph = document.querySelector(".asset-graph").getBoundingClientRect();
    return [...document.querySelectorAll(".asset-graph-node")].every((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.left >= graph.left &&
        rect.right <= graph.right &&
        rect.top >= graph.top &&
        rect.bottom <= graph.bottom
      );
    });
  });
  await page.screenshot({ path: "screenshots/nanpad-v040-graph.png" });
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.deepEqual((await page.evaluate(() => window.sinan.store.load())).state.secrets[0].tags, [
    "项目 A",
  ]);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      version,
      extensionPopupFixture: true,
      protocolStartup: true,
      queuedSecondInstance: true,
      encryptedCredential: true,
      mailboxRelation: true,
      bulkTags: true,
      searchMultiLink: true,
      graphConnect: true,
      reloadPersistence: true,
      mobileOverflow: false,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
