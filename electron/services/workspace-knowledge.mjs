import { tokenize } from "./rag.mjs";
import { isResourceRef } from "./resource-links.mjs";

export const WORKSPACE_LIMITS = {
  documents: 6000,
  page: 20,
  bodyDocuments: 40,
  bodyCharacters: 200000,
  documentCharacters: 20000,
  outputCharacters: 12000,
  toolCharacters: 40000,
  nodes: 20000,
};
const KINDS = new Set([
  "server",
  "domain",
  "mail",
  "ai",
  "secret",
  "cert",
  "service",
  "phone",
  "node",
  "document",
]);
const DOCUMENT_ID = /^doc-[a-zA-Z0-9-]{1,80}$/;
const PREFIX = "workspace-document:";
const safeString = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const sourceId = (id) => PREFIX + id;
const assetSourceId = (ref) =>
  ref.kind === "document" ? sourceId(ref.id) : `asset:${ref.kind}:${ref.id}`;

export function validWorkspaceArgs(name, args) {
  const page = () =>
    (args.offset === undefined ||
      (Number.isInteger(args.offset) && args.offset >= 0 && args.offset <= 6000)) &&
    (args.limit === undefined ||
      (Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= WORKSPACE_LIMITS.page));
  if (name === "get_document")
    return (
      Object.keys(args).length === 1 &&
      DOCUMENT_ID.test(args.documentId ?? "") &&
      typeof args.documentId === "string"
    );
  if (name === "search_documents")
    return (
      Object.keys(args).every((key) => ["query", "offset", "limit"].includes(key)) &&
      typeof args.query === "string" &&
      args.query.length <= 200 &&
      page()
    );
  if (name === "get_related_resources")
    return (
      Object.keys(args).every((key) => ["sourceId", "offset", "limit"].includes(key)) &&
      typeof args.sourceId === "string" &&
      args.sourceId.length > 0 &&
      args.sourceId.length <= 2048 &&
      page()
    );
  return false;
}

// 取消立即结束等待；存储适配器尚未结束的读取不会再进入模型上下文。
async function cancellable(operation, signal) {
  signal.throwIfAborted();
  let listener;
  const abort = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(operation), abort]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

// 白名单提取纯文本，不读取图片 URL、嵌入数据、节点属性和链接凭据。
export function documentText(root, maximum, signal) {
  const stack = [{ node: root, depth: 0 }];
  const pieces = [];
  let length = 0,
    visited = 0,
    truncated = false;
  while (stack.length) {
    signal.throwIfAborted();
    const { node, depth } = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (++visited > WORKSPACE_LIMITS.nodes || depth > 24 || length >= maximum) {
      truncated = true;
      break;
    }
    if (node.type === "text" && typeof node.text === "string") {
      const text = node.text.slice(0, maximum - length);
      pieces.push(text);
      length += text.length;
      if (text.length < node.text.length) truncated = true;
    } else if (node.type === "hardBreak") {
      pieces.push("\n");
      length++;
    }
    if (Array.isArray(node.content)) {
      // 子节点数量也受上限约束，避免畸形结构一次撑大栈。
      const remaining = Math.max(0, WORKSPACE_LIMITS.nodes - visited - stack.length);
      if (node.content.length > remaining) truncated = true;
      for (let i = Math.min(node.content.length, remaining) - 1; i >= 0; i--)
        stack.push({ node: node.content[i], depth: depth + 1 });
    }
    if (["paragraph", "heading", "codeBlock", "listItem"].includes(node.type) && length) {
      pieces.push("\n");
      length++;
    }
  }
  return { text: pieces.join("").slice(0, maximum), truncated };
}

export class WorkspaceKnowledge {
  constructor({ documents, index, snapshot, signal, allowDocumentContent }) {
    this.documents = documents;
    this.index = index;
    this.snapshot = snapshot;
    this.signal = signal;
    this.allowDocumentContent = allowDocumentContent === true;
    this.catalog = [];
    this.byId = new Map();
    this.bodies = new Map();
    this.bodyCharacters = 0;
    this.available = typeof documents?.list === "function" && typeof documents?.get === "function";
  }
  async load() {
    if (!this.available) return;
    let rows;
    try {
      rows = await cancellable(() => this.documents.list(), this.signal);
    } catch {
      this.signal.throwIfAborted();
      this.available = false;
      return;
    }
    // 兼容旧的数组适配器；目录服务显式报告截断，避免将部分目录当成完整清单。
    const reportedTruncated = !Array.isArray(rows) && rows?.truncated === true;
    if (!Array.isArray(rows)) rows = rows?.documents;
    if (!Array.isArray(rows)) {
      this.available = false;
      return;
    }
    this.catalogTruncated = reportedTruncated || rows.length > WORKSPACE_LIMITS.documents;
    for (const row of rows.slice(0, WORKSPACE_LIMITS.documents)) {
      this.signal.throwIfAborted();
      if (!row || typeof row.id !== "string" || !DOCUMENT_ID.test(row.id) || this.byId.has(row.id))
        continue;
      const bindings = [];
      const seen = new Set();
      for (const ref of (Array.isArray(row.bindings) ? row.bindings : []).slice(0, 100)) {
        if (!KINDS.has(ref?.kind) || typeof ref.id !== "string" || !ref.id || ref.id.length > 256)
          continue;
        const key = assetSourceId(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        bindings.push({ kind: ref.kind, id: ref.id });
      }
      // 不展开整个 summary：excerpt 是正文派生数据，未授权时连读取也不允许。
      const metadata = {
        documentId: row.id,
        sourceId: sourceId(row.id),
        title: safeString(row.title, 160) || "未命名文档",
        createdAt: safeString(row.createdAt, 40),
        updatedAt: safeString(row.updatedAt, 40),
        bindings,
      };
      this.catalog.push(metadata);
      this.byId.set(row.id, metadata);
    }
  }
  metadata(row) {
    return {
      ...row,
      bindings: row.bindings.slice(0, 10),
      bindingCount: row.bindings.length,
      bindingsTruncated: row.bindings.length > 10,
    };
  }
  citation(row, text, content = false) {
    return {
      id: row.sourceId + (content ? ":content" : ""),
      documentId: row.documentId,
      workspaceDocument: true,
      title: row.title,
      text: text ?? JSON.stringify(this.metadata(row)),
    };
  }
  metadataMatches(query) {
    const terms = [...new Set(tokenize(query))];
    return this.catalog
      .map((row) => {
        const title = row.title.toLocaleLowerCase();
        const text = [
          row.documentId,
          ...row.bindings.flatMap((ref) => [
            ref.id,
            safeString(this.index.byId.get(assetSourceId(ref))?.title, 160),
          ]),
        ]
          .join(" ")
          .toLocaleLowerCase();
        const score = terms.reduce(
          (sum, term) => sum + (title.includes(term) ? 3 : text.includes(term) ? 1 : 0),
          0,
        );
        return { row, score };
      })
      .filter(({ score }) => !query.trim() || score > 0)
      .sort((a, b) => b.score - a.score);
  }
  initial(query, limit) {
    return this.metadataMatches(query)
      .slice(0, limit)
      .map(({ row }) => this.citation(row));
  }
  async body(row) {
    if (!this.allowDocumentContent)
      return { error: "Document content access is disabled for this request." };
    if (this.bodies.has(row.documentId)) return this.bodies.get(row.documentId);
    if (
      this.bodies.size >= WORKSPACE_LIMITS.bodyDocuments ||
      this.bodyCharacters >= WORKSPACE_LIMITS.bodyCharacters
    )
      return {
        error:
          "Document content reading limit reached for this request. Narrow the question and start a new authorized request.",
      };
    let result;
    try {
      const doc = await cancellable(() => this.documents.get(row.documentId), this.signal);
      if (doc?.id !== row.documentId) throw new Error("Document identity mismatch");
      result = documentText(
        doc.content,
        Math.min(
          WORKSPACE_LIMITS.documentCharacters,
          WORKSPACE_LIMITS.bodyCharacters - this.bodyCharacters,
        ),
        this.signal,
      );
      this.bodyCharacters += result.text.length;
    } catch {
      this.signal.throwIfAborted();
      result = {
        error: "Document is missing or cannot be read. Refresh the workspace document list.",
      };
    }
    this.bodies.set(row.documentId, result);
    return result;
  }
  async search({ query, offset = 0, limit = 10 }) {
    if (!this.available) return { error: "Workspace documents are unavailable." };
    const matches = new Map(
      this.metadataMatches(query).map(({ row, score }) => [row.documentId, { row, score }]),
    );
    if (this.allowDocumentContent && query.trim()) {
      const terms = [...new Set(tokenize(query))];
      // 优先读取标题匹配的文档，所有正文缓存仅活在当前请求内。
      const candidates = [...matches.values()].map(({ row }) => row);
      candidates.push(...this.catalog.filter((row) => !matches.has(row.documentId)));
      for (const row of candidates) {
        this.signal.throwIfAborted();
        const body = await this.body(row);
        if (body.error) continue;
        const lower = body.text.toLocaleLowerCase();
        const position = Math.min(
          ...terms.map((term) => lower.indexOf(term)).filter((value) => value >= 0),
        );
        if (!Number.isFinite(position)) continue;
        const found = matches.get(row.documentId) ?? { row, score: 0 };
        found.score += 1;
        found.excerpt = body.text.slice(
          Math.max(0, position - 120),
          Math.max(0, position - 120) + 600,
        );
        found.contentTruncated = body.truncated;
        matches.set(row.documentId, found);
      }
    }
    const sorted = [...matches.values()].sort((a, b) => b.score - a.score);
    const page = [];
    let pageCharacters = 0;
    for (const item of sorted.slice(offset, offset + limit)) {
      // 引用会再次序列化元信息，预留转义膨胀空间保证单个工具结果有界。
      const characters =
        3 * JSON.stringify({ ...this.metadata(item.row), excerpt: item.excerpt }).length + 600;
      if (page.length && pageCharacters + characters > WORKSPACE_LIMITS.toolCharacters) break;
      pageCharacters += characters;
      page.push(item);
    }
    const failed = [...this.bodies.values()].filter((body) => body.error || body.truncated).length;
    return {
      scope: this.allowDocumentContent
        ? "workspace_documents_with_authorized_content"
        : "workspace_document_metadata",
      total: sorted.length,
      offset,
      nextOffset: offset + page.length < sorted.length ? offset + page.length : null,
      catalogTruncated: this.catalogTruncated,
      contentSearch: {
        enabled: this.allowDocumentContent,
        scannedDocuments: this.bodies.size,
        complete:
          this.allowDocumentContent &&
          query.trim().length > 0 &&
          this.bodies.size === this.catalog.length &&
          !failed &&
          !this.catalogTruncated,
      },
      documents: page.map(({ row, excerpt, contentTruncated }) => ({
        ...this.metadata(row),
        ...(excerpt !== undefined ? { excerpt, contentTruncated } : {}),
      })),
      sourceDocs: page.map(({ row, excerpt }) =>
        this.citation(
          row,
          excerpt === undefined ? undefined : JSON.stringify({ ...this.metadata(row), excerpt }),
          excerpt !== undefined,
        ),
      ),
    };
  }
  async get(documentId) {
    if (!this.allowDocumentContent)
      return {
        error:
          "Document content access is disabled for this request. Ask the user to enable it for this question.",
      };
    if (!this.available) return { error: "Workspace documents are unavailable." };
    const row = this.byId.get(documentId);
    if (!row)
      return {
        error:
          "Workspace document not found. Use search_documents to find an existing document ID.",
      };
    const body = await this.body(row);
    if (body.error) return body;
    let text = body.text.slice(0, WORKSPACE_LIMITS.outputCharacters);
    const result = () => ({
      ...this.metadata(row),
      text,
      truncated: body.truncated || body.text.length > text.length,
      sourceDocs: [this.citation(row, text, true)],
    });
    // 控制字符在 JSON 中会膨胀，正文长度上限之外再限制实际工具输出。
    while (text.length && JSON.stringify(result()).length > WORKSPACE_LIMITS.toolCharacters)
      text = text.slice(0, Math.floor(text.length * 0.75));
    return result();
  }
  related({ sourceId: requestedId, offset = 0, limit = 10 }) {
    const id =
      requestedId.startsWith(PREFIX) && requestedId.endsWith(":content")
        ? requestedId.slice(0, -8)
        : requestedId;
    const document = id.startsWith(PREFIX) ? this.byId.get(id.slice(PREFIX.length)) : undefined;
    const asset = this.index.byId.get(id);
    if (!document && !asset?.assetId)
      return {
        error: "Resource not found. Use an existing asset or workspace document source ID.",
      };
    const related = new Map();
    const addAsset = (target, relationship) => {
      if (target.startsWith(PREFIX)) {
        const found = this.byId.get(target.slice(PREFIX.length));
        related.set(target, {
          sourceId: target,
          relationship,
          exists: Boolean(found),
          ...(found ? { title: found.title, documentId: found.documentId } : {}),
        });
        return;
      }
      const found = this.index.byId.get(target);
      related.set(target, {
        sourceId: target,
        relationship,
        exists: Boolean(found?.assetId),
        ...(found?.assetId
          ? { title: safeString(found.title, 160), kind: found.kind, assetId: found.assetId }
          : {}),
      });
    };
    if (document)
      for (const ref of document.bindings) addAsset(assetSourceId(ref), "document_binding");
    else {
      for (const row of this.catalog)
        if (row.bindings.some((ref) => assetSourceId(ref) === id))
          related.set(row.sourceId, {
            sourceId: row.sourceId,
            documentId: row.documentId,
            title: row.title,
            exists: true,
            relationship: "document_binding",
          });
    }
    const links = [
      ...(Array.isArray(this.snapshot.links) ? this.snapshot.links : []),
      ...(this.snapshot.phoneNumbers ?? []).flatMap((phone) =>
        (phone.subscriptionIds ?? []).map((target) => ({
          from: { kind: "phone", id: phone.id },
          to: { kind: "ai", id: target },
        })),
      ),
    ];
    for (const link of links) {
      if (!isResourceRef(link?.from) || !isResourceRef(link?.to)) continue;
      const from = assetSourceId(link.from),
        to = assetSourceId(link.to);
      if (from === id && to !== id) addAsset(to, "asset_link");
      else if (to === id && from !== id) addAsset(from, "asset_link");
    }
    const resources = [...related.values()].slice(offset, offset + limit);
    const origin = document
      ? this.citation(document)
      : {
          id: asset.id,
          title: safeString(asset.title, 160),
          kind: asset.kind,
          assetId: asset.assetId,
        };
    const result = () => ({
      sourceId: id,
      total: related.size,
      offset,
      nextOffset: offset + resources.length < related.size ? offset + resources.length : null,
      documentRelationsAvailable: this.available,
      catalogTruncated: this.catalogTruncated,
      resources,
      sourceDocs: [
        {
          ...origin,
          id: `related:${id}:${offset}:${limit}`,
          text: JSON.stringify({ sourceId: id, total: related.size, resources }),
        },
        ...resources
          .filter((item) => item.exists)
          .map((item) =>
            item.documentId
              ? this.citation(this.byId.get(item.documentId), JSON.stringify(item))
              : {
                  id: item.sourceId,
                  title: item.title,
                  kind: item.kind,
                  assetId: item.assetId,
                  text: JSON.stringify(item),
                },
          ),
      ],
    });
    while (
      resources.length > 1 &&
      JSON.stringify(result()).length > WORKSPACE_LIMITS.toolCharacters
    )
      resources.pop();
    return result();
  }
}
