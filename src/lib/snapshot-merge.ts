import type { Snapshot } from "./types";

export interface SnapshotChange {
  before: Snapshot;
  snapshot: Snapshot;
}

const collections = [
  "servers",
  "domains",
  "mailboxes",
  "aiAssets",
  "secrets",
  "certs",
  "services",
  "assetTypes",
  "reminders",
  "phoneNumbers",
  "mailFolders",
  "secretFolders",
  "links",
] as const;

type Row = Record<string, unknown>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function identity(row: Row, collection: string) {
  if (collection !== "links") return String(row.id);
  const from = row.from as { kind: string; id: string };
  const to = row.to as { kind: string; id: string };
  return [`${from.kind}:${from.id}`, `${to.kind}:${to.id}`].sort().join("|");
}

/** 仅接收主进程实际改过的字段，同时保留本地并发修改、添加和删除。 */
export function mergeSnapshotChange(current: Snapshot, change: SnapshotChange): Snapshot {
  const result: Record<string, unknown> = { ...current };
  for (const collection of collections) {
    const before = (change.before[collection] ?? []) as unknown as Row[];
    const incoming = (change.snapshot[collection] ?? []) as unknown as Row[];
    if (equal(before, incoming)) continue;
    const local = (current[collection] ?? []) as unknown as Row[];
    const oldById = new Map(before.map((row) => [identity(row, collection), row]));
    const newById = new Map(incoming.map((row) => [identity(row, collection), row]));
    const localIds = new Set(local.map((row) => identity(row, collection)));
    const merged: Row[] = [];
    for (const row of local) {
      const id = identity(row, collection),
        old = oldById.get(id),
        next = newById.get(id);
      if (!old) {
        merged.push(row);
        continue;
      }
      if (!next) {
        if (!equal(row, old)) merged.push(row);
        continue;
      }
      const value = { ...row };
      for (const field of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (equal(old[field], next[field]) || !equal(row[field], old[field])) continue;
        if (Object.hasOwn(next, field)) value[field] = next[field];
        else delete value[field];
      }
      merged.push(value);
    }
    for (const row of incoming) {
      const id = identity(row, collection);
      if (!oldById.has(id) && !localIds.has(id)) merged.push(row);
    }
    result[collection] = merged;
  }
  return result as unknown as Snapshot;
}
