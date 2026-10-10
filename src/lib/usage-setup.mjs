const types = new Set(["3x-ui", "subscription", "openai-api", "anthropic-api"]);
/** @param {unknown} value @param {number} limit */
const text = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

/**
 * 页面跳转只传资产归属；凭据始终在当前表单和加密存储之间传递。
 * @param {unknown} input
 * @returns {import("./store").UsageSetupDraft & {name: string; type: NonNullable<import("./store").UsageSetupDraft["type"]>}}
 */
export function normalizeUsageDraft(input) {
  const value =
    input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  const type =
    typeof value.type === "string" && types.has(value.type)
      ? /** @type {NonNullable<import("./store").UsageSetupDraft["type"]>} */ (value.type)
      : "3x-ui";
  const serverId = text(value.serverId, 256);
  const nodeId = text(value.nodeId, 256);
  return {
    type,
    ...(serverId ? { serverId } : {}),
    ...(nodeId ? { nodeId } : {}),
    name: text(value.name, 160),
  };
}

/** @param {unknown} input @returns {Record<string, string>} */
export function usageFormFromDraft(input) {
  const draft = normalizeUsageDraft(input);
  const traffic = draft.type === "3x-ui" || draft.type === "subscription";
  return {
    name: draft.name,
    type: draft.type,
    url: "",
    username: "",
    password: "",
    apiKey: "",
    inboundId: "",
    clientEmail: "",
    nodeId: traffic && draft.serverId && draft.nodeId ? `${draft.serverId}:${draft.nodeId}` : "",
  };
}

/** 编辑只使用公开来源信息；所有凭据留空，由后端保留原值。
 * @param {import('./usage').UsageSource} source
 * @returns {Record<string, string>}
 */
export function usageFormFromSource(source) {
  const form = usageFormFromDraft({ name: source.name, type: source.type });
  if (form.type === "3x-ui" || form.type === "subscription") form.nodeId = source.nodeId ?? "";
  return form;
}
