import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** 网页正文只作为文字保存，链接仅保留公开文档定位字段。 */
export function browserDocument(input) {
  if (
    !input ||
    typeof input.url !== "string" ||
    input.url.length > 4096 ||
    typeof input.title !== "string" ||
    input.title.length > 512 ||
    typeof input.text !== "string" ||
    input.text.length > 200000
  )
    throw new Error("网页文档格式无效或超过 20 万字符。");
  const source = new URL(input.url);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(source.hostname);
  if (
    source.username ||
    source.password ||
    !(source.protocol === "https:" || (local && source.protocol === "http:"))
  )
    throw new Error("仅支持 HTTPS 网页文档。");
  source.hash = "";
  const allowed =
    source.hostname === "mp.weixin.qq.com" ? new Set(["__biz", "mid", "idx", "sn"]) : new Set();
  for (const name of [...source.searchParams.keys()])
    if (!allowed.has(name)) source.searchParams.delete(name);
  source.searchParams.sort();
  const url = source.href;
  const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
  // 合并过密换行，保持节点数低于 DocumentsStore 的结构上限。
  const text = input.text.replace(/\0/g, "").trim();
  const lines = text
    ? text.split(/\n\s*\n/).filter(Boolean)
    : ["此页面未提供可读取正文，已保存来源链接。"];
  const blocks = lines.length > 1000 ? [text] : lines;
  return {
    id: "doc-web-" + bytesToHex(sha256(new TextEncoder().encode(url))).slice(0, 40),
    title: input.title.trim().slice(0, 160) || source.hostname,
    content: {
      type: "doc",
      content: [
        ...blocks.map(paragraph),
        { type: "horizontalRule" },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "网页快照 · 来源：" },
            { type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] },
          ],
        },
      ],
    },
    bindings: [],
    createOnly: true,
  };
}

export async function saveBrowserDocument(store, input, assertCurrent = () => {}) {
  const document = browserDocument(input);
  assertCurrent();
  let exists = false;
  try {
    await store.get(document.id);
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assertCurrent();
  await store.save(document, { assertCurrent });
  return { id: document.id, status: exists ? "existing" : "created" };
}
