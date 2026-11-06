/** @typedef {import('../../src/lib/types').ResourceRef} ResourceRef */
/** @typedef {import('../../src/lib/types').Snapshot} Snapshot */
export const RESOURCE_COLLECTIONS = /** @type {const} */ ({
  server: "servers",
  domain: "domains",
  mail: "mailboxes",
  ai: "aiAssets",
  secret: "secrets",
  cert: "certs",
  service: "services",
  phone: "phoneNumbers",
});
export const RESOURCE_KINDS = new Set([...Object.keys(RESOURCE_COLLECTIONS), "document", "node"]);

/** @param {unknown} value @returns {value is ResourceRef} */
export function isResourceRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = /** @type {ResourceRef} */ (value);
  return (
    RESOURCE_KINDS.has(ref.kind) &&
    typeof ref.id === "string" &&
    ref.id.trim().length > 0 &&
    ref.id.length <= (ref.kind === "node" ? 1024 : 256) &&
    (ref.kind !== "node" || Boolean(nodeOwner(ref.id)))
  );
}
/** @param {ResourceRef} ref */
export const resourceRefKey = (ref) => JSON.stringify([ref.kind, ref.id]);
/** @param {ResourceRef} a @param {ResourceRef} b */
export const resourcePairKey = (a, b) =>
  JSON.stringify([resourceRefKey(a), resourceRefKey(b)].sort());
/** @param {string} serverId @param {string} nodeId */
export const nodeResourceId = (serverId, nodeId) => JSON.stringify([serverId, nodeId]);
/** @param {string} id @returns {{serverId:string,nodeId:string}|null} */
export function nodeOwner(id) {
  try {
    const parts = JSON.parse(id);
    return Array.isArray(parts) &&
      parts.length === 2 &&
      parts.every((part) => typeof part === "string" && part.trim() && part.length <= 256)
      ? { serverId: parts[0], nodeId: parts[1] }
      : null;
  } catch {
    return null;
  }
}
/** 文档独立存储，是否存在由文档服务确认，不能把尚未读取的文档误删。
 * @param {Partial<Snapshot>} snapshot @returns {Set<string>}
 */
export function snapshotResourceKeys(snapshot) {
  const keys = new Set();
  for (const [kind, collection] of Object.entries(RESOURCE_COLLECTIONS))
    for (const item of snapshot[collection] ?? []) {
      const ref = { kind, id: item?.id };
      if (isResourceRef(ref)) keys.add(resourceRefKey(ref));
    }
  for (const server of snapshot.servers ?? [])
    for (const node of server.nodes ?? []) {
      const ref = { kind: "node", id: nodeResourceId(server.id, node.id) };
      if (isResourceRef(ref)) keys.add(resourceRefKey(ref));
    }
  return keys;
}
/** @param {unknown} value @param {Partial<Snapshot>} snapshot
 * @returns {Array<{from:ResourceRef,to:ResourceRef}>}
 */
export function normalizeResourceLinks(value, snapshot) {
  if (!Array.isArray(value)) return [];
  const known = snapshotResourceKeys(snapshot),
    seen = new Set();
  return value.flatMap((link) => {
    if (!isResourceRef(link?.from) || !isResourceRef(link?.to)) return [];
    const { from, to } = link;
    if (resourceRefKey(from) === resourceRefKey(to)) return [];
    if ([from, to].some((ref) => ref.kind !== "document" && !known.has(resourceRefKey(ref))))
      return [];
    const key = resourcePairKey(from, to);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ from: { kind: from.kind, id: from.id }, to: { kind: to.kind, id: to.id } }];
  });
}
/** 仅在号码编辑时同步旧订阅字段，不影响号码与其他资源的联系。
 * @param {Partial<Snapshot>} snapshot @param {import('../../src/lib/types').PhoneNumber} phone
 * @param {ResourceRef[] | undefined} [targets]
 */
export function replacePhoneRelations(snapshot, phone, targets) {
  const owner = { kind: /** @type {const} */ ("phone"), id: phone.id };
  const current = normalizeResourceLinks(snapshot.links, snapshot);
  const kept = current.filter(({ from, to }) => {
    const other =
      resourceRefKey(from) === resourceRefKey(owner)
        ? to
        : resourceRefKey(to) === resourceRefKey(owner)
          ? from
          : null;
    return !other || (targets === undefined && other.kind !== "ai");
  });
  const selected =
    targets ?? phone.subscriptionIds.map((id) => ({ kind: /** @type {const} */ ("ai"), id }));
  const list = snapshot.phoneNumbers ?? [];
  const phoneNumbers = list.some((p) => p.id === phone.id)
    ? list.map((p) => (p.id === phone.id ? phone : p))
    : [phone, ...list];
  const links = normalizeResourceLinks([...kept, ...selected.map((to) => ({ from: owner, to }))], {
    ...snapshot,
    phoneNumbers,
  });
  return { phoneNumbers, links };
}

/** @param {Partial<Snapshot>} snapshot @param {ResourceRef} from @param {ResourceRef} to @param {boolean} [remove] */
export function mutateResourceRelation(snapshot, from, to, remove = false) {
  if (!isResourceRef(from) || !isResourceRef(to) || resourceRefKey(from) === resourceRefKey(to))
    throw new Error("请选择两项不同的有效资源。");
  const known = snapshotResourceKeys(snapshot);
  if (
    !remove &&
    [from, to].some((ref) => ref.kind !== "document" && !known.has(resourceRefKey(ref)))
  )
    throw new Error("关联资源已不存在，请刷新后重试。");
  const key = resourcePairKey(from, to);
  const links = normalizeResourceLinks(
    [
      ...normalizeResourceLinks(snapshot.links, snapshot).filter(
        (link) => resourcePairKey(link.from, link.to) !== key,
      ),
      ...(remove ? [] : [{ from, to }]),
    ],
    snapshot,
  );
  const phoneRef = from.kind === "phone" ? from : to.kind === "phone" ? to : null;
  const aiRef = from.kind === "ai" ? from : to.kind === "ai" ? to : null;
  const phoneNumbers = (snapshot.phoneNumbers ?? []).map((phone) =>
    phoneRef?.id === phone.id && aiRef
      ? {
          ...phone,
          subscriptionIds: remove
            ? phone.subscriptionIds.filter((id) => id !== aiRef.id)
            : [...new Set([...phone.subscriptionIds, aiRef.id])],
        }
      : phone,
  );
  return { links, phoneNumbers };
}

/** @param {Partial<Snapshot>} snapshot @param {{exists:(id:string)=>Promise<boolean>}} documents */
export async function assertDocumentLinks(snapshot, documents) {
  const ids = new Set(
    (snapshot.links ?? []).flatMap((link) =>
      [link.from, link.to].filter((ref) => ref.kind === "document").map((ref) => ref.id),
    ),
  );
  for (const id of ids)
    if (!(await documents.exists(id))) throw Error("关联文档已不存在，请刷新后重试。");
}
