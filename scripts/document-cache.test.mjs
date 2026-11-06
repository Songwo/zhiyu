import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Node 的类型擦除保留实际 store 代码，只补齐项目中面向打包器的扩展名解析。
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const resolved = new URL(specifier, context.parentURL);
      if (!/\.[cm]?[jt]sx?$/.test(resolved.pathname) && existsSync(fileURLToPath(resolved) + ".ts"))
        return nextResolve(resolved.href + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { useDocuments } = await import("../src/lib/documents.ts");
hook.deregister();
const summary = (id, title = id) => ({
  id,
  title,
  bindings: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  excerpt: title,
  imageCount: 0,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function reset(list = []) {
  useDocuments.setState({
    list,
    loaded: false,
    selected: null,
    drafts: {},
    status: {},
    errors: {},
  });
}
function bridge(list) {
  globalThis.window = { sinan: { documents: { list } } };
}

await test("文档列表复用缓存，多个并发请求只读取一次，force重新读取", async () => {
  reset();
  let calls = 0;
  const pending = deferred();
  bridge(() => {
    calls++;
    return calls === 1 ? pending.promise : Promise.resolve([summary("doc-2")]);
  });
  const first = useDocuments.getState().load();
  const second = useDocuments.getState().load();
  const third = useDocuments.getState().load(true);
  const fourth = useDocuments.getState().load(true);
  assert.equal(calls, 1);
  pending.resolve([summary("doc-1")]);
  await Promise.all([first, second, third, fourth]);
  assert.deepEqual(
    useDocuments.getState().list.map((doc) => doc.id),
    ["doc-2"],
  );
  await useDocuments.getState().load();
  assert.equal(calls, 2, "读取期间的多次失效合并为一次补读");
  await useDocuments.getState().load(true);
  assert.equal(calls, 3);
  assert.deepEqual(
    useDocuments.getState().list.map((doc) => doc.id),
    ["doc-2"],
  );
});

await test("加载失败不标记成功，下一次可重试且保留已有草稿", async () => {
  reset([summary("doc-local")]);
  const draft = {
    ...summary("doc-local"),
    title: "未保存修改",
    content: { type: "doc", content: [] },
  };
  useDocuments.setState({
    drafts: { "doc-local": draft },
    selected: "doc-local",
    status: { "doc-local": "dirty" },
  });
  let calls = 0;
  bridge(async () => {
    if (++calls === 1) throw Error("synthetic read failure");
    return [summary("doc-local", "旧标题")];
  });
  await assert.rejects(useDocuments.getState().load(), /synthetic read failure/);
  assert.equal(useDocuments.getState().loaded, false);
  assert.equal(useDocuments.getState().drafts["doc-local"], draft);
  await useDocuments.getState().load();
  assert.equal(calls, 2);
  assert.equal(useDocuments.getState().loaded, true);
  assert.equal(useDocuments.getState().drafts["doc-local"], draft);
  assert.equal(useDocuments.getState().selected, "doc-local");
});

await test("读取期间的本地新增、修改、删除不会被迟到的列表覆盖", async () => {
  const removed = summary("doc-removed"),
    edited = summary("doc-edited"),
    unchanged = summary("doc-remote");
  reset([removed, edited, unchanged]);
  const pending = deferred();
  bridge(() => pending.promise);
  const loading = useDocuments.getState().load();
  useDocuments.setState({
    list: [summary("doc-added"), summary("doc-edited", "新标题"), unchanged],
  });
  pending.resolve([removed, edited, summary("doc-remote", "外部更新")]);
  await loading;
  const state = useDocuments.getState();
  assert.equal(
    state.list.some((doc) => doc.id === "doc-removed"),
    false,
  );
  assert.equal(state.list.find((doc) => doc.id === "doc-added").title, "doc-added");
  assert.equal(state.list.find((doc) => doc.id === "doc-edited").title, "新标题");
  assert.equal(state.list.find((doc) => doc.id === "doc-remote").title, "外部更新");
});
await test("旧请求失败期间发生外部失效，所有等待者会等到补读完成", async () => {
  reset();
  let calls = 0;
  const pending = deferred();
  bridge(() => (++calls === 1 ? pending.promise : Promise.resolve([summary("doc-new")])));
  const first = useDocuments.getState().load();
  const invalidation = useDocuments.getState().load(true);
  pending.reject(Error("superseded read failed"));
  await Promise.all([first, invalidation]);
  assert.equal(calls, 2);
  assert.equal(useDocuments.getState().list[0].id, "doc-new");
});

await test("请求完成的同一轮微任务内到达失效通知，也不能丢掉补读", async () => {
  reset();
  let calls = 0;
  const pending = deferred();
  bridge(() => (++calls === 1 ? pending.promise : Promise.resolve([summary("doc-latest")])));
  const first = useDocuments.getState().load();
  pending.resolve([summary("doc-old")]);
  await Promise.resolve();
  const invalidation = useDocuments.getState().load(true);
  await Promise.all([first, invalidation]);
  assert.equal(useDocuments.getState().list[0].id, "doc-latest");
  assert.equal(calls, 2);
});

await test("自身保存通知刷新不覆盖未保存正文，新建和删除通知不重复或复活条目", async () => {
  reset();
  const docs = new Map();
  const notifications = [];
  globalThis.window = {
    sinan: {
      documents: {
        list: async () =>
          [...docs.values()].map((doc) => ({
            ...summary(doc.id, doc.title),
            updatedAt: doc.updatedAt,
          })),
        save: async (doc) => {
          const saved = { ...doc, updatedAt: new Date().toISOString() };
          docs.set(doc.id, saved);
          const refreshing = useDocuments.getState().load(true);
          notifications.push(refreshing);
          await refreshing;
          return saved;
        },
        remove: async (id) => {
          docs.delete(id);
          const refreshing = useDocuments.getState().load(true);
          notifications.push(refreshing);
          await refreshing;
        },
      },
    },
  };
  await useDocuments
    .getState()
    .create([], { title: "新建资料", content: { type: "doc", content: [] } });
  const id = useDocuments.getState().selected;
  assert.equal(useDocuments.getState().list.filter((doc) => doc.id === id).length, 1);
  const draft = { ...useDocuments.getState().drafts[id], title: "编辑中的新标题" };
  useDocuments.getState().change(draft);
  await useDocuments.getState().load(true);
  assert.equal(useDocuments.getState().drafts[id], draft);
  assert.equal(useDocuments.getState().list.find((doc) => doc.id === id).title, draft.title);
  await useDocuments.getState().flush(id);
  assert.equal(useDocuments.getState().status[id], "saved");
  assert.equal(useDocuments.getState().drafts[id].title, draft.title);
  await useDocuments.getState().remove(id);
  await Promise.all(notifications);
  assert.equal(useDocuments.getState().list.length, 0);
  assert.equal(useDocuments.getState().selected, null);
  assert.equal(useDocuments.getState().drafts[id], undefined);
});

await test("批量导入和自动保存使用单篇增量通知，不重新枚举已有文档", async () => {
  reset();
  let lists = 0;
  const docs = new Map();
  globalThis.window = {
    sinan: {
      documents: {
        list: async () => {
          lists++;
          return [...docs.values()].map((doc) => summary(doc.id, doc.title));
        },
        save: async (doc) => {
          const saved = { ...doc, updatedAt: new Date().toISOString() };
          docs.set(doc.id, saved);
          useDocuments.getState().acceptChange({ document: saved });
          return saved;
        },
        remove: async (id) => {
          docs.delete(id);
          useDocuments.getState().acceptChange({ removedId: id });
        },
      },
    },
  };
  await useDocuments.getState().load();
  for (let index = 0; index < 50; index++)
    await useDocuments
      .getState()
      .create([], { title: `资料 ${index}`, content: { type: "doc", content: [] } });
  const id = useDocuments.getState().selected;
  useDocuments.getState().change({ ...useDocuments.getState().drafts[id], title: "自动保存修改" });
  await useDocuments.getState().flush(id);
  assert.equal(useDocuments.getState().list.length, 50);
  assert.equal(useDocuments.getState().list.find((doc) => doc.id === id).title, "自动保存修改");
  await useDocuments.getState().remove(id);
  await useDocuments.getState().load();
  assert.equal(lists, 1, "导入和保存没有触发全库重新枚举");
  assert.equal(useDocuments.getState().list.length, 49);
});

await test("增量通知刷新已缓存正文，保护编辑草稿，并发旧列表不能覆盖新通知", async () => {
  const initial = { ...summary("doc-notify"), content: { type: "doc", content: [] } };
  reset([summary(initial.id)]);
  useDocuments.setState({
    drafts: { [initial.id]: initial },
    status: { [initial.id]: "saved" },
    selected: initial.id,
  });
  const pending = deferred();
  bridge(() => pending.promise);
  const loading = useDocuments.getState().load();
  const latest = {
    ...initial,
    title: "增量新正文",
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "新正文" }] }],
    },
  };
  useDocuments.getState().acceptChange({ document: latest });
  pending.resolve([summary(initial.id)]);
  await loading;
  assert.equal(useDocuments.getState().drafts[initial.id], latest);
  assert.equal(useDocuments.getState().list[0].title, latest.title);
  useDocuments.setState({ status: { [initial.id]: "dirty" } });
  useDocuments.getState().acceptChange({ document: initial });
  useDocuments.getState().acceptChange({ removedId: initial.id });
  assert.equal(useDocuments.getState().drafts[initial.id], latest);
  useDocuments.setState({ status: { [initial.id]: "saved" } });
  useDocuments.getState().acceptChange({ removedId: initial.id });
  assert.equal(useDocuments.getState().selected, null);
  assert.equal(useDocuments.getState().drafts[initial.id], undefined);
});

await test("保存失败后保留最新草稿，重试只保存最新内容并清除错误", async () => {
  const id = "doc-retry-latest";
  reset([summary(id)]);
  const initial = { ...summary(id), markdown: "# 合成原文", content: { type: "doc", content: [] } };
  useDocuments.setState({ drafts: { [id]: initial }, status: { [id]: "saved" }, selected: id });
  const first = deferred();
  const writes = [];
  globalThis.window = {
    sinan: {
      documents: {
        save: async (doc) => {
          writes.push(doc);
          if (writes.length === 1) return first.promise;
          return { ...doc, updatedAt: "2026-11-03T00:00:00Z" };
        },
      },
    },
  };
  useDocuments.getState().change({ ...initial, markdown: "# 第一版" });
  const saving = useDocuments.getState().flush(id);
  const latest = { ...initial, markdown: "# 最终版\n\n保留失败期间的新修改" };
  useDocuments.getState().change(latest);
  first.reject(new Error("Synthetic disk write failure"));
  await assert.rejects(saving, /Synthetic disk write failure/);
  assert.equal(useDocuments.getState().drafts[id], latest);
  assert.equal(useDocuments.getState().status[id], "error");
  await useDocuments.getState().flush(id);
  assert.equal(writes.length, 2);
  // 请求新增了保护关联的控制字段，不再与草稿共享对象；仍逐字段确认最新正文完整提交。
  assert.deepEqual(writes[1], { ...latest, preserveBindings: true });
  assert.equal(useDocuments.getState().drafts[id].markdown, latest.markdown);
  assert.equal(useDocuments.getState().errors[id], "");
  assert.equal(useDocuments.getState().status[id], "saved");
});

delete globalThis.window;
