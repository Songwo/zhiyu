import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "./store";
import { useDocuments } from "./documents";
import { assetRows } from "./asset-view";
import {
  confirmedRelations,
  resourceRows,
  resourceKey,
  type ResourceRef,
} from "./resource-relations.mjs";
import { KIND_LABEL } from "./status";
import { nodeOwner } from "../../electron/services/resource-links.mjs";

export const resourceKindLabel = (ref: ResourceRef & { typeLabel?: string }) =>
  ref.typeLabel ||
  (ref.kind === "document"
    ? "文档"
    : ref.kind === "phone"
      ? "号码"
      : ref.kind === "node"
        ? "自建节点"
        : KIND_LABEL[ref.kind]);

export function useResourceInventory() {
  const snapshot = useAppStore();
  const documents = useDocuments((state) => state.list);
  const loaded = useDocuments((state) => state.loaded);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void useDocuments
      .getState()
      .load()
      .catch((cause) => {
        if (alive) setError(String(cause.message ?? cause));
      });
    return () => {
      alive = false;
    };
  }, []);
  const resources = useMemo(
    () => resourceRows(assetRows(snapshot), documents, snapshot),
    [snapshot, documents],
  );
  const relations = useMemo(
    () => confirmedRelations(resources, snapshot.links, documents),
    [resources, snapshot.links, documents],
  );
  return { resources, relations, loaded, error };
}

export function connectedRefs(
  owner: ResourceRef,
  relations: ReturnType<typeof confirmedRelations>,
): ResourceRef[] {
  const key = resourceKey(owner);
  return relations.flatMap(({ from, to }) =>
    resourceKey(from) === key ? [to] : resourceKey(to) === key ? [from] : [],
  );
}

export async function openResource(
  ref: ResourceRef,
  origin?: { x: number; y: number; w: number; h: number },
  focus?: "account",
) {
  const state = useAppStore.getState();
  if (ref.kind === "document") {
    await useDocuments.getState().open(ref.id);
    state.setView("docs");
  } else if (ref.kind === "phone") state.openPhones({ id: ref.id });
  else if (ref.kind === "node") {
    const owner = nodeOwner(ref.id);
    if (
      !owner ||
      !state.servers.some(
        (server) =>
          server.id === owner.serverId && server.nodes?.some((node) => node.id === owner.nodeId),
      )
    )
      throw Error("关联资源已不存在，请刷新后重试。");
    state.setExpanded({
      kind: "server",
      id: owner.serverId,
      focus: "nodes",
      nodeId: owner.nodeId,
      origin: origin ?? { x: 0, y: 0, w: 100, h: 100 },
    });
  } else
    state.setExpanded({
      kind: ref.kind,
      id: ref.id,
      focus,
      origin: origin ?? { x: 0, y: 0, w: 100, h: 100 },
    });
}
