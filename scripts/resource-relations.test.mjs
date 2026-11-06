import test from "node:test";
import assert from "node:assert/strict";
import {
  resourceRows,
  resourceKey,
  confirmedRelations,
  relatedResources,
  suggestRelations,
  resourceGraph,
  resourceRelationPath,
  relationPaths,
  canRelateResources,
} from "../src/lib/resource-relations.mjs";

const row = (kind, id, name, extra = {}) => ({
  kind,
  id,
  name,
  detail: "",
  tags: [],
  status: "online",
  search: name.toLowerCase(),
  ...extra,
});
const rows = [
  row("server", "same", "example.test"),
  row("secret", "same", "Project account"),
  row("domain", "domain", "example.test"),
];
const doc = {
  id: "doc-one",
  title: "example.test 部署手册",
  bindings: [{ kind: "secret", id: "same" }],
  excerpt: "PRIVATE BODY",
  content: { text: "PRIVATE BODY" },
};
const snapshot = {
  servers: [{ id: "same", host: "example.test" }],
  domains: [{ id: "domain", name: "example.test" }],
  secrets: [{ id: "same", value: "PRIVATE PASSWORD" }],
  mailboxes: [],
  certs: [],
  aiAssets: [],
};

test("邮箱—账号—主机—文档链双向最短路径，环路/孤立/悬空不伪造依赖", () => {
  const resources = [
    row("mail", "mail", "邮箱"),
    row("secret", "account", "账号"),
    row("server", "host", "主机"),
    row("document", "doc", "文档"),
    row("domain", "alone", "孤立域名"),
  ];
  const link = (from, to) => ({ from: resources[from], to: resources[to], type: "asset" });
  const relations = [
    link(0, 1),
    link(1, 2),
    link(2, 3),
    link(3, 1),
    { from: resources[0], to: { kind: "secret", id: "missing" } },
  ];
  const paths = relationPaths(resources, relations, resources[0]);
  assert.equal(paths.length, 4);
  assert.equal(paths.find((p) => p.row.id === "doc").distance, 2);
  assert.deepEqual(
    paths.find((p) => p.row.id === "doc").path.map((p) => p.id),
    ["mail", "account", "doc"],
  );
  assert.equal(
    relationPaths(resources, relations, resources[3]).find((p) => p.row.id === "mail").distance,
    2,
  );
  assert.deepEqual(relationPaths(resources, relations, { kind: "server", id: "missing" }), []);
});

test("号码兼容已有订阅绑定，隐私不进入节点，并允许通用资源关联", () => {
  const s = {
    ...snapshot,
    phoneNumbers: [
      {
        id: "phone",
        label: "保号",
        number: "PRIVATE NUMBER",
        numberHint: "••••1234",
        subscriptionIds: ["ai-1", "missing"],
        expiresAt: "2026-12-01",
      },
    ],
  };
  const resources = resourceRows([...rows, row("ai", "ai-1", "订阅")], [], s);
  const phone = resources.find((r) => r.kind === "phone");
  assert.ok(phone);
  assert.equal(JSON.stringify(phone).includes("PRIVATE"), false);
  const links = confirmedRelations(resources, [], []);
  assert.equal(links.length, 1);
  assert.equal(links[0].type, "phone");
  // 新需求允许号码关联文档与服务器，旧版拒绝该组合的断言不再适用。
  assert.equal(canRelateResources(phone, { kind: "document", id: "d" }), true);
  assert.equal(canRelateResources(phone, { kind: "server", id: "s" }), true);
  assert.equal(canRelateResources(phone, { kind: "ai", id: "ai-1" }), true);
});

test("关系节点读取文档标题与绑定，凭据和正文不进入图或建议", () => {
  const resources = resourceRows(rows, [doc], snapshot);
  assert.equal(resources.length, 4);
  assert.equal(new Set(resources.map(resourceKey)).size, 4);
  assert.equal(JSON.stringify(resources).includes("PRIVATE"), false);
});
test("当前账号图带出相连的服务器和文档，孤立资源保持独立", () => {
  const resources = resourceRows(rows, [doc], snapshot);
  const relations = confirmedRelations(resources, [{ from: rows[0], to: rows[1] }], [doc]);
  assert.equal(relations.length, 2);
  const visible = relatedResources(resources, relations, [rows[1]]);
  assert.deepEqual(
    visible.map((x) => x.kind),
    ["server", "secret", "document"],
  );
  assert.equal(resourceGraph(visible, relations, false).edges.length, 2);
});
test("无效目标、自连与重复绑定不制造虚假关系", () => {
  const resources = resourceRows(rows, [doc], snapshot);
  const duplicate = {
    ...doc,
    bindings: [...doc.bindings, ...doc.bindings, { kind: "server", id: "deleted" }],
  };
  const relations = confirmedRelations(
    resources,
    [
      { from: rows[0], to: rows[1] },
      { from: rows[1], to: rows[0] },
      { from: rows[0], to: rows[0] },
      { from: rows[0], to: { kind: "mail", id: "deleted" } },
    ],
    [duplicate],
  );
  assert.equal(relations.length, 2);
  assert.equal(resourceGraph(resources, relations, true).nodes.length, 4);
});
test("关联发现显示地址/标题依据，但未确认前不写入图", () => {
  const resources = resourceRows(rows, [doc], snapshot);
  const before = JSON.stringify(resources);
  const suggestions = suggestRelations(resources, []);
  assert.ok(suggestions.some((x) => x.basis === "host" && x.evidence === "example.test"));
  assert.ok(suggestions.some((x) => x.basis === "title"));
  assert.equal(resourceGraph(resources, [], false).edges.length, 0);
  assert.equal(JSON.stringify(resources), before);
  assert.equal(suggestRelations(resources, suggestions).length, 0);
});
test("通用标签、演示数据与名称片段不产生误导建议", () => {
  const resources = [
    row("server", "a", "host-one", { tags: ["prod"] }),
    row("secret", "b", "account", { tags: ["prod"] }),
    row("document", "c", "host-oner 说明"),
    row("server", "demo", "demo", { demo: true, host: "same.test" }),
    row("domain", "d", "same.test", { host: "same.test" }),
  ];
  assert.deepEqual(suggestRelations(resources, []), []);
});
test("专属标签可建议账号组合，重复共同标签只出现一条", () => {
  const resources = [
    row("secret", "a", "First", { tags: ["项目海岸", "项目二"] }),
    row("secret", "b", "Second", { tags: ["项目海岸", "项目二"] }),
  ];
  const suggestions = suggestRelations(resources, []);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].basis, "tag");
});

test("无向关联按画布方向连接，跨列文档绑定从卡片外侧绕行", () => {
  const resources = resourceRows(rows, [doc], snapshot);
  const relations = confirmedRelations(resources, [{ from: rows[0], to: rows[1] }], [doc]);
  const graph = resourceGraph(resources, relations, false);
  const saved = graph.edges.find((edge) => edge.data.relation.type === "asset");
  assert.equal(saved.source, encodeURIComponent(resourceKey(rows[1])));
  assert.equal(saved.target, encodeURIComponent(resourceKey(rows[0])));
  const binding = graph.edges.find((edge) => edge.data.relation.type === "document");
  assert.equal(binding.type, "resource");
  assert.equal(binding.data.bypass, true);
  assert.equal(saved.data.bypass, false);
  assert.equal(binding.target, encodeURIComponent(resourceKey({ kind: "document", id: doc.id })));
  assert.deepEqual(
    binding.data.relation.from,
    { kind: "document", id: doc.id },
    "显示方向不改变实际绑定",
  );
});

test("同类型多排和第二排跨列关系使用区域外侧通道，竖屏保持相同拓扑", () => {
  const resources = [
    row("secret", "a", "A"),
    row("secret", "b", "B"),
    row("server", "c", "C"),
    row("domain", "d", "D"),
  ];
  const relations = confirmedRelations(
    resources,
    [
      { from: resources[0], to: resources[1] },
      { from: resources[1], to: resources[3] },
      { from: resources[1], to: resources[2] },
    ],
    [],
  );
  for (const vertical of [false, true]) {
    const graph = resourceGraph(resources, relations, vertical);
    assert.deepEqual(
      graph.edges.map((edge) => edge.data.bypass),
      [true, true, false],
    );
    assert.ok(graph.edges.every((edge) => edge.data.vertical === vertical));
    const input = {
      sourceX: 220,
      sourceY: 190,
      targetX: 560,
      targetY: 190,
      vertical: false,
      bypass: true,
      lane: -64,
    };
    const path = resourceRelationPath(
      vertical
        ? {
            ...input,
            sourceX: input.sourceY,
            sourceY: input.sourceX,
            targetX: input.targetY,
            targetY: input.targetX,
            vertical: true,
          }
        : input,
    );
    assert.ok(path.includes("-64"), "跨列多排应绕到所有节点外侧，不能从卡片上方穿过前一排");
    assert.doesNotMatch(path, /NaN|Infinity/);
    assert.ok(path.endsWith(vertical ? "L 190 560" : "L 560 190"));
  }
});

test("相邻同排连接及同列回环路径始终保留有效端点", () => {
  for (const target of [
    { targetX: 280, targetY: 50, bypass: false },
    { targetX: 0, targetY: 190, bypass: true },
  ]) {
    const path = resourceRelationPath({
      sourceX: 220,
      sourceY: 50,
      ...target,
      vertical: false,
      lane: -40,
    });
    assert.ok(path.startsWith("M 220 50"));
    assert.ok(path.endsWith(`L ${target.targetX} ${target.targetY}`));
    assert.doesNotMatch(path, /NaN|Infinity/);
  }
});
