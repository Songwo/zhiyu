import { useAppStore, flushAssetPersistence } from "./store";
import { useDocuments, documentsApi, type DocumentAsset } from "./documents";
import { refKey, type AssetRef } from "./operations";
import type { ResourceRef, PhoneNumber } from "./types";
import { isResourceRef, snapshotResourceKeys } from "../../electron/services/resource-links.mjs";
import { normalizePhoneNumber } from "../../electron/services/phone-numbers.mjs";
import { resourcePairKey } from "../../electron/services/resource-links.mjs";

// 所有入口共享顺序，避免同一文档或号码的并发操作互相覆盖。
let updates = Promise.resolve();
function serial(action: () => Promise<void>) {
  const task = updates.catch(() => {}).then(action);
  updates = task.catch(() => {});
  return task;
}
async function persistRelations() {
  try {
    await flushAssetPersistence();
  } catch (error) {
    // 恢复已确认的资料；表单和文档草稿是独立状态，不随资产重新读取而清空。
    await Promise.resolve(useAppStore.persist.rehydrate()).catch(() => {});
    throw error;
  }
}
export const commitResourceChanges = persistRelations;
async function removeDuplicateDocumentEdge(from: ResourceRef, to: ResourceRef) {
  const state = useAppStore.getState();
  if (
    !state.links.some((link) => resourcePairKey(link.from, link.to) === resourcePairKey(from, to))
  )
    return;
  state.unlinkAssets(from, to);
  await persistRelations();
}
async function assertExists(ref: ResourceRef): Promise<DocumentAsset | null> {
  if (!isResourceRef(ref)) throw Error("关联资源无效，请重新选择。");
  if (ref.kind === "document") {
    const document = await documentsApi().get(ref.id);
    if (!document) throw Error("关联文档已不存在，请刷新后重试。");
    return document;
  }
  if (!snapshotResourceKeys(useAppStore.getState()).has(refKey(ref)))
    throw Error("关联资源已不存在，请刷新后重试。");
  return null;
}

/** 所有入口共用保存与解除逻辑，文档正文不因通用连线改变。 */
export function updateResourceRelation(from: ResourceRef, to: ResourceRef, remove = false) {
  return serial(async () => {
    if (!isResourceRef(from) || !isResourceRef(to) || refKey(from) === refKey(to))
      throw Error("请选择两项不同的有效资源。");
    if (!remove) {
      await assertExists(from);
      await assertExists(to);
      const known = snapshotResourceKeys(useAppStore.getState());
      if ([from, to].some((ref) => ref.kind !== "document" && !known.has(refKey(ref))))
        throw Error("关联资源已不存在，请刷新后重试。");
    }
    const document = from.kind === "document" ? from : to.kind === "document" ? to : null;
    const target = document === from ? to : from;
    if (document && !["document", "phone", "node"].includes(target.kind)) {
      const documents = useDocuments.getState();
      if (documents.status[document.id] && documents.status[document.id] !== "saved")
        await documents.flush(document.id);
      const api = documentsApi();
      if (api.bind) {
        const saved = await api.bind(
          document.id,
          { kind: target.kind, id: target.id } as AssetRef,
          remove,
        );
        const latestState = useDocuments.getState();
        const latestDraft = latestState.drafts[document.id];
        if (latestDraft && latestState.status[document.id] !== "saved") {
          latestState.change({ ...latestDraft, bindings: saved.bindings });
          await useDocuments.getState().flush(document.id);
        } else latestState.acceptChange({ document: saved });
        await removeDuplicateDocumentEdge(from, to);
        useAppStore.getState().log(remove ? "已解除一条资源关联" : "已确认一条资源关联");
        return;
      }
      // 旧桥接不能保证正文与关联并发安全，禁止以整体文档保存冒充关联已保存。
      throw Error("当前文档接口不支持安全修改关联，请更新客户端或服务端后重试。");
    } else {
      const state = useAppStore.getState();
      if (remove) state.unlinkAssets(from, to);
      else state.linkAssets(from, to);
      await persistRelations();
    }
    useAppStore.getState().log(remove ? "已解除一条资源关联" : "已确认一条资源关联");
  });
}

/** 号码与所选资源一次提交到同一份快照，兼容原订阅字段。 */
export function savePhoneRelations(
  record: PhoneNumber,
  targets: ResourceRef[],
  existing = false,
  assertCurrent: () => void = () => {},
) {
  return serial(async () => {
    assertCurrent();
    if (existing && !useAppStore.getState().phoneNumbers.some((phone) => phone.id === record.id))
      throw Error("关联资源已不存在，请刷新后重试。");
    const owner = { kind: "phone" as const, id: record.id };
    const unique = [...new Map(targets.map((ref) => [refKey(ref), ref])).values()];
    for (const target of unique) {
      if (refKey(target) === refKey(owner)) throw Error("请选择两项不同的有效资源。");
      await assertExists(target);
    }
    const normalized = normalizePhoneNumber({
      ...record,
      subscriptionIds: unique.filter((ref) => ref.kind === "ai").map((ref) => ref.id),
    });
    assertCurrent();
    const known = snapshotResourceKeys(useAppStore.getState());
    if (existing && !useAppStore.getState().phoneNumbers.some((phone) => phone.id === record.id))
      throw Error("关联资源已不存在，请刷新后重试。");
    if (unique.some((ref) => ref.kind !== "document" && !known.has(refKey(ref))))
      throw Error("关联资源已不存在，请刷新后重试。");
    useAppStore.getState().upsertPhoneNumber(normalized, unique);
    await persistRelations();
  });
}
