import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 用正式主进程和本机合成模型走完整链路，隔离账号、文档、监控和模型配置。
const packaged = process.argv.slice(2).find((arg) => /\.exe$/i.test(arg));
const expectedVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const directory = await mkdtemp(join(tmpdir(), "zhiyu-workspace-v150-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
if (packaged) delete env.NANPAD_TEST_DATA_DIR;
const requests = [];
const errors = [];
const checks = [];
const fixture = {
  id: "secret-packaged-account",
  name: "打包回归账号",
  username: "private-fixture-user@example.test",
  password: "synthetic-private-password-v150",
  url: "https://private-fixture.example.test/login",
};
let scenario;
let instance;
let page;

function sse(response, chunk) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [chunk] })}\n\ndata: [DONE]\n\n`);
}
function callTool(response, name, args) {
  sse(response, {
    delta: {
      tool_calls: [
        {
          index: 0,
          id: `call-${requests.length}`,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    finish_reason: "tool_calls",
  });
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, authorization: request.headers.authorization, body });
    assert.equal(body.model, "packaged-fixture-model");
    assert.ok(scenario, "每次请求都必须对应明确的合成场景");
    const calls = body.messages.filter((message) => message.role === "tool");
    // 文档编辑先通过真实 get_document 工具读取原文，再生成修改建议。
    if (scenario.name === "propose_document_edit" && calls.length === 0) {
      callTool(response, "get_document", { documentId: scenario.args.documentId });
    } else if (calls.length === (scenario.name === "propose_document_edit" ? 1 : 0)) {
      if (scenario.name === "propose_document_edit")
        assert.ok(calls[0].content.includes(scenario.args.find), "文档工具应返回真实待修改原文");
      callTool(response, scenario.name, scenario.args);
    } else {
      sse(response, {
        delta: { content: "已生成建议，请在本机审阅后应用。" },
        finish_reason: "stop",
      });
    }
  } catch (error) {
    errors.push(`合成模型服务：${error.message}`);
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});

async function propose(name, args) {
  scenario = { name, args };
  const result = await page.evaluate(
    ({ id, documentContent }) =>
      window.sinan.agent.run({
        id,
        question: "请根据本机回归场景生成可审阅的资料修改建议。",
        allowMailboxChecks: false,
        allowDocumentContent: documentContent,
        allowWorkspaceChanges: true,
        history: [],
      }),
    { id: `integration-${requests.length}`, documentContent: name === "propose_document_edit" },
  );
  assert.equal(result.proposals.length, 1, JSON.stringify(result));
  assert.ok(result.tools.includes(name));
  return result.proposals[0];
}
const apply = (id) =>
  page.evaluate((proposalId) => window.sinan.agent.applyProposal(proposalId), id);
const getDocument = (id) =>
  page.evaluate((documentId) => window.sinan.documents.get(documentId), id);
const getSnapshot = () => page.evaluate(async () => (await window.sinan.store.load()).state);
const account = (snapshot) => snapshot.secrets.find((entry) => entry.id === fixture.id);
function textContent(document) {
  const collect = (node) => node.text ?? (node.content ?? []).map(collect).join("\n");
  return collect(document.content);
}
async function verifyGraphRouting() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.locator(".react-flow__edge-path").count(), 2);
  const collisions = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".asset-graph-node")].map((node) => ({
      id: node.dataset.assetId,
      box: node.getBoundingClientRect(),
    }));
    const frame = document.querySelector(".asset-graph").getBoundingClientRect();
    const collisions = [];
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
      if (length <= 0) collisions.push("关系没有生成可见路径");
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
  assert.deepEqual(collisions, [], "同类账号和文档的连线不能穿过卡片内部或超出画布");
}

try {
  await mkdir("screenshots", { recursive: true });
  await writeFile(
    join(directory, "local-usage.json"),
    JSON.stringify({ version: 1, enabled: false, checkpoints: [], events: [], records: [] }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  instance = await electron.launch({
    ...(packaged ? { executablePath: resolve(packaged) } : {}),
    args: packaged ? [`--user-data-dir=${directory}`] : [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  assert.equal(await instance.evaluate(({ app }) => app.isPackaged), Boolean(packaged));
  const version = await instance.evaluate(({ app }) => app.getVersion());
  assert.equal(version, expectedVersion);
  page = await instance.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(async (fixture) => {
    await window.sinan.vault.set(`account:${fixture.id}`, {
      kind: "account",
      username: fixture.username,
      password: fixture.password,
      url: fixture.url,
    });
    const snapshot = await window.sinan.store.load();
    const now = new Date().toISOString();
    snapshot.state.secrets = [
      {
        id: fixture.id,
        name: fixture.name,
        kind: "account",
        hint: "",
        value: "",
        notes: "",
        tags: [],
        status: "online",
        lastRotated: now,
      },
      {
        id: "secret-packaged-backup",
        name: "回归备用账号",
        kind: "account",
        hint: "",
        value: "",
        notes: "",
        tags: [],
        status: "online",
        lastRotated: now,
      },
    ];
    snapshot.state.secretFolders = [];
    await window.sinan.store.save(snapshot);
  }, fixture);
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();

  const sidebar = page.locator("aside.app-sidebar:visible");
  assert.equal(await sidebar.getByRole("button", { name: "关系图", exact: true }).count(), 0);
  assert.equal(await sidebar.getByRole("button", { name: "设置", exact: true }).count(), 0);
  const titlebar = page.locator("header.app-titlebar");
  const settings = titlebar.getByRole("button", { name: "系统设置…", exact: true });
  const settingsBox = await settings.boundingBox();
  const titlebarBox = await titlebar.boundingBox();
  assert.ok(
    settingsBox &&
      titlebarBox &&
      settingsBox.y >= titlebarBox.y &&
      settingsBox.y + settingsBox.height <= titlebarBox.y + titlebarBox.height,
    "设置按钮保留在顶部标题栏",
  );
  await settings.click();
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "detached" });
  checks.push("侧栏不显示关系图和设置，顶部原位置设置入口可打开");
  async function openAllResourceGraph() {
    await navigateDesktop(page, "标签");
    await page
      .getByRole("group", { name: "显示方式", exact: true })
      .getByRole("button", { name: "关系图", exact: true })
      .click();
    await page.getByRole("button", { name: "全部资源", exact: true }).click();
    await page.locator(".asset-graph").waitFor();
  }

  await sidebar.getByRole("button", { name: "文档资产", exact: true }).click();
  await page.getByRole("button", { name: "添加文档", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "导入 Markdown", exact: true }).click();
  await (
    await chooser
  ).setFiles([
    { name: "打包回归.md", mimeType: "text/markdown", buffer: Buffer.from("# 打包回归\n\n旧地址") },
  ]);
  await page
    .getByRole("region", { name: "文档正文", exact: true })
    .getByText("旧地址", { exact: true })
    .waitFor();
  const documents = await page.evaluate(() => window.sinan.documents.list());
  const documentId = documents.find((document) => document.title === "打包回归")?.id;
  assert.ok(documentId);
  checks.push("文档加号菜单打开真实文件选择器并导入 Markdown");

  await openAllResourceGraph();
  await page.locator(`.asset-graph-node[data-asset-id="${fixture.id}"]`).waitFor();
  await page.locator(`.asset-graph-node[data-asset-id="${documentId}"]`).waitFor();
  assert.equal(await page.locator(".react-flow__edge").count(), 0);
  await page.screenshot({ path: "screenshots/workspace-v150-graph-before.png" });
  checks.push("标签页现有关系图视图可查看全部资源，展示真实账号与文档且没有虚构连线");

  await navigateDesktop(page, "用量记录");
  await page.getByRole("button", { name: "采集与监控", exact: true }).click();
  const monitor = page.getByRole("dialog", { name: "采集与监控", exact: true });
  await monitor.waitFor();
  await monitor.getByRole("button", { name: "关闭监控详情", exact: true }).click();
  await monitor.waitFor({ state: "detached" });
  checks.push("采集与监控独立入口可打开和关闭");

  await page.evaluate(async (baseUrl) => {
    const config = await window.sinan.agent.config();
    await window.sinan.agent.saveConfig({
      ...config,
      baseUrl,
      model: "packaged-fixture-model",
      clearApiKey: true,
      topK: 6,
      maxSteps: 4,
      maxTokens: 2048,
      embeddingEnabled: false,
    });
    window.__workspaceAssetEvents = [];
    window.__workspaceDocumentEvents = 0;
    window.sinan.store.onChanged((event) => window.__workspaceAssetEvents.push(event));
    window.sinan.documents.onChanged(() => window.__workspaceDocumentEvents++);
  }, `http://127.0.0.1:${server.address().port}/v1`);
  const credential = await page.evaluate(
    (id) => window.sinan.vault.get(`account:${id}`),
    fixture.id,
  );
  const original = await getDocument(documentId);
  const edit = await propose("propose_document_edit", {
    documentId,
    find: "旧地址",
    replace: "新地址",
    reason: "合成文档迁移地址。",
  });
  assert.deepEqual(await getDocument(documentId), original, "生成提案不能提前修改文档");
  const edited = await apply(edit.id);
  assert.match(textContent(edited.document), /新地址/);
  assert.match(textContent(await getDocument(documentId)), /新地址/);
  await page.waitForFunction(() => window.__workspaceDocumentEvents > 0);
  await assert.rejects(apply(edit.id), /已经应用/);
  checks.push("真实 SDK 工具调用只生成提案，应用 IPC 保存文档并广播事件，重复应用拒绝");

  const stale = await propose("propose_document_edit", {
    documentId,
    find: "新地址",
    replace: "旧提案的地址",
    reason: "验证旧提案冲突保护。",
  });
  const updated = await page.evaluate(async (id) => {
    const document = await window.sinan.documents.get(id);
    document.content = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "用户后来写入的地址" }] }],
    };
    return window.sinan.documents.save(document);
  }, documentId);
  await assert.rejects(apply(stale.id), /文档已在其他位置修改/);
  assert.deepEqual(await getDocument(documentId), updated);
  await page.evaluate((id) => window.sinan.agent.discardProposal(id), stale.id);
  checks.push("文档 revision 冲突拒绝旧建议，保留用户后续编辑");

  const accountArgs = {
    assetId: fixture.id,
    patch: { name: "打包回归主账号", tags: ["回归项目"] },
    reason: "整理合成账号名称和分组。",
  };
  const discarded = await propose("propose_account_edit", accountArgs);
  assert.equal(account(await getSnapshot()).name, fixture.name);
  assert.equal(
    await page.evaluate((id) => window.sinan.agent.discardProposal(id), discarded.id),
    true,
  );
  await assert.rejects(apply(discarded.id), /已忽略/);
  assert.equal(account(await getSnapshot()).name, fixture.name);
  const accountEdit = await propose("propose_account_edit", accountArgs);
  const before = await getSnapshot();
  const applied = await apply(accountEdit.id);
  assert.deepEqual(applied.before, before);
  assert.equal(account(applied.before).name, fixture.name);
  assert.equal(account(applied.snapshot).name, accountArgs.patch.name);
  assert.deepEqual(account(applied.snapshot).tags, accountArgs.patch.tags);
  await page.waitForFunction(() => window.__workspaceAssetEvents.length === 1);
  const event = await page.evaluate(() => window.__workspaceAssetEvents[0]);
  assert.deepEqual(event.before, applied.before);
  assert.deepEqual(event.snapshot, applied.snapshot);
  assert.deepEqual(await getSnapshot(), applied.snapshot);
  assert.deepEqual(
    await page.evaluate((id) => window.sinan.vault.get(`account:${id}`), fixture.id),
    credential,
  );
  checks.push("忽略 IPC 不写入；账号应用结果与资产事件包含准确 before 和 snapshot，凭据不变");

  const link = await propose("propose_asset_link", {
    from: { kind: "secret", id: fixture.id },
    to: { kind: "secret", id: "secret-packaged-backup" },
    reason: "主账号和备用账号属于同一合成项目。",
  });
  await apply(link.id);
  const binding = await propose("propose_document_binding", {
    documentId,
    to: { kind: "secret", id: fixture.id },
    reason: "文档说明此合成账号的使用方式。",
  });
  await apply(binding.id);
  assert.deepEqual((await getDocument(documentId)).bindings, [{ kind: "secret", id: fixture.id }]);
  assert.deepEqual((await getSnapshot()).links, [
    {
      from: { kind: "secret", id: fixture.id },
      to: { kind: "secret", id: "secret-packaged-backup" },
    },
  ]);
  await openAllResourceGraph();
  await page
    .locator(`.asset-graph-node[data-asset-id="${fixture.id}"]`)
    .getByText(accountArgs.patch.name, { exact: true })
    .waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 2);
  await page.screenshot({
    path: `screenshots/workspace-v150-${packaged ? "packaged" : "desktop"}.png`,
  });
  await verifyGraphRouting();
  checks.push("提案建立账号关联和文档绑定，关系图同步出现两条真实连线");

  assert.equal(requests.length, 14);
  assert.ok(requests.every((request) => request.authorization === "Bearer local-no-key"));
  const sent = JSON.stringify(requests);
  for (const sensitive of [fixture.username, fixture.password, fixture.url])
    assert.equal(sent.includes(sensitive), false, "模型请求不能包含加密凭据");
  const usage = JSON.parse(await readFile(join(directory, "local-usage.json"), "utf8"));
  assert.equal(usage.enabled, false);
  assert.equal(usage.records.length, 0);
  assert.deepEqual(errors, []);
  checks.push("没有真实 API Key、监控扫描、凭据外传或页面错误");
  console.log(
    JSON.stringify(
      {
        ok: true,
        packaged: Boolean(packaged),
        version,
        modelRequests: requests.length,
        checks,
        pageerrors: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: "screenshots/workspace-v150-failure.png" }).catch(() => {});
  throw error;
} finally {
  if (instance) await instance.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
