import MiniSearch from "minisearch";
import { createHash } from "node:crypto";

const COLLECTIONS = {
  server: "servers",
  service: "services",
  domain: "domains",
  cert: "certs",
  mail: "mailboxes",
  ai: "aiAssets",
  secret: "secrets",
};
const FIELDS = [
  "name",
  "label",
  "host",
  "region",
  "os",
  "status",
  "cpu",
  "memory",
  "disk",
  "lastSeen",
  "probedAt",
  "expiresAt",
  "renewsAt",
  "registrar",
  "dns",
  "autoRenew",
  "cn",
  "issuer",
  "address",
  "domain",
  "kind",
  "usedMb",
  "quotaMb",
  "provider",
  "category",
  "plan",
  "monthlyUsd",
  "usagePct",
  "usageAvailable",
  "usageCheckedAt",
  "monthlyUsdKnown",
  "subscriptionExpiresAt",
  "lastRotated",
  "demo",
  "tags",
];
const LABELS = {
  server: "服务器 主机",
  service: "服务资产 Workers 博客 自建邮箱",
  domain: "域名 续费",
  cert: "证书 到期",
  mail: "邮箱 容量",
  ai: "AI 订阅 费用 用量",
  secret: "凭据 密钥 元信息",
};
export const hash = (text) => createHash("sha256").update(text).digest("hex");

/** MiniSearch 配置以常量共享：loadJSON 反序列化必须使用与构建时相同的选项。 */
const SEARCH_OPTIONS = { fields: ["title", "text"], storeFields: [], tokenize };
/** 索引格式版本：分块、字段或序列化结构变化时递增，使旧缓存整体失效。 */
const INDEX_FORMAT_VERSION = 2;

/** 文档集签名：任何文档的增删改都会改变签名，从而触发重建。 */
function docsSignature(docs) {
  const parts = [`v${INDEX_FORMAT_VERSION}`];
  for (const doc of docs) parts.push(`${doc.id}\0${doc.text}`, "\x01");
  return hash(parts.join(""));
}

export function tokenize(text) {
  const result =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9]+|\p{Script=Han}/gu) ?? [];
  for (const part of String(text).match(/\p{Script=Han}+/gu) ?? []) {
    for (let i = 0; i < part.length - 1; i++) result.push(part.slice(i, i + 2));
  }
  return result;
}

function normalizedMailFolders(value) {
  if (!Array.isArray(value))
    return [
      { id: "work", name: "工作邮箱" },
      { id: "personal", name: "生活邮箱" },
    ];
  const folders = [];
  for (const folder of value.slice(0, 100)) {
    if (
      !folder ||
      typeof folder.id !== "string" ||
      !folder.id ||
      folder.id.length > 128 ||
      typeof folder.name !== "string"
    )
      continue;
    const name = folder.name.trim().slice(0, 40);
    if (!name || folders.some((saved) => saved.id === folder.id || saved.name === name)) continue;
    folders.push({ id: folder.id, name });
  }
  return folders;
}

/** 密钥分组归一化；与邮箱分组同规则，仅保留 id 与名称（颜色不进索引）。 */
function normalizedSecretFolders(value) {
  const defaults = [
    { id: "work", name: "工作密钥" },
    { id: "personal", name: "个人密钥" },
  ];
  if (!Array.isArray(value)) return defaults;
  const folders = [];
  for (const folder of value.slice(0, 100)) {
    if (
      !folder ||
      typeof folder.id !== "string" ||
      !folder.id ||
      folder.id.length > 128 ||
      typeof folder.name !== "string"
    )
      continue;
    const name = folder.name.trim().slice(0, 40);
    if (!name || folders.some((saved) => saved.id === folder.id || saved.name === name)) continue;
    folders.push({ id: folder.id, name });
  }
  return folders;
}

export function assetDocuments(
  snapshot,
  mailFolders = normalizedMailFolders(snapshot.mailFolders),
  secretFolders = normalizedSecretFolders(snapshot.secretFolders),
) {
  const docs = [];
  for (const [kind, collection] of Object.entries(COLLECTIONS)) {
    for (const asset of snapshot[collection] ?? []) {
      if (typeof asset?.id !== "string" || !asset.id || asset.id.length > 200) continue;
      // 仅索引白名单元信息；密钥值、账号密码及自由备注不进入模型上下文。
      const fields = Object.fromEntries(
        FIELDS.filter(
          (key) =>
            !(key === "monthlyUsd" && asset.monthlyUsdKnown === false) &&
            !(key === "usagePct" && asset.usageAvailable === false) &&
            (["string", "number", "boolean"].includes(typeof asset[key]) ||
              (key === "tags" && Array.isArray(asset[key]))),
        ).map((key) => [
          key,
          typeof asset[key] === "string"
            ? asset[key].slice(0, 500)
            : key === "tags"
              ? asset[key]
                  .filter((tag) => typeof tag === "string")
                  .slice(0, 30)
                  .map((tag) => tag.slice(0, 100))
              : asset[key],
        ]),
      );
      if (kind === "service" && typeof asset.typeId === "string") {
        // 自定义类型：带上类型名与字段（名称 + 用户填写的值），字段提示里已要求不填凭据。
        const type = (snapshot.assetTypes ?? []).find((entry) => entry.id === asset.typeId);
        if (type && typeof type.name === "string") {
          fields.assetType = type.name.slice(0, 40);
          for (const field of (type.fields ?? []).slice(0, 12)) {
            const value = asset.fields?.[field.id];
            if (typeof field.label === "string" && typeof value === "string" && value)
              fields[`field ${field.label.slice(0, 40)}`] = value.slice(0, 500);
          }
        }
      }
      if (kind === "mail") {
        const folder = mailFolders.find((entry) => entry.id === asset.folderId);
        fields.folderId = folder?.id ?? "";
        fields.folderName = folder?.name ?? "未分组";
      }
      if (kind === "secret") {
        const folder = secretFolders.find((entry) => entry.id === asset.folderId);
        fields.folderId = folder?.id ?? "";
        fields.folderName = folder?.name ?? "未分组";
      }
      const id = `asset:${kind}:${asset.id}`;
      const title = String(asset.name ?? asset.cn ?? asset.address ?? asset.id);
      docs.push({
        id,
        title,
        kind,
        assetId: asset.id,
        text: `${LABELS[kind]}\n\n${Object.entries(fields)
          .map(
            ([key, value]) =>
              `- ${key}: ${String(value)
                .replace(/[\\`*_{}[\]<>|]/g, "\\$&")
                .replace(/\r?\n/g, " ")}`,
          )
          .join("\n")}`,
        fields,
      });
    }
  }
  const ids = new Set(docs.map((doc) => doc.id));
  for (const doc of docs) {
    const links = (snapshot.links ?? []).flatMap(({ from, to }) => {
      const a = `asset:${from.kind}:${from.id}`,
        b = `asset:${to.kind}:${to.id}`;
      return doc.id === a && ids.has(b) ? [b] : doc.id === b && ids.has(a) ? [a] : [];
    });
    if (links.length) doc.text += `\n关联: ${links.join(", ")}`;
  }
  return docs;
}

export function knowledgeChunks(documents) {
  return documents.flatMap((doc) => {
    const chunks = [];
    for (let start = 0; start < doc.text.length; start += 800) {
      chunks.push({
        id: `doc:${doc.id}:${start}`,
        documentId: doc.id,
        title: doc.name,
        text: doc.text.slice(start, start + 1000),
        chunk: Math.floor(start / 800) + 1,
      });
    }
    return chunks;
  });
}

export class LocalIndex {
  /**
   * `saved` 为上次持久化的 `rag-index.json` 内容：签名一致时直接
   * `MiniSearch.loadJSON` 复用，跳过分词与建索引（见 docs/archive/plans/v0.9.0）。
   */
  constructor(snapshot, documents, saved = null) {
    const folders = normalizedMailFolders(snapshot.mailFolders);
    const secretFolders = normalizedSecretFolders(snapshot.secretFolders);
    const assets = assetDocuments(snapshot, folders, secretFolders);
    const mailboxes = assets.filter((doc) => doc.kind === "mail");
    this.mailFolders = [...folders, { id: "", name: "未分组" }].map((folder) => {
      const members = mailboxes.filter((doc) => doc.fields.folderId === folder.id);
      return {
        ...folder,
        count: members.length,
        mailboxCount: members.filter((doc) => doc.fields.kind !== "alias").length,
        aliasCount: members.filter((doc) => doc.fields.kind === "alias").length,
        demoCount: members.filter((doc) => doc.fields.demo === true).length,
      };
    });
    const folderDocs = this.mailFolders.map((folder) => ({
      id: `mail-folder:${folder.id ? `saved:${folder.id}` : "unfiled"}`,
      title: `${folder.name} / 邮箱收纳组`,
      text: `本地邮箱文件夹 收纳组 分组；不是 IMAP 服务端的收件箱、已发送等邮件目录。\n${JSON.stringify(folder)}`,
    }));
    // 密钥分组目录：只统计名称、类型与数量；密钥值与提示永不进入索引。
    const secrets = assets.filter((doc) => doc.kind === "secret");
    this.secretFolders = [...secretFolders, { id: "", name: "未分组" }].map((folder) => {
      const members = secrets.filter((doc) => doc.fields.folderId === folder.id);
      return {
        ...folder,
        count: members.length,
        passwordCount: members.filter((doc) => doc.fields.kind === "password").length,
        keyCount: members.filter((doc) => doc.fields.kind !== "password").length,
      };
    });
    const secretFolderDocs = this.secretFolders.map((folder) => ({
      id: `secret-folder:${folder.id ? `saved:${folder.id}` : "unfiled"}`,
      title: `${folder.name} / 密钥分组`,
      text: `本地密钥分组 收纳组；条目为密钥元信息目录，不含密钥值。\n${JSON.stringify(folder)}`,
    }));
    this.docs = [...assets, ...folderDocs, ...secretFolderDocs, ...knowledgeChunks(documents)];
    if (this.docs.length > 6000) throw new Error("本地索引超过 6000 个片段，请减少导入文档。");
    this.byId = new Map(this.docs.map((doc) => [doc.id, doc]));
    this.signature = docsSignature(this.docs);
    this.reused = false;
    if (saved?.signature === this.signature && saved.index && typeof saved.index === "object") {
      try {
        // MiniSearch 7 的 toJSON 返回普通对象，对应 loadJS 反序列化。
        this.searcher = MiniSearch.loadJS(saved.index, SEARCH_OPTIONS);
        this.reused = true;
        return;
      } catch {
        // 缓存损坏按未命中处理，走重建。
      }
    }
    this.searcher = new MiniSearch(SEARCH_OPTIONS);
    this.searcher.addAll(this.docs);
  }
  search(query, limit = 6) {
    return this.searcher
      .search(query, { boost: { title: 3 }, prefix: true, combineWith: "OR" })
      .slice(0, limit)
      .map((row) => ({ ...this.byId.get(row.id), score: row.score }));
  }
  listMailboxes({ folderId, query = "", offset = 0, limit = 25 } = {}) {
    const term = query.trim().toLocaleLowerCase();
    const matches = this.docs.filter(
      (doc) =>
        doc.kind === "mail" &&
        doc.assetId &&
        (folderId === undefined || doc.fields.folderId === folderId) &&
        (!term ||
          [doc.title, doc.fields.address, doc.fields.domain, doc.fields.folderName].some((value) =>
            String(value ?? "")
              .toLocaleLowerCase()
              .includes(term),
          )),
    );
    return {
      scope: "local_mailbox_groups",
      total: matches.length,
      offset,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      mailboxes: matches.slice(offset, offset + limit).map((doc) => ({
        sourceId: doc.id,
        assetId: doc.assetId,
        address: doc.fields.address ?? doc.title,
        kind: doc.fields.kind ?? "mailbox",
        status: doc.fields.status ?? null,
        folderId: doc.fields.folderId,
        folderName: doc.fields.folderName,
        demo: doc.fields.demo === true,
      })),
    };
  }
  /** 按密钥分组分页列出密钥元信息目录；名称、类型与归属之外的字段一律不返回。 */
  listSecrets({ folderId, query = "", offset = 0, limit = 25 } = {}) {
    const term = query.trim().toLocaleLowerCase();
    const matches = this.docs.filter(
      (doc) =>
        doc.kind === "secret" &&
        doc.assetId &&
        (folderId === undefined || doc.fields.folderId === folderId) &&
        (!term ||
          [doc.title, doc.fields.kind, doc.fields.folderName].some((value) =>
            String(value ?? "")
              .toLocaleLowerCase()
              .includes(term),
          )),
    );
    return {
      scope: "local_secret_groups",
      total: matches.length,
      offset,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      secrets: matches.slice(offset, offset + limit).map((doc) => ({
        sourceId: doc.id,
        assetId: doc.assetId,
        name: doc.title,
        kind: doc.fields.kind ?? null,
        folderId: doc.fields.folderId,
        folderName: doc.fields.folderName,
        lastRotated: doc.fields.lastRotated ?? null,
      })),
    };
  }
  summary() {
    const assets = this.docs.filter((x) => x.assetId);
    const counts = Object.fromEntries(
      Object.keys(COLLECTIONS).map((kind) => [kind, assets.filter((x) => x.kind === kind).length]),
    );
    return {
      counts,
      total: assets.length,
      demo: assets.filter((x) => x.fields.demo).length,
      monthlyUsd: assets.reduce((sum, x) => sum + (Number(x.fields.monthlyUsd) || 0), 0),
      attention: assets
        .filter((x) => x.fields.status !== "online")
        .map((x) => ({ sourceId: x.id, title: x.title, status: x.fields.status })),
    };
  }
}

export function cosine(a, b) {
  if (a.length !== b.length || !a.length) throw new Error("Embedding 向量维度不一致。");
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function hybridSearch(index, query, vector, vectors, limit) {
  const scores = new Map();
  const lexical = index.search(query, 30);
  const semantic = index.docs
    .map((doc) => ({ id: doc.id, score: cosine(vector, vectors[hash(doc.text)]) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  for (const list of [lexical, semantic])
    list.forEach((doc, i) => scores.set(doc.id, (scores.get(doc.id) ?? 0) + 1 / (60 + i)));
  return [...scores]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ ...index.byId.get(id), score }));
}
