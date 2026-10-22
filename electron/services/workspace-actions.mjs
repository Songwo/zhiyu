import { createHash, randomUUID } from "node:crypto";
import { documentRevision } from "./documents.mjs";
import { markdownContent } from "./document-markdown.mjs";
import { calendarDay, normalizeBilling } from "./renewals.mjs";

const COLLECTIONS = {
  server: "servers",
  service: "services",
  domain: "domains",
  mail: "mailboxes",
  ai: "aiAssets",
  secret: "secrets",
  cert: "certs",
};
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (ref) => `${ref.kind}:${ref.id}`;
const pairKey = (link) => [key(link.from), key(link.to)].sort().join("|");
const ownKeys = (value, allowed) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
function text(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}无效。`);
  return value;
}
function resource(snapshot, ref) {
  if (
    !ownKeys(ref, ["kind", "id"]) ||
    !Object.hasOwn(COLLECTIONS, ref.kind) ||
    typeof ref.id !== "string"
  )
    throw new Error("资产引用无效。");
  const asset = (snapshot[COLLECTIONS[ref.kind]] ?? []).find((asset) => asset.id === ref.id);
  if (!asset) throw new Error("资产已不存在，请重新生成建议。");
  return asset;
}
const label = (asset) => asset.name || asset.address || asset.cn || asset.id;
const accountPreview = (value) =>
  Object.entries(value)
    .map(
      ([field, content]) =>
        `${field === "name" ? "名称" : "标签"}：${Array.isArray(content) ? content.join("、") : content}`,
    )
    .join("\n");

/** 每类资产允许由修改建议更新的字段；凭据、主机地址、连接配置都不在其中。 */
const ASSET_FIELDS = {
  server: ["tags", "notes", "expiresAt", "billing"],
  domain: ["tags", "notes", "expiresAt", "billing"],
  service: ["tags", "notes", "expiresAt", "billing"],
  ai: ["tags", "notes", "renewsAt", "monthlyUsd"],
  cert: ["tags", "notes"],
  mail: ["tags", "notes"],
};
const FIELD_LABEL = {
  tags: "标签",
  notes: "备注",
  expiresAt: "到期日",
  renewsAt: "续费日",
  billing: "费用",
  monthlyUsd: "美元月费",
};
const CYCLE_LABEL = { month: "每月", year: "每年", once: "一次性" };
function fieldText(field, value) {
  if (value === undefined || value === null || value === "") return "未填写";
  if (field === "tags") return value.length ? value.join("、") : "无";
  if (field === "billing")
    return `${value.currency === "USD" ? "$" : "¥"}${value.amount} · ${CYCLE_LABEL[value.cycle]}`;
  if (field === "monthlyUsd") return `$${value}`;
  return String(value);
}
const fieldsPreview = (value) =>
  Object.entries(value)
    .map(([field, content]) => `${FIELD_LABEL[field]}：${fieldText(field, content)}`)
    .join("\n");
/** 校验并规范化资产字段补丁；不允许的字段直接拒绝，而不是悄悄丢弃。 */
function assetPatch(kind, input) {
  const allowed = ASSET_FIELDS[kind];
  if (!allowed) throw new Error("这类资产不支持通过建议修改。");
  if (!ownKeys(input, allowed) || !Object.keys(input).length)
    throw new Error(`这类资产只能修改：${allowed.map((field) => FIELD_LABEL[field]).join("、")}。`);
  const patch = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === "tags") {
      if (
        !Array.isArray(value) ||
        value.length > 20 ||
        value.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 80)
      )
        throw new Error("标签格式无效。");
      patch.tags = [...new Set(value.map((tag) => tag.trim()))];
    } else if (field === "notes") {
      if (typeof value !== "string" || value.length > 2000) throw new Error("备注过长或格式无效。");
      patch.notes = value;
    } else if (field === "expiresAt" || field === "renewsAt") {
      const day =
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? calendarDay(value) : "";
      if (!day) throw new Error(`${FIELD_LABEL[field]}必须是有效的 YYYY-MM-DD 日期。`);
      patch[field] = day;
    } else if (field === "billing") {
      if (value === null) patch.billing = null;
      else {
        const billing = normalizeBilling(value);
        if (!billing)
          throw new Error("费用格式无效：需要金额、币种（CNY/USD）和周期（month/year/once）。");
        patch.billing = billing;
      }
    } else if (field === "monthlyUsd") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100000)
        throw new Error("美元月费无效。");
      patch.monthlyUsd = Math.round(value * 100) / 100;
    }
  }
  return patch;
}
/** 域名状态跟着到期日走，与编辑器保存时的规则一致。 */
function expiryStatus(day, now) {
  const days = Math.ceil((Date.parse(`${day}T00:00:00`) - now) / 86_400_000);
  return days <= 7 ? "offline" : days <= 21 ? "warning" : "online";
}
const NEW_DOCUMENT_ID = () => `doc-${randomUUID()}`;

/** 模型只能暂存建议；应用入口只接受主进程签发的随机标识。 */
export class WorkspaceActions {
  constructor({ getSnapshot, documents, mutateAssets, now = Date.now }) {
    this.getSnapshot = getSnapshot;
    this.documents = documents;
    this.mutateAssets = mutateAssets;
    this.now = now;
    this.pending = new Map();
    // 已处理记录只留短期标识与状态，不占待审阅容量，也不保留整篇文档。
    this.finished = new Map();
  }
  prune() {
    const now = this.now();
    for (const [id, proposal] of this.pending)
      if (proposal.state === "pending" && proposal.expiresAt <= now) this.pending.delete(id);
    for (const [id, record] of this.finished) if (record.expiresAt <= now) this.finished.delete(id);
  }
  finish(proposal, state) {
    this.pending.delete(proposal.id);
    this.finished.set(proposal.id, { state, expiresAt: this.now() + 30 * 60 * 1000 });
    while (this.finished.size > 1024) this.finished.delete(this.finished.keys().next().value);
  }
  async propose(name, args, { allowDocumentContent = false, requestId } = {}) {
    if (
      !ownKeys(args, [
        "documentId",
        "find",
        "replace",
        "expectedTitle",
        "title",
        "assetId",
        "patch",
        "from",
        "to",
        "asset",
        "markdown",
        "bindings",
        "reason",
      ])
    )
      throw new Error("不允许的修改字段。");
    const reason = text(args.reason, 1200, "修改依据");
    const snapshot = this.getSnapshot();
    let details;
    if (name === "propose_document_rename") {
      if (!ownKeys(args, ["documentId", "expectedTitle", "title", "reason"]))
        throw new Error("不允许的文档重命名字段。");
      if (typeof args.documentId !== "string" || !/^doc-[a-zA-Z0-9-]{1,80}$/.test(args.documentId))
        throw new Error("文档标识无效。");
      const expectedTitle = text(args.expectedTitle, 160, "原标题");
      const title = text(args.title, 160, "新标题").trim();
      let doc;
      try {
        doc = await this.documents.get(args.documentId);
      } catch (error) {
        throw new Error(
          error.code === "ENOENT"
            ? "文档已不存在，请重新检索后生成建议。"
            : "无法读取本机文档，请检查文档状态后重试。",
        );
      }
      if (doc.title !== expectedTitle)
        throw new Error("文档标题已变化，请重新检索当前标题后生成建议。");
      if (title === doc.title) throw new Error("文档标题未变化。");
      // 正文仅在本机保留并参与并发校验，不发送给模型或提案预览。
      details = {
        type: "document-rename",
        title: doc.title,
        documentId: doc.id,
        before: doc.title,
        after: title,
        revision: documentRevision(doc),
        next: { ...doc, title },
      };
    } else if (name === "propose_document_edit") {
      if (!ownKeys(args, ["documentId", "find", "replace", "reason"]))
        throw new Error("不允许的文档修改字段。");
      if (!allowDocumentContent)
        throw new Error("请先勾选本次允许检索文档正文，再生成文档修改建议。");
      text(args.find, 4000, "原文");
      if (
        typeof args.replace !== "string" ||
        args.replace.length > 6000 ||
        args.replace === args.find
      )
        throw new Error("替换文本无效或未变化。");
      const doc = await this.documents.get(args.documentId);
      const next = structuredClone(doc);
      let matches = 0;
      const visit = (node) => {
        if (node.type === "text" && typeof node.text === "string") {
          matches += node.text.split(args.find).length - 1;
          node.text = node.text.replace(args.find, () => args.replace);
        }
        node.content?.forEach(visit);
      };
      if (typeof doc.markdown === "string") {
        matches = doc.markdown.split(args.find).length - 1;
        if (matches === 1) {
          next.markdown = doc.markdown.replace(args.find, () => args.replace);
          next.content = markdownContent(next.markdown);
        }
      } else visit(next.content);
      if (matches !== 1)
        throw new Error("原文必须在同一文本段落中唯一匹配，请缩小修改片段后重试。");
      details = {
        type: "document-edit",
        title: doc.title,
        documentId: doc.id,
        before: args.find,
        after: args.replace,
        revision: documentRevision(doc),
        next,
      };
    } else if (name === "propose_account_edit") {
      if (
        !ownKeys(args, ["assetId", "patch", "reason"]) ||
        !ownKeys(args.patch, ["name", "tags"]) ||
        !Object.keys(args.patch).length
      )
        throw new Error("账号只允许修改名称和标签；密码、用户名、网址请在本机账号面板编辑。");
      const ref = { kind: "secret", id: args.assetId };
      const asset = resource(snapshot, ref);
      const patch = {};
      if (args.patch.name !== undefined) patch.name = text(args.patch.name, 200, "账号名称").trim();
      if (args.patch.tags !== undefined) {
        if (
          !Array.isArray(args.patch.tags) ||
          args.patch.tags.length > 20 ||
          args.patch.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 80)
        )
          throw new Error("标签格式无效。");
        patch.tags = [...new Set(args.patch.tags.map((tag) => tag.trim()))];
      }
      const before = Object.fromEntries(
        Object.keys(patch).map((field) => [field, asset[field] ?? (field === "tags" ? [] : "")]),
      );
      details = {
        type: "account-edit",
        title: label(asset),
        assetId: asset.id,
        before: accountPreview(before),
        after: accountPreview(patch),
        revision: hash(asset),
        patch,
      };
    } else if (name === "propose_asset_link") {
      if (!ownKeys(args, ["from", "to", "reason"])) throw new Error("不允许的关联字段。");
      const from = resource(snapshot, args.from),
        to = resource(snapshot, args.to);
      const link = { from: args.from, to: args.to };
      if (key(args.from) === key(args.to)) throw new Error("不能关联同一资产。");
      if ((snapshot.links ?? []).some((item) => pairKey(item) === pairKey(link)))
        throw new Error("这两个资产已经关联。");
      details = {
        type: "asset-link",
        title: `${label(from)} ↔ ${label(to)}`,
        before: "未关联",
        after: "建立关联",
        link,
        revision: hash([from, to]),
      };
    } else if (name === "propose_document_binding") {
      if (!ownKeys(args, ["documentId", "to", "reason"])) throw new Error("不允许的文档关联字段。");
      const asset = resource(snapshot, args.to),
        doc = await this.documents.get(args.documentId);
      if (doc.bindings.some((ref) => key(ref) === key(args.to)))
        throw new Error("文档已经关联此资产。");
      details = {
        type: "document-binding",
        title: `${doc.title} ↔ ${label(asset)}`,
        documentId: doc.id,
        before: "未关联",
        after: "建立关联",
        to: args.to,
        revision: documentRevision(doc),
        assetRevision: hash(asset),
        next: { ...doc, bindings: [...doc.bindings, args.to] },
      };
    } else if (name === "propose_asset_update") {
      if (!ownKeys(args, ["asset", "patch", "reason"])) throw new Error("不允许的资产修改字段。");
      const asset = resource(snapshot, args.asset);
      const patch = assetPatch(args.asset.kind, args.patch);
      const before = Object.fromEntries(Object.keys(patch).map((field) => [field, asset[field]]));
      if (JSON.stringify(before) === JSON.stringify(patch)) throw new Error("建议的值与当前一致。");
      details = {
        type: "asset-update",
        title: label(asset),
        assetId: asset.id,
        asset: args.asset,
        before: fieldsPreview(before),
        after: fieldsPreview(patch),
        revision: hash(asset),
        patch,
      };
    } else if (name === "propose_document_create") {
      if (!ownKeys(args, ["title", "markdown", "bindings", "reason"]))
        throw new Error("不允许的新文档字段。");
      const title = text(args.title, 160, "文档标题").trim();
      const markdown = text(args.markdown, 20000, "文档正文");
      const bindings = args.bindings ?? [];
      if (!Array.isArray(bindings) || bindings.length > 10)
        throw new Error("文档最多关联 10 项资产。");
      const assets = bindings.map((ref) => resource(snapshot, ref));
      const id = NEW_DOCUMENT_ID();
      // 预先按正式规则解析一次，格式问题在审阅前就暴露。
      markdownContent(markdown);
      details = {
        type: "document-create",
        title,
        before: "（新文档）",
        after: [
          markdown.length > 600 ? `${markdown.slice(0, 600)}…` : markdown,
          assets.length ? `\n关联：${assets.map(label).join("、")}` : "",
        ].join(""),
        next: {
          id,
          title,
          markdown,
          bindings: bindings.map((ref) => ({ kind: ref.kind, id: ref.id })),
        },
        assetRevision: hash(assets),
        bindings,
      };
    } else throw new Error("未知的修改建议。");
    this.prune();
    if (this.pending.size >= 80) throw new Error("待审阅建议过多，请先应用或放弃已有建议。");
    const proposal = {
      ...details,
      id: randomUUID(),
      reason,
      requestId,
      expiresAt: this.now() + 30 * 60 * 1000,
      state: "pending",
    };
    this.pending.set(proposal.id, proposal);
    return this.public(proposal);
  }
  public({ id, type, title, documentId, assetId, before, after, reason, expiresAt }) {
    return { id, type, title, documentId, assetId, before, after, reason, expiresAt };
  }
  discardRequest(requestId) {
    for (const [id, proposal] of this.pending)
      if (proposal.requestId === requestId && proposal.state === "pending") this.pending.delete(id);
  }
  discard(id) {
    this.prune();
    if (this.finished.get(id)?.state === "applied") throw new Error("此建议已经应用，不能再忽略。");
    const proposal = this.pending.get(id);
    if (proposal?.state === "applying") throw new Error("此建议正在应用，请等待修改保存。");
    if (proposal) this.finish(proposal, "dismissed");
    // 历史对话中的过期建议也允许隐藏，不会重新创建任何修改。
    return true;
  }
  async apply(id) {
    this.prune();
    const finished = this.finished.get(id);
    if (finished)
      throw new Error(
        finished.state === "applied"
          ? "此建议已经应用，请勿重复操作。"
          : "此建议已忽略，请重新生成后审阅。",
      );
    const proposal = this.pending.get(id);
    if (!proposal || proposal.expiresAt <= this.now())
      throw new Error("建议已过期或软件已重启，请重新生成后审阅。");
    if (proposal.state !== "pending") throw new Error("此建议正在应用或已经应用，请勿重复操作。");
    proposal.state = "applying";
    try {
      let result;
      if (proposal.type === "document-create") {
        const assertCurrent = () => {
          const assets = proposal.bindings.map((ref) => resource(this.getSnapshot(), ref));
          if (hash(assets) !== proposal.assetRevision)
            throw new Error("关联资产已变化，请重新生成建议。");
        };
        assertCurrent();
        const document = await this.documents.save(
          { ...proposal.next, createOnly: true },
          { assertCurrent },
        );
        result = { document };
      } else if (["document-edit", "document-rename", "document-binding"].includes(proposal.type)) {
        const assertCurrent = proposal.to
          ? () => {
              if (hash(resource(this.getSnapshot(), proposal.to)) !== proposal.assetRevision)
                throw new Error("关联资产已变化，请重新生成建议。");
            }
          : null;
        assertCurrent?.();
        const document = await this.documents.save(proposal.next, {
          expectedRevision: proposal.revision,
          assertCurrent,
        });
        result = { document };
      } else {
        result = await this.mutateAssets((snapshot) => {
          if (proposal.type === "asset-update") {
            const asset = resource(snapshot, proposal.asset);
            if (hash(asset) !== proposal.revision)
              throw new Error("资产资料已变化，请重新生成建议。");
            const next = { ...asset };
            for (const [field, value] of Object.entries(proposal.patch)) {
              if (value === null) delete next[field];
              else next[field] = value;
            }
            if (proposal.patch.monthlyUsd !== undefined) next.monthlyUsdKnown = true;
            if (proposal.asset.kind === "domain" && proposal.patch.expiresAt)
              next.status = expiryStatus(proposal.patch.expiresAt, this.now());
            const collection = COLLECTIONS[proposal.asset.kind];
            return {
              ...snapshot,
              [collection]: snapshot[collection].map((item) =>
                item.id === asset.id ? next : item,
              ),
            };
          }
          if (proposal.type === "account-edit") {
            const asset = resource(snapshot, { kind: "secret", id: proposal.assetId });
            if (hash(asset) !== proposal.revision)
              throw new Error("账号资料已变化，请重新生成建议。");
            return {
              ...snapshot,
              secrets: snapshot.secrets.map((item) =>
                item.id === asset.id ? { ...item, ...proposal.patch } : item,
              ),
            };
          }
          const from = resource(snapshot, proposal.link.from),
            to = resource(snapshot, proposal.link.to);
          if (hash([from, to]) !== proposal.revision)
            throw new Error("关联资产已变化，请重新生成建议。");
          const seen = new Set();
          const links = [...(snapshot.links ?? []), proposal.link].filter((link) => {
            try {
              resource(snapshot, link.from);
              resource(snapshot, link.to);
            } catch {
              return false;
            }
            const id = pairKey(link);
            if (key(link.from) === key(link.to) || seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          return { ...snapshot, links };
        });
      }
      this.finish(proposal, "applied");
      return result;
    } catch (error) {
      proposal.state = "pending";
      throw error;
    }
  }
}
