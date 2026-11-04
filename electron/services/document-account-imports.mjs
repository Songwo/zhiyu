import { documentRevision } from "./document-revision.mjs";
import { documentMarkdown } from "./document-markdown.mjs";

function normalizeCandidate(value) {
  const fields = {};
  for (const [key, limit] of Object.entries({
    name: 300,
    url: 4096,
    username: 320,
    password: 4096,
    note: 20000,
  })) {
    const text = value?.[key] ?? "";
    if (typeof text !== "string" || text.length > limit || text.includes("\0"))
      throw new Error("账号字段无效或过长，请检查预览内容。");
    fields[key] = text;
  }
  if (!fields.username.trim() || /[\r\n]/.test(fields.username + fields.name))
    throw new Error("请为每个选中的账号填写有效的用户名。");
  fields.url = fields.url.trim();
  if (fields.url) {
    let url;
    try {
      url = new URL(fields.url);
    } catch {
      throw new Error("账号网址格式无效。");
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error("账号网址只支持不含内嵌凭据的 HTTP 或 HTTPS 地址。");
    fields.url = url.href;
  }
  fields.name = fields.name.trim() || fields.username;
  return fields;
}

function credentialKey(value) {
  try {
    const site = value.url ? new URL(value.url).origin : "";
    return JSON.stringify([site, value.username || "", value.password || ""]);
  } catch {
    return null;
  }
}

/** 只从主进程文档读取候选；确认后一次加密写入，原文不修改。 */
export class DocumentAccountImports {
  #vault;
  #documents;
  #getAssets;
  #publishAssets;
  #parse;
  #now;
  #tickets = new Map();
  #queue = Promise.resolve();
  #off;
  #uuid;
  constructor({
    vault,
    documents,
    getAssets,
    publishAssets,
    parse,
    now = Date.now,
    uuid = () => globalThis.crypto.randomUUID(),
  }) {
    this.#vault = vault;
    this.#documents = documents;
    this.#getAssets = getAssets;
    this.#publishAssets = publishAssets;
    this.#parse = parse;
    this.#now = now;
    this.#uuid = uuid;
    this.#off = vault.onLock(() => this.#tickets.clear());
  }
  #run(action) {
    const session = this.#vault.session;
    const guard = () => {
      if (!this.#vault.unlocked || this.#vault.session !== session)
        throw new Error("密钥库已锁定，请解锁后重新提取账号。");
    };
    const task = this.#queue.then(async () => {
      guard();
      return action(guard);
    });
    this.#queue = task.catch(() => {});
    return task;
  }
  preview(documentId) {
    return this.#run(async (guard) => {
      const doc = await this.#documents.get(documentId);
      guard();
      const parsed = this.#parse(documentMarkdown(doc));
      guard();
      const ticket = this.#uuid();
      while (this.#tickets.size >= 4) this.#tickets.delete(this.#tickets.keys().next().value);
      this.#tickets.set(ticket, {
        documentId,
        revision: documentRevision(doc),
        allowedIds: new Set(parsed.candidates.map((row) => row.id)),
        expires: this.#now() + 300000,
      });
      return { ticket, documentTitle: doc.title, ...parsed };
    });
  }
  cancel(ticket) {
    this.#tickets.delete(ticket);
    return Promise.resolve();
  }
  stop() {
    this.#tickets.clear();
    this.#off?.();
    this.#off = null;
  }
  commit(input) {
    return this.#run(async (guard) => {
      const pending = this.#tickets.get(input?.ticket);
      const check = () => {
        guard();
        if (
          !pending ||
          this.#tickets.get(input.ticket) !== pending ||
          pending.expires <= this.#now()
        )
          throw new Error("提取预览已失效，请重新打开文档提取。");
      };
      check();
      if (
        !Array.isArray(input.candidates) ||
        !input.candidates.length ||
        input.candidates.length > 50
      )
        throw new Error("请选择 1–50 个要保存的账号。");
      const seen = new Set();
      const candidates = input.candidates.map((candidate) => {
        if (!pending.allowedIds.has(candidate?.id) || seen.has(candidate.id))
          throw new Error("账号候选已失效，请重新提取。");
        seen.add(candidate.id);
        return normalizeCandidate(candidate);
      });
      const doc = await this.#documents.get(pending.documentId);
      check();
      if (documentRevision(doc) !== pending.revision)
        throw new Error("原文档已修改，请重新提取以免保存过期内容。");
      const all = await this.#vault.readAll("account:");
      const snapshot = await this.#getAssets();
      check();
      const visible = Array.isArray(snapshot) ? snapshot : snapshot?.secrets || [];
      const index = new Map();
      for (const [key, record] of Object.entries(all)) {
        const id = key.slice("account:".length);
        const asset =
          visible.find((item) => item.id === id && item.kind === "account") ||
          record?._browserAsset;
        const identity = credentialKey(record || {});
        if (asset?.id === id && identity) index.set(identity, asset);
      }
      const assets = [];
      const entries = [];
      let existing = 0;
      const updatedAt = new Date(this.#now()).toISOString();
      for (const candidate of candidates) {
        const key = credentialKey(candidate);
        let asset = index.get(key);
        if (asset) existing++;
        else {
          asset = {
            id: this.#uuid(),
            name: candidate.name,
            kind: "account",
            hint: "",
            value: "",
            notes: "",
            lastRotated: updatedAt.slice(0, 10),
            status: "online",
            tags: [],
          };
          entries.push({
            id: `account:${asset.id}`,
            secret: {
              url: candidate.url,
              username: candidate.username,
              password: candidate.password,
              note: candidate.note,
              updatedAt,
              _browserAsset: asset,
            },
          });
          index.set(key, asset);
        }
        if (!assets.some((item) => item.id === asset.id)) assets.push(asset);
      }
      const bindings = [...doc.bindings];
      for (const asset of assets)
        if (!bindings.some((ref) => ref.kind === "secret" && ref.id === asset.id))
          bindings.push({ kind: "secret", id: asset.id });
      if (bindings.length > 100) throw new Error("文档关联已达到 100 项上限，请减少选择后重试。");
      check();
      if (entries.length) await this.#vault.batch(entries, { beforeCommit: check });
      check();
      this.#tickets.delete(input.ticket);
      // 凭据中保留恢复标记，即使资产文件保存失败，下次解锁也能恢复入口。
      await this.#publishAssets(assets);
      guard();
      let document;
      let bindingError;
      try {
        document = await this.#documents.save(
          { ...doc, bindings },
          { expectedRevision: pending.revision, assertCurrent: guard },
        );
      } catch {
        guard();
        bindingError = "账号已加密保存，但原文档关联未保存。请重新提取并确认以补全关联。";
      }
      guard();
      return {
        assets,
        added: entries.length,
        existing,
        documentId: doc.id,
        ...(document ? { document } : {}),
        ...(bindingError ? { bindingError } : {}),
      };
    });
  }
}
