import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** 浏览器与 Node 共用的文档版本摘要，字段顺序与原格式一致。
 * @param {import("../../src/lib/documents").DocumentAsset} doc
 */
export function documentRevision(doc) {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify({
          title: doc.title,
          content: doc.content,
          markdown: doc.markdown,
          bindings: doc.bindings,
          updatedAt: doc.updatedAt,
        }),
      ),
    ),
  );
}
