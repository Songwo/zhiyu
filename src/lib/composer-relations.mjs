import { resourceRefKey } from "../../electron/services/resource-links.mjs";

/** @typedef {import("./types").ResourceRef} ResourceRef */
/** @typedef {Pick<ResourceRef, "kind" | "id">} ResourceEntry */

/**
 * 只保留仍存在、非自身且不重复的关联目标。旧快照里的悬空引用在这里安全丢弃。
 * @param {ResourceEntry[]} entries
 * @param {ResourceRef[]} selected
 * @param {ResourceRef|null} [owner]
 * @returns {ResourceRef[]}
 */
export function normalizeRelationSelection(entries, selected, owner = null) {
  const known = new Set(entries.map((entry) => resourceRefKey(entry)));
  const ownerKey = owner ? resourceRefKey(owner) : null;
  const seen = new Set();
  return (Array.isArray(selected) ? selected : []).filter((ref) => {
    if (!ref || typeof ref.kind !== "string" || typeof ref.id !== "string") return false;
    const key = resourceRefKey(ref);
    if (key === ownerKey || seen.has(key) || !known.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 普通资源继续进入 links；文档由文档绑定接口单独保存。
 * @param {ResourceRef[]} targets
 * @returns {{assets:ResourceRef[],documents:ResourceRef[]}}
 */
export function splitRelationTargets(targets) {
  const unique = [];
  const seen = new Set();
  for (const ref of Array.isArray(targets) ? targets : []) {
    const key = resourceRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  /** @type {ResourceRef[]} */
  const documents = [];
  /** @type {ResourceRef[]} */
  const assets = [];
  for (const ref of unique) (ref.kind === "document" ? documents : assets).push(ref);
  return { assets, documents };
}

/**
 * 找出旧快照中被存储为普通 links 的文档关系，保存时保留并供失败回滚。
 * @param {Array<{from:ResourceRef,to:ResourceRef}>} links
 * @param {ResourceRef} owner
 * @returns {ResourceRef[]}
 */
export function linkedDocumentTargets(links, owner) {
  const ownerKey = resourceRefKey(owner);
  const result = [];
  const seen = new Set();
  for (const link of Array.isArray(links) ? links : []) {
    const other =
      resourceRefKey(link.from) === ownerKey
        ? link.to
        : resourceRefKey(link.to) === ownerKey
          ? link.from
          : null;
    if (other?.kind !== "document") continue;
    const key = resourceRefKey(other);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(other);
  }
  return result;
}

/**
 * 比较编辑前后的完整目标集合，供保存失败时补偿。
 * @param {ResourceRef[]} before
 * @param {ResourceRef[]} after
 */
export function relationSelectionDiff(before, after) {
  const previous = new Set((before ?? []).map(resourceRefKey));
  const next = new Set((after ?? []).map(resourceRefKey));
  return {
    added: (after ?? []).filter((ref) => !previous.has(resourceRefKey(ref))),
    removed: (before ?? []).filter((ref) => !next.has(resourceRefKey(ref))),
  };
}
