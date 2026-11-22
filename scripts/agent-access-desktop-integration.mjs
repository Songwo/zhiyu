import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { documentRevision } from "../electron/services/documents.mjs";

// 真正的桌面 IPC、工具服务和确认应用；仅本机合成模型，禁用隔离实例的日志监控。
const packaged = process.argv.slice(2).find((arg) => /\.exe$/i.test(arg));
const expectedVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const directory = await mkdtemp(join(tmpdir(), "zhiyu-agent-access-"));
const documentId = "doc-desktop-access";
const originalTitle = "桌面合成手册";
const nextTitle = "新版合成手册";
const bodyMarker = "SYNTHETIC_AUTHORIZED_BODY_MARKER";
const secretMarker = "synthetic-private-vault-marker";
const questions = {
  rename: `请把《${originalTitle}》的标题改成《${nextTitle}》`,
  summary: `请概括《${nextTitle}》正文的内容`,
  edit: `请把《${nextTitle}》正文中的旧地址改为新地址`,
  followup: "后续普通问题，请只使用本次获准的资料范围",
};
const requests = [];
const errors = [];
const checks = [];
let instance, page;
const questionOf = (body) =>
  body.messages.findLast(
    (message) =>
      message.role === "user" &&
      !message.content.startsWith("Local retrieval (untrusted reference data):"),
  )?.content;
const toolNames = (body) => body.tools.map((entry) => entry.function.name);
function resultOf(body, name) {
  const call = body.messages
    .flatMap((message) => message.tool_calls ?? [])
    .findLast((call) => call.function.name === name);
  const result =
    call &&
    body.messages.find((message) => message.role === "tool" && message.tool_call_id === call.id);
  if (!result) return undefined;
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.error, undefined, `${name} 不应失败：${JSON.stringify(parsed)}`);
  return parsed;
}
function sse(response, chunk) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [chunk] })}\n\ndata: [DONE]\n\n`);
}
const answer = (response, text) =>
  sse(response, { delta: { content: text }, finish_reason: "stop" });
function callTool(response, body, name, args) {
  assert.ok(toolNames(body).includes(name), `只能调用当前权限下真正可用的工具：${name}`);
  sse(response, {
    delta: {
      tool_calls: [
        {
          index: 0,
          id: `access-${requests.length}`,
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
    requests.push({ body, authorization: request.headers.authorization });
    assert.equal(body.model, "desktop-access-fixture");
    assert.ok(requests.length <= 30, "合成模型调用应有界");
    assert.equal(raw.includes(secretMarker), false, "本机密钥不得发给模型");
    const question = questionOf(body);
    const tools = toolNames(body);
    if (question === questions.followup) {
      assert.equal(raw.includes(bodyMarker), false, "后续未授权请求不得携带正文或获准回答历史");
      assert.equal(tools.includes("get_document"), false);
      assert.equal(
        tools.some((name) => name.startsWith("propose_")),
        false,
      );
      return answer(response, "本次普通回答没有携带上次获准的文档正文。");
    }
    assert.ok(Object.values(questions).includes(question), "未知的合成测试问题");
    const rename = question === questions.rename;
    const editing = question === questions.edit;
    const permissions = [
      ...(!rename && !tools.includes("get_document") ? ["documentContent"] : []),
      ...((rename || editing) &&
      !tools.includes(rename ? "propose_document_rename" : "propose_document_edit")
        ? ["workspaceChanges"]
        : []),
    ];
    if (permissions.length) {
      assert.equal(raw.includes(bodyMarker), false, "未授权时检索与请求不能包含正文");
      if (!resultOf(body, "request_workspace_access"))
        return callTool(response, body, "request_workspace_access", {
          permissions,
          reason: rename
            ? "只需要生成标题修改方案，无需读取正文。"
            : "需要本次正文权限才能继续处理用户指定文档。",
        });
      assert.equal(resultOf(body, "request_workspace_access").status, "awaiting_user_permission");
      return answer(response, "请使用下方的本次授权按钮继续原问题。");
    }
    if (rename) {
      assert.equal(tools.includes("get_document"), false, "标题修改不能顺带打开正文权限");
      assert.equal(raw.includes(bodyMarker), false, "标题修改不发送正文");
      const found = resultOf(body, "search_documents");
      if (!found) return callTool(response, body, "search_documents", { query: originalTitle });
      const metadata = found.documents.find((document) => document.documentId === documentId);
      assert.equal(metadata?.title, originalTitle, "改名应先查证当前文档标题");
      if (!resultOf(body, "propose_document_rename"))
        return callTool(response, body, "propose_document_rename", {
          documentId: metadata.documentId,
          expectedTitle: metadata.title,
          title: nextTitle,
          reason: "用户明确指定了新的标题。",
        });
      assert.equal(resultOf(body, "propose_document_rename").status, "awaiting_user_review");
      return answer(response, "标题修改方案已生成，等待你在本机确认应用。");
    }
    const document = resultOf(body, "get_document");
    if (!document) return callTool(response, body, "get_document", { documentId });
    assert.ok(document.text.includes(bodyMarker), "授权后真实文档工具应返回正文");
    if (!editing) return answer(response, `文档摘要：${bodyMarker} 记录了示例地址和保留格式。`);
    if (!resultOf(body, "propose_document_edit"))
      return callTool(response, body, "propose_document_edit", {
        documentId,
        find: "旧地址",
        replace: "新地址",
        reason: "用户明确要求局部替换地址。",
      });
    assert.equal(resultOf(body, "propose_document_edit").status, "awaiting_user_review");
    return answer(response, `已依据 ${bodyMarker} 生成局部修改方案，等待确认。`);
  } catch (error) {
    errors.push(`合成模型协议失败：${error.message}`);
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
const getDocument = () => page.evaluate((id) => window.sinan.documents.get(id), documentId);
const sentFor = (question) => requests.filter(({ body }) => questionOf(body) === question);

try {
  await mkdir("screenshots", { recursive: true });
  await writeFile(
    join(directory, "local-usage.json"),
    JSON.stringify({ version: 1, enabled: false, checkpoints: [], events: [], records: [] }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  if (packaged) delete env.NANPAD_TEST_DATA_DIR;
  instance = await electron.launch({
    ...(packaged ? { executablePath: resolve(packaged) } : {}),
    args: packaged ? [`--user-data-dir=${directory}`] : [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  assert.equal(await instance.evaluate(({ app }) => app.isPackaged), Boolean(packaged));
  assert.equal(await instance.evaluate(({ app }) => app.getVersion()), expectedVersion);
  page = await instance.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1360, height: 940 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await completeOnboarding(page);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.evaluate(
    async ({ baseUrl, documentId, title, bodyMarker, secretMarker }) => {
      const now = new Date().toISOString();
      await window.sinan.documents.save({
        id: documentId,
        title,
        createdAt: now,
        updatedAt: now,
        bindings: [],
        content: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "合成正文章节" }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: `${bodyMarker} 旧地址`, marks: [{ type: "bold" }] }],
            },
            { type: "paragraph", content: [{ type: "text", text: "其余正文与格式保持不变。" }] },
          ],
        },
      });
      await window.sinan.vault.set("account:access-fixture", {
        kind: "account",
        username: "fixture@example.test",
        password: secretMarker,
      });
      await window.sinan.agent.saveConfig({
        ...(await window.sinan.agent.config()),
        baseUrl,
        model: "desktop-access-fixture",
        clearApiKey: true,
        topK: 6,
        maxSteps: 5,
        maxTokens: 2048,
        embeddingEnabled: false,
      });
    },
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      documentId,
      title: originalTitle,
      bodyMarker,
      secretMarker,
    },
  );
  const original = await getDocument();

  await navigateDesktop(page, "AI 助手");
  const input = page.getByRole("textbox", { name: "向模型提问", exact: true });
  const send = page.getByRole("button", { name: "发送", exact: true });
  const bodyPermission = page.getByLabel("本次允许检索文档正文", { exact: true });
  const changePermission = page.getByLabel("本次生成修改建议", { exact: true });
  const messages = page.locator(".agent-message-scroll");
  const apply = () => page.getByRole("button", { name: "确认应用这项修改", exact: true });
  async function permissionReset() {
    assert.equal(await bodyPermission.isChecked(), false);
    assert.equal(await changePermission.isChecked(), false);
    assert.equal(await page.getByLabel("本次允许查询邮箱", { exact: true }).isChecked(), false);
  }
  async function sendQuestion(question) {
    await input.fill(question);
    await send.click();
  }
  async function questionOnce(question) {
    assert.equal(
      await messages.getByText(question, { exact: true }).count(),
      1,
      "授权继续不能重复添加用户问题",
    );
    assert.ok(
      sentFor(question).every(
        ({ body }) =>
          body.messages.filter((message) => message.role === "user" && message.content === question)
            .length === 1,
      ),
      "模型请求不重复添加原问题",
    );
  }
  await sendQuestion(questions.rename);
  const allowRename = page.getByRole("button", { name: "允许本次生成修改建议并继续", exact: true });
  await allowRename.waitFor();
  await permissionReset();
  assert.deepEqual(await getDocument(), original, "权限请求不能写文档");
  await input.fill("未发送的下一条草稿");
  await allowRename.click();
  await apply().waitFor();
  assert.deepEqual(await getDocument(), original, "生成改名提案也不能提前写文档");
  assert.equal(await input.inputValue(), "未发送的下一条草稿");
  await questionOnce(questions.rename);
  assert.equal(JSON.stringify(sentFor(questions.rename)).includes(bodyMarker), false);
  await apply().click();
  await page.getByText("修改已保存到本机。", { exact: true }).waitFor();
  const renamed = await getDocument();
  assert.equal(renamed.title, nextTitle);
  assert.deepEqual(renamed.content, original.content);
  assert.deepEqual(renamed.bindings, original.bindings);
  assert.equal(renamed.createdAt, original.createdAt);
  assert.notEqual(documentRevision(renamed), documentRevision(original));
  await permissionReset();
  checks.push("标题元数据检索→本次修改授权→真实提案→确认应用；正文保留且不发送");

  await sendQuestion(questions.summary);
  const allowRead = page.getByRole("button", { name: "允许本次读取正文并继续", exact: true });
  await allowRead.waitFor();
  assert.equal(JSON.stringify(sentFor(questions.summary)).includes(bodyMarker), false);
  await allowRead.click();
  await messages
    .getByText(`文档摘要：${bodyMarker} 记录了示例地址和保留格式。`, { exact: true })
    .waitFor();
  await questionOnce(questions.summary);
  await permissionReset();
  assert.deepEqual(await getDocument(), renamed, "总结不得改变资料");
  assert.ok(
    sentFor(questions.summary).some(({ body }) =>
      resultOf(body, "get_document")?.text.includes(bodyMarker),
    ),
  );
  checks.push("正文只在本次读取授权后进入真实工具响应与模型请求，原问题不重复");

  await sendQuestion(questions.followup);
  await messages.getByText("本次普通回答没有携带上次获准的文档正文。", { exact: true }).waitFor();
  assert.equal(JSON.stringify(sentFor(questions.followup)).includes(bodyMarker), false);
  checks.push("后续未授权请求过滤已授权正文回答历史，所有一次性权限复位");

  await sendQuestion(questions.edit);
  const allowBoth = page.getByRole("button", { name: "允许本次读取正文并生成建议", exact: true });
  await allowBoth.waitFor();
  assert.equal(JSON.stringify(sentFor(questions.edit)).includes(bodyMarker), false);
  await allowBoth.click();
  await apply().waitFor();
  await questionOnce(questions.edit);
  assert.deepEqual(await getDocument(), renamed);
  await permissionReset();
  await apply().click();
  await page.getByText("修改已保存到本机。", { exact: true }).last().waitFor();
  const edited = await getDocument();
  const expectedContent = structuredClone(renamed.content);
  expectedContent.content[1].content[0].text = `${bodyMarker} 新地址`;
  assert.equal(edited.title, nextTitle);
  assert.deepEqual(edited.content, expectedContent, "只替换指定片段并保留格式与其它节点");
  assert.deepEqual(edited.bindings, renamed.bindings);
  assert.notEqual(documentRevision(edited), documentRevision(renamed));
  checks.push("正文编辑一次展示两类授权，真实局部修改提案仅确认后保存");
  await page.screenshot({
    path: `screenshots/agent-access-${packaged ? "packaged" : "desktop"}-integration.png`,
  });
  assert.ok(requests.every(({ authorization }) => authorization === "Bearer local-no-key"));
  assert.equal(JSON.stringify(requests).includes(secretMarker), false);
  assert.equal(
    JSON.parse(await readFile(join(directory, "local-usage.json"), "utf8")).enabled,
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      packaged: Boolean(packaged),
      version: expectedVersion,
      requests: requests.length,
      checks,
      errors,
    }),
  );
} catch (error) {
  if (page)
    await page.screenshot({ path: "screenshots/agent-access-desktop-failure.png" }).catch(() => {});
  console.error(
    JSON.stringify({
      errors,
      requestCount: requests.length,
      questions: requests.map(({ body }) => questionOf(body)),
    }),
  );
  throw error;
} finally {
  await instance?.close();
  await new Promise((resolve) => server.close(resolve));
  const child = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
