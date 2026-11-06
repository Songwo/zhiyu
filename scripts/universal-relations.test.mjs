import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import {
  createBackup,
  openBackup,
  stageRestore,
  applyPendingRestore,
} from "../electron/services/backup.mjs";
import { LocalIndex, assetDocuments } from "../electron/services/rag.mjs";
import { WorkspaceKnowledge } from "../electron/services/workspace-knowledge.mjs";
import { WorkspaceActions } from "../electron/services/workspace-actions.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeResourceLinks,
  mutateResourceRelation,
  nodeResourceId,
  resourcePairKey,
  replacePhoneRelations,
} from "../electron/services/resource-links.mjs";
import { normalizeSnapshotImages } from "../electron/services/image-data.mjs";
import {
  confirmedRelations,
  canRelateResources,
  relationPaths,
  resourceGraph,
} from "../src/lib/resource-relations.mjs";
import { DocumentsStore } from "../electron/services/documents.mjs";
import { mergeAssets } from "../electron/services/sync-merge.mjs";

import {
  universalRelationFixture as fixture,
  RELATION_TIME as now,
} from "./universal-relations-fixture.mjs";

test("AI 概览保留核心资产计数，号码与节点另列且不制造异常", async () => {
  const { snapshot } = fixture();
  const index = new LocalIndex(snapshot, []);
  const summary = index.summary();
  assert.equal(summary.total, 17);
  assert.equal(summary.resourceTotal, 21);
  assert.equal(summary.resourceCounts.phone, 2);
  assert.equal(summary.resourceCounts.node, 2);
  assert.equal(
    summary.attention.some((item) => /asset:(phone|node):/.test(item.sourceId)),
    false,
  );
});

test("所有资源组合均可添加、反向去重、往返和解除，包括卡片、号码、节点和文档", () => {
  const { snapshot, documents, resources } = fixture();
  let pairs = 0;
  for (let i = 0; i < resources.length; i++)
    for (let j = i + 1; j < resources.length; j++) {
      const a = resources[i],
        b = resources[j],
        key = resourcePairKey(a, b);
      assert.equal(canRelateResources(a, b), true, key);
      assert.equal(canRelateResources(b, a), true, key);
      let next = { ...snapshot, ...mutateResourceRelation(snapshot, a, b) };
      next = { ...next, ...mutateResourceRelation(next, b, a) };
      const restored = normalizeSnapshotImages(JSON.parse(JSON.stringify(next)));
      const relations = confirmedRelations(resources, restored.links, documents);
      assert.equal(
        relations.filter((link) => resourcePairKey(link.from, link.to) === key).length,
        1,
        key,
      );
      assert.equal(
        relationPaths(resources, relations, a).some(
          (path) => path.row.id === b.id && path.row.kind === b.kind,
        ),
        true,
        key,
      );
      assert.equal(resourceGraph(resources, relations, false).edges.length, 1, key);
      const removed = mutateResourceRelation(restored, b, a, true);
      assert.equal(confirmedRelations(resources, removed.links, documents).length, 0, key);
      pairs++;
    }
  assert.equal(pairs, 253);
  assert.equal(JSON.stringify(resources).includes("PRIVATE"), false);
});

test("删除号码、节点或父主机会清理关联，同 ID 的其他类型不受影响", () => {
  const { snapshot } = fixture();
  const p = { kind: "phone", id: "phone-a" },
    n = { kind: "node", id: nodeResourceId("server-a", "same-node") },
    s = { kind: "server", id: "server-b" };
  const linked = {
    ...snapshot,
    links: [
      { from: p, to: s },
      { from: n, to: s },
      { from: { kind: "node", id: nodeResourceId("server-b", "same-node") }, to: p },
    ],
  };
  assert.equal(normalizeResourceLinks(linked.links, { ...linked, phoneNumbers: [] }).length, 1);
  assert.equal(
    normalizeResourceLinks(linked.links, {
      ...linked,
      servers: linked.servers.filter((server) => server.id !== "server-a"),
    }).length,
    2,
  );
  assert.equal(canRelateResources(p, p), false);
  assert.equal(canRelateResources(p, { kind: "unknown", id: "x" }), false);
  assert.equal(
    normalizeResourceLinks([{ from: { kind: "node", id: "bad" }, to: s }], linked).length,
    0,
  );
});

test("旧订阅关联兼容且可双向解除，编辑订阅不清除号码与服务器、文档的关联", () => {
  const { snapshot, resources, documents } = fixture();
  const p = { ...snapshot.phoneNumbers[0], subscriptionIds: ["ai-a"] };
  const base = {
    ...snapshot,
    phoneNumbers: [p],
    links: [
      { from: { kind: "phone", id: p.id }, to: { kind: "server", id: "server-a" } },
      { from: { kind: "phone", id: p.id }, to: { kind: "document", id: "doc-a" } },
    ],
  };
  const next = replacePhoneRelations(base, p);
  assert.equal(confirmedRelations(resources, next.links, documents).length, 3);
  const removed = mutateResourceRelation(
    { ...base, ...next },
    { kind: "ai", id: "ai-a" },
    { kind: "phone", id: p.id },
    true,
  );
  assert.equal(removed.phoneNumbers[0].subscriptionIds.length, 0);
  assert.equal(removed.links.length, 2);
  assert.equal(normalizeResourceLinks(next.links, { ...base, phoneNumbers: [p] }).length, 3);
});

test("跨端合并保留不同类型关系，文档列表尚未读取时不丢文档引用", () => {
  const { snapshot } = fixture();
  const a = { from: { kind: "phone", id: "phone-a" }, to: { kind: "document", id: "doc-a" } };
  const b = {
    from: { kind: "node", id: nodeResourceId("server-a", "same-node") },
    to: { kind: "service", id: "card-esim" },
  };
  const merged = mergeAssets(
    snapshot,
    { ...snapshot, links: [a] },
    { ...snapshot, links: [b] },
  ).merged;
  assert.equal(normalizeResourceLinks(merged.links, merged).length, 2);
});

test("绑定元信息与正文保存共用队列，正文保存不覆盖绑定，删除后不复活", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-universal-doc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DocumentsStore(root);
  const base = {
    id: "doc-relations",
    title: "正文保护",
    bindings: [],
    createdAt: now,
    updatedAt: now,
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "原始正文" }] }],
    },
  };
  await store.save(base);
  const changed = {
    ...base,
    title: "最新标题",
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "用户继续编辑的正文" }] }],
    },
    preserveBindings: true,
  };
  await Promise.all([
    store.bind(base.id, { kind: "server", id: "server-a" }),
    store.save(changed),
    store.bind(base.id, { kind: "mail", id: "mail-a" }),
  ]);
  const saved = await store.get(base.id);
  assert.deepEqual(saved.content, changed.content);
  assert.equal(saved.title, changed.title);
  assert.equal(saved.bindings.length, 2);
  assert.equal(
    (await readFile(join(root, base.id + ".json"), "utf8")).includes("preserveBindings"),
    false,
  );
  await store.bind(base.id, { kind: "server", id: "server-a" }, true);
  assert.equal((await store.get(base.id)).bindings.length, 1);
  await store.remove(base.id);
  await assert.rejects(store.save(changed), /已删除/);
  await assert.rejects(store.get(base.id), { code: "ENOENT" });
  // 缺失文档不能因为绑定操作被重新创建。
  await assert.rejects(store.bind(base.id, { kind: "server", id: "server-a" }), { code: "ENOENT" });
});

test("通用关联经过实际加密备份、恢复到另一目录后完整保留", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "zhiyu-relations-backup-"));
  const target = await mkdtemp(join(tmpdir(), "zhiyu-relations-restored-"));
  t.after(() =>
    Promise.all([
      rm(source, { recursive: true, force: true }),
      rm(target, { recursive: true, force: true }),
    ]),
  );
  const { snapshot, resources, documents } = fixture();
  snapshot.links = resources.slice(1).map((to) => ({
    from: { kind: resources[0].kind, id: resources[0].id },
    to: { kind: to.kind, id: to.id },
  }));
  await writeFile(join(source, "assets.json"), JSON.stringify({ version: 0, state: snapshot }));
  await mkdir(join(source, "documents"));
  for (const doc of documents)
    await writeFile(
      join(source, "documents", doc.id + ".json"),
      JSON.stringify({ ...doc, content: { type: "doc", content: [] } }),
    );
  const { data } = await createBackup({ root: source, password: "relations-backup-test-2026" });
  const backup = await openBackup(data, "relations-backup-test-2026");
  await stageRestore({ root: target, backup });
  await applyPendingRestore(target);
  const restored = normalizeSnapshotImages(
    JSON.parse(await readFile(join(target, "assets.json"), "utf8")),
  ).state;
  assert.deepEqual(restored.links, snapshot.links);
  assert.equal(
    confirmedRelations(resources, restored.links, documents).length,
    resources.length - 1,
  );
});

test("AI 关联查询能读号码、节点和文档之间的关系，不能读号码或节点凭据", async () => {
  const { snapshot, documents } = fixture();
  Object.defineProperty(snapshot.phoneNumbers[0], "number", {
    get() {
      throw Error("不得读取号码");
    },
  });
  Object.defineProperty(snapshot.servers[0].nodes[0], "password", {
    get() {
      throw Error("不得读取节点密码");
    },
  });
  Object.defineProperty(snapshot.servers[0].nodes[0], "rawUri", {
    get() {
      throw Error("不得读取节点配置");
    },
  });
  const node = nodeResourceId("server-a", "same-node");
  snapshot.links = [
    { from: { kind: "phone", id: "phone-a" }, to: { kind: "document", id: "doc-a" } },
    { from: { kind: "node", id: node }, to: { kind: "phone", id: "phone-a" } },
    { from: { kind: "document", id: "doc-a" }, to: { kind: "document", id: "doc-b" } },
  ];
  assert.equal(JSON.stringify(assetDocuments(snapshot)).includes("PRIVATE"), false);
  const knowledge = new WorkspaceKnowledge({
    snapshot,
    index: new LocalIndex(snapshot, []),
    documents: {
      list: async () => documents,
      get: async () => {
        throw Error("不得读取正文");
      },
    },
    signal: new AbortController().signal,
    allowDocumentContent: false,
  });
  await knowledge.load();
  const phoneRelations = knowledge.related({ sourceId: "asset:phone:phone-a" });
  assert.equal(phoneRelations.total, 2);
  assert.equal(
    phoneRelations.resources.every((ref) => ref.exists),
    true,
  );
  const documentRelations = knowledge.related({ sourceId: "workspace-document:doc-a" });
  assert.equal(documentRelations.total, 2);
  assert.equal(
    documentRelations.resources.some((ref) => ref.documentId === "doc-b"),
    true,
  );
  assert.equal(JSON.stringify(documentRelations).includes("PRIVATE"), false);
});

test("AI 关联建议覆盖全部资源组合，确认前不写入，也不会清除已有通用关联", async () => {
  const { snapshot, resources, documents } = fixture();
  let current = structuredClone(snapshot);
  const actions = new WorkspaceActions({
    getSnapshot: () => current,
    documents: {
      list: async () => documents,
      get: async () => {
        throw Error("不应读取正文");
      },
    },
    mutateAssets: async (fn) => {
      current = fn(current);
      return { snapshot: current };
    },
  });
  for (let i = 0; i < resources.length; i++)
    for (let j = i + 1; j < resources.length; j++) {
      current = structuredClone(snapshot);
      const from = { kind: resources[i].kind, id: resources[i].id },
        to = { kind: resources[j].kind, id: resources[j].id };
      const proposal = await actions.propose("propose_asset_link", {
        from,
        to,
        reason: "用户明确要求建立这条测试关联",
      });
      assert.equal(current.links.length, 0);
      await actions.apply(proposal.id);
      assert.equal(current.links.length, 1, resourcePairKey(from, to));
      assert.equal(
        resourcePairKey(current.links[0].from, current.links[0].to),
        resourcePairKey(from, to),
      );
    }
  current = {
    ...snapshot,
    links: [
      { from: { kind: "phone", id: "phone-a" }, to: { kind: "document", id: "doc-a" } },
      {
        from: { kind: "node", id: nodeResourceId("server-a", "same-node") },
        to: { kind: "service", id: "card-esim" },
      },
    ],
  };
  const proposal = await actions.propose("propose_asset_link", {
    from: { kind: "server", id: "server-a" },
    to: { kind: "mail", id: "mail-a" },
    reason: "保留其他关联的回归",
  });
  await actions.apply(proposal.id);
  assert.equal(current.links.length, 3);
});
