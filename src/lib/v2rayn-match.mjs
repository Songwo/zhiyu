/** @param {unknown} value */
const host = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized.includes(":")) {
    try {
      return new URL(`http://[${normalized}]`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return normalized;
    }
  }
  return normalized;
};
/** @type {Record<string, string>} */
const protocolAliases = { ss: "shadowsocks", socks5: "socks", hy2: "hysteria2" };
/** @param {string} value */
const protocol = (value) => protocolAliases[value] || value;
/** @param {import('./usage').SubscriptionNode} node */
const key = (node) => {
  const type = protocol(String(node.protocol || "").toLowerCase());
  if (
    !type ||
    type === "unknown" ||
    !host(node.host) ||
    !Number.isInteger(node.port) ||
    node.port <= 0
  )
    return null;
  return `${type}|${host(node.host)}|${node.port}`;
};
/** @param {import('./usage').SubscriptionNode} node */
const name = (node) => String(node.name || "").trim();

/**
 * 只返回一对一确认的客户端配置；同目标重复配置必须有唯一名称消歧。
 * @template {import('./usage').SubscriptionNode} T
 * @param {T[]} clientNodes
 * @param {import('./usage').SubscriptionNode[]} subscriptionNodes
 * @returns {T[]}
 */
export function matchV2raynNodes(clientNodes, subscriptionNodes) {
  /** @type {Map<string | null, T[]>} */
  const clients = new Map();
  /** @type {Map<string | null, import('./usage').SubscriptionNode[]>} */
  const subscriptions = new Map();
  for (const node of clientNodes) {
    const identity = key(node);
    if (identity) clients.set(identity, [...(clients.get(identity) || []), node]);
  }
  for (const node of subscriptionNodes) {
    const identity = key(node);
    if (identity) subscriptions.set(identity, [...(subscriptions.get(identity) || []), node]);
  }
  return clientNodes.filter((node) => {
    const identity = key(node);
    const candidates = clients.get(identity) || [];
    const targets = subscriptions.get(identity) || [];
    if (candidates.length === 1 && targets.length === 1) return true;
    const label = name(node);
    return (
      !!label &&
      candidates.filter((candidate) => name(candidate) === label).length === 1 &&
      targets.filter((target) => name(target) === label).length === 1
    );
  });
}
