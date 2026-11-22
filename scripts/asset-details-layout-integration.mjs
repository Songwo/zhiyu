import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { demoSnapshot } from "../electron/services/demo.mjs";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { chooseOption } from "./select-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "zhiyu-detail-layout-"));
const screenshotDir = "screenshots/ui-layout-v3";
const snapshot = demoSnapshot();
const service = {
  id: "layout-service",
  name: "布局验证服务",
  category: "custom",
  status: "online",
  provider: "演示服务商",
  tags: [],
};
snapshot.services = [
  service,
  {
    ...service,
    id: "layout-card",
    name: "布局验证支付卡",
    card: { kind: "payment", network: "Visa", last4: "4242", expiryMonth: "2028-02" },
  },
  {
    ...service,
    id: "layout-esim",
    name: "布局验证 eSIM",
    card: { kind: "esim", plan: "演示套餐", keepAliveAt: "2028-02-01" },
  },
];
const views = [
  ["secret", snapshot.secrets[0].id, snapshot.secrets[0].name],
  ["server", snapshot.servers[0].id, snapshot.servers[0].name],
  ["domain", snapshot.domains[3].id, snapshot.domains[3].name],
  ["cert", snapshot.certs[1].id, snapshot.certs[1].cn],
  ["mail", snapshot.mailboxes[0].id, snapshot.mailboxes[0].address],
  ["ai", snapshot.aiAssets[0].id, snapshot.aiAssets[0].name],
  ...snapshot.services.map(({ id, name }) => ["service", id, name]),
];
let instance;
try {
  await writeFile(join(directory, "assets.json"), JSON.stringify({ version: 0, state: snapshot }));
  await writeFile(
    join(directory, "preferences.json"),
    JSON.stringify({ notifications: false, backgroundUpdateDownload: false, closeToTray: false }),
  );
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.SINAN_DEV_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  instance = await electron.launch({
    args: [resolve("electron/main.mjs"), `--user-data-dir=${directory}`],
    env,
    locale: "zh-CN",
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await mkdir(screenshotDir, { recursive: true });

  const details = page.getByRole("region", { name: "资产详情", exact: true });
  const context = details.getByRole("complementary", { name: "关联资料", exact: true });
  const relations = context.getByRole("region", { name: "关联资产", exact: true });
  async function open(kind, id, label) {
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "搜索资产与操作" });
    await search.fill(label);
    await page
      .getByRole("option")
      .and(page.locator(`[data-value="${kind}:${id}"]`))
      .click();
    await details.getByRole("heading", { level: 1, name: label, exact: true }).waitFor();
    await context.getByRole("heading", { name: /关联文档/ }).waitFor();
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [kind, id, label] of views) {
      await open(kind, id, label);
      const manage = relations.getByRole("button", { name: "管理关联", exact: true });
      assert.equal(await manage.getAttribute("aria-expanded"), "false");
      assert.equal(
        await details.getByRole("combobox", { name: "选择关联资产" }).isVisible(),
        false,
      );
      const summary = details.locator(".detail-summary");
      const mainBox = await summary.boundingBox();
      const sideBox = await context.boundingBox();
      if (width === 1440) assert.ok(mainBox.x + mainBox.width <= sideBox.x, label);
      else assert.ok(mainBox.y + mainBox.height <= sideBox.y, label);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        label,
      );
      if (kind === "secret") {
        const content = details.getByRole("region", { name: "密钥内容", exact: true });
        await content.getByRole("button", { name: "录入账号密码", exact: true }).waitFor();
        await content.waitFor();
        assert.ok(
          await content.evaluate((section) =>
            Boolean(
              section.compareDocumentPosition(document.querySelector(".detail-context")) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          ),
        );
        await page.screenshot({ path: `${screenshotDir}/secret-${width}.png` });
        if (width === 1440) {
          await manage.click();
          await chooseOption(
            page,
            relations.getByRole("combobox", { name: "选择关联资产" }),
            snapshot.mailboxes[0].address,
          );
          await relations.getByRole("button", { name: "添加关联", exact: true }).click();
          await relations.getByRole("button", { name: "解除关联", exact: true }).waitFor();
          await manage.click();
          await relations
            .getByRole("button", {
              name: new RegExp(snapshot.mailboxes[0].address.replace(/\./g, "\\.")),
            })
            .waitFor();
          await relations.getByRole("button", { name: "解除关联", exact: true }).click();
          await relations.getByText("尚未关联资产", { exact: true }).waitFor();
        }
      }
      if (kind === "server" && width === 1440) {
        await page.screenshot({ path: `${screenshotDir}/server-${width}.png` });
        const fileTab = details.getByRole("button", { name: "文件SFTP", exact: true });
        await fileTab.click();
        await details.getByRole("heading", { name: "SFTP", exact: true }).waitFor();
        assert.equal(await fileTab.getAttribute("aria-pressed"), "true");
        await details.getByRole("button", { name: /自建节点/ }).click();
        await details.getByRole("button", { name: "监控概览", exact: true }).click();
        await context.waitFor();
      }
      if (kind === "domain" && width === 1440)
        await page.screenshot({ path: `${screenshotDir}/domain-${width}.png` });
      if (id === "layout-card" && width === 1440)
        await page.screenshot({ path: `${screenshotDir}/card-${width}.png` });
      await details.getByRole("button", { name: "返回列表", exact: true }).click();
      await details.waitFor({ state: "detached" });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, views: views.length, widths: [1440, 390], errors }));
} finally {
  if (instance) await instance.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await instance?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
