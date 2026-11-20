import type { Relation, ResourceRef } from "./resource-relations.mjs";

export const RELATION_COLOR_LABELS = {
  asset: "普通关联",
  document: "文档绑定",
  phone: "号码订阅",
} as const;
export const RESOURCE_COLOR_LABELS = {
  server: "服务器",
  domain: "域名",
  mail: "邮箱",
  secret: "密钥",
  ai: "AI 订阅",
  cert: "安全证书",
  service: "服务资产",
  phone: "号码",
  node: "自建节点",
  document: "文档",
} as const;
type RelationKind = keyof typeof RELATION_COLOR_LABELS;
type ResourceKind = ResourceRef["kind"];
export interface GraphAppearance {
  mode: "relation" | "resource" | "monochrome";
  width: number;
  showLegend: boolean;
  pulseSelection: boolean;
  singleColor: string;
  relationColors: Record<RelationKind, string>;
  resourceColors: Record<ResourceKind, string>;
  overrides: Record<string, string>;
}
const RELATION_COLORS: Record<RelationKind, string> = {
  asset: "#3f6fd8",
  document: "#9561c8",
  phone: "#16866f",
};
const RESOURCE_COLORS: Record<ResourceKind, string> = {
  server: "#3f6fd8",
  domain: "#b06c19",
  mail: "#16866f",
  secret: "#9561c8",
  ai: "#b04c83",
  cert: "#727e19",
  service: "#287d9c",
  phone: "#b85c35",
  node: "#596ac0",
  document: "#9561c8",
};
export function validGraphColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function colors<K extends string>(defaults: Record<K, string>, value: unknown): Record<K, string> {
  const input = record(value);
  return Object.fromEntries(
    Object.entries(defaults).map(([key, color]) => [
      key,
      validGraphColor(input[key]) ? String(input[key]).toLowerCase() : color,
    ]),
  ) as Record<K, string>;
}
export function normalizeGraphAppearance(value: unknown): GraphAppearance {
  const input = record(value);
  return {
    mode: input.mode === "resource" || input.mode === "monochrome" ? input.mode : "relation",
    width:
      typeof input.width === "number" && Number.isFinite(input.width)
        ? Math.max(1, Math.min(5, input.width))
        : 1.8,
    showLegend: input.showLegend !== false,
    pulseSelection: input.pulseSelection !== false,
    singleColor: validGraphColor(input.singleColor) ? input.singleColor.toLowerCase() : "#6c6c67",
    relationColors: colors(RELATION_COLORS, input.relationColors),
    resourceColors: colors(RESOURCE_COLORS, input.resourceColors),
    overrides: Object.fromEntries(
      Object.entries(record(input.overrides))
        .slice(0, 2000)
        .filter(([key, color]) => key.length > 0 && key.length <= 10000 && validGraphColor(color))
        .map(([key, color]) => [key, String(color).toLowerCase()]),
    ),
  };
}
export function graphEdgeColor(value: GraphAppearance, relation: Relation) {
  return (
    (Object.hasOwn(value.overrides, relation.id) ? value.overrides[relation.id] : undefined) ??
    (value.mode === "monochrome"
      ? value.singleColor
      : value.mode === "resource"
        ? value.resourceColors[relation.from.kind]
        : value.relationColors[relation.type])
  );
}
export function graphColorLegend(value: GraphAppearance, relations: Relation[]) {
  if (value.mode === "monochrome")
    return [{ key: "monochrome", label: "全部关联", color: value.singleColor }];
  if (value.mode === "resource")
    return [...new Set(relations.map((relation) => relation.from.kind))].map((key) => ({
      key,
      label: RESOURCE_COLOR_LABELS[key],
      color: value.resourceColors[key],
    }));
  return [...new Set(relations.map((relation) => relation.type))].map((key) => ({
    key,
    label: RELATION_COLOR_LABELS[key],
    color: value.relationColors[key],
  }));
}
