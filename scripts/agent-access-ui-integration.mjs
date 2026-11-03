import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

// 只挂载真实界面和合成桥接数据，不连接用户配置或外部模型。
const origin = new URL(process.env.NANPAD_QA_URL ?? "http://127.0.0.1:8080").origin;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}/__agent-access-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><link rel="stylesheet" href="/src/styles.css"></head><body><main id="root" style="display:flex;height:100vh"></main></body></html>',
    }),
  );
  await page.goto(`${origin}/__agent-access-test`);
  await page.evaluate(async () => {
    const RefreshRuntime = (await import("/@react-refresh")).default;
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    window.__requests = [];
    window.__applies = [];
    window.sinan = {
      store: { load: async () => null, save: async () => {}, saveConversations: async () => {} },
      documents: { list: async () => [] },
      aiAccounts: { list: async () => [] },
      agent: {
        config: async () => ({ model: "integration-model" }),
        onEvent: () => () => {},
        run: async (request) => {
          window.__requests.push(request);
          const rename = request.question.includes("标题");
          const granted = rename ? request.allowWorkspaceChanges : request.allowDocumentContent;
          return {
            model: "integration-model",
            steps: 2,
            sources: 1,
            text: granted
              ? rename
                ? "标题修改方案已生成，请确认。"
                : "已经读取获准正文，摘要如下。"
              : "需要你允许本次操作后继续。",
            sourceItems: [
              {
                id: "workspace-document:doc-demo",
                citation: "S1",
                title: "合成指南",
                documentId: "doc-demo",
                excerpt: "合成指南",
              },
            ],
            tools: granted
              ? [rename ? "propose_document_rename" : "get_document"]
              : ["request_workspace_access"],
            accessRequests: granted
              ? []
              : [
                  {
                    permissions: [rename ? "workspaceChanges" : "documentContent"],
                    reason: rename
                      ? "生成标题修改方案，无需读取正文。"
                      : "需要读取正文才能提供可靠摘要。",
                  },
                ],
            proposals:
              granted && rename
                ? [
                    {
                      id: "rename-demo",
                      type: "document-rename",
                      documentId: "doc-demo",
                      title: "合成指南",
                      before: "合成指南",
                      after: "新版指南",
                      reason: "用户指定新标题",
                      expiresAt: Date.now() + 60000,
                    },
                  ]
                : [],
          };
        },
        applyProposal: async (id) => {
          window.__applies.push(id);
          return {};
        },
      },
    };
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { AgentView } = await import("/src/components/agent-view.tsx");
    const resources = performance.getEntriesByType("resource");
    const { useConversations } = await import(
      resources.find((entry) => entry.name.includes("/src/lib/conversations.ts")).name
    );
    useConversations.setState({
      hydrated: true,
      activeId: "access-test",
      conversations: [
        {
          id: "access-test",
          title: "授权流程",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        },
      ],
    });
    window.__conversations = useConversations;
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(AgentView));
  });
  const input = page.getByRole("textbox", { name: "向模型提问" });
  await input.fill("请将合成指南的标题改为新版指南");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const allowChanges = page.getByRole("button", {
    name: "允许本次生成修改建议并继续",
    exact: true,
  });
  await allowChanges.waitFor();
  assert.equal(await page.evaluate(() => window.__requests.length), 1);
  assert.equal(await page.evaluate(() => window.__applies.length), 0);
  await input.fill("尚未发送的下一条草稿");
  // 回答按钮仅授予明示的范围，不夹带输入区其他勾选。
  await page.getByLabel("本次允许检索文档正文", { exact: true }).check();
  await page.getByLabel("本次允许查询邮箱", { exact: true }).check();
  await allowChanges.click();
  await page.getByRole("button", { name: "确认应用这项修改", exact: true }).waitFor();
  const renameRequests = await page.evaluate(() => window.__requests);
  assert.equal(renameRequests.length, 2);
  assert.equal(renameRequests[1].question, renameRequests[0].question);
  assert.equal(renameRequests[1].allowWorkspaceChanges, true);
  assert.equal(renameRequests[1].allowDocumentContent, false);
  assert.equal(renameRequests[1].allowMailboxChecks, false);
  assert.deepEqual(renameRequests[1].history, []);
  assert.equal(await input.inputValue(), "尚未发送的下一条草稿");
  assert.equal(
    await page.evaluate(
      () =>
        window.__conversations.getState().conversations[0].messages.filter((m) => m.role === "you")
          .length,
    ),
    1,
  );
  assert.equal(await page.evaluate(() => window.__applies.length), 0);
  assert.equal(await page.getByLabel("本次生成修改建议", { exact: true }).isChecked(), false);
  await page.getByRole("button", { name: "确认应用这项修改", exact: true }).click();
  await page.getByText("修改已保存到本机。", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__applies), ["rename-demo"]);

  await input.fill("总结合成指南，并生成一段局部修改建议");
  await page.getByLabel("本次生成修改建议", { exact: true }).check();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const allowBoth = page.getByRole("button", { name: "允许本次读取正文并生成建议", exact: true });
  await allowBoth.waitFor();
  await allowBoth.scrollIntoViewIfNeeded();
  await page
    .locator(".agent-access-request")
    .evaluate((element) =>
      Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/agent-access-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await allowBoth.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "screenshots/agent-access-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await allowBoth.click();
  await page.getByText("已经读取获准正文，摘要如下。", { exact: true }).waitFor();
  const requests = await page.evaluate(() => window.__requests);
  assert.equal(requests[3].allowDocumentContent, true);
  assert.equal(requests[3].allowWorkspaceChanges, true);
  assert.equal(requests[3].allowMailboxChecks, false);
  assert.equal(await page.getByLabel("本次允许检索文档正文", { exact: true }).isChecked(), false);
  assert.equal(await page.getByRole("region", { name: "继续完成这项任务" }).count(), 0);
  await input.fill("后续普通问题");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "允许本次读取正文并继续", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__requests.at(-1).allowDocumentContent), false);
  assert.equal(await page.evaluate(() => window.__requests.at(-1).allowWorkspaceChanges), false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "rename-access-continuation",
        "no-body-or-mailbox-escalation",
        "draft-preserved",
        "no-duplicate-question",
        "explicit-apply-only",
        "combined-access-visible",
        "one-request-only",
        "mobile-no-overflow",
      ],
    }),
  );
} finally {
  await browser.close();
}
