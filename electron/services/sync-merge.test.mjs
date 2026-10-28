import test from "node:test";
import assert from "node:assert/strict";
import { canonical, mergeAssets, mergeDocument, mergeVault, same } from "./sync-merge.mjs";

const item = (id, name, extra = {}) => ({ id, name, tags: [], ...extra });

test("canonical 与键顺序无关，数组顺序有关", () => {
  assert.equal(canonical({ a: 1, b: [1, 2] }), canonical({ b: [1, 2], a: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.ok(same(undefined, undefined));
  assert.ok(!same(undefined, null));
});

test("资产：只有一边改动时直接采用，没有冲突", () => {
  const base = { servers: [item("s1", "A"), item("s2", "B")], domains: [item("d1", "x.test")] };
  const local = { ...base, servers: [item("s1", "A改"), item("s2", "B")] };
  const remote = { ...base, domains: [item("d1", "x.test"), item("d2", "y.test")] };
  const { merged, conflicts } = mergeAssets(base, local, remote);
  assert.deepEqual(
    merged.servers.map((s) => s.name),
    ["A改", "B"],
  );
  assert.deepEqual(
    merged.domains.map((d) => d.id),
    ["d1", "d2"],
  );
  assert.deepEqual(conflicts, []);
});

test("资产：两边各改同一条记录的不同字段，字段级合并，不算冲突", () => {
  const base = { servers: [item("s1", "A", { region: "东京", notes: "" })] };
  const local = { servers: [item("s1", "A", { region: "大阪", notes: "" })] };
  const remote = { servers: [item("s1", "A", { region: "东京", notes: "网页写的备注" })] };
  const { merged, conflicts } = mergeAssets(base, local, remote);
  assert.equal(merged.servers[0].region, "大阪");
  assert.equal(merged.servers[0].notes, "网页写的备注");
  assert.deepEqual(conflicts, []);
});

test("资产：两边改了同一个字段，取较新的一边并记录冲突", () => {
  const base = { servers: [item("s1", "A")] };
  const local = { servers: [item("s1", "桌面名")] };
  const remote = { servers: [item("s1", "网页名")] };
  let result = mergeAssets(base, local, remote, { newer: "remote" });
  assert.equal(result.merged.servers[0].name, "网页名");
  assert.deepEqual(result.conflicts, [{ path: "servers.s1.name", kept: "remote" }]);
  result = mergeAssets(base, local, remote, { newer: "local" });
  assert.equal(result.merged.servers[0].name, "桌面名");
});

test("资产：一边删除、一边修改时保留修改；只有一边删除时才真正删除", () => {
  const base = { servers: [item("s1", "A"), item("s2", "B"), item("s3", "C")] };
  const local = { servers: [item("s2", "B"), item("s3", "C桌面改")] }; // 删了 s1，改了 s3
  const remote = { servers: [item("s1", "A网页改"), item("s2", "B")] }; // 改了 s1，删了 s3
  const { merged } = mergeAssets(base, local, remote);
  assert.deepEqual(
    merged.servers.map((s) => [s.id, s.name]),
    [
      ["s2", "B"],
      ["s3", "C桌面改"],
      ["s1", "A网页改"],
    ],
  );
  const onlyDelete = mergeAssets(
    base,
    { servers: [item("s2", "B"), item("s3", "C")] },
    base,
  ).merged;
  assert.deepEqual(
    onlyDelete.servers.map((s) => s.id),
    ["s2", "s3"],
    "另一边没动就按删除处理",
  );
});

test("资产：两边各新增不同记录都保留，网页新增排在桌面之后", () => {
  const base = { aiAssets: [item("a1", "一")] };
  const merged = mergeAssets(
    base,
    { aiAssets: [item("a1", "一"), item("a2", "桌面新增")] },
    { aiAssets: [item("a1", "一"), item("a3", "网页新增")] },
  ).merged;
  assert.deepEqual(
    merged.aiAssets.map((a) => a.id),
    ["a1", "a2", "a3"],
  );
});

test("资产：没有 id 的列表（关联）按集合合并，删除也同步", () => {
  const link = (a, b) => ({ from: { kind: "server", id: a }, to: { kind: "domain", id: b } });
  const base = { links: [link("s1", "d1"), link("s2", "d2")] };
  const local = { links: [link("s1", "d1"), link("s3", "d3")] }; // 删了 s2-d2，加了 s3-d3
  const remote = { links: [link("s1", "d1"), link("s2", "d2"), link("s4", "d4")] }; // 加了 s4-d4
  const { merged } = mergeAssets(base, local, remote);
  assert.deepEqual(merged.links.map((l) => `${l.from.id}-${l.to.id}`).sort(), [
    "s1-d1",
    "s3-d3",
    "s4-d4",
  ]);
});

test("资产：第一次同步（没有基线）按并集合并，不会丢任何一边的记录", () => {
  const { merged } = mergeAssets(
    undefined,
    { servers: [item("s1", "桌面")], domains: [item("d1", "a.test")] },
    { servers: [item("s2", "网页")], reminders: [item("r1", "续费")] },
  );
  assert.deepEqual(
    merged.servers.map((s) => s.id),
    ["s1", "s2"],
  );
  assert.equal(merged.domains.length, 1);
  assert.equal(merged.reminders.length, 1);
});

test("资产：合并不改动输入，结果是独立副本", () => {
  const local = { servers: [item("s1", "A")] };
  const remote = { servers: [item("s1", "A"), item("s2", "B")] };
  const snapshot = structuredClone([local, remote]);
  const { merged } = mergeAssets(local, local, remote);
  merged.servers[0].name = "被改了";
  assert.deepEqual([local, remote], snapshot);
});

const doc = (id, content, updatedAt, extra = {}) => ({
  id,
  title: `标题${id}`,
  content,
  updatedAt,
  ...extra,
});

test("文档：单边变化直接传播，删除只在另一边没动时传播", () => {
  const base = doc("doc-1", "a", "2026-10-01");
  const edited = doc("doc-1", "b", "2026-10-02");
  assert.deepEqual(mergeDocument(base, base, edited), { local: edited, remote: null, copy: null });
  assert.deepEqual(mergeDocument(base, edited, base), { local: null, remote: edited, copy: null });
  assert.deepEqual(mergeDocument(base, undefined, base), {
    local: null,
    remote: { delete: true },
    copy: null,
  });
  assert.deepEqual(mergeDocument(base, base, undefined), {
    local: { delete: true },
    remote: null,
    copy: null,
  });
  assert.deepEqual(mergeDocument(base, edited, edited), { local: null, remote: null, copy: null });
});

test("文档：一边删除一边修改时保留修改", () => {
  const base = doc("doc-1", "a", "2026-10-01");
  const edited = doc("doc-1", "b", "2026-10-02");
  assert.deepEqual(mergeDocument(base, undefined, edited), {
    local: edited,
    remote: null,
    copy: null,
  });
  assert.deepEqual(mergeDocument(base, edited, undefined), {
    local: null,
    remote: edited,
    copy: null,
  });
});

test("文档：两边都改时较新的作正文，另一份另存为冲突副本，内容都不丢", () => {
  const base = doc("doc-1", "a", "2026-10-01");
  const local = doc("doc-1", "桌面版内容", "2026-10-03");
  const remote = doc("doc-1", "网页版内容", "2026-10-02");
  const out = mergeDocument(base, local, remote);
  assert.equal(out.local.content, "桌面版内容");
  assert.equal(out.remote.content, "桌面版内容");
  assert.equal(out.copy.doc.content, "网页版内容");
  assert.match(out.copy.doc.id, /^doc-conflict-[0-9a-f]{12}$/);
  assert.match(out.copy.doc.title, /（冲突副本）$/);
  assert.equal(out.copy.from, "remote");
  const flipped = mergeDocument(
    base,
    doc("doc-1", "桌面", "2026-10-02"),
    doc("doc-1", "网页", "2026-10-04"),
  );
  assert.equal(flipped.local.content, "网页");
  assert.equal(flipped.copy.doc.content, "桌面");
  const tie = mergeDocument(
    base,
    doc("doc-1", "桌面", "2026-10-02"),
    doc("doc-1", "网页", "2026-10-02"),
    { newer: "remote" },
  );
  assert.equal(tie.local.content, "网页", "时间相同按调用方给的 newer 判定");
});

const sealed = (n) => ({ iv: `iv${n}`, tag: `tag${n}`, data: `data${n}` });
const vault = (records, salt = "salt-A", extra = {}) => ({
  v: 2,
  salt,
  kdf: { N: 131072, r: 8, p: 1 },
  check: sealed("check-" + salt),
  records,
  ...extra,
});

test("密钥库：同一主密码下按记录合并密文，不需要解密", () => {
  const base = vault({ a: sealed(1), b: sealed(2) });
  const local = vault({ a: sealed(1), b: sealed(2), c: sealed(3) }); // 桌面新增 c
  const remote = vault({ a: sealed(1), b: sealed("2x") }); // 网页改了 b
  const out = mergeVault(base, local, remote);
  assert.equal(out.source, "merged");
  assert.deepEqual(Object.keys(out.doc.records).sort(), ["a", "b", "c"]);
  assert.deepEqual(out.doc.records.b, sealed("2x"));
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.hard, false);
});

test("密钥库：同一条记录两边都改时保留较新的，另一份密文放进 losers 以便找回", () => {
  const base = vault({ a: sealed(1) });
  const out = mergeVault(base, vault({ a: sealed("L") }), vault({ a: sealed("R") }), {
    newer: "remote",
  });
  assert.deepEqual(out.doc.records.a, sealed("R"));
  assert.deepEqual(out.losers, [{ id: "a", record: sealed("L") }]);
  assert.deepEqual(out.conflicts, [{ path: "vault.a", kept: "remote" }]);
});

test("密钥库：一边删除、一边修改时保留修改；只有一边删除时才删除", () => {
  const base = vault({ a: sealed(1), b: sealed(2) });
  const out = mergeVault(base, vault({ b: sealed(2) }), vault({ a: sealed("1x"), b: sealed(2) }));
  assert.deepEqual(out.doc.records.a, sealed("1x"));
  const plain = mergeVault(base, vault({ b: sealed(2) }), base);
  assert.deepEqual(Object.keys(plain.doc.records), ["b"]);
});

test("密钥库：一边改了主密码（盐变了）而另一边没动，整体采用改过的一边", () => {
  const base = vault({ a: sealed(1) }, "old");
  const changed = vault({ a: sealed("re") }, "new");
  assert.equal(mergeVault(base, base, changed).source, "remote");
  assert.equal(mergeVault(base, changed, base).source, "local");
});

test("密钥库：两边主密码不同且都改过、或没有基线时不自动处理", () => {
  const base = vault({ a: sealed(1) }, "old");
  const out = mergeVault(
    base,
    vault({ a: sealed("x") }, "mine"),
    vault({ a: sealed("y") }, "theirs"),
  );
  assert.equal(out.hard, true);
  assert.equal(out.doc, null);
  assert.equal(mergeVault(undefined, vault({}, "A"), vault({}, "B")).hard, true);
  // 一边改了主密码、另一边也改了记录：同样是硬冲突，不能把新密钥的密文和旧密钥的混在一起。
  const mixed = mergeVault(
    base,
    vault({ a: sealed("z") }, "old"),
    vault({ a: sealed("re") }, "new"),
  );
  assert.equal(mixed.hard, true);
});

test("密钥库：缺一边时整体采用另一边，两边一致无需操作", () => {
  const doc1 = vault({ a: sealed(1) });
  assert.equal(mergeVault(undefined, doc1, undefined).source, "local");
  assert.equal(mergeVault(undefined, undefined, doc1).source, "remote");
  assert.equal(mergeVault(doc1, doc1, structuredClone(doc1)).source, "same");
  assert.equal(mergeVault(undefined, undefined, undefined).doc, null);
});

test("密钥库：头部相同、基线头部不同（改密后第一次合并）时不把旧密文当共同祖先", () => {
  const base = vault({ a: sealed("old-key") }, "old");
  const local = vault({ a: sealed("n1"), b: sealed("n2") }, "new");
  const remote = vault({ a: sealed("n1") }, "new");
  const out = mergeVault(base, local, remote);
  assert.deepEqual(Object.keys(out.doc.records).sort(), ["a", "b"]);
});
