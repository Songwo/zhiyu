import { phoneExpiry } from "../../electron/services/phone-numbers.mjs";
import { isResourceRef, nodeResourceId } from "../../electron/services/resource-links.mjs";
/** @typedef {import('./asset-view').AssetRow} AssetRow */
/** @typedef {import('./types').Snapshot} Snapshot */
/** @typedef {import('./documents').DocumentSummary} DocumentSummary */
/** @typedef {import('./types').ResourceRef} ResourceRef */
/** @typedef {Omit<AssetRow, 'kind'> & ResourceRef & {demo?: boolean, host?: string, typeLabel?:string, subscriptionIds?: string[]}} ResourceRow */
/** @typedef {{id: string, from: ResourceRef, to: ResourceRef, type: 'asset' | 'document' | 'phone'}} Relation */

/** @param {ResourceRef} ref */
export const resourceKey = (ref) => JSON.stringify([ref.kind, ref.id]);
/** @param {ResourceRef} from @param {ResourceRef} to */
export const relationKey = (from, to) =>
  JSON.stringify([resourceKey(from), resourceKey(to)].sort());

/** 图与建议只使用公开元数据，绝不取账号凭据、文档正文或摘要。
 * @param {AssetRow[]} rows @param {DocumentSummary[]} documents @param {Snapshot} snapshot
 * @returns {ResourceRow[]}
 */
export function resourceRows(rows, documents, snapshot) {
  const inventory = new Map(
    [
      ...snapshot.servers.map((x) => [
        resourceKey({ kind: "server", id: x.id }),
        { demo: x.demo, host: x.host },
      ]),
      ...snapshot.domains.map((x) => [
        resourceKey({ kind: "domain", id: x.id }),
        { demo: x.demo, host: x.name },
      ]),
      ...snapshot.certs.map((x) => [
        resourceKey({ kind: "cert", id: x.id }),
        { demo: x.demo, host: x.host || x.cn },
      ]),
      ...snapshot.mailboxes.map((x) => [
        resourceKey({ kind: "mail", id: x.id }),
        { demo: x.demo, host: x.domain },
      ]),
      ...snapshot.aiAssets.map((x) => [resourceKey({ kind: "ai", id: x.id }), { demo: x.demo }]),
      ...(snapshot.services ?? []).map((x) => [
        resourceKey({ kind: "service", id: x.id }),
        {
          demo: x.demo,
          typeLabel:
            x.card?.kind === "payment"
              ? "U 卡与支付卡"
              : x.card?.kind === "esim"
                ? "eSIM 卡"
                : (snapshot.assetTypes ?? []).find((type) => type.id === x.typeId)?.name,
          host: (() => {
            try {
              return new URL(x.url).hostname;
            } catch {
              return "";
            }
          })(),
        },
      ]),
      ...snapshot.secrets.map((x) => [resourceKey({ kind: "secret", id: x.id }), { demo: x.demo }]),
    ].map(
      ([key, value]) =>
        /** @type {[string, {demo?:boolean,host?:string,typeLabel?:string}]} */ ([key, value]),
    ),
  );
  return [
    ...rows.map((row) => ({ ...row, ...inventory.get(resourceKey(row)) })),
    ...snapshot.servers.flatMap((server) =>
      (server.nodes ?? []).map((node) => ({
        kind: /** @type {const} */ ("node"),
        id: nodeResourceId(server.id, node.id),
        name: node.name || node.protocol,
        detail: server.name,
        tags: [],
        status: /** @type {'online'|'warning'} */ (node.checkError ? "warning" : "online"),
        pending: !node.checkedAt,
        demo: server.demo,
        search: `${node.name} ${node.protocol} ${server.name}`.toLocaleLowerCase(),
      })),
    ),
    ...(snapshot.phoneNumbers ?? []).map((phone) => ({
      kind: /** @type {const} */ ("phone"),
      id: phone.id,
      name: phone.label || "••••" + phone.number.replace(/\D/g, "").slice(-4),
      detail: `••••${phone.number.replace(/\D/g, "").slice(-4)} · ${phone.provider}`,
      tags: [],
      status: /** @type {'online'|'warning'} */ (
        ["expired", "today", "soon"].includes(phoneExpiry(phone.expiresAt).status)
          ? "warning"
          : "online"
      ),
      search: `${phone.label} ${phone.provider}`.toLocaleLowerCase(),
      subscriptionIds: phone.subscriptionIds,
    })),
    ...documents.map((doc) => ({
      kind: /** @type {const} */ ("document"),
      id: doc.id,
      name: doc.title,
      detail: "",
      tags: [],
      status: /** @type {const} */ ("online"),
      search: doc.title.toLocaleLowerCase(),
    })),
  ];
}

/** @param {ResourceRow[]} rows @param {Snapshot['links']} links @param {DocumentSummary[]} documents @returns {Relation[]} */
export function confirmedRelations(rows, links, documents) {
  const known = new Set(rows.map(resourceKey));
  const result = new Map();
  /** @param {ResourceRef} from @param {ResourceRef} to @param {'asset'|'document'|'phone'} type */
  const add = (from, to, type) => {
    if (
      resourceKey(from) === resourceKey(to) ||
      !known.has(resourceKey(from)) ||
      !known.has(resourceKey(to))
    )
      return;
    const id = relationKey(from, to);
    result.set(id, {
      id,
      from: { kind: from.kind, id: from.id },
      to: { kind: to.kind, id: to.id },
      type,
    });
  };
  for (const link of links ?? []) add(link.from, link.to, "asset");
  for (const row of rows)
    if (row.kind === "phone")
      for (const id of row.subscriptionIds ?? []) add(row, { kind: "ai", id }, "phone");
  for (const doc of documents)
    for (const ref of doc.bindings) add({ kind: "document", id: doc.id }, ref, "document");
  return [...result.values()];
}

/** 当前类型只是入口，已保存关系的整组资源都应可见。
 * @param {ResourceRow[]} rows @param {Relation[]} relations @param {ResourceRef[]} anchors
 */
export function relatedResources(rows, relations, anchors) {
  const known = new Set(rows.map(resourceKey));
  const selected = new Set(anchors.map(resourceKey).filter((key) => known.has(key)));
  const adjacency = new Map();
  for (const { from, to } of relations) {
    const a = resourceKey(from),
      b = resourceKey(to);
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  }
  const queue = [...selected];
  for (let index = 0; index < queue.length; index++)
    for (const next of adjacency.get(queue[index]) ?? []) {
      if (!selected.has(next)) {
        selected.add(next);
        queue.push(next);
      }
    }
  return rows.filter((row) => selected.has(resourceKey(row)));
}

/** @param {ResourceRef} from @param {ResourceRef} to */
export function canRelateResources(from, to) {
  return isResourceRef(from) && isResourceRef(to) && resourceKey(from) !== resourceKey(to);
}

/** 只沿已保存关系计算最短链路，不读取凭据、文档正文或自动确认建议。
 * @param {ResourceRow[]} rows @param {Relation[]} relations @param {ResourceRef} root
 * @returns {Array<{row: ResourceRow, distance: number, path: ResourceRef[]}>}
 */
export function relationPaths(rows, relations, root) {
  const known = new Map(rows.map((row) => [resourceKey(row), row])),
    key = resourceKey(root);
  if (!known.has(key)) return [];
  const adjacency = new Map();
  for (const edge of relations) {
    const a = resourceKey(edge.from),
      b = resourceKey(edge.to);
    if (a === b || !known.has(a) || !known.has(b)) continue;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      adjacency.get(from).add(to);
    }
  }
  const paths = new Map([[key, [root]]]),
    queue = [key];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const currentPath = paths.get(current);
    if (!currentPath) continue;
    for (const next of [...(adjacency.get(current) ?? [])].sort())
      if (!paths.has(next)) {
        const row = known.get(next);
        if (!row) continue;
        paths.set(next, [...currentPath, { kind: row.kind, id: row.id }]);
        queue.push(next);
      }
  }
  return queue.flatMap((k) => {
    const row = known.get(k),
      path = paths.get(k);
    return row && path ? [{ row, distance: path.length - 1, path }] : [];
  });
}

/** @param {string | undefined} host */
function normalizedHost(host) {
  if (!host) return "";
  const value = host.trim().toLowerCase().replace(/\.$/, "");
  return value.includes(".") && !value.startsWith("*.") && !/[\s/@]/.test(value) ? value : "";
}

/** 自动发现只是可审阅建议；同名、同标签不直接成为已确认关系。
 * @param {ResourceRow[]} rows @param {Relation[]} relations
 * @returns {Array<Relation & {basis:'host'|'tag'|'title', evidence:string}>}
 */
export function suggestRelations(rows, relations) {
  const exists = new Set(relations.map((link) => link.id));
  const suggestions = new Map();
  const candidates = rows.filter((row) => !row.demo);
  /** @param {ResourceRow} from @param {ResourceRow} to @param {'host'|'tag'|'title'} basis @param {string} evidence */
  const add = (from, to, basis, evidence) => {
    const id = relationKey(from, to);
    if (
      suggestions.size >= 80 ||
      exists.has(id) ||
      suggestions.has(id) ||
      resourceKey(from) === resourceKey(to) ||
      !canRelateResources(from, to)
    )
      return;
    if (!canRelateResources(from, to)) return;
    suggestions.set(id, {
      id,
      from: { kind: from.kind, id: from.id },
      to: { kind: to.kind, id: to.id },
      type: from.kind === "document" || to.kind === "document" ? "document" : "asset",
      basis,
      evidence,
    });
  };
  const hosts = new Map();
  for (const row of candidates) {
    const host = normalizedHost(row.host);
    if (!host) continue;
    for (const match of hosts.get(host) ?? []) add(match, row, "host", host);
    if (!hosts.has(host)) hosts.set(host, []);
    hosts.get(host).push(row);
  }
  const generic = new Set([
    "prod",
    "production",
    "test",
    "demo",
    "web",
    "work",
    "工作",
    "个人",
    "账号",
    "默认",
  ]);
  const tags = new Map();
  for (const row of candidates)
    for (const tag of row.tags) {
      if (tag.length < 2 || generic.has(tag.toLowerCase())) continue;
      for (const match of tags.get(tag) ?? []) add(match, row, "tag", tag);
      if (!tags.has(tag)) tags.set(tag, []);
      tags.get(tag).push(row);
    }
  // 按标题中的完整资产名称给建议，不检索正文，限制循环规模。
  const assets = candidates
    .filter((row) => row.kind !== "document" && row.name.length >= 4)
    .slice(0, 500);
  for (const doc of candidates.filter((row) => row.kind === "document").slice(0, 500))
    for (const asset of assets) {
      const title = doc.name.toLocaleLowerCase(),
        name = asset.name.toLocaleLowerCase();
      const start = title.indexOf(name);
      if (start < 0) continue;
      const before = title[start - 1] || "",
        after = title[start + name.length] || "";
      if (
        (/[a-z0-9]/i.test(name[0]) && /[a-z0-9]/i.test(before)) ||
        (/[a-z0-9]/i.test(name.at(-1) || "") && /[a-z0-9]/i.test(after))
      )
        continue;
      add(doc, asset, "title", asset.name);
    }
  return [...suggestions.values()];
}

/** @param {ResourceRow[]} rows @param {Relation[]} relations @param {boolean} vertical */
export function resourceGraph(rows, relations, vertical) {
  const kinds = [
    "secret",
    "server",
    "node",
    "service",
    "domain",
    "cert",
    "mail",
    "ai",
    "phone",
    "document",
  ].filter((kind) => rows.some((row) => row.kind === kind));
  const slots = new Map();
  const known = new Set(rows.map(resourceKey));
  const nodeId = (/** @type {ResourceRef} */ ref) => encodeURIComponent(resourceKey(ref));
  return {
    nodes: rows.map((row) => {
      const slot = slots.get(row.kind) ?? 0;
      slots.set(row.kind, slot + 1);
      return {
        id: nodeId(row),
        type: /** @type {const} */ ("asset"),
        position: vertical
          ? { x: slot * 260, y: kinds.indexOf(row.kind) * 150 }
          : { x: kinds.indexOf(row.kind) * 280, y: slot * 140 },
        data: { asset: row, vertical },
      };
    }),
    edges: relations
      .filter(({ from, to }) => known.has(resourceKey(from)) && known.has(resourceKey(to)))
      .map((link, index) => {
        const fromColumn = kinds.indexOf(link.from.kind),
          toColumn = kinds.indexOf(link.to.kind);
        const forward = fromColumn <= toColumn;
        const bypass = Math.abs(fromColumn - toColumn) !== 1;
        return {
          id: link.id,
          source: nodeId(forward ? link.from : link.to),
          target: nodeId(forward ? link.to : link.from),
          type: "resource",
          data: { relation: link, vertical, bypass, laneOffset: 40 + (index % 5) * 12 },
          style: link.type === "document" ? { strokeDasharray: "5 4" } : undefined,
        };
      }),
  };
}

/** 从两端侧边接入，长距离与同列关系统一沿节点区域外侧绕行。
 * @param {{sourceX:number,sourceY:number,targetX:number,targetY:number,vertical:boolean,bypass:boolean,lane:number}} input
 */
export function resourceRelationPath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  vertical,
  bypass,
  lane,
}) {
  const source = vertical ? [sourceY, sourceX] : [sourceX, sourceY];
  const target = vertical ? [targetY, targetX] : [targetX, targetY];
  const gap = 20;
  const middle = (source[0] + target[0]) / 2;
  const route =
    bypass || source[0] >= target[0]
      ? [
          source,
          [source[0] + gap, source[1]],
          [source[0] + gap, lane],
          [target[0] - gap, lane],
          [target[0] - gap, target[1]],
          target,
        ]
      : [source, [middle, source[1]], [middle, target[1]], target];
  const points = route
    .map(([u, v]) => (vertical ? [v, u] : [u, v]))
    .filter(
      (point, index, all) =>
        !index || point[0] !== all[index - 1][0] || point[1] !== all[index - 1][1],
    );
  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1],
      corner = points[index],
      after = points[index + 1];
    const incoming = Math.hypot(corner[0] - before[0], corner[1] - before[1]);
    const outgoing = Math.hypot(after[0] - corner[0], after[1] - corner[1]);
    const radius = Math.min(8, incoming / 2, outgoing / 2);
    const enter = corner.map((value, axis) => value + ((before[axis] - value) * radius) / incoming);
    const leave = corner.map((value, axis) => value + ((after[axis] - value) * radius) / outgoing);
    path += ` L ${enter[0]} ${enter[1]} Q ${corner[0]} ${corner[1]} ${leave[0]} ${leave[1]}`;
  }
  const end = points[points.length - 1];
  return `${path} L ${end[0]} ${end[1]}`;
}
