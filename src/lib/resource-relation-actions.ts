import { useAppStore } from "./store";
import { useDocuments, documentsApi, type DocumentAsset } from "./documents";
import { assetEntries, refKey, type AssetRef } from "./operations";
import type { ResourceRef } from "./resource-relations.mjs";

const documentUpdates = new Map<string, Promise<void>>();

/** 图中的连线与文档详情共用同一份绑定数据。 */
export async function updateResourceRelation(from: ResourceRef, to: ResourceRef, remove = false) {
  const document = from.kind === "document" ? from : to.kind === "document" ? to : null;
  if (!document) return applyResourceRelation(from, to, remove);
  const previous = documentUpdates.get(document.id) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => applyResourceRelation(from, to, remove));
  documentUpdates.set(document.id, task);
  try {
    await task;
  } finally {
    if (documentUpdates.get(document.id) === task) documentUpdates.delete(document.id);
  }
}

async function applyResourceRelation(from: ResourceRef, to: ResourceRef, remove: boolean) {
  const phoneRef = from.kind === "phone" ? from : to.kind === "phone" ? to : null;
  if (phoneRef) {
    const target = from.kind === "phone" ? to : from;
    if (target.kind !== "ai")
      throw new Error("号码通过已绑定的 AI 订阅连接其他资源，请选择 AI 订阅。");
    const state = useAppStore.getState(),
      phone = state.phoneNumbers.find((p) => p.id === phoneRef.id);
    if (!phone || !state.aiAssets.some((a) => a.id === target.id))
      throw new Error("关联资源已不存在，请刷新后重试。");
    state.upsertPhoneNumber({
      ...phone,
      subscriptionIds: remove
        ? phone.subscriptionIds.filter((id) => id !== target.id)
        : [...new Set([...phone.subscriptionIds, target.id])],
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  if (from.kind === "document" && to.kind === "document")
    throw new Error("请选择至少一项账号或其他资产，文档通过共同资产组成关联组。");
  const state = useAppStore.getState();
  const assets = new Set(assetEntries(state).map(refKey));
  for (const ref of [from, to])
    if (ref.kind !== "document" && !assets.has(refKey(ref as AssetRef)))
      throw new Error("关联资源已不存在，请刷新后重试。");
  if (from.kind !== "document" && to.kind !== "document") {
    if (remove) state.unlinkAssets(from as AssetRef, to as AssetRef);
    else state.linkAssets(from as AssetRef, to as AssetRef);
  } else {
    const document = from.kind === "document" ? from : to;
    const asset = (from.kind === "document" ? to : from) as AssetRef;
    const documents = useDocuments.getState();
    if (documents.status[document.id] && documents.status[document.id] !== "saved")
      await documents.flush(document.id);
    const beforeRead = useDocuments.getState().drafts[document.id];
    const current: DocumentAsset | null = await documentsApi().get(document.id);
    if (!current) throw new Error("关联文档已不存在，请刷新后重试。");
    // 异步读取期间若用户继续编辑，绑定应合并到新草稿，不能覆盖正文。
    const latestDraft = useDocuments.getState().drafts[document.id];
    const base = latestDraft && latestDraft !== beforeRead ? latestDraft : current;
    const bindings = base.bindings.filter((ref) => refKey(ref) !== refKey(asset));
    if (!remove) bindings.push({ kind: asset.kind, id: asset.id });
    documents.change({ ...base, bindings });
    await useDocuments.getState().flush(document.id);
  }
  state.log(remove ? "已解除一条资源关联" : "已确认一条资源关联");
}
