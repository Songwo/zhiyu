import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { checkedUrl } from "./browser-guard.mjs";

// 独立浏览器和合成桥接数据，不访问用户资料或真实模型。
const origin = new URL(checkedUrl(process.env.NANPAD_QA_URL || "http://127.0.0.1:8080/")).origin;
const browser = await chromium.launch({ headless: true });
const results = [];
await mkdir("screenshots/agent-workspace", { recursive: true });
const source = {
  id: "doc-qa",
  documentId: "doc-qa",
  title: "合成文档",
  citation: "D1",
  excerpt: "仅供隔离验证的文档片段。",
};
const now = new Date().toISOString();
const history = [
  {
    id: "conv-long",
    title: "部署问答记录",
    createdAt: now,
    updatedAt: now,
    messages: Array.from({ length: 60 }, (_, index) => ({
      id: "message-" + index,
      role: index % 2 ? "agent" : "you",
      at: now,
      blocks: [
        {
          type: "text",
          text: "第 " + (index + 1) + " 条合成消息：" + "检查资源状态与关联文档。".repeat(12),
        },
        ...(index === 59 ? [{ type: "sources", sources: [source] }] : []),
      ],
    })),
  },
  {
    id: "conv-other",
    title: "费用优化记录",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: "other-message",
        role: "you",
        at: now,
        blocks: [{ type: "text", text: "独立费用问题" }],
      },
    ],
  },
];
async function scenario(name, viewport, action) {
  if (process.env.NANPAD_QA_CASE && !name.includes(process.env.NANPAD_QA_CASE)) return;
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await action(page, context);
    assert.deepEqual(errors, [], "页面不能出现未捕获错误");
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack, pageErrors: errors });
    await page
      .screenshot({ path: "screenshots/agent-workspace/failure-" + viewport.width + ".png" })
      .catch(() => {});
  } finally {
    await context.close();
  }
  console.log(JSON.stringify(results.at(-1)));
}
async function openContext(page, mobile) {
  if (mobile) await page.getByRole("button", { name: "对话上下文", exact: true }).click();
  return mobile
    ? page.getByRole("dialog", { name: "对话上下文", exact: true })
    : page.locator(".agent-context-desktop");
}
try {
  for (const mobile of [false, true]) {
    await scenario(
      mobile ? "移动端上下文与滚动边界" : "桌面历史恢复与独立滚动",
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      async (page, context) => {
        await context.addInitScript(
          ({ history, now }) => {
            localStorage.setItem(
              "sinan-conversations-v1",
              JSON.stringify({ state: { conversations: history }, version: 0 }),
            );
            localStorage.setItem(
              "sinan-settings-v1",
              JSON.stringify({
                state: {
                  language: "zh",
                  theme: "light",
                  toolsExpanded: true,
                  reduceMotion: true,
                  assetLayout: "cards",
                },
                version: 0,
              }),
            );
            localStorage.setItem(
              "nanpad-doc:doc-qa",
              JSON.stringify({
                id: "doc-qa",
                title: "合成文档",
                createdAt: now,
                updatedAt: now,
                bindings: [],
                content: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "仅供隔离验证的文档片段。" }],
                    },
                  ],
                },
              }),
            );
          },
          { history, now },
        );
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.locator('[data-app-ready="true"]').waitFor();
        await navigateDesktop(page, "AI 助手");
        await page.locator(".agent-workspace").waitFor();
        let rail = await openContext(page, mobile);
        await rail.getByRole("textbox", { name: "搜索历史对话" }).fill("部署");
        assert.equal(await rail.locator(".agent-history-row").count(), 1);
        await rail.locator(".agent-history-open").click();
        const scroller = page.locator(".agent-message-scroll");
        await page.waitForFunction(
          () => document.querySelector(".agent-message-scroll").scrollTop > 0,
        );
        const composerBefore = await page.locator(".agent-composer").boundingBox();
        const geometry = await page.evaluate(() => {
          const shell = document.querySelector(".agent-shell");
          const scroll = document.querySelector(".agent-message-scroll");
          const form = document.querySelector(".agent-composer").getBoundingClientRect();
          return {
            shellTop: shell.scrollTop,
            shellExcess: shell.scrollHeight - shell.clientHeight,
            pageTop: document.documentElement.scrollTop,
            bodyExcess: document.documentElement.scrollHeight - innerHeight,
            formBottom: form.bottom,
            viewport: innerHeight,
            scrollBottom: scroll.getBoundingClientRect().bottom,
            formTop: form.top,
            overflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
        assert.equal(geometry.shellTop, 0);
        assert.ok(geometry.shellExcess <= 1, "外层不能产生空白：" + JSON.stringify(geometry));
        assert.equal(geometry.pageTop, 0);
        assert.ok(geometry.bodyExcess <= 1);
        assert.ok(Math.abs(geometry.scrollBottom - geometry.formTop) <= 1, "消息与输入区连续衔接");
        assert.ok(
          Math.abs(geometry.formBottom - (geometry.viewport - (mobile ? 56 : 0))) <= 2,
          "输入区固定到底边",
        );
        assert.ok(geometry.overflow <= 1);
        await scroller.hover();
        await page.mouse.wheel(0, -100000);
        await page.waitForFunction(
          () => document.querySelector(".agent-message-scroll").scrollTop === 0,
        );
        await page.getByRole("button", { name: "显示更早的 20 条消息", exact: true }).click();
        assert.equal(await page.locator("[data-message-id]").count(), 60);
        assert.equal(
          Math.round((await page.locator(".agent-composer").boundingBox()).y),
          Math.round(composerBefore.y),
        );
        for (const theme of ["light", "dark"]) {
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          await page.screenshot({
            path:
              "screenshots/agent-workspace/" +
              (mobile ? "mobile" : "desktop") +
              "-" +
              theme +
              ".png",
            animations: "disabled",
          });
        }
        rail = await openContext(page, mobile);
        if (mobile)
          await page.screenshot({
            path: "screenshots/agent-workspace/mobile-context-dark.png",
            animations: "disabled",
          });
        await rail.getByRole("textbox", { name: "搜索历史对话" }).fill("");
        await rail
          .getByRole("button", { name: "我的主机、域名和证书有哪些关联？", exact: true })
          .click();
        assert.equal(
          await page.getByRole("textbox", { name: "向模型提问" }).inputValue(),
          "我的主机、域名和证书有哪些关联？",
        );
        assert.equal(await page.locator("[data-message-id]").count(), 60, "常问不能直接发送");
        rail = await openContext(page, mobile);
        page.once("dialog", (dialog) => dialog.dismiss());
        await rail.getByRole("button", { name: "删除对话：费用优化记录", exact: true }).click();
        assert.equal(await rail.locator(".agent-history-row").count(), 2);
        page.once("dialog", (dialog) => dialog.accept());
        await rail.getByRole("button", { name: "删除对话：费用优化记录", exact: true }).click();
        assert.equal(await rail.locator(".agent-history-row").count(), 1);
        await rail.getByRole("button", { name: "回到引用消息", exact: true }).click();
        assert.ok(await scroller.evaluate((element) => element.scrollTop > 0));
        rail = await openContext(page, mobile);
        await rail.locator(".agent-source-title").filter({ hasText: "合成文档" }).click();
        await page.getByRole("heading", { name: "合成文档", exact: true }).waitFor();
      },
    );
  }

  await scenario(
    "流式归属、单次授权、跨请求标记与文档保存失败",
    { width: 1440, height: 900 },
    async (page, context) => {
      const fixture = [
        "import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;",
        "import('/scripts/agent-workspace-fixture.mjs').then(({mount}) => mount());",
      ].join("\n");
      await context.route(origin + "/__agent-workspace-qa__", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body:
            '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离验证</title><body><div id="root"></div><script type="module">' +
            fixture +
            "</script></body></html>",
        }),
      );
      await page.goto(origin + "/__agent-workspace-qa__");
      await page.waitForFunction(() => window.__qa?.ready);
      await page.getByText("synthetic-test-model", { exact: true }).waitFor();
      const input = page.getByRole("textbox", { name: "向模型提问" });
      const permission = page.getByRole("checkbox", { name: "本次允许检索文档正文", exact: true });
      assert.equal(await permission.isChecked(), false);
      await permission.check();
      await input.fill("合成问题一");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page.getByRole("button", { name: "停止生成", exact: true }).waitFor();
      assert.equal(await permission.isChecked(), false);
      assert.equal(await permission.isDisabled(), true);
      assert.equal(
        await page.getByRole("button", { name: "新对话", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: /^删除对话：/ })
          .first()
          .isDisabled(),
        true,
      );
      assert.equal(await page.locator(".agent-history-open").last().isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__qa.requests[0].allowDocumentContent), true);
      await page.evaluate((source) => {
        const qa = window.__qa;
        const id = qa.requests[0].id;
        for (const event of [
          { type: "tool", name: "get_document" },
          { type: "source", source },
          { type: "delta", text: "合成流式正文回答" },
        ])
          for (const fn of qa.listeners) fn({ id, ...event });
      }, source);
      await page.locator(".agent-pending").getByText("合成流式正文回答", { exact: true }).waitFor();
      await page.evaluate(
        (source) =>
          window.__qa.resolve({
            model: "synthetic-test-model",
            text: "合成文档授权回答",
            sourceItems: [source],
            steps: 1,
            tools: ["get_document"],
          }),
        source,
      );
      await page
        .getByRole("button", { name: "停止生成", exact: true })
        .waitFor({ state: "detached" });
      const saved = await page.evaluate(() => window.__qa.conversations.getState().conversations);
      assert.equal(saved.find((c) => c.id === "conv-b").messages.length, 0);
      assert.equal(
        saved.find((c) => c.id === "conv-a").messages[1].blocks.find((b) => b.type === "run")
          .documentContent,
        true,
      );
      await input.fill("合成问题二");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const request = await page.evaluate(() => window.__qa.requests[1]);
      assert.equal(request.allowDocumentContent, false);
      assert.equal(
        request.history.find((entry) => entry.role === "assistant").documentContent,
        true,
      );
      assert.equal(request.history.find((entry) => entry.role === "user").content, "合成问题一");
      await page.getByRole("button", { name: "停止生成", exact: true }).click();
      await page.getByRole("button", { name: "发送", exact: true }).waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            window.__qa.conversations
              .getState()
              .conversations[0].messages.at(-1)
              .blocks.find((b) => b.type === "run").status,
        ),
        "stopped",
      );
      await page.evaluate(() => {
        const qa = window.__qa;
        qa.failSave = true;
        qa.documents.setState({
          selected: "doc-old",
          drafts: {
            "doc-old": {
              id: "doc-old",
              title: "合成草稿",
              bindings: [],
              content: { type: "doc", content: [] },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
          status: { "doc-old": "dirty" },
        });
      });
      const sourceButton = page
        .locator(".agent-context-desktop .agent-source-title")
        .filter({ hasText: "合成文档" });
      await sourceButton.click();
      await page.waitForFunction(() => typeof window.__qa.finishSave === "function");
      assert.equal(await page.evaluate(() => window.__qa.app.getState().view), "agent");
      await page.evaluate(() => window.__qa.finishSave());
      await page.getByText("打开来源失败：合成保存失败", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__qa.documents.getState().selected), "doc-old");
      await page.evaluate(() => {
        window.__qa.failSave = false;
        window.__qa.finishSave = null;
      });
      await sourceButton.click();
      await page.waitForFunction(() => typeof window.__qa.finishSave === "function");
      await page.evaluate(() => window.__qa.finishSave());
      await page.waitForFunction(() => window.__qa.app.getState().view === "docs");
      assert.equal(await page.evaluate(() => window.__qa.documents.getState().selected), "doc-qa");
    },
  );
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: results.every((result) => result.ok), results }, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
