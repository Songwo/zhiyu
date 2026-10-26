import { createHash } from "node:crypto";
import { normalizeIntegrationRef } from "./integration-ref.mjs";
import { normalizeService } from "./service-assets.mjs";

export const ASSET_COLLECTIONS = { domain: "domains", service: "services", server: "servers" };
export function sameIntegration(a, b) {
  return Boolean(
    a &&
    b &&
    a.provider === b.provider &&
    a.connectionId === b.connectionId &&
    a.resourceType === b.resourceType &&
    a.remoteId === b.remoteId &&
    (a.accountId ?? "") === (b.accountId ?? ""),
  );
}

function expiryStatus(expiresAt, now = Date.now()) {
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) return "warning";
  const days = Math.ceil((time - now) / 86_400_000);
  return days <= 7 ? "offline" : days <= 21 ? "warning" : "online";
}

/**
 * 以 Cloudflare 为准的域名字段：NS、DNS 服务商，以及在 Cloudflare 注册时的到期日与自动续费。
 * 备注、标签、费用等用户填写的资料不动；Cloudflare 没提供到期日时保留已有值。
 */
export function syncZoneFields(domain, resource, now = Date.now()) {
  const zone = resource.zone;
  if (!zone) return domain;
  const next = { ...domain, dns: "Cloudflare" };
  if (zone.nameServers?.length) next.nameservers = zone.nameServers;
  if (zone.createdOn && !next.createdAt) next.createdAt = zone.createdOn;
  if (zone.registrar) next.registrar = zone.registrar;
  if (zone.expiresAt) next.expiresAt = zone.expiresAt.slice(0, 10);
  if (zone.autoRenew !== undefined) next.autoRenew = zone.autoRenew;
  next.status = next.expiresAt ? expiryStatus(next.expiresAt, now) : "warning";
  return next;
}

/** 把已绑定到此连接的域名资产与最新的远端信息对齐，返回更新数量。 */
export function syncBoundZones(snapshot, connection, resources, now = Date.now()) {
  let updated = 0;
  const domains = (snapshot.domains ?? []).map((domain) => {
    const ref = domain.integration;
    if (!ref || ref.provider !== "cloudflare" || ref.connectionId !== connection.id) return domain;
    const resource = resources.find(
      (row) =>
        row.type === "zone" &&
        row.remoteId === ref.remoteId &&
        (row.accountId ?? "") === (ref.accountId ?? ""),
    );
    if (!resource) return domain;
    const next = syncZoneFields(domain, resource, now);
    if (JSON.stringify(next) !== JSON.stringify(domain)) updated += 1;
    return next;
  });
  return { snapshot: { ...snapshot, domains }, updated };
}

/** 用户确认的来源绑定；重复导入只补引用，保留用户已编辑的公开资料。 */
export function bindResource(snapshot, connection, resource, assetId) {
  const integration = normalizeIntegrationRef({
    provider: connection.provider,
    connectionId: connection.id,
    resourceType: resource.type,
    remoteId: resource.remoteId,
    accountId: resource.accountId,
  });
  const kind =
    resource.type === "zone" ? "domain" : resource.type === "host" ? "server" : "service";
  const collection = ASSET_COLLECTIONS[kind];
  const items = snapshot[collection] ?? [];
  const duplicate = items.find((a) => sameIntegration(a.integration, integration));
  const selected = assetId ? items.find((a) => a.id === assetId) : duplicate;
  if (assetId && !selected) throw new Error("选择的本地资产已不存在。");
  if (duplicate && selected && duplicate.id !== selected.id)
    throw new Error("这个远端资源已绑定其他资产，请先解除原绑定。");
  if (selected?.integration && !sameIntegration(selected.integration, integration))
    throw new Error("资产已有其他接入来源，请先解除原绑定。");
  const id =
    selected?.id ??
    "cloud-" + createHash("sha256").update(JSON.stringify(integration)).digest("hex").slice(0, 32);
  if (!selected && items.some((a) => a.id === id))
    throw new Error("导入标识已存在，请选择已有资产绑定。");
  const base = { id, name: resource.name, tags: [], notes: "", integration };
  let item;
  if (selected) item = { ...selected, integration };
  else if (kind === "domain")
    item = {
      ...base,
      registrar: "",
      expiresAt: "",
      dns: "Cloudflare",
      nameservers: [],
      autoRenew: false,
      status: "warning",
    };
  else if (kind === "server")
    item = {
      ...base,
      label: "",
      host: "",
      port: 22,
      username: "root",
      sshConfigured: false,
      os: resource.host?.os ?? "",
      region: "",
      status: "warning",
      cpu: 0,
      memory: 0,
      disk: 0,
      uptime: "",
      lastSeen: "",
    };
  else
    item = normalizeService({
      ...base,
      category: resource.type === "worker" ? "worker" : "custom",
      url: resource.url,
      provider: connection.provider === "cloudflare" ? "Cloudflare" : "知屿探针",
      status: "warning",
    });
  if (kind === "domain") item = syncZoneFields(item, resource);
  return {
    snapshot: {
      ...snapshot,
      [collection]: selected ? items.map((a) => (a.id === id ? item : a)) : [...items, item],
    },
    asset: { kind, id },
  };
}

export function unbindResource(snapshot, { kind, id }) {
  const collection = Object.hasOwn(ASSET_COLLECTIONS, kind) ? ASSET_COLLECTIONS[kind] : null;
  if (!collection || typeof id !== "string") throw new Error("资产引用无效。");
  const items = snapshot[collection] ?? [];
  if (!items.some((a) => a.id === id)) throw new Error("资产已不存在。");
  return {
    ...snapshot,
    [collection]: items.map((a) => {
      if (a.id !== id) return a;
      const copy = { ...a };
      delete copy.integration;
      return copy;
    }),
  };
}
