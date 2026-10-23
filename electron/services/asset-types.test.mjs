import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAssetType, normalizeAssetTypes, normalizeFieldValues } from "./asset-types.mjs";
import { normalizeService } from "./service-assets.mjs";
import { normalizeSnapshotImages } from "./image-data.mjs";

const type = (patch = {}) => ({
  id: "type-nas",
  name: "家用 NAS",
  icon: "database",
  fields: [
    { id: "f-ip", label: "内网地址", kind: "text" },
    { id: "f-buy", label: "购入日期", kind: "date" },
  ],
  ...patch,
});

test("类型：名称、图标与字段经过清理，未知图标和字段类型回退", () => {
  const result = normalizeAssetType(
    type({
      icon: "nope",
      name: "  家用 NAS ",
      fields: [{ id: "a", label: " 容量 ", kind: "weird" }],
    }),
  );
  assert.equal(result.name, "家用 NAS");
  assert.equal(result.icon, "box");
  assert.deepEqual(result.fields, [{ id: "a", label: "容量", kind: "text" }]);
});

test("类型：拒绝空名称、危险标识、重复字段与过多字段", () => {
  assert.throws(() => normalizeAssetType(type({ name: "  " })), /类型名称/);
  assert.throws(() => normalizeAssetType(type({ id: "__proto__" })));
  assert.throws(() =>
    normalizeAssetType(
      type({
        fields: [
          { id: "a", label: "一" },
          { id: "a", label: "二" },
        ],
      }),
    ),
  );
  assert.throws(() =>
    normalizeAssetType(
      type({ fields: Array.from({ length: 13 }, (_, i) => ({ id: `f${i}`, label: `字段${i}` })) }),
    ),
  );
});

test("类型列表：宽松模式丢弃坏数据，严格模式报错，标识不能重复", () => {
  assert.equal(normalizeAssetTypes([type(), { id: "bad" }], false).length, 1);
  assert.throws(() => normalizeAssetTypes([type(), { id: "bad" }]));
  assert.throws(() => normalizeAssetTypes([type(), type()]));
  assert.deepEqual(normalizeAssetTypes(undefined), []);
});

test("字段值：只保留非空字符串，限制数量与长度", () => {
  assert.deepEqual(normalizeFieldValues({ a: " 1 ", b: "  " }), { a: "1" });
  assert.equal(normalizeFieldValues({ a: "" }), undefined);
  assert.equal(normalizeFieldValues(undefined), undefined);
  assert.throws(() => normalizeFieldValues({ a: 1 }));
  assert.throws(() => normalizeFieldValues({ a: "x".repeat(501) }));
  assert.throws(() => normalizeFieldValues(["a"]));
  assert.throws(() => normalizeFieldValues({ __proto__x: "1", constructor: "2" }));
});

test("服务资产带上类型与字段，快照校验同时清理类型列表", () => {
  const service = normalizeService({
    id: "svc-1",
    name: "客厅 NAS",
    category: "custom",
    url: "",
    provider: "",
    status: "online",
    notes: "",
    tags: [],
    typeId: "type-nas",
    fields: { "f-ip": "192.168.1.8" },
  });
  assert.equal(service.typeId, "type-nas");
  assert.deepEqual(service.fields, { "f-ip": "192.168.1.8" });
  const snapshot = normalizeSnapshotImages({ assetTypes: [type()], services: [service] });
  assert.equal(snapshot.assetTypes.length, 1);
  assert.equal(snapshot.services[0].fields["f-ip"], "192.168.1.8");
  assert.throws(() => normalizeSnapshotImages({ assetTypes: [{ id: "x" }] }));
});

test("AI 索引带上自定义类型名与字段，没有类型时保持原样", async () => {
  const { assetDocuments } = await import("./rag.mjs");
  const service = {
    id: "svc-1",
    name: "客厅 NAS",
    category: "custom",
    status: "online",
    tags: [],
    typeId: "type-nas",
    fields: { "f-ip": "192.168.1.8", "f-buy": "2025-01-02" },
  };
  const snapshot = {
    servers: [],
    domains: [],
    mailboxes: [],
    aiAssets: [],
    secrets: [],
    certs: [],
    services: [service],
    assetTypes: [type()],
  };
  const doc = assetDocuments(snapshot).find((item) => item.assetId === "svc-1");
  assert.equal(doc.fields.assetType, "家用 NAS");
  assert.equal(doc.fields["field 内网地址"], "192.168.1.8");
  const plain = assetDocuments({ ...snapshot, assetTypes: [] }).find(
    (item) => item.assetId === "svc-1",
  );
  assert.equal(plain.fields.assetType, undefined);
});
