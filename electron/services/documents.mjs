import { hostedImageUrl } from "./hosted-image.mjs";
import { documentRevision } from "./document-revision.mjs";
export { documentRevision } from "./document-revision.mjs";
import { renameSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, rename, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { inspectRaster } from "./image-data.mjs";
import { markdownContent } from "./document-markdown.mjs";
import { documentLink } from "./document-links.mjs";
export { documentLink } from "./document-links.mjs";

const KINDS = new Set(["server", "domain", "mail", "ai", "secret", "cert", "service"]);
const TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "text",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "hardBreak",
  "horizontalRule",
  "image",
]);
export function normalizeDocument(input) {
  if (!input || typeof input !== "object" || !/^doc-[a-zA-Z0-9-]{1,80}$/.test(input.id))
    throw new Error("文档标识无效");
  if (JSON.stringify(input).length > 16 * 1024 * 1024) throw new Error("单篇文档不能超过 16 MiB");
  if (input.markdown !== undefined && typeof input.markdown !== "string")
    throw new Error("Markdown 源码必须是文本。");
  const content =
    typeof input.markdown === "string" ? markdownContent(input.markdown) : input.content;
  let count = 0;
  const walk = (node, depth = 0) => {
    if (++count > 20000 || depth > 24 || !node || !TYPES.has(node.type))
      throw new Error("文档结构无效或内容过长");
    const out = { type: node.type };
    if (node.type === "text") {
      if (typeof node.text !== "string") throw new Error("文本无效");
      out.text = node.text;
    }
    if (node.type === "heading")
      out.attrs = { level: [1, 2, 3].includes(node.attrs?.level) ? node.attrs.level : 2 };
    if (
      node.type === "codeBlock" &&
      typeof node.attrs?.language === "string" &&
      /^[\w+-]{1,40}$/.test(node.attrs.language)
    )
      out.attrs = { language: node.attrs.language };
    if (node.type === "orderedList")
      out.attrs = {
        start:
          Number.isSafeInteger(node.attrs?.start) && node.attrs.start > 0 ? node.attrs.start : 1,
      };
    if (node.type === "image") {
      const src = node.attrs?.src;
      const match =
        typeof src === "string" &&
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
      if (!match && !hostedImageUrl(src))
        throw new Error("图片必须是上传图片或 HTTPS 图床地址，不支持 SVG");
      if (match) {
        const bytes = Buffer.from(match[2], "base64");
        if (bytes.length > 2 * 1024 * 1024 || bytes.toString("base64") !== match[2])
          throw new Error("图片编码无效或超过 2 MiB");
        const size = inspectRaster(bytes, "image/" + match[1]);
        if (Math.max(size.width, size.height) > 2048)
          throw new Error("图片最长边不能超过 2048 像素");
      }
      out.attrs = { src, alt: String(node.attrs?.alt ?? "图片").slice(0, 300) };
    }
    if (Array.isArray(node.marks))
      out.marks = node.marks.map((mark) => {
        if (["bold", "italic", "strike", "underline", "code"].includes(mark.type))
          return { type: mark.type };
        if (mark.type === "link") {
          const href = documentLink(mark.attrs?.href);
          if (!href) throw new Error("链接只支持 HTTP 或 HTTPS");
          return { type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer" } };
        }
        throw new Error("不支持的文本格式");
      });
    if (Array.isArray(node.content))
      out.content = node.content.map((child) => walk(child, depth + 1));
    return out;
  };
  if (content?.type !== "doc") throw new Error("缺少文档正文");
  const seen = new Set();
  const bindings = (Array.isArray(input.bindings) ? input.bindings : [])
    .map((ref) => {
      if (!KINDS.has(ref?.kind) || typeof ref.id !== "string" || !ref.id || ref.id.length > 256)
        throw new Error("关联资产无效");
      return { kind: ref.kind, id: ref.id };
    })
    .filter((ref) => {
      const key = JSON.stringify(ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (bindings.length > 100) throw new Error("单篇文档最多关联 100 项资产");
  return {
    id: input.id,
    title:
      String(input.title ?? "")
        .trim()
        .slice(0, 160) || "未命名文档",
    content: walk(content),
    ...(typeof input.markdown === "string" ? { markdown: input.markdown } : {}),
    bindings,
  };
}
export function documentSummary(doc) {
  const text = [];
  let imageCount = 0;
  const walk = (node) => {
    if (node.text) text.push(node.text);
    if (node.type === "image") imageCount++;
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc.content);
  return {
    id: doc.id,
    title: doc.title,
    bindings: doc.bindings,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    excerpt: text.join(" ").slice(0, 180),
    imageCount,
  };
}

const METADATA_LIMIT = 6000;
const metadataFingerprint = (info) =>
  [info.mtimeNs, info.size, info.dev, info.ino, info.ctimeNs].join(":");

// 冷读只解析 JSON 后提取白名单，不遍历正文、不生成摘要或处理图片。
function documentMetadata(value, id) {
  if (!value || value.id !== id) throw new Error("文档标识与文件名不一致");
  const bindings = [],
    seen = new Set();
  for (const ref of Array.isArray(value.bindings) ? value.bindings : []) {
    if (!KINDS.has(ref?.kind) || typeof ref.id !== "string" || !ref.id || ref.id.length > 256)
      throw new Error("关联资产无效");
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ kind: ref.kind, id: ref.id });
    if (bindings.length > 100) throw new Error("单篇文档最多关联 100 项资产");
  }
  return {
    id,
    title:
      (typeof value.title === "string" ? value.title.trim().slice(0, 160) : "") || "未命名文档",
    bindings,
    createdAt: typeof value.createdAt === "string" ? value.createdAt.slice(0, 40) : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt.slice(0, 40) : "",
  };
}

export class DocumentsStore {
  #directory;
  #queue = Promise.resolve();
  #metadata = new Map();
  #metadataLimit;
  #readMetadataFile;
  constructor(directory, { metadataLimit = METADATA_LIMIT, readMetadataFile = readFile } = {}) {
    if (!Number.isInteger(metadataLimit) || metadataLimit < 1 || metadataLimit > METADATA_LIMIT)
      throw new Error("文档元信息目录上限必须在 1 到 6000 之间");
    this.#directory = directory;
    this.#metadataLimit = metadataLimit;
    this.#readMetadataFile = readMetadataFile;
  }
  #path(id) {
    if (!/^doc-[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("文档标识无效");
    return join(this.#directory, id + ".json");
  }
  async list() {
    await this.#queue;
    let names;
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const result = [];
    for (const name of names.filter((n) => /^doc-[a-zA-Z0-9-]{1,80}\.json$/.test(n)))
      result.push(documentSummary(await this.get(name.slice(0, -5))));
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  listMetadata() {
    // 与保存、删除共用队列，避免异步冷读把已失效的元信息重新写回缓存。
    const job = this.#queue.then(async () => {
      let names;
      try {
        names = (await readdir(this.#directory))
          .filter((name) => /^doc-[a-zA-Z0-9-]{1,80}\.json$/.test(name))
          .sort();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.#metadata.clear();
        return { documents: [], truncated: false };
      }
      const selected = names.slice(0, this.#metadataLimit);
      const selectedIds = new Set(selected.map((name) => name.slice(0, -5)));
      for (const id of this.#metadata.keys()) if (!selectedIds.has(id)) this.#metadata.delete(id);
      const documents = [];
      for (const name of selected) {
        const id = name.slice(0, -5);
        const path = this.#path(id);
        let metadata;
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const before = await lstat(path, { bigint: true });
            // 只扫描普通文档文件，避免跟随文档目录中的符号链接读取其他存储。
            if (!before.isFile()) {
              this.#metadata.delete(id);
              break;
            }
            const fingerprint = metadataFingerprint(before);
            const cached = this.#metadata.get(id);
            if (cached?.fingerprint === fingerprint) {
              metadata = cached.value;
              break;
            }
            this.#metadata.delete(id);
            if (before.size > 64n * 1024n * 1024n) throw new Error("文档文件过大");
            const raw = await this.#readMetadataFile(path, "utf8");
            if (raw.length > 16 * 1024 * 1024 + 4096) throw new Error("文档文件过大");
            const value = documentMetadata(JSON.parse(raw), id);
            const after = await lstat(path, { bigint: true });
            if (after.isFile() && metadataFingerprint(after) === fingerprint) {
              this.#metadata.set(id, { fingerprint, value });
              metadata = value;
              break;
            }
            if (attempt === 1) throw new Error("文档正在被外部程序持续修改");
          }
          if (metadata) documents.push(structuredClone(metadata));
        } catch (error) {
          this.#metadata.delete(id);
          // 文件在枚举后被外部删除时跳过；其他错误不能伪装成完整空目录。
          if (error.code !== "ENOENT")
            throw new Error("无法读取工作区文档元信息，请检查本机文档文件。");
        }
      }
      return {
        documents: documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        truncated: names.length > selected.length,
      };
    });
    this.#queue = job.catch(() => {});
    return job;
  }
  async get(id) {
    await this.#queue;
    const doc = JSON.parse(await readFile(this.#path(id), "utf8"));
    return { ...normalizeDocument(doc), createdAt: doc.createdAt, updatedAt: doc.updatedAt };
  }
  save(input, { assertCurrent = null, expectedRevision = null } = {}) {
    const clean = normalizeDocument(input);
    const createOnly = input.createOnly === true;
    const job = this.#queue.then(async () => {
      assertCurrent?.();
      const path = this.#path(clean.id);
      let createdAt = new Date().toISOString();
      try {
        const existing = JSON.parse(await readFile(path, "utf8"));
        if (expectedRevision && documentRevision(existing) !== expectedRevision)
          throw new Error("文档已在其他位置修改，请重新生成建议，避免覆盖新内容。");
        // 显式迁移只创建缺失文档，队列内检查避免并发导入覆盖用户后续编辑。
        if (createOnly)
          return {
            ...normalizeDocument(existing),
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
          };
        createdAt = existing.createdAt || createdAt;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (expectedRevision) throw new Error("文档已删除，未应用修改建议。");
      }
      const doc = { ...clean, createdAt, updatedAt: new Date().toISOString() };
      await mkdir(this.#directory, { recursive: true });
      await writeFile(path + ".tmp", JSON.stringify(doc), "utf8");
      try {
        if (assertCurrent) {
          assertCurrent();
          // 授权检查与提交在同一同步段完成，锁库不能插入二者之间。
          renameSync(path + ".tmp", path);
        } else await rename(path + ".tmp", path);
      } catch (error) {
        await unlink(path + ".tmp").catch(() => {});
        throw error;
      }
      this.#metadata.delete(clean.id);
      return doc;
    });
    this.#queue = job.catch(() => {});
    return job;
  }
  remove(id) {
    const path = this.#path(id);
    const job = this.#queue.then(async () => {
      this.#metadata.delete(id);
      await unlink(path);
    });
    this.#queue = job.catch(() => {});
    return job;
  }
}
