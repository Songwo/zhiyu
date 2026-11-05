import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { webResearchFixture } from "./web-research-fixture.mjs";

const f = await webResearchFixture({ built: true }),
  browser = await chromium.launch(),
  errors = [];
const time = new Date().toISOString();
const container = {
  id: "synthetic-container",
  name: "upgrade-web",
  image: "synthetic:v1",
  state: "running",
  status: "Up",
  health: "healthy",
  restartCount: 7,
  startedAt: "2026-01-01T00:00:00Z",
  ports: [],
};
const server = {
  id: "alert-server",
  name: "升级告警验证",
  host: "example.test",
  port: 22,
  username: "root",
  label: "",
  os: "Linux",
  region: "",
  status: "warning",
  hostProbeStatus: "online",
  cpu: 2,
  memory: 3,
  disk: 4,
  uptime: "1d",
  lastSeen: time,
  probedAt: time,
  tags: [],
  notes: "",
  sshConfigured: false,
  collect: true,
  serviceScan: {
    collectedAt: time,
    ports: [],
    docker: { available: true, containers: [container] },
  },
};
await f.call("/api/web/store", {
  cookie: f.cookie,
  method: "PUT",
  body: { revision: null, data: { version: 0, state: { servers: [server] } } },
});
const read = async () =>
  await (await f.call("/api/web/store", { cookie: f.cookie, method: "GET" })).json();
await mkdir("screenshots", { recursive: true });
try {
  for (const [width, height] of [
    [1440, 960],
    [390, 844],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: "zh-CN",
      reducedMotion: "reduce",
    });
    await context.addCookies([
      { name: "zhiyu_session", value: f.cookie.split("=")[1], url: f.base },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const open = async () => {
      await page.goto(f.base);
      await page.locator('[data-app-ready="true"]').waitFor();
      if (width < 768) {
        await page.getByRole("button", { name: "打开菜单", exact: true }).click();
        await page
          .getByRole("dialog", { name: "全部页面", exact: true })
          .getByRole("button", { name: /^服务器/ })
          .click();
      } else
        await page
          .getByRole("navigation", { name: "主导航" })
          .getByRole("button", { name: /^服务器/ })
          .click();
      await page.getByText(server.name, { exact: true }).first().click();
      await page.getByRole("button", { name: /端口与容器/ }).click();
    };
    await open();
    await page.getByRole("button", { name: "确认 upgrade-web 当前异常", exact: true }).click();
    await page.getByText("已确认本次异常", { exact: true }).waitFor();
    await page.waitForTimeout(700);
    let saved = await read();
    assert.ok(saved.data.state.servers[0].containerAlerts.acknowledged[container.name]);
    assert.equal(saved.data.state.servers[0].status, "online");
    await open();
    await page.getByText("已确认本次异常", { exact: true }).waitFor();
    await page.getByRole("button", { name: "撤销 upgrade-web 异常确认", exact: true }).click();
    await page.getByRole("button", { name: "确认 upgrade-web 当前异常", exact: true }).waitFor();
    await page.getByLabel("容器告警设置", { exact: true }).locator("summary").click();
    await page.getByRole("spinbutton", { name: "累计重启告警阈值（次）", exact: true }).fill("10");
    await page.getByRole("spinbutton", { name: "启动宽限（秒）", exact: true }).fill("0");
    await page.getByRole("button", { name: "保存告警规则", exact: true }).click();
    await page.waitForTimeout(700);
    saved = await read();
    assert.equal(saved.data.state.servers[0].containerAlerts.restartThreshold, 10);
    assert.equal(
      await page.getByRole("button", { name: "确认 upgrade-web 当前异常", exact: true }).count(),
      0,
    );
    await page.getByRole("spinbutton", { name: "累计重启告警阈值（次）", exact: true }).fill("5");
    await page.getByRole("button", { name: "保存告警规则", exact: true }).click();
    await page.getByRole("button", { name: "进入维护静音", exact: true }).click();
    await page.getByText("维护静音中", { exact: true }).waitFor();
    await page.waitForTimeout(700);
    saved = await read();
    assert.ok(saved.data.state.servers[0].containerAlerts.mutedUntil[container.name] > Date.now());
    assert.equal(saved.data.state.servers[0].serviceScan.docker.containers[0].restartCount, 7);
    await page.screenshot({ path: `screenshots/web-container-alerts-${width}.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.getByRole("button", { name: "取消静音", exact: true }).click();
    await page.getByRole("button", { name: "确认 upgrade-web 当前异常", exact: true }).waitFor();
    await page.waitForTimeout(700);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        viewports: [1440, 390],
        customRules: true,
        acknowledgeAndRevoke: true,
        maintenanceAndCancel: true,
        reloadPersistence: true,
        rawStatePreserved: true,
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const page of browser.contexts().flatMap((c) => c.pages()))
    console.error((await page.locator("body").innerText()).slice(-7000));
  throw error;
} finally {
  await browser.close();
  await f.close();
}
