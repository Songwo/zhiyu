/**
 * ZSP 的三方合并：基线（上次同步后的状态）、桌面、网页。全部是纯函数，不碰文件和网络。
 *
 * 原则（见 docs/SYNC.md）：
 *  - 只有一边改过就采用那一边；
 *  - 一边删除、一边修改时保留修改，宁可多留也不丢；
 *  - 两边改了同一个值时取较新的一方，并把这次取舍记入 conflicts，让界面能告诉用户；
 *  - 文档整篇冲突时另存「冲突副本」；密钥库在密文层按记录合并，不需要也不会解密。
 */
import { createHash } from "node:crypto";

/** 键排序的稳定序列化，用于比较结构相等。 */
export function canonical(value) {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const same = (a, b) => canonical(a) === canonical(b);
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasIds = (list) =>
  Array.isArray(list) && list.every((item) => isObject(item) && typeof item.id === "string");
const MAX_DEPTH = 24;

/**
 * 两端各自采集的遥测字段：值随时在变，谁采到都算数，不该触发同步，也不算「冲突」。
 * 名字只在资产记录（集合里的每一项）内部生效；顶层的集合名不受影响。
 */
export const VOLATILE_FIELDS = new Set([
  "cpu",
  "memory",
  "disk",
  "uptime",
  "lastSeen",
  "loadavg",
  "kernel",
  "memTotalKb",
  "diskTotalKb",
  "probedAt",
  "probeError",
  "serviceScan",
  "usageCheckedAt",
  "usageSummary",
  "usageAvailable",
  "usageStale",
  "usageScope",
  "usagePct",
]);
/** 去掉每条资产记录里的遥测字段，用于比较「用户有没有改过」。 */
export function stripVolatile(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const out = {};
  for (const [key, value] of Object.entries(state)) {
    out[key] = Array.isArray(value)
      ? value.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(
                Object.entries(item).filter(([field]) => !VOLATILE_FIELDS.has(field)),
              )
            : item,
        )
      : value;
  }
  return out;
}

const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
/** 内容哈希：与键顺序和文件排版无关，两端对同一份内容总是得到同一个值。 */
export const hashValue = digest;
/** 文档的创建与保存时间由各端自己写入，不参与内容比较，否则每次同步都会互相覆盖。 */
export const stripDocument = (doc) => {
  if (!doc) return doc;
  const { createdAt: _created, updatedAt: _updated, ...rest } = doc;
  return rest;
};
export const hashDocument = (doc) => digest(stripDocument(doc));

/**
 * 三方合并任意 JSON 值。
 * @param newer 两边改了同一个值时保留哪一边（"local" 或 "remote"）
 */
function mergeValue(path, base, local, remote, ctx, depth = 0) {
  if (same(local, remote)) return clone(local);
  if (same(local, base)) return clone(remote);
  if (same(remote, base)) return clone(local);
  // 到这里两边都改了且不相同。删除与修改冲突：保留修改。
  if (local === undefined) return clone(remote);
  if (remote === undefined) return clone(local);
  if (depth > MAX_DEPTH) return pick(path, local, remote, ctx);

  if (Array.isArray(local) && Array.isArray(remote)) {
    const baseList = Array.isArray(base) ? base : [];
    if (hasIds(local) && hasIds(remote) && hasIds(baseList))
      return mergeById(path, baseList, local, remote, ctx, depth);
    return mergeSet(baseList, local, remote);
  }
  if (isObject(local) && isObject(remote)) {
    const baseObject = isObject(base) ? base : {};
    const out = {};
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      // 遥测字段静默取较新的一边，不记入冲突。
      const quiet = depth >= 1 && VOLATILE_FIELDS.has(key);
      const merged = mergeValue(
        [...path, key],
        baseObject[key],
        local[key],
        remote[key],
        quiet ? { newer: ctx.newer, conflicts: [] } : ctx,
        depth + 1,
      );
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }
  return pick(path, local, remote, ctx);
}

function pick(path, local, remote, ctx) {
  ctx.conflicts.push({ path: path.join("."), kept: ctx.newer });
  return clone(ctx.newer === "local" ? local : remote);
}

/** 带 id 的记录列表：顺序以桌面为准，网页新增的追加在后面。 */
function mergeById(path, base, local, remote, ctx, depth) {
  const byId = (list) => new Map(list.map((item) => [item.id, item]));
  const [b, l, r] = [byId(base), byId(local), byId(remote)];
  const order = [...l.keys(), ...[...r.keys()].filter((id) => !l.has(id))];
  const out = [];
  for (const id of order) {
    const merged = mergeValue([...path, id], b.get(id), l.get(id), r.get(id), ctx, depth + 1);
    if (merged !== undefined) out.push(merged);
  }
  return out;
}

/** 没有 id 的列表（例如资产关联）按集合合并：(基线∩桌面∩网页) ∪ 桌面新增 ∪ 网页新增。 */
function mergeSet(base, local, remote) {
  const keyed = (list) => new Map(list.map((item) => [canonical(item), item]));
  const [b, l, r] = [keyed(base), keyed(local), keyed(remote)];
  const out = [];
  const seen = new Set();
  for (const [key, item] of [...l, ...r]) {
    if (seen.has(key)) continue;
    seen.add(key);
    const inBase = b.has(key);
    // 基线里有、却有一边没有 = 那一边删除了它。
    if (inBase && (!l.has(key) || !r.has(key))) continue;
    out.push(clone(item));
  }
  return out;
}

/** 合并资产快照（assets.json 里的 state）。 */
export function mergeAssets(base, local, remote, { newer = "local" } = {}) {
  const ctx = { newer, conflicts: [] };
  const merged = mergeValue([], base ?? undefined, local ?? {}, remote ?? {}, ctx) ?? {};
  return { merged, conflicts: ctx.conflicts };
}

// ———— 文档 ————

const sha = digest;
const sameDocument = (a, b) => same(stripDocument(a), stripDocument(b));

/**
 * 合并一篇文档。返回要在两边执行的动作；`copy` 是需要另存的冲突副本。
 * 任何一边缺失表示该边没有这篇文档。
 */
export function mergeDocument(base, local, remote, { newer = "local" } = {}) {
  const none = { local: null, remote: null, copy: null };
  if (sameDocument(local, remote)) return none;
  if (sameDocument(local, base)) return { ...none, local: remote ?? { delete: true } };
  if (sameDocument(remote, base)) return { ...none, remote: local ?? { delete: true } };
  // 两边都改了：删除与修改冲突保留修改。
  if (!local) return { ...none, local: remote };
  if (!remote) return { ...none, remote: local };
  const time = (doc) => Date.parse(doc.updatedAt ?? "") || 0;
  const winner =
    time(local) === time(remote) ? newer : time(local) > time(remote) ? "local" : "remote";
  const [main, other] = winner === "local" ? [local, remote] : [remote, local];
  const copy = {
    ...other,
    id: `doc-conflict-${sha(other).slice(0, 12)}`,
    title: `${other.title ?? ""}（冲突副本）`,
  };
  return {
    local: main,
    remote: main,
    copy: { doc: copy, from: winner === "local" ? "remote" : "local" },
  };
}

// ———— 密钥库（只比较密文，不解密） ————

const sameHeader = (a, b) =>
  !!a && !!b && a.v === b.v && a.salt === b.salt && same(a.kdf, b.kdf) && same(a.check, b.check);
const recordsOf = (doc) => (doc && isObject(doc.records) ? doc.records : {});
const sameRecords = (a, b) => same(recordsOf(a), recordsOf(b));

/**
 * 合并密钥库文档。结果的 `source` 说明采用了哪一份：
 *  - "same"：两边一致，无需操作；
 *  - "local" / "remote"：整体采用一边；
 *  - "merged"：同一主密码下按记录合并；
 *  - hard=true：无法自动处理（两边主密码不同且都改过），需要用户选择。
 */
export function mergeVault(base, local, remote, { newer = "local" } = {}) {
  const result = (extra) => ({
    doc: null,
    source: "same",
    conflicts: [],
    losers: [],
    hard: false,
    ...extra,
  });
  if (!local && !remote) return result({});
  if (!local) return result({ doc: remote, source: "remote" });
  if (!remote) return result({ doc: local, source: "local" });
  if (same(local, remote)) return result({});

  if (!sameHeader(local, remote)) {
    // 主密码（盐或参数）不同。只有一边改过时整体采用那一边。
    const localChanged = base ? !sameHeader(local, base) || !sameRecords(local, base) : true;
    const remoteChanged = base ? !sameHeader(remote, base) || !sameRecords(remote, base) : true;
    if (localChanged && !remoteChanged) return result({ doc: local, source: "local" });
    if (remoteChanged && !localChanged) return result({ doc: remote, source: "remote" });
    return result({ hard: true });
  }

  // 头部一致：基线头部不同则把基线当作空，避免把旧密钥加密的记录当共同祖先。
  const baseRecords = base && sameHeader(base, local) ? recordsOf(base) : {};
  const l = recordsOf(local);
  const r = recordsOf(remote);
  const records = {};
  const conflicts = [];
  const losers = [];
  for (const id of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const [b0, l0, r0] = [baseRecords[id], l[id], r[id]];
    if (same(l0, r0)) {
      if (l0) records[id] = l0;
    } else if (same(l0, b0)) {
      if (r0) records[id] = r0;
    } else if (same(r0, b0)) {
      if (l0) records[id] = l0;
    } else if (!l0) records[id] = r0;
    else if (!r0) records[id] = l0;
    else {
      records[id] = newer === "local" ? l0 : r0;
      losers.push({ id, record: newer === "local" ? r0 : l0 });
      conflicts.push({ path: `vault.${id}`, kept: newer });
    }
  }
  const doc = { ...local, records };
  return result({
    doc,
    source: same(doc, local) ? "local" : same(doc, remote) ? "remote" : "merged",
    conflicts,
    losers,
  });
}
