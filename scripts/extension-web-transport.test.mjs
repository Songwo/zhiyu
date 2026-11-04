import test from "node:test";
import assert from "node:assert/strict";
import {
  createBridgeFetch,
  workspaceOrigin,
  WEB_WORKSPACE_KEY,
} from "../browser-extension/web-transport.mjs";

test("插件 Web 地址只接受 HTTPS 或本机测试源，不接受凭据、路径与查询", () => {
  assert.equal(
    workspaceOrigin("https://workspace.example.test/"),
    "https://workspace.example.test",
  );
  assert.equal(workspaceOrigin("http://127.0.0.1:8848"), "http://127.0.0.1:8848");
  for (const value of [
    "http://public.test",
    "https://user:pass@workspace.test",
    "https://workspace.test/app",
    "https://workspace.test/?token=secret",
    "javascript:alert(1)",
  ])
    assert.throws(() => workspaceOrigin(value));
});

test("插件经 Web 标签页配对并绑定该标签，不访问远程 HTTP 密码接口", async () => {
  const local = { [WEB_WORKSPACE_KEY]: "https://workspace.example.test" },
    session = {};
  const messages = [];
  const tabs = [
    { id: 1, url: "https://workspace.example.test/" },
    { id: 2, url: "https://workspace.example.test/" },
    { id: 3, url: "https://other.example.test/" },
  ];
  const chrome = {
    storage: {
      local: { get: async () => local },
      session: { get: async () => session, set: async (value) => Object.assign(session, value) },
    },
    tabs: {
      query: async () => tabs,
      get: async (id) => tabs.find((tab) => tab.id === id),
      sendMessage: async (id, message, options) => {
        messages.push({ id, message });
        assert.equal(options.frameId, 0);
        return message.path === "/v1/pair"
          ? id === 1
            ? { status: 401, data: { error: "wrong preview" } }
            : { status: 200, data: { token: "a".repeat(64) } }
          : { status: 200, data: { unlocked: true } };
      },
    },
  };
  const send = createBridgeFetch({
    chrome,
    fetchImpl: () => {
      throw new Error("must not fetch");
    },
  });
  const base = "http://127.0.0.1:47832";
  const pair = await send(base + "/v1/pair", {
    method: "POST",
    body: JSON.stringify({ code: "synthetic" }),
  });
  assert.equal(pair.status, 200);
  assert.equal(session.zhiyuWebWorkspaceTab.tabId, 2);
  await send(base + "/v1/status", {
    method: "POST",
    headers: { Authorization: "Bearer " + "a".repeat(64) },
    body: "{}",
  });
  assert.equal(messages.at(-1).id, 2);
  assert.equal(messages.at(-1).message.token, "a".repeat(64));
  assert.equal(JSON.stringify(local).includes("a".repeat(64)), false);
  tabs[1].url = "https://other.example.test/";
  await assert.rejects(send(base + "/v1/status", { method: "POST", body: "{}" }), /打开|配对/);
});

test("未选择 Web 时原有本机请求完整保留", async () => {
  let observed;
  const send = createBridgeFetch({
    chrome: { storage: { local: { get: async () => ({}) } } },
    fetchImpl: async (...args) => {
      observed = args;
      return new Response("{}");
    },
  });
  const options = { method: "POST", body: "{}" };
  await send("http://127.0.0.1:47832/v1/status", options);
  assert.deepEqual(observed, ["http://127.0.0.1:47832/v1/status", options]);
});
