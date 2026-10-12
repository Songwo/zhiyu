/** 持久化的接入引用仅包含公开标识，忽略供应商返回的其他字段。
 * @param {unknown} value
 * @returns {import('../../src/lib/integrations').IntegrationRef | undefined}
 */
export function normalizeIntegrationRef(value) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("接入引用无效。");
  const v = /** @type {Record<string, unknown>} */ (value);
  if (v.provider !== "cloudflare" && v.provider !== "probe") throw new Error("接入来源无效。");
  const allowed =
    v.provider === "cloudflare" ? ["zone", "worker", "pages", "tunnel"] : ["host", "check"];
  if (!allowed.includes(String(v.resourceType))) throw new Error("远端资源类型无效。");
  const text = (/** @type {unknown} */ s) => {
    if (
      typeof s !== "string" ||
      !s.trim() ||
      s.length > 256 ||
      [...s].some((c) => c.charCodeAt(0) < 32)
    )
      throw new Error("远端资源标识无效。");
    return s.trim();
  };
  return {
    provider: v.provider,
    connectionId: text(v.connectionId),
    resourceType: /** @type {import('../../src/lib/integrations').IntegrationResourceType} */ (
      v.resourceType
    ),
    remoteId: text(v.remoteId),
    ...(v.accountId === undefined ? {} : { accountId: text(v.accountId) }),
  };
}
