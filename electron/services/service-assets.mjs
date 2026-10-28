import { normalizeIntegrationRef } from "./integration-ref.mjs";
import { calendarDay, normalizeBilling } from "./renewals.mjs";
import { normalizeFieldValues } from "./asset-types.mjs";
const CATEGORIES = new Set(["worker", "blog", "mail", "custom"]);
const STATUSES = new Set(["online", "warning", "offline"]);

/** @param {unknown} value @returns {string} */
export function serviceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("服务地址无效。");
  const input = value.trim();
  if (!input) return "";
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("服务地址需为完整的 HTTP 或 HTTPS 链接。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("服务地址需为不含账号密码的 HTTP 或 HTTPS 链接。");
  return url.href;
}

/** 服务资产绑定的位置：主机必填，端口、容器、域名按需。 @param {unknown} value */
export function normalizeEndpoint(value) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("服务绑定无效。");
  const item = /** @type {Record<string, unknown>} */ (value);
  const text = (/** @type {string} */ key, /** @type {number} */ max) => {
    const result = item[key];
    if (result == null || result === "") return "";
    if (typeof result !== "string" || result.length > max)
      throw new Error("服务绑定字段过长或格式不正确。");
    return result.trim();
  };
  const serverId = text("serverId", 200);
  if (!serverId || ["__proto__", "prototype", "constructor"].includes(serverId))
    throw new Error("服务绑定需要选择主机。");
  const out = /** @type {import('../../src/lib/server-services').ServiceEndpoint} */ ({ serverId });
  if (item.port != null && item.port !== "") {
    const port = Number(item.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("端口需要是 1–65535 的整数。");
    out.port = port;
  }
  if (item.proto != null && item.proto !== "") {
    if (item.proto !== "tcp" && item.proto !== "udp")
      throw new Error("端口协议只能是 TCP 或 UDP。");
    out.proto = item.proto;
  }
  const container = text("container", 80);
  if (container) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(container))
      throw new Error("容器名称格式不正确。");
    out.container = container;
  }
  const domainId = text("domainId", 200);
  if (domainId) out.domainId = domainId;
  return out;
}

/** @param {unknown} value @returns {import('../../src/lib/types').ServiceAsset} */
export function normalizeService(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("服务资产无效。");
  const item = /** @type {Record<string, unknown>} */ (value);
  const text = (/** @type {string} */ key, /** @type {number} */ max) => {
    const result = item[key] ?? "";
    if (typeof result !== "string" || result.length > max)
      throw new Error("服务资产字段过长或格式不正确。");
    return result.trim();
  };
  const id = text("id", 200),
    name = text("name", 160);
  if (!id || !name || ["__proto__", "prototype", "constructor"].includes(id))
    throw new Error("请填写服务名称和有效标识。");
  if (typeof item.category !== "string" || !CATEGORIES.has(item.category))
    throw new Error("服务类型无效。");
  if (typeof item.status !== "string" || !STATUSES.has(item.status))
    throw new Error("服务状态无效。");
  const tags = item.tags ?? [];
  if (
    !Array.isArray(tags) ||
    tags.length > 100 ||
    tags.some((tag) => typeof tag !== "string" || tag.length > 100)
  )
    throw new Error("服务标签无效。");
  const expiresAt = calendarDay(item.expiresAt);
  const typeId = text("typeId", 200);
  const fields = normalizeFieldValues(item.fields);
  const billing = normalizeBilling(item.billing);
  const endpoint = normalizeEndpoint(item.endpoint);
  return {
    id,
    name,
    category: /** @type {import('../../src/lib/types').ServiceAsset['category']} */ (item.category),
    url: serviceUrl(item.url ?? ""),
    provider: text("provider", 160),
    status: /** @type {import('../../src/lib/types').Status} */ (item.status),
    notes: text("notes", 20000),
    tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))],
    ...(typeof item.imageDataUrl === "string" ? { imageDataUrl: item.imageDataUrl } : {}),
    ...(item.demo === true ? { demo: true } : {}),
    ...(item.integration == null ? {} : { integration: normalizeIntegrationRef(item.integration) }),
    ...(expiresAt ? { expiresAt } : {}),
    ...(billing ? { billing } : {}),
    ...(typeId ? { typeId } : {}),
    ...(fields ? { fields } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

/** @param {unknown} value @param {boolean} [strict] @returns {import('../../src/lib/types').ServiceAsset[]} */
export function normalizeServices(value, strict = true) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10000) {
    if (strict) throw new Error("服务资产列表无效或超过 10000 项。");
    return [];
  }
  const result = [],
    ids = new Set();
  for (const entry of value) {
    try {
      const item = normalizeService(entry);
      if (ids.has(item.id)) throw new Error("服务资产标识重复。");
      ids.add(item.id);
      result.push(item);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return result;
}
