import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsageDraft, usageFormFromDraft } from "../src/lib/usage-setup.mjs";
import * as setup from "../src/lib/usage-setup.mjs";

test("节点连接向导带入正确归属，凭据不会通过页面跳转传递", () => {
  const input = {
    type: "subscription",
    serverId: "server-1",
    nodeId: "node-2",
    name: "机场节点",
    password: "secret",
    apiKey: "secret",
    url: "https://private.example.test/token",
  };
  const draft = normalizeUsageDraft(input);
  assert.deepEqual(draft, {
    type: "subscription",
    serverId: "server-1",
    nodeId: "node-2",
    name: "机场节点",
  });
  const form = usageFormFromDraft(draft);
  assert.equal(form.nodeId, "server-1:node-2");
  assert.equal(form.type, "subscription");
  assert.equal(form.password, "");
  assert.equal(form.apiKey, "");
  assert.equal(form.url, "");
});

test("API 用量入口不混入节点归属，旧或未知类型安全退回默认", () => {
  assert.equal(usageFormFromDraft({ type: "openai-api", serverId: "s", nodeId: "n" }).nodeId, "");
  assert.equal(usageFormFromDraft({ type: "anthropic-api" }).type, "anthropic-api");
  assert.equal(usageFormFromDraft({ type: "unsupported" }).type, "3x-ui");
  assert.equal(usageFormFromDraft({ nodeId: "n" }).nodeId, "");
  assert.equal(usageFormFromDraft(null).name, "");
});

test("异常上下文不写入对象和无限长名称", () => {
  const result = normalizeUsageDraft({ name: "a".repeat(500), nodeId: {}, serverId: ["s"] });
  assert.equal(result.name.length, 160);
  assert.equal(result.nodeId, undefined);
  assert.equal(result.serverId, undefined);
});

test("编辑表单只回填公开字段，已有凭据始终留空", () => {
  const form = setup.usageFormFromSource({
    id: "airport",
    name: "我的机场",
    type: "subscription",
    nodeId: "server:node",
    url: "https://private.example/token",
    password: "secret",
    apiKey: "secret",
    username: "private",
  });
  assert.equal(form.name, "我的机场");
  assert.equal(form.type, "subscription");
  assert.equal(form.nodeId, "server:node");
  for (const field of ["url", "password", "apiKey", "username"]) assert.equal(form[field], "");
  assert.doesNotMatch(JSON.stringify(form), /secret|private/);
});
