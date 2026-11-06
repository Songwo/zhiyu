import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { universalRelationFixture } from "./universal-relations-fixture.mjs";

// 执行真实前端 store 和动作，只补齐打包器允许省略的扩展名。
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts"))
        return nextResolve(url.href + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { useAppStore } = await import("../src/lib/store.ts");
const { useDocuments } = await import("../src/lib/documents.ts");
const { savePhoneRelations, updateResourceRelation } =
  await import("../src/lib/resource-relation-actions.ts");
const { openResource } = await import("../src/lib/resource-inventory.ts");
hook.deregister();
const document = (row) => ({ ...row, content: { type: "doc", content: [] } });
function reset() {
  const fixture = universalRelationFixture();
  useAppStore.setState({
    ...fixture.snapshot,
    expanded: null,
    view: "overview",
    phoneFocusId: null,
  });
  useDocuments.setState({
    list: fixture.documents,
    drafts: {},
    status: {},
    errors: {},
    selected: null,
    loaded: true,
  });
  globalThis.window = {
    sinan: {
      documents: { get: async (id) => document(fixture.documents.find((doc) => doc.id === id)) },
    },
  };
  return fixture;
}

await test("号码编辑动作保存全部类型并能从反向解除；取消验证不写入", async () => {
  const { snapshot, resources } = reset();
  const phone = snapshot.phoneNumbers[0];
  const targets = resources.filter((ref) => ref.kind !== "phone" || ref.id !== phone.id);
  await savePhoneRelations(phone, targets, true);
  assert.equal(useAppStore.getState().links.length, 22);
  assert.deepEqual(useAppStore.getState().phoneNumbers[0].subscriptionIds.sort(), ["ai-a", "ai-b"]);
  await updateResourceRelation(
    { kind: "server", id: "server-a" },
    { kind: "phone", id: phone.id },
    true,
  );
  assert.equal(useAppStore.getState().links.length, 21);
  await assert.rejects(
    savePhoneRelations(phone, [], true, () => {
      throw Error("取消保存");
    }),
    /取消保存/,
  );
  assert.equal(useAppStore.getState().links.length, 21);
});

await test("旧文档桥接明确拒绝不安全回写，不伪造关联成功", async () => {
  reset();
  let writes = 0;
  window.sinan.documents.save = async () => {
    writes++;
    throw Error("不应调用");
  };
  await assert.rejects(
    updateResourceRelation({ kind: "document", id: "doc-a" }, { kind: "server", id: "server-a" }),
    /更新客户端或服务端/,
  );
  assert.equal(writes, 0);
  assert.equal(useAppStore.getState().links.length, 0);
});

await test("文档关联只调用元信息接口，接口失败保留原稿和原关系", async () => {
  const fixture = reset();
  const original = document(fixture.documents[0]);
  useDocuments.setState({ drafts: { "doc-a": original }, status: { "doc-a": "saved" } });
  window.sinan.documents.bind = async () => {
    throw Error("合成绑定失败");
  };
  await assert.rejects(
    updateResourceRelation({ kind: "document", id: "doc-a" }, { kind: "server", id: "server-a" }),
    /合成绑定失败/,
  );
  assert.equal(useDocuments.getState().drafts["doc-a"], original);
  window.sinan.documents.bind = async (_id, ref) => ({ ...original, bindings: [ref] });
  await updateResourceRelation(
    { kind: "document", id: "doc-a" },
    { kind: "server", id: "server-a" },
  );
  assert.deepEqual(useDocuments.getState().drafts["doc-a"].bindings, [
    { kind: "server", id: "server-a" },
  ]);
  assert.equal(useDocuments.getState().drafts["doc-a"].content, original.content);
});

await test("AI 与关联共用跳转：号码、节点、文档定位正确，原凭据焦点保留", async () => {
  reset();
  await openResource({ kind: "phone", id: "phone-a" });
  assert.equal(useAppStore.getState().view, "phones");
  assert.equal(useAppStore.getState().phoneFocusId, "phone-a");
  await openResource({ kind: "node", id: JSON.stringify(["server-b", "same-node"]) });
  assert.equal(useAppStore.getState().expanded.id, "server-b");
  assert.equal(useAppStore.getState().expanded.nodeId, "same-node");
  assert.equal(useAppStore.getState().expanded.focus, "nodes");
  await openResource({ kind: "document", id: "doc-b" });
  assert.equal(useAppStore.getState().view, "docs");
  assert.equal(useDocuments.getState().selected, "doc-b");
  await openResource({ kind: "server", id: "server-a" }, undefined, "account");
  assert.equal(useAppStore.getState().expanded.focus, "account");
  await assert.rejects(openResource({ kind: "node", id: "missing" }), /已不存在/);
});
delete globalThis.window;
