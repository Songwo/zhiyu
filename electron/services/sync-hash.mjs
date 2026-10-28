/**
 * 同步用的内容哈希。桌面端与网页版必须对同一份内容算出同一个值，所以都先走各自存储层用的规范化，
 * 再对规范化后的内容取哈希；否则老格式的数据会让两边永远认为对方改过。
 */
import { normalizeDocument } from "./documents.mjs";
import { normalizeSnapshotImages } from "./image-data.mjs";
import { hashDocument, hashValue, stripVolatile } from "./sync-merge.mjs";

/** assets.json 的内容（`{state, version}` 或直接是 state）。 */
export function assetsState(parsed) {
  const wrapped =
    parsed?.state && typeof parsed.state === "object"
      ? parsed
      : { state: parsed ?? {}, version: 0 };
  try {
    return normalizeSnapshotImages(wrapped, { strict: false }).state;
  } catch {
    return wrapped.state;
  }
}
/** 资产内容哈希不含遥测字段：只有用户的改动才会触发同步。 */
export const hashAssetsFile = (parsed) => hashValue(stripVolatile(assetsState(parsed)));
export const hashDocumentFile = (parsed) => hashDocument(normalizeDocument(parsed));
export const hashVaultFile = (parsed) => hashValue(parsed);
