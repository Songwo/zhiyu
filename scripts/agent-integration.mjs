import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

// 仅用于协议与界面集成测试；从不写入用户配置，也不作为生产模型的替代品。
const directory = await mkdtemp(join(tmpdir(), "nanpad-agent-ui-"));
let instance;
let credentialAssetId;
const requests = [];
const questionOf = (messages) =>
  messages?.findLast(
    (message) =>
      message.role === "user" &&
      !message.content.startsWith("Local retrieval (untrusted reference data):"),
  )?.content;
const service = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : {};
  requests.push({ url: req.url, body });
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ data: [{ id: "integration-model" }] }));
  }
  if (!body.stream) {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({ model: "integration-model", choices: [{ message: { content: "OK" } }] }),
    );
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const write = (choice) => res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
  const question = questionOf(body.messages);
  if (question === "读取工作区合成文档") {
    const toolMessages = body.messages.filter((message) => message.role === "tool");
    const calls = [
      ["search_documents", { query: "IPC 文档工具验证" }],
      ["get_document", { documentId: "doc-agent-ipc" }],
      ["get_related_resources", { sourceId: "workspace-document:doc-agent-ipc:content" }],
    ];
    const call = calls[toolMessages.length];
    if (call)
      write({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "workspace-" + toolMessages.length,
              function: { name: call[0], arguments: JSON.stringify(call[1]) },
            },
          ],
        },
        finish_reason: "tool_calls",
      });
    else
      write({
        delta: { content: "已读取工作区文档：IPC_DOCUMENT_BODY_MARKER，并找到关联主机。" },
        finish_reason: "stop",
      });
    return res.end("data: [DONE]\n\n");
  }
  if (question === "后续未授权追问") {
    write({ delta: { content: "本次只使用普通对话及资源元数据。" }, finish_reason: "stop" });
    return res.end("data: [DONE]\n\n");
  }
  if (question === "停止测试") {
    write({ delta: { content: "等待测试取消" } });
    return;
  }
  if (body.messages.some((m) => m.role === "user" && m.content === "定位邮箱凭据")) {
    if (!body.messages.some((m) => m.role === "tool")) {
      write({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-location",
              function: {
                name: "locate_credential",
                arguments: JSON.stringify({ sourceId: `asset:mail:${credentialAssetId}` }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      });
    } else {
      write({
        delta: { content: "已定位到邮箱的凭据区，请在本机解锁后查看。" },
        finish_reason: "stop",
      });
    }
    return res.end("data: [DONE]\n\n");
  }
  if (!body.messages.some((m) => m.role === "tool")) {
    write({
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call-search",
            function: { name: "search_knowledge", arguments: '{"query":"API 高负载处理"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    });
  } else {
    write({
      delta: {
        content:
          "## 运行状态\n\n演示环境的 **hk-api-02** CPU 为 84%。\n\n- 检查慢请求\n- 比较节点流量\n\n```bash\nssh example\n```\n\n| 指标 | 数值 |\n| --- | --- |\n| CPU | 84% |\n\n[危险链接](javascript:alert(1)) ![远程图片](https://example.test/track.png)\n\n",
      },
    });
    write({
      delta: { content: "请先比较节点流量，再检查慢请求和连接池 [S1]。" },
      finish_reason: "stop",
    });
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((done) => service.listen(0, "127.0.0.1", done));
try {
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator('[data-app-ready="true"]').waitFor();
  await mkdir("screenshots", { recursive: true });
  await completeOnboarding(page);
  const snapshot = await page.evaluate(() => window.sinan.store.addDemo());
  assert.equal(snapshot.servers.length, 6);
  assert.equal(snapshot.links.length, 13);
  credentialAssetId = "agent-location-fixture";
  await page.evaluate(async (id) => {
    await window.sinan.vault.set(`account:${id}`, {
      username: "fixture@example.test",
      password: "fixture-vault-private-value",
    });
  }, credentialAssetId);
  await page.evaluate(() => window.sinan.store.addDemo());
  await page.evaluate(
    async ({ snapshot, id }) => {
      await window.sinan.store.save({
        state: {
          ...snapshot,
          mailboxes: [
            ...snapshot.mailboxes,
            {
              ...snapshot.mailboxes.find((mailbox) => mailbox.kind === "mailbox"),
              id,
              demo: false,
              address: "fixture@example.test",
            },
          ],
        },
        version: 0,
      });
    },
    { snapshot, id: credentialAssetId },
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await page.getByRole("button", { name: "更多工具", exact: true }).click();
  await page.getByRole("button", { name: "AI 助手", exact: true }).click();
  await page.getByRole("button", { name: "模型与知识库", exact: true }).click();
  await page
    .getByRole("textbox", { name: "API Base URL", exact: true })
    .fill(`http://127.0.0.1:${service.address().port}/v1`);
  await page.getByRole("combobox", { name: "模型名称", exact: true }).fill("integration-model");
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill("integration-only-key");
  await page.getByRole("button", { name: "读取模型", exact: true }).click();
  // 0.9.0 起读取成功的提示带模型数量，不再是无参数的「模型列表已更新」。
  await page.getByText(/已加载 \d+ 个模型/).waitFor();
  assert.ok(
    !(await readFile(join(directory, "agent-config.json"), "utf8")).includes(
      "integration-only-key",
    ),
  );
  assert.equal((await page.evaluate(() => window.sinan.agent.config())).hasApiKey, true);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await page.getByText(/真实模型连接成功/).waitFor();
  await page.getByRole("button", { name: "重建索引", exact: true }).click();
  await page.getByText("本地索引已重建", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.sinan.agent.knowledge())).documents.length, 1);
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/nanpad-agent-settings.png" });
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("textbox", { name: "向模型提问" }).fill("API 高负载处理");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText(/integration-model · 生成完成/).waitFor();
  await page.screenshot({ path: "screenshots/nanpad-markdown-check.png" });
  assert.equal(await page.locator(".markdown-body h2").first().innerText(), "运行状态");
  assert.equal(await page.locator(".markdown-body strong").first().innerText(), "hk-api-02");
  assert.ok(await page.locator(".markdown-body table").count());
  assert.ok(await page.locator(".markdown-body pre code").count());
  assert.equal(await page.locator('.markdown-body a[href^="javascript:"]').count(), 0);
  assert.equal(await page.locator(".markdown-body img").count(), 0);
  await page.locator(".agent-sources summary").click();
  assert.ok((await page.locator(".agent-sources").innerText()).includes("星桥商城演示运维手册"));
  assert.ok(requests.some((req) => req.body.messages?.some((m) => m.role === "tool")));
  await page.screenshot({ path: "screenshots/nanpad-agent-answer.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".agent-sources summary").click();
  await page.screenshot({ path: "screenshots/nanpad-agent-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const mailboxPermission = page.getByRole("checkbox", { name: "本次允许查询邮箱" });
  assert.equal(await mailboxPermission.isChecked(), false);
  await mailboxPermission.check();
  await page.getByRole("textbox", { name: "向模型提问" }).fill("定位邮箱凭据");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("已定位到邮箱的凭据区，请在本机解锁后查看。", { exact: true }).waitFor();
  assert.equal(await mailboxPermission.isChecked(), false);
  await page.locator(".agent-sources summary").click();
  await page
    .locator(".agent-sources .agent-source-title")
    .filter({ hasText: "fixture@example.test" })
    .click();
  await page.getByRole("region", { name: "资产详情" }).waitFor();
  await page.getByLabel("凭据位置", { exact: true }).waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes("fixture-vault-private-value"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/nanpad-v030-credential-mobile.png" });
  await page
    .getByRole("region", { name: "资产详情" })
    .getByRole("button", { name: "返回列表", exact: true })
    .click();
  const allowedRequests = requests.filter((req) =>
    req.body.messages?.some(
      (message) => message.role === "user" && message.content === "定位邮箱凭据",
    ),
  );
  assert.ok(
    allowedRequests.some((req) =>
      req.body.tools?.some((entry) => entry.function.name === "check_mailbox"),
    ),
  );
  assert.ok(
    requests
      .filter((req) =>
        req.body.messages?.some(
          (message) => message.role === "user" && message.content === "API 高负载处理",
        ),
      )
      .every((req) => !req.body.tools?.some((entry) => entry.function.name === "check_mailbox")),
  );
  assert.ok(!JSON.stringify(requests).includes("fixture-vault-private-value"));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.evaluate(async (serverId) => {
    const now = new Date().toISOString();
    await window.sinan.documents.save({
      id: "doc-agent-ipc",
      title: "IPC 文档工具验证",
      createdAt: now,
      updatedAt: now,
      bindings: [{ kind: "server", id: serverId }],
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "IPC_DOCUMENT_BODY_MARKER" }] },
        ],
      },
    });
  }, snapshot.servers[0].id);
  const documentPermission = page.getByRole("checkbox", {
    name: "本次允许检索文档正文",
    exact: true,
  });
  assert.equal(await documentPermission.isChecked(), false);
  await documentPermission.check();
  await page.getByRole("textbox", { name: "向模型提问" }).fill("读取工作区合成文档");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page
    .getByText("已读取工作区文档：IPC_DOCUMENT_BODY_MARKER，并找到关联主机。", { exact: true })
    .waitFor();
  assert.equal(await documentPermission.isChecked(), false);
  const documentRequests = requests.filter(
    (request) => questionOf(request.body.messages) === "读取工作区合成文档",
  );
  const toolResults = documentRequests
    .at(-1)
    .body.messages.filter((message) => message.role === "tool")
    .map((message) => JSON.parse(message.content));
  assert.equal(toolResults.length, 3, "必须通过真实主进程完成三个工作区文档工具往返");
  assert.ok(
    toolResults.every((result) => !result.error),
    JSON.stringify(toolResults),
  );
  assert.ok(toolResults[0].documents.some((document) => document.documentId === "doc-agent-ipc"));
  assert.equal(toolResults[1].text, "IPC_DOCUMENT_BODY_MARKER");
  assert.ok(
    toolResults[2].resources.some((resource) => resource.assetId === snapshot.servers[0].id),
  );
  await page.getByRole("textbox", { name: "向模型提问" }).fill("后续未授权追问");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("本次只使用普通对话及资源元数据。", { exact: true }).waitFor();
  const followup = requests.findLast(
    (request) => questionOf(request.body.messages) === "后续未授权追问",
  );
  assert.ok(
    !JSON.stringify(followup.body).includes("IPC_DOCUMENT_BODY_MARKER"),
    "下一次未授权请求不得重发授权文档回答",
  );
  assert.ok(
    followup.body.messages.some(
      (message) => message.role === "user" && message.content === "读取工作区合成文档",
    ),
    "仍需保留普通提问历史",
  );
  assert.ok(!followup.body.tools.some((tool) => tool.function.name === "get_document"));
  await page
    .locator(".agent-context-desktop .agent-source-title")
    .filter({ hasText: "IPC 文档工具验证" })
    .first()
    .click();
  await page.getByRole("heading", { name: "IPC 文档工具验证", exact: true }).waitFor();
  await page
    .getByRole("region", { name: "文档正文", exact: true })
    .getByText("IPC_DOCUMENT_BODY_MARKER", { exact: true })
    .waitFor();
  await page.screenshot({ path: "screenshots/agent-workspace/electron-document-source.png" });
  await page.getByRole("button", { name: "AI 助手", exact: true }).click();
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("textbox", { name: "向模型提问" }).fill("停止测试");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("等待测试取消", { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await page.getByText(/integration-model · 已停止/).waitFor();
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  const stored = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
  assert.ok(JSON.stringify(stored).includes('"type":"sources"'));
  assert.ok(JSON.stringify(stored).includes('"status":"stopped"'));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        demoAssets: 22,
        links: 13,
        ragDocument: true,
        streamedToolRoundTrip: true,
        cancellation: true,
        credentialLocationWithoutDisclosure: true,
        mailboxPermissionPerQuestion: true,
        persistedSources: true,
        workspaceDocumentIpcTools: true,
        documentPermissionPerQuestion: true,
        documentAnswerNotReusedWithoutPermission: true,
        documentSourceOpen: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const page = instance ? await instance.firstWindow() : null;
  console.error(
    JSON.stringify(
      {
        error: String(error),
        ui: page
          ? await page
              .locator("body")
              .innerText()
              .catch(() => "")
          : "",
        documentRequests: requests.filter(
          (request) => questionOf(request.body.messages) === "读取工作区合成文档",
        ),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await instance?.close();
  service.closeAllConnections();
  await new Promise((done) => service.close(done));
  await rm(directory, { recursive: true, force: true });
}
