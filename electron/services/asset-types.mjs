/**
 * 自定义资产类型：用户给「服务资产」定义自己的类型（名称、图标和一组字段），
 * 之后按这个类型记录资产。资产本身仍是服务资产，所以费用、续费日历、标签、
 * 关联、备份和 AI 助手都照常可用。类型只保存字段定义，不保存任何凭据。
 */

export const ASSET_TYPE_ICONS = [
  "box",
  "key",
  "cloud",
  "database",
  "globe",
  "phone",
  "mail",
  "shield",
  "wrench",
  "book",
  "camera",
  "car",
  "home",
  "card",
  "gamepad",
  "package",
];
export const FIELD_KINDS = ["text", "url", "date", "number"];
export const MAX_ASSET_TYPES = 30;
export const MAX_TYPE_FIELDS = 12;
const MAX_FIELD_VALUE = 500;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** @param {unknown} value @param {number} max @param {string} message */
const text = (value, max, message) => {
  const result = value ?? "";
  if (typeof result !== "string" || result.length > max) throw new Error(message);
  return result.trim();
};

/** @param {unknown} value @returns {import('../../src/lib/types').AssetType} */
export function normalizeAssetType(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("资产类型无效。");
  const item = /** @type {Record<string, unknown>} */ (value);
  const id = text(item.id, 200, "资产类型标识无效。");
  const name = text(item.name, 40, "类型名称过长或格式不正确。");
  if (!id || FORBIDDEN.has(id) || !name) throw new Error("请填写类型名称。");
  const icon = ASSET_TYPE_ICONS.includes(/** @type {string} */ (item.icon))
    ? /** @type {string} */ (item.icon)
    : "box";
  const rawFields = item.fields ?? [];
  if (!Array.isArray(rawFields) || rawFields.length > MAX_TYPE_FIELDS)
    throw new Error(`每个类型最多 ${MAX_TYPE_FIELDS} 个字段。`);
  const seen = new Set();
  const fields = rawFields.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("字段定义无效。");
    const fieldId = text(raw.id, 100, "字段标识无效。");
    const label = text(raw.label, 40, "字段名称过长或格式不正确。");
    if (!fieldId || FORBIDDEN.has(fieldId) || !label) throw new Error("请填写字段名称。");
    if (seen.has(fieldId)) throw new Error("字段标识重复。");
    seen.add(fieldId);
    return {
      id: fieldId,
      label,
      kind: FIELD_KINDS.includes(raw.kind) ? raw.kind : "text",
    };
  });
  return { id, name, icon, fields };
}

/** @param {unknown} value @param {boolean} [strict] @returns {import('../../src/lib/types').AssetType[]} */
export function normalizeAssetTypes(value, strict = true) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ASSET_TYPES) {
    if (strict) throw new Error(`资产类型列表无效或超过 ${MAX_ASSET_TYPES} 个。`);
    return [];
  }
  const result = [],
    ids = new Set();
  for (const entry of value) {
    try {
      const item = normalizeAssetType(entry);
      if (ids.has(item.id)) throw new Error("资产类型标识重复。");
      ids.add(item.id);
      result.push(item);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return result;
}

/** 资产里的自定义字段值：只保留字符串，数量与长度有上限。
 * @param {unknown} value @returns {Record<string, string> | undefined} */
export function normalizeFieldValues(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("自定义字段无效。");
  const entries = Object.entries(value);
  if (entries.length > MAX_TYPE_FIELDS) throw new Error("自定义字段过多。");
  /** @type {Record<string, string>} */
  const result = {};
  for (const [key, raw] of entries) {
    if (!key || key.length > 100 || FORBIDDEN.has(key)) throw new Error("自定义字段标识无效。");
    if (typeof raw !== "string" || raw.length > MAX_FIELD_VALUE)
      throw new Error("自定义字段值过长或格式不正确。");
    const trimmed = raw.trim();
    if (trimmed) result[key] = trimmed;
  }
  return Object.keys(result).length ? result : undefined;
}
