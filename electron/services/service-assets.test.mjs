import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeService, normalizeServices, serviceUrl } from "./service-assets.mjs";
import { normalizeSnapshotImages } from "./image-data.mjs";
import { assetDocuments } from "./rag.mjs";
import { DocumentsStore } from "./documents.mjs";
import { WorkspaceActions } from "./workspace-actions.mjs";
import { assetRows, filterAssetRows } from "../../src/lib/asset-view.ts";
import { assetEntries, normalizeLinks, updateAssetTags } from "../../src/lib/operations.ts";
import { tagIndex } from "../../src/lib/tags.ts";
import {
  resourceRows,
  confirmedRelations,
  resourceGraph,
} from "../../src/lib/resource-relations.mjs";
import { mergeSnapshotChange } from "../../src/lib/snapshot-merge.ts";

const service = (patch = {}) => ({
  id: "svc-test",
  name: "合成博客",
  category: "blog",
  url: "https://blog.example.test/",
  provider: "Cloudflare",
  status: "online",
  notes: "不应进入模型的敏感备注",
  tags: ["项目"],
  ...patch,
});
const snapshot = () => ({
  servers: [],
  domains: [],
  mailboxes: [],
  aiAssets: [],
  certs: [],
  secrets: [{ id: "account", name: "关联账号", tags: [], status: "online", kind: "account" }],
  services: [service()],
  links: [],
});

test("旧数据无 services 时保持兼容，服务导入只保留公开字段并规范标签", () => {
  assert.deepEqual(normalizeServices(undefined), []);
  const old = { servers: [], domains: [], certs: [], mailboxes: [], aiAssets: [], secrets: [] };
  assert.deepEqual(normalizeSnapshotImages(old), old);
  assert.equal(assetEntries(old).length, 0);
  const record = normalizeService(
    service({ password: "do-not-persist", token: "secret", tags: [" 项目 ", "项目"] }),
  );
  assert.equal(record.password, undefined);
  assert.equal(record.token, undefined);
  assert.deepEqual(record.tags, ["项目"]);
  assert.deepEqual(normalizeSnapshotImages({ state: { services: [record] } }).state.services, [
    record,
  ]);
});

test("服务地址与导入边界拒绝脚本、内嵌凭据、无效状态及重复标识", () => {
  assert.equal(serviceUrl(""), "");
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/a",
    "https://user:pass@example.test",
    "example.test",
  ])
    assert.throws(() => normalizeService(service({ url })));
  for (const patch of [
    { name: "" },
    { status: "invented" },
    { category: "server" },
    { tags: [1] },
    { id: "__proto__" },
  ])
    assert.throws(() => normalizeService(service(patch)));
  assert.throws(() => normalizeServices([service(), service()]));
  assert.deepEqual(normalizeServices([service(), { id: "invalid" }], false), [service()]);
});

test("服务加入列表、标签、关系与并发快照合并且不被旧快照覆盖", () => {
  const state = snapshot();
  assert.ok(assetEntries(state).some((row) => row.kind === "service"));
  const rows = assetRows(state);
  assert.equal(filterAssetRows(rows, "services", "博客", false, []).length, 1);
  assert.deepEqual(tagIndex(state)[0].byKind, [{ kind: "service", count: 1 }]);
  const link = { from: { kind: "service", id: "svc-test" }, to: { kind: "secret", id: "account" } };
  assert.deepEqual(normalizeLinks([link], state), [link]);
  assert.deepEqual(updateAssetTags(state, [link.from], "新分组", "add").services[0].tags, [
    "项目",
    "新分组",
  ]);
  const resources = resourceRows(rows, [], state);
  const graph = resourceGraph(resources, confirmedRelations(resources, [link], []));
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  const next = structuredClone(state),
    local = structuredClone(state);
  next.services[0].name = "远端更名";
  local.services[0].notes = "本地正在编辑";
  const merged = mergeSnapshotChange(local, { before: state, snapshot: next });
  assert.equal(merged.services[0].name, "远端更名");
  assert.equal(merged.services[0].notes, "本地正在编辑");
});

test("Agent 检索服务元数据但不发送 URL 查询凭据或自由备注", () => {
  const state = snapshot();
  state.services[0].url += "?token=not-for-model";
  state.services[0].password = "do-not-index";
  const document = assetDocuments(state).find((item) => item.kind === "service");
  assert.equal(document.assetId, "svc-test");
  assert.match(document.text, /合成博客/);
  assert.match(document.text, /Cloudflare/);
  assert.doesNotMatch(JSON.stringify(document), /not-for-model|do-not-index|不应进入模型/);
});

test("服务可绑定文档，Agent 确认提案后才能写入服务关联", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhiyu-service-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const documents = new DocumentsStore(directory);
  let state = snapshot();
  await documents.save({
    id: "doc-service",
    title: "服务部署说明",
    content: { type: "doc", content: [] },
    bindings: [{ kind: "service", id: "svc-test" }],
  });
  assert.equal((await documents.get("doc-service")).bindings[0].kind, "service");
  const actions = new WorkspaceActions({
    documents,
    getSnapshot: () => state,
    mutateAssets: async (mutate) => {
      state = mutate(state);
      return { snapshot: state };
    },
  });
  const proposal = await actions.propose("propose_asset_link", {
    from: { kind: "service", id: "svc-test" },
    to: { kind: "secret", id: "account" },
    reason: "用户指定博客使用该账号",
  });
  assert.equal(state.links.length, 0);
  await actions.apply(proposal.id);
  assert.equal(state.links.length, 1);
  assert.equal(state.links[0].from.kind, "service");
});

test("服务绑定：主机必填，端口、协议、容器名、域名按格式校验，保存后不丢失", async () => {
  const { normalizeService, normalizeEndpoint } = await import("./service-assets.mjs");
  const base = { id: "svc", name: "博客", category: "custom", status: "online", tags: [] };
  const bound = normalizeService({
    ...base,
    endpoint: {
      serverId: "s1",
      port: "2368",
      proto: "tcp",
      container: "ghost_1",
      domainId: "d1",
      extra: "x",
    },
  });
  assert.deepEqual(bound.endpoint, {
    serverId: "s1",
    port: 2368,
    proto: "tcp",
    container: "ghost_1",
    domainId: "d1",
  });
  assert.equal(normalizeService(base).endpoint, undefined);
  assert.equal(normalizeEndpoint(null), undefined);
  for (const bad of [
    { port: 80 },
    { serverId: "" },
    { serverId: "s1", port: 0 },
    { serverId: "s1", port: 70000 },
    { serverId: "s1", port: 1.5 },
    { serverId: "s1", proto: "icmp" },
    { serverId: "s1", container: "bad name; rm -rf /" },
    { serverId: "s1", container: "x".repeat(81) },
    { serverId: "__proto__" },
    ["s1"],
  ])
    assert.throws(() => normalizeEndpoint(bad), Error, JSON.stringify(bad));
});
