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
import {
  normalizeRelationSelection,
  relationSelectionDiff,
  splitRelationTargets,
} from "../src/lib/composer-relations.mjs";

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

test("关系分层跨类型聚合，横纵切换保留全部节点、边和文档虚线", () => {
  const resources = [
    row("mail", "m", "邮箱"),
    row("server", "s", "主机"),
    row("domain", "d", "域名"),
    row("secret", "a", "账号"),
    row("ai", "ai", "订阅"),
    row("document", "doc", "文档"),
  ];
  const links = [1, 2, 3, 4].map((index) => ({ from: resources[0], to: resources[index] }));
  const relations = confirmedRelations(resources, links, [
    { id: "doc", title: "文档", bindings: [resources[1]] },
  ]);
  const original = JSON.stringify({ resources, relations });
  const horizontal = resourceGraph(resources, relations, false, "relationships", resources[0]);
  const vertical = resourceGraph(resources, relations, true, "relationships", resources[0]);
  assert.equal(horizontal.nodes.length, resources.length);
  assert.deepEqual(horizontal.edges.map((e) => e.id).sort(), relations.map((r) => r.id).sort());
  assert(horizontal.edges.some((e) => e.style?.strokeDasharray === "5 4"));
  for (let i = 0; i < horizontal.nodes.length; i++) {
    assert.equal(horizontal.nodes[i].position.x / 300, vertical.nodes[i].position.y / 190);
    assert.equal(horizontal.nodes[i].position.y / 160, vertical.nodes[i].position.x / 280);
  }
  assert(
    Math.max(...horizontal.nodes.map((n) => n.position.x)) <
      Math.max(...resourceGraph(resources, relations, false).nodes.map((n) => n.position.x)),
    "不应再按六个类型平铺",
  );
  assert.equal(JSON.stringify({ resources, relations }), original, "布局不改写真实关联");
});

test("分层布局处理环路、多个连通组和孤立节点，结果稳定且卡片不重叠", () => {
  const resources = Array.from({ length: 24 }, (_, i) => row("server", `s${i}`, `主机${i}`));
  const relations = confirmedRelations(
    resources,
    [
      { from: resources[0], to: resources[1] },
      { from: resources[1], to: resources[2] },
      { from: resources[2], to: resources[0] },
      { from: resources[4], to: resources[5] },
    ],
    [],
  );
  const graph = resourceGraph(resources, relations, false, "relationships");
  assert.deepEqual(
    graph.nodes,
    resourceGraph(resources, [...relations].reverse(), false, "relationships").nodes,
    "连线输入顺序不能打乱布局",
  );
  assert.equal(new Set(graph.nodes.map((n) => n.id)).size, 24);
  for (const a of graph.nodes)
    for (const b of graph.nodes)
      if (a.id !== b.id) {
        assert(
          Math.abs(a.position.x - b.position.x) >= 220 ||
            Math.abs(a.position.y - b.position.y) >= 140,
          "卡片不能重叠",
        );
        assert(Number.isFinite(a.position.x) && Number.isFinite(a.position.y));
      }
  assert.equal(resourceGraph([], [], false, "relationships").nodes.length, 0);
});

test("新增编辑选择器去重、排除自身和悬空引用，网站账号与域名保留类型", () => {
  const entries = [
    row("mail", "m", "owner@example.test"),
    row("domain", "d", "example.test"),
    row("secret", "web", "Example", { typeLabel: "网站账号" }),
  ];
  const owner = { kind: "secret", id: "web" };
  const selected = normalizeRelationSelection(
    entries,
    [
      { kind: "mail", id: "m" },
      { kind: "mail", id: "m" },
      owner,
      { kind: "domain", id: "gone" },
      { kind: "domain", id: "d" },
    ],
    owner,
  );
  assert.deepEqual(selected, [
    { kind: "mail", id: "m" },
    { kind: "domain", id: "d" },
  ]);
  const split = splitRelationTargets([
    ...selected,
    { kind: "document", id: "doc" },
    { kind: "document", id: "doc" },
  ]);
  assert.deepEqual(split.assets, selected);
  assert.deepEqual(split.documents, [{ kind: "document", id: "doc" }]);
  const rowsWithKinds = resourceRows(
    [
      row("secret", "web", "Example"),
      row("domain", "domain", "example.test"),
    ],
    [],
    {
      servers: [],
      domains: [{ id: "domain", name: "example.test", demo: false }],
      certs: [],
      mailboxes: [],
      aiAssets: [],
      secrets: [{ id: "web", kind: "password", demo: false }],
      services: [],
      phoneNumbers: [],
      links: [],
    },
  );
  assert.equal(rowsWithKinds.find((item) => item.id === "web")?.typeLabel, "网站账号");
  assert.equal(rowsWithKinds.find((item) => item.id === "domain")?.kind, "domain");
});

test("编辑关联差异只返回新增与移除，不改变其他关系", () => {
  const before = [
    { kind: "mail", id: "m" },
    { kind: "document", id: "doc" },
  ];
  const after = [
    { kind: "domain", id: "d" },
    { kind: "document", id: "doc" },
  ];
  assert.deepEqual(relationSelectionDiff(before, after), {
    added: [{ kind: "domain", id: "d" }],
    removed: [{ kind: "mail", id: "m" }],
  });
});
