import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { chooseOption } from "./select-helper.mjs";
import { runUsageSubscriptionUiQa } from "./usage-subscription-ui-qa.mjs";

// 只使用隔离数据与本机合成服务；可传入正式打包的 exe 验证同一条链路。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-subscription-desktop-"));
const fixtureRoot = join(directory, "synthetic-v2rayn");
const selectedRoot = join(directory, "selected-v2rayn");
const screenshotRoot = resolve("screenshots");
const executablePath = process.argv[2] ? resolve(process.argv[2]) : null;
const screenshotSuffix = executablePath ? "packaged" : "source";
const privateMarker = "SYNTHETIC_PRIVATE_SUBSCRIPTION";
const nodeAuth = "SYNTHETIC_PRIVATE_NODE_AUTH";
const requests = new Map();
let failSubscription = true;
let upload = 1024;
let download = 2048;
let liveUpload = 1024;
let liveDownload = 2048;
const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
const nodeText = [
  `vless://${nodeAuth}@a.example.test:443#${encodeURIComponent("香港主线")}`,
  `vless://${nodeAuth}@b.example.test:8443#${encodeURIComponent("香港主线")}`,
  `trojan://${nodeAuth}@c.example.test:443#${encodeURIComponent("日本备用")}`,
].join("\n");
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  if (path === "/debug/vars") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        stats: { outbound: { proxy: { uplink: liveUpload, downlink: liveDownload } } },
      }),
    );
    return;
  }
  if (path === "/error" && failSubscription) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!["/first", "/replacement", "/missing-header", "/large", "/error"].includes(path)) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (path !== "/missing-header") {
    const up = path === "/replacement" ? 5 * 1024 * 1024 : upload;
    const down = path === "/replacement" ? 6 * 1024 * 1024 : download;
    res.setHeader(
      "subscription-userinfo",
      `upload=${up}; download=${down}; total=${20 * 1024 * 1024}; expire=${expiry}`,
    );
  }
  if (path === "/large") res.end("x".repeat(2 * 1024 * 1024 + 1));
  else if (path === "/replacement") res.end(Buffer.from(nodeText).toString("base64"));
  else if (path === "/missing-header") {
    res.end(
      `proxies:\n  - name: 无流量头节点\n    type: trojan\n    server: c.example.test\n    port: 443\n    password: ${nodeAuth}\n`,
    );
  } else res.end(nodeText);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const subscriptionUrl = (path) => `http://127.0.0.1:${port}${path}?token=${privateMarker}`;
let instance;
let page;
const pageErrors = [];
const consoleErrors = [];
const passed = [];
function check(name) {
  passed.push(name);
  console.log(JSON.stringify({ check: name, status: "passed" }));
}
const sourceCard = (name) =>
  page.locator(".subscription-source-card").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
async function state() {
  return page.evaluate(() => window.sinan.usage.list());
}
async function addSource(name, path) {
  await page.getByRole("button", { name: "连接用量来源", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "连接用量来源", exact: true });
  await dialog.getByLabel("来源名称", { exact: true }).fill(name);
  await chooseOption(
    page,
    dialog.getByRole("combobox", { name: "来源类型", exact: true }),
    "机场订阅",
  );
  await dialog.getByLabel("机场订阅地址", { exact: true }).fill(subscriptionUrl(path));
  assert.equal(
    await dialog.getByLabel("机场订阅地址", { exact: true }).getAttribute("type"),
    "password",
  );
  await dialog.getByRole("button", { name: "保存并验证连接", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("tab", { name: /订阅与来源/ }).getAttribute("aria-selected"),
    "true",
  );
}
async function editSource(name, { newName, path } = {}) {
  await sourceCard(name)
    .getByRole("button", { name: `编辑 ${name}`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "编辑用量来源", exact: true });
  assert.equal(
    await dialog.getByLabel("机场订阅地址", { exact: true }).inputValue(),
    "",
    "编辑不回显订阅地址",
  );
  if (newName) await dialog.getByLabel("来源名称", { exact: true }).fill(newName);
  if (path) await dialog.getByLabel("机场订阅地址", { exact: true }).fill(subscriptionUrl(path));
  await dialog.getByRole("button", { name: "保存并验证连接", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}
async function refreshSource(name) {
  const button = sourceCard(name).getByRole("button", { name: `刷新 ${name}`, exact: true });
  await button.click();
  await page.waitForFunction((sourceName) => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === `刷新 ${sourceName}`,
    );
    return button && !button.disabled;
  }, name);
}
async function details(id) {
  return page.evaluate((sourceId) => window.sinan.usage.subscriptionDetails(sourceId), id);
}
async function verifyPublicPrivacy() {
  const usage = await state();
  const publicJson = JSON.stringify(usage);
  const disk = await readFile(join(directory, "usage-history.json"), "utf8");
  for (const text of [publicJson, disk, await page.locator("body").innerText()]) {
    assert.equal(
      text.includes(privateMarker),
      false,
      "订阅 token 不出现在公开数据、磁盘明文或界面",
    );
    assert.equal(text.includes(nodeAuth), false, "节点认证字段不出现在公开数据、磁盘明文或界面");
    assert.equal(text.includes(`http://127.0.0.1:${port}`), false, "完整订阅 URL 仅在加密库中保存");
  }
  assert.equal(
    publicJson.includes("a.example.test"),
    false,
    "usage.list 只返回订阅摘要，不批量返回节点正文",
  );
  const vaultFile = join(directory, "vault.enc");
  assert.ok((await stat(vaultFile)).size > 100);
  const encrypted = await readFile(vaultFile, "utf8");
  assert.equal(encrypted.includes(privateMarker), false);
  assert.equal(encrypted.includes(nodeAuth), false);
}
try {
  await mkdir(screenshotRoot, { recursive: true });
  await mkdir(join(fixtureRoot, "guiConfigs"), { recursive: true });
  await mkdir(join(fixtureRoot, "binConfigs"), { recursive: true });
  // 启动前指定目录，正式打包实例也不会探测用户真实 v2rayN。
  await writeFile(join(directory, "v2rayn-usage.json"), JSON.stringify({ directory: fixtureRoot }));
  await writeFile(
    join(directory, "local-usage.json"),
    JSON.stringify({ version: 1, enabled: false, events: [], checkpoints: [], records: [] }),
  );
  await writeFile(
    join(directory, "preferences.json"),
    JSON.stringify({ locale: "zh", notifications: false, closeToTray: false }),
  );
  const now = new Date();
  const ticks =
    621355968000000000n +
    BigInt(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) * 10000n;
  const database = new DatabaseSync(join(fixtureRoot, "guiConfigs", "guiNDB.db"));
  try {
    database.exec(`CREATE TABLE ProfileItem (IndexId TEXT PRIMARY KEY, Subid TEXT, Remarks TEXT, Address TEXT, Port INTEGER, ConfigType INTEGER, CoreType INTEGER, Id TEXT, Password TEXT);
      CREATE TABLE SubItem (Id TEXT PRIMARY KEY, Remarks TEXT, Enabled INTEGER, Url TEXT);
      CREATE TABLE ServerStatItem (IndexId TEXT PRIMARY KEY, TotalUp INTEGER, TotalDown INTEGER, TodayUp INTEGER, TodayDown INTEGER, DateNow INTEGER);`);
    database
      .prepare("INSERT INTO SubItem VALUES (?, ?, ?, ?)")
      .run("fixture-sub", "隔离机场", 1, subscriptionUrl("/first"));
    const insert = database.prepare("INSERT INTO ProfileItem VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(
      "fixture-a",
      "fixture-sub",
      "香港主线",
      "a.example.test",
      443,
      5,
      1,
      nodeAuth,
      nodeAuth,
    );
    insert.run(
      "fixture-b",
      "fixture-sub",
      "香港主线",
      "b.example.test",
      8443,
      5,
      1,
      nodeAuth,
      nodeAuth,
    );
    database
      .prepare("INSERT INTO ServerStatItem VALUES (?, ?, ?, ?, ?, ?)")
      .run("fixture-a", 1024, 2048, 100, 200, ticks);
  } finally {
    database.close();
  }
  await writeFile(
    join(fixtureRoot, "guiConfigs", "guiNConfig.json"),
    JSON.stringify({
      IndexId: "fixture-a",
      GuiItem: { EnableStatistics: true },
      WebDavItem: { Password: nodeAuth },
    }),
  );
  await writeFile(
    join(fixtureRoot, "binConfigs", "config.json"),
    JSON.stringify({
      metrics: { listen: `127.0.0.1:${port}` },
      policy: { system: { statsOutboundUplink: true, statsOutboundDownlink: true } },
      outbounds: [
        {
          tag: "proxy",
          protocol: "vless",
          settings: {
            vnext: [{ address: "a.example.test", port: 443, users: [{ id: nodeAuth }] }],
          },
        },
      ],
    }),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  if (executablePath) delete env.NANPAD_TEST_DATA_DIR;
  else env.NANPAD_TEST_DATA_DIR = directory;
  instance = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [`--user-data-dir=${directory}`] : [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  page = await instance.firstWindow();
  const runtime = await instance.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
    return {
      packaged: app.isPackaged,
      directory: app.getPath("userData"),
      version: app.getVersion(),
    };
  });
  assert.equal(resolve(runtime.directory), resolve(directory));
  assert.equal(runtime.packaged, Boolean(executablePath));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await completeOnboarding(page);
  assert.equal((await page.evaluate(() => window.sinan.usage.localStatus())).enabled, false);
  assert.equal((await state()).records.length, 0);
  await page
    .getByRole("button", { name: /^用量记录/ })
    .first()
    .click();
  await addSource("隔离机场", "/first");
  const first = (await state()).sources.find((source) => source.name === "隔离机场");
  assert.ok(first);
  assert.equal(first.subscription.nodeCount, 3);
  assert.equal(first.subscription.trafficAvailable, true);
  assert.equal(requests.get("/first"), 1, "首次保存只获取一次订阅");
  const firstRecord = (await state()).records.find((row) => row.sourceId === first.id);
  assert.equal(firstRecord.upload, upload);
  assert.equal(firstRecord.download, download);
  assert.equal(firstRecord.total, 20 * 1024 * 1024);
  assert.equal(firstRecord.expiresAt, new Date(expiry * 1000).toISOString());
  assert.equal(firstRecord.deltaUpload, null);
  const card = sourceCard("隔离机场");
  await card
    .locator(".subscription-metrics > div")
    .filter({ hasText: "总额度" })
    .getByText("20.00 MiB", { exact: true })
    .waitFor();
  assert.match(
    await card.locator(".subscription-metrics > div").filter({ hasText: "剩余流量" }).innerText(),
    /20\.00 MiB/,
  );
  assert.match(await card.locator(".subscription-metrics").innerText(), /3\.00 KiB/);
  assert.match(await card.locator(".subscription-meta").innerText(), /到期时间/);
  check("添加机场、首次采集、总量与到期");

  await runUsageSubscriptionUiQa(page, {
    sourceName: "隔离机场",
    screenshotPath: join(screenshotRoot, `subscription-mobile-editor-${screenshotSuffix}.png`),
  });
  assert.equal(requests.get("/first"), 1, "展开、搜索、取消编辑不能联网刷新订阅");
  await card.getByRole("button", { name: /节点详情/ }).click();
  await card.locator(".subscription-node").first().waitFor();
  const cached = await details(first.id);
  assert.equal(cached.format, "uri");
  assert.equal(
    new Set(cached.nodes.map((node) => node.id)).size,
    3,
    "同名不同主机节点保留各自身份",
  );
  assert.equal(cached.nodes.filter((node) => node.name === "香港主线").length, 2);
  await card.getByRole("textbox", { name: "搜索订阅节点", exact: true }).fill("b.example.test");
  assert.equal(await card.locator(".subscription-node").count(), 1);
  await card.getByRole("textbox", { name: "搜索订阅节点", exact: true }).fill("");
  check("缓存节点、同名区分、搜索、编辑与删除取消、窄屏弹窗");

  const local = card.getByRole("region", { name: "v2rayN 本机流量", exact: true });
  await local.scrollIntoViewIfNeeded();
  await local.locator(".v2rayn-node").first().waitFor();
  assert.equal(await local.locator(".v2rayn-node").count(), 2);
  const savedText = await local.locator(".v2rayn-saved").innerText();
  assert.match(savedText, /1 MB/);
  assert.match(savedText, /2 MB/);
  await local.locator(".v2rayn-live-grid").waitFor();
  assert.match(await local.locator(".v2rayn-live-grid").innerText(), /1\.00 KiB/);
  assert.match(await local.locator(".v2rayn-live-grid").innerText(), /2\.00 KiB/);
  const localState = await page.evaluate(() => window.sinan.usage.v2raynStatus(true));
  assert.equal(localState.nodes[0].savedUploadKb, 1024);
  assert.equal(localState.live.upload, 1024);
  assert.equal(localState.live.nodeId, "fixture-a");
  assert.equal(JSON.stringify(localState).includes(nodeAuth), false);
  assert.equal(JSON.stringify(localState).includes(privateMarker), false);
  // 第二份目录具有不同统计值，断言配置和界面均切换，避免空操作也通过。
  await cp(fixtureRoot, selectedRoot, { recursive: true });
  const selectedDatabase = new DatabaseSync(join(selectedRoot, "guiConfigs", "guiNDB.db"));
  try {
    selectedDatabase
      .prepare("UPDATE ServerStatItem SET TotalUp = ? WHERE IndexId = ?")
      .run(4096, "fixture-a");
  } finally {
    selectedDatabase.close();
  }
  // 仅替换原生文件选择结果；产品 IPC 与真实模块照常读取数据库。
  await instance.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, selectedRoot);
  await local.getByRole("button", { name: "选择目录", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="刷新本机流量"]').disabled);
  await local.locator(".v2rayn-saved").getByText(/4 MB/).waitFor();
  assert.equal(
    JSON.parse(await readFile(join(directory, "v2rayn-usage.json"), "utf8")).directory,
    selectedRoot,
  );
  await page.evaluate(() => window.sinan.vault.lock());
  liveUpload = 1536;
  liveDownload = 3072;
  await local.getByRole("button", { name: "刷新本机流量", exact: true }).click();
  await local
    .locator(".v2rayn-live-grid")
    .getByText(/1\.50 KiB/)
    .waitFor();
  assert.equal((await page.evaluate(() => window.sinan.vault.status())).unlocked, false);
  assert.equal(await page.getByRole("dialog", { name: "解锁密钥库", exact: true }).count(), 0);
  const locked = await page.evaluate(() => window.sinan.usage.v2raynStatus(true));
  assert.equal(locked.live.observedUpload, 512);
  assert.equal(locked.live.observedDownload, 1024);
  assert.equal(locked.nodes[0].savedUploadKb, 4096, "实时增量不覆盖或混入已保存 KB");
  assert.equal((await details(first.id)).nodeCount, 3, "锁库仍能查看安全缓存");
  assert.equal(requests.get("/first"), 1, "本机刷新不触发机场订阅请求");
  await page.screenshot({
    path: join(screenshotRoot, `subscription-v2rayn-${screenshotSuffix}.png`),
    fullPage: true,
  });
  const desktopDetails = await card.evaluate((element) => {
    const catalog = element.querySelector(".subscription-catalog").getBoundingClientRect();
    const local = element.querySelector(".v2rayn-traffic").getBoundingClientRect();
    const grid = element.closest(".usage-source-grid").getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      catalogRight: catalog.right,
      localLeft: local.left,
      cardWidth: bounds.width,
      gridWidth: grid.width,
    };
  });
  assert.ok(desktopDetails.localLeft >= desktopDetails.catalogRight, "桌面节点列表与本机统计并排");
  assert.ok(
    Math.abs(desktopDetails.cardWidth - desktopDetails.gridWidth) < 2,
    "展开卡占满来源网格整行",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDetails = await card.evaluate((element) => {
    const catalog = element.querySelector(".subscription-catalog").getBoundingClientRect();
    const local = element.querySelector(".v2rayn-traffic").getBoundingClientRect();
    return {
      catalogBottom: catalog.bottom,
      localTop: local.top,
      left: local.left,
      right: local.right,
      width: innerWidth,
    };
  });
  assert.ok(
    mobileDetails.localTop >= mobileDetails.catalogBottom,
    "手机节点列表与本机统计按单列排列",
  );
  assert.ok(
    mobileDetails.left >= 0 && mobileDetails.right <= mobileDetails.width,
    "手机本机统计不横向溢出",
  );
  await local.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(screenshotRoot, `subscription-v2rayn-mobile-${screenshotSuffix}.png`),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const beforeCanceledUnlock = await state();
  await card.getByRole("button", { name: "刷新 隔离机场", exact: true }).click();
  const unlockDialog = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await unlockDialog.waitFor();
  await unlockDialog.getByRole("button", { name: "取消", exact: true }).click();
  await unlockDialog.waitFor({ state: "detached" });
  assert.deepEqual(await state(), beforeCanceledUnlock, "取消解锁不刷新或改变远程订阅数据");
  assert.equal(requests.get("/first"), 1);
  await page.evaluate(() => window.sinan.vault.unlock("integration-master-2026"));
  check("真实 v2rayN SQLite 与实时接口、目录选择、锁库读取、KB 和 bytes 分离");

  upload += 1024;
  download += 2048;
  await refreshSource("隔离机场");
  let current = await state();
  assert.equal(current.records.filter((row) => row.sourceId === first.id).at(-1).deltaUpload, 1024);
  await editSource("隔离机场", { newName: "改名机场" });
  current = await state();
  assert.equal(current.sources.find((source) => source.id === first.id).revision, 0);
  assert.equal(current.sources.find((source) => source.id === first.id).name, "改名机场");
  assert.equal(current.records.filter((row) => row.sourceId === first.id).at(-1).deltaUpload, 0);
  assert.equal(requests.get("/first"), 3, "空 URL 编辑保留原地址并验证一次");
  await editSource("改名机场", { path: "/replacement" });
  current = await state();
  assert.equal(current.sources.find((source) => source.id === first.id).revision, 1);
  const revised = current.records.filter((row) => row.sourceId === first.id).at(-1);
  assert.equal(revised.upload, 5 * 1024 * 1024);
  assert.equal(revised.deltaUpload, null, "替换地址后的第一次采集重新建立基线");
  assert.equal(revised.deltaDownload, null);
  assert.equal((await details(first.id)).format, "base64");
  await addSource("不应新增的重复机场", "/replacement");
  assert.equal((await state()).sources.length, 1, "相同 URL 不新增来源");
  assert.equal(await sourceCard("改名机场").count(), 1);
  assert.equal(await sourceCard("不应新增的重复机场").count(), 0);
  check("编辑保留空凭据、更新 URL 独立基线、重复 URL 去重");

  await addSource("无头机场", "/missing-header");
  const missing = (await state()).sources.find((source) => source.name === "无头机场");
  assert.equal(missing.subscription.trafficAvailable, false);
  assert.equal(missing.subscription.nodeCount, 1);
  assert.equal((await details(missing.id)).format, "clash");
  assert.equal((await state()).records.filter((row) => row.sourceId === missing.id).length, 0);
  assert.match(await sourceCard("无头机场").innerText(), /当前流量未知/);
  await addSource("超限机场", "/large");
  const large = (await state()).sources.find((source) => source.name === "超限机场");
  assert.match(large.error, /2 MiB/);
  assert.equal(
    (await state()).records.filter((row) => row.sourceId === large.id).length,
    0,
    "超限响应即使有用量头也不能伪造完整采集",
  );
  await sourceCard("超限机场").getByRole("button", { name: "重试连接", exact: true }).waitFor();
  await editSource("超限机场", { path: "/error" });
  await sourceCard("超限机场").getByRole("alert").waitFor();
  assert.match(await sourceCard("超限机场").getByRole("alert").innerText(), /403/);
  failSubscription = false;
  await sourceCard("超限机场").getByRole("button", { name: "重试连接", exact: true }).click();
  await sourceCard("超限机场").getByRole("alert").waitFor({ state: "detached" });
  assert.equal((await state()).records.filter((row) => row.sourceId === large.id).length, 1);
  assert.equal((await state()).sources.length, 3);
  check("缺少用量头保留节点、超限拒绝落盘、错误卡编辑与重试");

  await page.getByRole("tab", { name: "用量概览", exact: true }).click();
  for (const type of ["API Token", "本机 Token"]) {
    await chooseOption(page, page.getByRole("combobox", { name: "用量类型", exact: true }), type);
    await page.getByRole("combobox", { name: "来源筛选", exact: true }).click();
    assert.equal(
      (await page.getByRole("option").allTextContents()).some((value) => /机场/.test(value)),
      false,
      "Token 来源筛选不混入机场",
    );
    await page.keyboard.press("Escape");
  }
  await page.getByRole("tab", { name: /订阅与来源/ }).click();
  await verifyPublicPrivacy();
  for (const expanded of await page.locator('.subscription-expand[aria-expanded="true"]').all())
    await expanded.click();
  await page.getByRole("tab", { name: /订阅与来源/ }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(screenshotRoot, `subscription-desktop-${screenshotSuffix}.png`),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await sourceCard("改名机场").scrollIntoViewIfNeeded();
  const bounds = await sourceCard("改名机场").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, "390px 来源卡不横向溢出");
  await page.screenshot({
    path: join(screenshotRoot, `subscription-mobile-${screenshotSuffix}.png`),
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  check("Token 来源筛选、公开数据与磁盘隐私、桌面和手机来源卡");

  const beforeRemoval = (await state()).records.filter((row) => row.sourceId === first.id);
  await sourceCard("改名机场").getByRole("button", { name: "移除 改名机场", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "移除用量来源", exact: true });
  await removal.getByRole("button", { name: "取消", exact: true }).click();
  assert.ok((await state()).sources.some((source) => source.id === first.id));
  await sourceCard("改名机场").getByRole("button", { name: "移除 改名机场", exact: true }).click();
  await removal.getByRole("button", { name: "确认移除", exact: true }).click();
  await removal.waitFor({ state: "detached" });
  current = await state();
  assert.equal(
    current.sources.some((source) => source.id === first.id),
    false,
  );
  assert.deepEqual(
    current.records.filter((row) => row.sourceId === first.id),
    beforeRemoval,
    "移除仅停用来源，完整保留历史记录",
  );
  assert.equal(await sourceCard("改名机场").count(), 0);
  await verifyPublicPrivacy();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  check("取消和确认移除、历史保留、浏览器无异常");
  console.log(
    JSON.stringify({
      ok: true,
      passed: passed.length,
      failed: 0,
      skipped: 0,
      mode: screenshotSuffix,
      version: runtime.version,
      pageErrors,
      consoleErrors,
      checks: passed,
    }),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: join(screenshotRoot, `subscription-failure-${screenshotSuffix}.png`),
        fullPage: true,
      })
      .catch(() => {});
  console.error(
    JSON.stringify({
      ok: false,
      passed: passed.length,
      failed: 1,
      skipped: 0,
      message: error.message,
      pageErrors,
      consoleErrors,
    }),
  );
  throw error;
} finally {
  await instance?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  const child = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), "清理仅限本次隔离数据目录");
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
