import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGraphAppearance, graphEdgeColor, graphColorLegend } from "./graph-appearance.ts";
import type { Relation } from "./resource-relations.mjs";

const asset: Relation = {
  id: "asset-edge",
  from: { kind: "mail", id: "m" },
  to: { kind: "server", id: "s" },
  type: "asset",
};
const doc: Relation = {
  id: "doc-edge",
  from: { kind: "document", id: "d" },
  to: { kind: "server", id: "s" },
  type: "document",
};
test("缺失或损坏偏好使用默认配色，不接受任意 CSS 值", () => {
  const defaults = normalizeGraphAppearance(null);
  assert.equal(defaults.pulseSelection, true);
  assert.equal(normalizeGraphAppearance({ pulseSelection: false }).pulseSelection, false);
  assert.deepEqual(normalizeGraphAppearance([]), defaults);
  const actual = normalizeGraphAppearance({
    mode: "invalid",
    width: Infinity,
    relationColors: { asset: "url(https://invalid.test)" },
    singleColor: "red",
    overrides: { a: "var(--x)", b: "#ABCDEF" },
  });
  assert.equal(actual.relationColors.asset, defaults.relationColors.asset);
  assert.equal(actual.singleColor, defaults.singleColor);
  assert.equal(actual.width, 1.8);
  assert.deepEqual(actual.overrides, { b: "#abcdef" });
  assert.equal(normalizeGraphAppearance({ width: 999 }).width, 5);
  assert.equal(normalizeGraphAppearance({ width: -1 }).width, 1);
});
test("分组、资源、单色模式和单条覆盖按优先级生效", () => {
  const settings = normalizeGraphAppearance(null);
  assert.notEqual(graphEdgeColor(settings, asset), graphEdgeColor(settings, doc));
  settings.mode = "resource";
  assert.equal(graphEdgeColor(settings, asset), settings.resourceColors.mail);
  settings.mode = "monochrome";
  assert.equal(graphEdgeColor(settings, doc), settings.singleColor);
  settings.overrides[doc.id] = "#ff0000";
  assert.equal(graphEdgeColor(settings, doc), "#ff0000");
  delete settings.overrides[doc.id];
  assert.equal(graphEdgeColor(settings, doc), settings.singleColor);
  assert.equal(graphEdgeColor(settings, { ...asset, id: "constructor" }), settings.singleColor);
});
test("偏好序列化后保持自定义与图例，且不改动真实关系", () => {
  const original = JSON.stringify([asset, doc]);
  const settings = normalizeGraphAppearance({
    relationColors: { asset: "#123456" },
    width: 3,
    showLegend: false,
    overrides: { [doc.id]: "#ff2200" },
  });
  const restored = normalizeGraphAppearance(JSON.parse(JSON.stringify(settings)));
  assert.deepEqual(restored, settings);
  assert.deepEqual(
    graphColorLegend(restored, [asset, doc, asset]).map((item) => item.key),
    ["asset", "document"],
  );
  assert.equal(graphColorLegend(restored, [asset])[0].color, "#123456");
  assert.equal(JSON.stringify([asset, doc]), original);
});
