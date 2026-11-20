import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { universalRelationFixture } from "./universal-relations-fixture.mjs";

import { expandNavigationGroups } from "./navigation-helper.mjs";

const url = new URL(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:4173/");
assert.equal(url.hostname, "127.0.0.1");
assert.notEqual(url.port, "8080", "不得占用用户 8080 服务");
const outputDir = process.env.VALIDATION_OUTPUT ?? "docs/validation/feedback-2026-11-15";
await mkdir(`${outputDir}/screenshots`, { recursive: true });

function fixture() {
  const { snapshot, documents } = universalRelationFixture();
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
      label: server.name,
    });
  for (const mail of snapshot.mailboxes)
    Object.assign(mail, {
      address: `${mail.id}@example.test`,
      kind: "mailbox",
      domain: "example.test",
      usedMb: 0,
      quotaMb: 0,
    });
  for (const domain of snapshot.domains)
    Object.assign(domain, {
      registrar: "Test Registrar",
      nameservers: [],
      dns: "Cloudflare",
      expiresAt: "2026-11-25",
      autoRenew: false,
    });
  for (const cert of snapshot.certs)
    Object.assign(cert, {
      cn: `${cert.id}.example.test`,
      sans: [],
      issuer: "Test CA",
      expiresAt: "2029-01-01",
      trusted: true,
    });
  for (const ai of snapshot.aiAssets)
    Object.assign(ai, { plan: "Test", monthlyUsd: 20, usagePct: 0, renewsAt: "", keyHint: "" });
  for (const secret of snapshot.secrets)
    Object.assign(secret, { kind: "account", value: "", hint: "", lastRotated: "" });
  for (const service of snapshot.services)
    Object.assign(service, {
      category: "custom",
      url: `https://${service.id}.example.test`,
      expiresAt: "2026-12-02",
    });
  Object.assign(snapshot.servers[0], {
    name: "生产主机",
    billing: { amount: 12, currency: "CNY", cycle: "month" },
    expiresAt: "2026-11-20",
  });
  Object.assign(snapshot.servers[1], { name: "待补费用主机", expiresAt: "2026-12-10" });
  Object.assign(snapshot.domains[0], {
    name: "example.test",
    billing: { amount: 120, currency: "USD", cycle: "year" },
    expiresAt: "2026-11-22",
  });
  Object.assign(snapshot.services[0], {
    name: "一次性测试服务",
    billing: { amount: 99, currency: "USD", cycle: "once" },
    expiresAt: "2026-12-03",
  });
  snapshot.links.push(
    { from: { kind: "mail", id: "mail-a" }, to: { kind: "server", id: "server-a" } },
    { from: { kind: "mail", id: "mail-a" }, to: { kind: "secret", id: "secret-a" } },
    { from: { kind: "mail", id: "mail-a" }, to: { kind: "ai", id: "ai-a" } },
    { from: { kind: "server", id: "server-a" }, to: { kind: "domain", id: "domain-a" } },
    { from: { kind: "mail", id: "missing-mail" }, to: { kind: "server", id: "server-a" } },
    { from: { kind: "document", id: "doc-b" }, to: { kind: "server", id: "server-a" } },
    { from: { kind: "phone", id: "phone-a" }, to: { kind: "ai", id: "ai-a" } },
  );
  documents[0].bindings = [{ kind: "server", id: "server-a" }];
  snapshot.phoneNumbers[0].subscriptionIds = ["ai-a"];
  for (const doc of documents)
    doc.content = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "合成验收正文" }] }],
    };
  return { snapshot, documents };
}

async function seed(context, theme, startView) {
  const { snapshot, documents } = fixture();
  await context.addInitScript(
    ({ snapshot, documents, theme, startView }) => {
      if (localStorage.getItem("feedback-e2e-seeded")) return;
      localStorage.setItem("feedback-e2e-seeded", "1");
      localStorage.setItem(
        "sinan-assets-v1",
        JSON.stringify({ version: 0, state: { ...snapshot, view: startView } }),
      );
      localStorage.setItem(
        "sinan-settings-v1",
        JSON.stringify({
          version: 0,
          state: {
            theme,
            language: "zh",
            motionMode: "off",
            sidebarCollapsed: false,
            assetLayout: "cards",
            quickStartHidden: true,
            usdToCny: 7.2,
          },
        }),
      );
      for (const doc of documents)
        localStorage.setItem("nanpad-doc:" + doc.id, JSON.stringify(doc));
    },
    { snapshot, documents, theme, startView },
  );
  return { snapshot, documents };
}

async function navigate(page, label, mobile = false) {
  if (mobile) {
    const openMenu = page.getByRole("button", { name: "打开菜单", exact: true });
    if (await openMenu.isVisible()) await openMenu.click();
  }
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  await navigation.waitFor();
  await expandNavigationGroups(page);
  await navigation.getByRole("button", { name: label, exact: true }).click();
}

async function waitReady(page) {
  await page.goto(url.href);
  await page.locator("[data-app-ready=true]").waitFor();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("main [role=status]")].some((node) =>
        node.textContent?.includes("正在加载"),
      ),
    { timeout: 20000 },
  );
}

async function assertNoNodeOverlap(page) {
  const boxes = await page.locator(".asset-graph-node").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.getAttribute("data-asset-id"),
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    }),
  );
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j];
      assert(
        a.right <= b.left + 1 ||
          b.right <= a.left + 1 ||
          a.bottom <= b.top + 1 ||
          b.bottom <= a.top + 1,
        `节点重叠：${a.id} / ${b.id}`,
      );
    }
}

async function assertEdgesAvoidCards(page) {
  const collisions = await page.evaluate(() => {
    const rects = [...document.querySelectorAll(".asset-graph-node")].map((node) => ({
      id: node.getAttribute("data-asset-id"),
      rect: node.getBoundingClientRect(),
    }));
    const hits = [];
    for (const path of document.querySelectorAll(".react-flow__edge-path")) {
      if (!(path instanceof SVGPathElement)) continue;
      const matrix = path.getScreenCTM();
      if (!matrix) continue;
      const length = path.getTotalLength();
      for (let index = 1; index < 24; index++) {
        const point = path.getPointAtLength((length * index) / 24);
        const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        for (const node of rects) {
          if (
            screen.x > node.rect.left + 4 &&
            screen.x < node.rect.right - 4 &&
            screen.y > node.rect.top + 4 &&
            screen.y < node.rect.bottom - 4
          ) {
            hits.push(node.id);
            break;
          }
        }
        if (hits.length > 8) return hits;
      }
    }
    return hits;
  });
  assert.deepEqual(collisions, [], "连线不应穿过资产卡片");
}

async function chooseByText(page, trigger, text) {
  await trigger.click();
  await page.getByRole("option").filter({ hasText: text }).first().click();
}

async function selectPickerAsset(picker, query, label) {
  const search = picker.getByLabel("搜索资产名称或类型", { exact: true });
  await search.fill(query);
  const row = picker.locator("div.h-56 > label").filter({ hasText: label }).first();
  await row.waitFor();
  await row.getByRole("checkbox").check();
  await search.fill("");
}

async function openRelationPicker(dialog) {
  await dialog.locator("summary").filter({ hasText: "关联已有资产" }).click();
  return dialog.getByRole("group", { name: "选择多个关联资产", exact: true });
}

async function runMain(browser, errors, results) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: "reduce",
    locale: "zh-CN",
  });
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    return target.origin === url.origin
      ? route.continue()
      : route.fulfill({ status: 204, body: "" });
  });
  await seed(context, "light", "renewals");
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => {
    if (event.type() === "error") errors.push(event.text());
  });
  await waitReady(page);

  await page.locator(".spend-summary").waitFor();
  const spend = page.locator(".spend-summary");
  const spendText = await spend.innerText();
  assert.match(spendText, /人民币/);
  assert.match(spendText, /美元/);
  assert.match(spendText, /30 天内到期/);
  assert.match(spendText, /未填写费用/);
  assert.match(spendText, /一次性/);
  const spendBox = await spend.boundingBox();
  assert(spendBox && spendBox.height < 280, `费用顶部仍过高：${spendBox?.height}`);
  const rateDetails = page.locator(".spend-rate-details");
  assert.equal(await rateDetails.getAttribute("open"), null);
  const monthlyHeadline = page.locator(".spend-summary .overview-headline");
  const beforeRate = await monthlyHeadline.innerText();
  await rateDetails.locator("summary").click();
  await rateDetails.getByLabel("美元兑人民币汇率", { exact: true }).waitFor();
  assert.equal(await monthlyHeadline.innerText(), beforeRate, "展开汇率不应改变金额折算");
  await page.screenshot({ path: `${outputDir}/screenshots/fees-compact-desktop.png` });

  await navigate(page, "资产关系图");
  await page
    .locator(".resource-graph-compact .asset-graph-node")
    .first()
    .waitFor({ timeout: 20000 });
  const initialNodes = await page.locator(".asset-graph-node").count();
  const initialEdges = await page.locator(".react-flow__edge-path").count();
  assert.equal(initialEdges, 7, "悬空关联不应进入图，旧文档 links 与号码订阅应保留");
  await assertNoNodeOverlap(page);
  await assertEdgesAvoidCards(page);
  await page.waitForFunction(() => {
    const transform = document.querySelector(".asset-graph .react-flow__viewport")?.style.transform;
    const match = transform?.match(/scale\(([^)]+)\)/);
    return Boolean(match && Number(match[1]) >= 0.54);
  });

  await page.locator('[data-asset-id="mail-a"] .graph-node-meta').click();
  await page.getByText(/直接关联 3 项/).waitFor();
  assert.equal(await page.locator('[data-connection-highlighted="true"]').count(), 4);
  const unrelatedOpacity = await page
    .locator(".react-flow__node")
    .filter({ has: page.locator('[data-asset-id="cert-a"]') })
    .evaluate((node) => Number(getComputedStyle(node).opacity));
  assert(unrelatedOpacity < 0.5, `无关节点应弱化，实际 ${unrelatedOpacity}`);
  await page.getByRole("button", { name: "清除资产高亮", exact: true }).click();

  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForTimeout(250);
  const viewport = page.locator(".asset-graph .react-flow__viewport");
  const viewportBefore = await viewport.getAttribute("style");
  await page.getByRole("button", { name: "管理资源关联", exact: true }).click();
  const panel = page.getByRole("region", { name: "管理资源关联", exact: true });
  await panel.getByRole("button", { name: "新增关联", exact: true }).click();
  await chooseByText(
    page,
    panel.getByRole("combobox", { name: "起始资源", exact: true }),
    "待补费用主机",
  );
  await chooseByText(
    page,
    panel.getByRole("combobox", { name: "目标资源", exact: true }),
    "domain-b",
  );
  await panel.getByRole("button", { name: "保存关联", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__edge-path").length === 8,
  );
  assert.equal(await viewport.getAttribute("style"), viewportBefore, "关系更新不应重置用户视口");
  assert.equal(await page.locator(".asset-graph-node").count(), initialNodes);
  const idsBefore = await page
    .locator(".react-flow__node")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")).sort());
  await page.getByRole("button", { name: "纵向布局", exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "横向布局", exact: true }).click();
  await page.waitForTimeout(250);
  assert.deepEqual(
    await page
      .locator(".react-flow__node")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")).sort()),
    idsBefore,
    "切换布局不能丢节点",
  );
  await page.getByRole("button", { name: "管理资源关联", exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outputDir}/screenshots/relations-focused-desktop.png` });

  let dialog;
  let picker;
  let state;
  await navigate(page, "服务器");
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.getByRole("button", { name: "编辑 生产主机", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "服务器", exact: true });
  picker = await openRelationPicker(dialog);
  assert.equal(
    await dialog.locator('[aria-label="已选关联"] > span').count(),
    4,
    "旧文档 links 应回显为已有关联",
  );
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
  assert(
    state.links.some(
      (link) =>
        [link.from, link.to].some((ref) => ref.kind === "document" && ref.id === "doc-b") &&
        [link.from, link.to].some((ref) => ref.kind === "server" && ref.id === "server-a"),
    ),
    "编辑资产不能丢失仅存于 links 的旧文档关系",
  );
  results.push({ check: "legacy-document-link-preserved" });

  await navigate(page, "AI 订阅");
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.getByRole("button", { name: "编辑 ai-a", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "编辑 AI 订阅", exact: true });
  picker = await openRelationPicker(dialog);
  await dialog.getByRole("button", { name: "移除关联 phone-a", exact: true }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
  assert.equal(
    state.phoneNumbers.find((phone) => phone.id === "phone-a")?.subscriptionIds.includes("ai-a"),
    false,
    "移除号码关联后不能由 subscriptionIds 复活",
  );
  results.push({ check: "ai-phone-subscription-cleared" });

  await navigate(page, "U 卡与支付卡");
  await page.getByRole("button", { name: "添加支付卡", exact: true }).first().click();
  dialog = page.getByRole("dialog", { name: "添加支付卡", exact: true });
  await dialog.getByLabel("卡片名称", { exact: true }).fill("验收支付卡");
  await dialog.getByLabel("发卡服务商", { exact: true }).fill("Test Bank");
  picker = await openRelationPicker(dialog);
  await selectPickerAsset(picker, "mail-a", "mail-a@example.test");
  await dialog.getByRole("button", { name: "保存卡片", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
  const cardAsset = state.services.find((asset) => asset.name === "验收支付卡");
  assert.ok(cardAsset);
  assert(
    state.links.some(
      (link) =>
        [link.from, link.to].some((ref) => ref.kind === "service" && ref.id === cardAsset.id) &&
        [link.from, link.to].some((ref) => ref.kind === "mail" && ref.id === "mail-a"),
    ),
    "支付卡编辑器也应复用统一关联保存",
  );
  results.push({ check: "card-editor-relations" });

  await navigate(page, "服务器");
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "服务器", exact: true });
  await dialog.getByLabel("主机名", { exact: true }).fill("验收服务器");
  await dialog.getByLabel("IP / Host", { exact: true }).fill("192.0.2.55");
  picker = await openRelationPicker(dialog);
  await selectPickerAsset(picker, "mail-a", "mail-a@example.test");
  await selectPickerAsset(picker, "example.test", "example.test");
  await selectPickerAsset(picker, "secret-a", "secret-a");
  await selectPickerAsset(picker, "doc-a", "doc-a");
  assert.equal(await dialog.locator('[aria-label="已选关联"] > span').count(), 4);
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
  const created = state.servers.find((server) => server.name === "验收服务器");
  assert.ok(created);
  const related = state.links.filter((link) =>
    [link.from, link.to].some((ref) => ref.kind === "server" && ref.id === created.id),
  );
  assert.equal(related.length, 3, "服务器应关联邮箱、网站账号和域名");
  const domainLink = state.links.find(
    (link) =>
      [link.from, link.to].some((ref) => ref.kind === "domain" && ref.id === "domain-a") &&
      [link.from, link.to].some((ref) => ref.kind === "server" && ref.id === created.id),
  );
  assert.ok(domainLink, "域名关系应保存");
  const doc = await page.evaluate(() => JSON.parse(localStorage.getItem("nanpad-doc:doc-a")));
  assert(
    doc.bindings.some((ref) => ref.kind === "server" && ref.id === created.id),
    "文档绑定应保存",
  );
  results.push({
    check: "composer-create-with-links",
    owner: created.id,
    links: related.length + 1,
  });

  const beforeCancel = state.servers.length;
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "服务器", exact: true });
  await dialog.getByLabel("主机名", { exact: true }).fill("取消不写入");
  await dialog.getByLabel("IP / Host", { exact: true }).fill("192.0.2.56");
  picker = await openRelationPicker(dialog);
  await selectPickerAsset(picker, "mail-a", "mail-a@example.test");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
  assert.equal(state.servers.length, beforeCancel, "取消不能写入资产");
  assert(!state.servers.some((server) => server.name === "取消不写入"));

  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.__failNextAssetWrite = true;
    Storage.prototype.setItem = function (key, value) {
      if (window.__failNextAssetWrite && key === "sinan-assets-v1") {
        window.__failNextAssetWrite = false;
        throw new Error("synthetic asset write failure");
      }
      return original.call(this, key, value);
    };
  });
  const beforeFailure = state.servers.length;
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "服务器", exact: true });
  await dialog.getByLabel("主机名", { exact: true }).fill("失败回滚服务器");
  await dialog.getByLabel("IP / Host", { exact: true }).fill("192.0.2.57");
  picker = await openRelationPicker(dialog);
  await selectPickerAsset(picker, "mail-a", "mail-a@example.test");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await page
    .getByText(/保存失败，未写入关联，表单内容已保留/)
    .first()
    .waitFor({ timeout: 15000 });
  assert.equal(await dialog.getByLabel("主机名", { exact: true }).inputValue(), "失败回滚服务器");
  assert.equal(await dialog.locator('[aria-label="已选关联"] > span').count(), 1);
  await page.screenshot({
    path: `${outputDir}/screenshots/relations-failure-preserved.png`,
  });
  await page.waitForTimeout(700);
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
  assert.equal(state.servers.length, beforeFailure, "保存失败应回滚资产");
  assert(!state.servers.some((server) => server.name === "失败回滚服务器"));
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  results.push({ check: "composer-cancel-and-failure-rollback" });

  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.getByRole("button", { name: "编辑 验收服务器", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "服务器", exact: true });
  picker = await openRelationPicker(dialog);
  assert.equal(
    await dialog.locator('[aria-label="已选关联"] > span').count(),
    4,
    "编辑应回显已有关联",
  );
  await dialog.getByRole("button", { name: "移除关联 example.test", exact: true }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
  assert(
    !state.links.some(
      (link) =>
        [link.from, link.to].some((ref) => ref.kind === "domain" && ref.id === "domain-a") &&
        [link.from, link.to].some((ref) => ref.kind === "server" && ref.id === created.id),
    ),
    "移除的关联应删除",
  );

  await page.reload();
  await page.locator("[data-app-ready=true]").waitFor();
  await navigate(page, "服务器");
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.getByRole("button", { name: "编辑 验收服务器", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "服务器", exact: true });
  picker = await openRelationPicker(dialog);
  assert.equal(
    await dialog.locator('[aria-label="已选关联"] > span').count(),
    3,
    "重启后应保留剩余关联",
  );
  await page.screenshot({ path: `${outputDir}/screenshots/relations-edit-persisted.png` });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  results.push({ check: "edit-persistence", selectedAfterReload: 3 });
  await context.close();
}

async function runMobile(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "zh-CN",
  });
  await seed(context, "dark", "renewals");
  const page = await context.newPage();
  await waitReady(page);
  await page.locator(".spend-summary").waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
    false,
  );
  await page.locator(".spend-rate-details summary").click();
  const mobileSpendBox = await page.locator(".spend-summary").boundingBox();
  assert(
    mobileSpendBox && mobileSpendBox.height < 430,
    `移动端费用区仍过高：${mobileSpendBox?.height}`,
  );
  await page.screenshot({ path: `${outputDir}/screenshots/fees-compact-mobile-dark.png` });
  await navigate(page, "资产关系图", true);
  await page
    .locator(".resource-graph-compact .asset-graph-node")
    .first()
    .waitFor({ timeout: 20000 });
  await page.locator('[data-asset-id="mail-a"] .graph-node-meta').click();
  await page.getByText(/直接关联 3 项/).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
    false,
  );
  await page.screenshot({ path: `${outputDir}/screenshots/relations-focused-mobile-dark.png` });
  await context.close();
}

const browser = await chromium.launch();
const errors = [],
  results = [];
try {
  await runMain(browser, errors, results);
  await runMobile(browser);
  assert.deepEqual(errors, [], `浏览器错误：${errors.join(" | ")}`);
  const receipt = { passed: true, url: url.href, results, errors, screenshots: true };
  await writeFile(`${outputDir}/browser-receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  const receipt = {
    passed: false,
    url: url.href,
    results,
    errors,
    failure: error instanceof Error ? error.stack : String(error),
  };
  await writeFile(`${outputDir}/browser-receipt.json`, JSON.stringify(receipt, null, 2));
  console.error(JSON.stringify(receipt, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
