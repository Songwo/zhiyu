import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceActions } from "./workspace-actions.mjs";
import { DocumentsStore } from "./documents.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhiyu-actions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const documents = new DocumentsStore(directory);
  let snapshot = {
    servers: [{ id: "server-1", name: "隔离主机" }],
    secrets: [{ id: "account-1", name: "测试账号", tags: ["测试"], kind: "网站账号" }],
    links: [],
  };
  let time = Date.now();
  const actions = new WorkspaceActions({
    documents,
    getSnapshot: () => snapshot,
    now: () => time,
    mutateAssets: async (mutate) => {
      snapshot = mutate(snapshot);
      return { snapshot };
    },
  });
  const document = await documents.save({
    id: "doc-test",
    title: "测试指南",
    bindings: [],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "请先检查旧地址，再查看资源。", marks: [{ type: "bold" }] },
          ],
        },
      ],
    },
  });
  return {
    actions,
    documents,
    document,
    getSnapshot: () => snapshot,
    expire: () => {
      time += 31 * 60 * 1000;
    },
  };
}
const edit = {
  documentId: "doc-test",
  find: "旧地址",
  replace: "新地址",
  reason: "按用户提供的最新地址修订。",
};

const rename = {
  documentId: "doc-test",
  expectedTitle: "测试指南",
  title: "测试服务器信息概要",
  reason: "按用户要求重命名这篇文档。",
};

test("Agent局部修改Markdown保留六级标题、表格、任务列表及原文排版", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const markdown =
    "###### 六级标题\n\n| 名称 | 地址 |\n| --- | --- |\n| 测试 | 旧地址 |\n\n- [x] 已完成\n";
  await documents.save({ ...document, markdown });
  const proposal = await actions.propose("propose_document_edit", edit, {
    allowDocumentContent: true,
  });
  await actions.apply(proposal.id);
  assert.equal((await documents.get(document.id)).markdown, markdown.replace("旧地址", "新地址"));
});

test("Markdown唯一匹配失败时拒绝修改而不转换富文本", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const markdown = "旧地址\n\n旧地址";
  await documents.save({ ...document, markdown });
  await assert.rejects(
    actions.propose("propose_document_edit", edit, { allowDocumentContent: true }),
    /唯一/,
  );
  assert.equal((await documents.get(document.id)).markdown, markdown);
});

test("文档重命名只需元信息，预览不泄露正文，确认前不写入", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const proposal = await actions.propose("propose_document_rename", rename);
  assert.equal(proposal.type, "document-rename");
  assert.equal(proposal.before, document.title);
  assert.equal(proposal.after, rename.title);
  assert.equal(JSON.stringify(proposal).includes("旧地址"), false);
  assert.deepEqual(await documents.get(document.id), document);
  const { document: saved } = await actions.apply(proposal.id);
  assert.equal(saved.title, rename.title);
  assert.deepEqual(saved.content, document.content);
  assert.deepEqual(saved.bindings, document.bindings);
  assert.equal(saved.createdAt, document.createdAt);
  assert.equal((await documents.listMetadata()).documents[0].title, rename.title);
  await assert.rejects(actions.apply(proposal.id), /已经应用/);
});

test("文档重命名校验原标题、空标题、长度和额外字段", async (t) => {
  const { actions, documents, document } = await fixture(t);
  for (const patch of [
    { expectedTitle: "错误标题" },
    { title: " " },
    { title: "测".repeat(161) },
    { title: document.title },
    { content: { type: "doc" } },
    { find: "旧地址" },
    { documentId: "../../vault" },
  ])
    await assert.rejects(actions.propose("propose_document_rename", { ...rename, ...patch }));
  assert.deepEqual(await documents.get(document.id), document);
  assert.equal(actions.pending.size, 0);
});

test("重命名检索不到文档或存储损坏时不暴露路径与底层错误内容", async (t) => {
  const { actions, documents, document } = await fixture(t);
  await documents.remove(document.id);
  await assert.rejects(actions.propose("propose_document_rename", rename), {
    message: "文档已不存在，请重新检索后生成建议。",
  });
  actions.documents = {
    async get() {
      throw new Error("private-file-path and private-corrupt-body");
    },
  };
  await assert.rejects(actions.propose("propose_document_rename", rename), {
    message: "无法读取本机文档，请检查文档状态后重试。",
  });
  assert.equal(actions.pending.size, 0);
});

test("重命名提案不能覆盖排队中的正文更改或重建已删除文档", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const proposal = await actions.propose("propose_document_rename", rename);
  const next = structuredClone(document);
  next.content.content[0].content[0].text = "用户刚保存的新内容";
  const saving = documents.save(next);
  const applying = actions.apply(proposal.id);
  await saving;
  await assert.rejects(applying, /其他位置修改/);
  assert.equal((await documents.get(document.id)).title, document.title);
  assert.deepEqual((await documents.get(document.id)).content, next.content);
  const fresh = await actions.propose("propose_document_rename", rename);
  await documents.remove(document.id);
  await assert.rejects(actions.apply(fresh.id), /已删除/);
  assert.equal((await documents.listMetadata()).documents.length, 0);
});

test("模型生成文档建议不会写盘，明确应用后保留其余正文和格式", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const proposal = await actions.propose("propose_document_edit", edit, {
    allowDocumentContent: true,
  });
  assert.deepEqual(await documents.get(document.id), document);
  assert.equal(proposal.before, "旧地址");
  assert.equal(proposal.after, "新地址");
  assert.equal(Object.hasOwn(proposal, "next"), false);
  const { document: saved } = await actions.apply(proposal.id);
  assert.equal(saved.content.content[0].content[0].text, "请先检查新地址，再查看资源。");
  assert.deepEqual(saved.content.content[0].content[0].marks, [{ type: "bold" }]);
  await assert.rejects(actions.apply(proposal.id), /已经应用/);
});
test("文档正文无授权时不能生成修改建议", async (t) => {
  const { actions } = await fixture(t);
  await assert.rejects(actions.propose("propose_document_edit", edit), /正文/);
});

test("建议中的美元符号按字面保存，与预览保持一致", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const replace = "$& $` $' $$";
  const proposal = await actions.propose(
    "propose_document_edit",
    { ...edit, replace },
    { allowDocumentContent: true },
  );
  assert.equal(proposal.after, replace);
  await actions.apply(proposal.id);
  assert.equal(
    (await documents.get(document.id)).content.content[0].content[0].text,
    "请先检查" + replace + "，再查看资源。",
  );
});
test("排队中的文档编辑会让旧提案失败，不覆盖新内容", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const proposal = await actions.propose("propose_document_edit", edit, {
    allowDocumentContent: true,
  });
  const newer = documents.save({ ...document, title: "用户刚修改的标题" });
  const applying = actions.apply(proposal.id);
  await newer;
  await assert.rejects(applying, /其他位置修改/);
  assert.equal((await documents.get(document.id)).title, "用户刚修改的标题");
});
test("已删除文档不会因为应用旧提案而重建", async (t) => {
  const { actions, documents } = await fixture(t);
  const proposal = await actions.propose("propose_document_edit", edit, {
    allowDocumentContent: true,
  });
  await documents.remove(edit.documentId);
  await assert.rejects(actions.apply(proposal.id), /已删除/);
});
test("账号敏感字段和额外字段被拒绝，只能修改名称与标签", async (t) => {
  const { actions, getSnapshot } = await fixture(t);
  for (const field of ["password", "username", "url", "note", "apiKey", "id", "_browserAsset"]) {
    await assert.rejects(
      actions.propose("propose_account_edit", {
        assetId: "account-1",
        patch: { [field]: "secret-test" },
        reason: "测试",
      }),
      /只允许/,
    );
  }
  const proposal = await actions.propose("propose_account_edit", {
    assetId: "account-1",
    patch: { name: "新账号名称", tags: ["工作", "工作"] },
    reason: "统一用户指定分类",
  });
  assert.equal(getSnapshot().secrets[0].name, "测试账号");
  await actions.apply(proposal.id);
  assert.equal(getSnapshot().secrets[0].name, "新账号名称");
  assert.deepEqual(getSnapshot().secrets[0].tags, ["工作"]);
});
test("关联建议只能引用真实存在资产，确认后去重保存", async (t) => {
  const { actions, getSnapshot } = await fixture(t);
  const args = {
    from: { kind: "secret", id: "account-1" },
    to: { kind: "server", id: "server-1" },
    reason: "用户确认此账号管理这台主机",
  };
  await assert.rejects(
    actions.propose("propose_asset_link", { ...args, to: { kind: "server", id: "missing" } }),
    /已不存在/,
  );
  const a = await actions.propose("propose_asset_link", args);
  const b = await actions.propose("propose_asset_link", { ...args, from: args.to, to: args.from });
  assert.equal(getSnapshot().links.length, 0);
  await actions.apply(a.id);
  await actions.apply(b.id);
  assert.equal(getSnapshot().links.length, 1);
});
test("文档绑定建议无须正文授权，保存后保持文档内容", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const proposal = await actions.propose("propose_document_binding", {
    documentId: document.id,
    to: { kind: "secret", id: "account-1" },
    reason: "用户指定这篇指南属于此账号",
  });
  await actions.apply(proposal.id);
  const saved = await documents.get(document.id);
  assert.deepEqual(saved.content, document.content);
  assert.deepEqual(saved.bindings, [{ kind: "secret", id: "account-1" }]);
});
test("过期、未知和失败运行中的建议都不能应用", async (t) => {
  const { actions, expire } = await fixture(t);
  const proposal = await actions.propose("propose_document_edit", edit, {
    allowDocumentContent: true,
    requestId: "failed-run",
  });
  actions.discardRequest("failed-run");
  await assert.rejects(actions.apply(proposal.id), /过期/);
  const expiring = await actions.propose("propose_document_edit", edit, {
    allowDocumentContent: true,
  });
  expire();
  await assert.rejects(actions.apply(expiring.id), /过期/);
  await assert.rejects(actions.apply("invented-id"), /过期/);
});

test("连续处理超过 80 个建议不会耗尽待审阅容量，已应用建议不再保留正文", async (t) => {
  const { actions } = await fixture(t);
  let first;
  for (let index = 0; index < 85; index += 1) {
    const proposal = await actions.propose(
      "propose_document_edit",
      {
        ...edit,
        find: index % 2 === 0 ? "旧地址" : "新地址",
        replace: index % 2 === 0 ? "新地址" : "旧地址",
      },
      { allowDocumentContent: true },
    );
    first ??= proposal;
    await actions.apply(proposal.id);
    assert.equal(actions.pending.size, 0);
  }
  await assert.rejects(actions.apply(first.id), /已经应用/);
});

test("忽略建议释放容量且不修改原数据，已忽略建议不能重新应用", async (t) => {
  const { actions, documents, document } = await fixture(t);
  const proposals = [];
  for (let index = 0; index < 80; index += 1)
    proposals.push(
      await actions.propose("propose_document_edit", edit, { allowDocumentContent: true }),
    );
  await assert.rejects(
    actions.propose("propose_document_edit", edit, { allowDocumentContent: true }),
    /待审阅建议过多/,
  );
  assert.equal(actions.discard(proposals[0].id), true);
  assert.equal(actions.pending.size, 79);
  const replacement = await actions.propose("propose_document_edit", edit, {
    allowDocumentContent: true,
  });
  for (const proposal of [...proposals.slice(1), replacement]) actions.discard(proposal.id);
  assert.equal(actions.pending.size, 0);
  assert.deepEqual(await documents.get(document.id), document);
  await assert.rejects(actions.apply(proposals[0].id), /已忽略/);
  assert.equal(actions.discard(proposals[0].id), true);
});

test("忽略过期或重启前的建议可清理对话，但不会中断正在应用的修改", async (t) => {
  const { actions } = await fixture(t);
  assert.equal(actions.discard("before-restart"), true);
  const proposal = await actions.propose("propose_document_edit", edit, {
    allowDocumentContent: true,
  });
  const applying = actions.apply(proposal.id);
  assert.throws(() => actions.discard(proposal.id), /正在应用/);
  await applying;
  assert.throws(() => actions.discard(proposal.id), /已经应用/);
});

test("资产修改建议：只允许白名单字段，应用后写入费用与日期，域名状态随到期日更新", async (t) => {
  const f = await fixture(t);
  const snapshot = f.getSnapshot();
  snapshot.domains = [{ id: "domain-1", name: "example.test", expiresAt: "2030-01-01", status: "online" }];
  await assert.rejects(
    f.actions.propose("propose_asset_update", {
      asset: { kind: "server", id: "server-1" },
      patch: { host: "10.0.0.1" },
      reason: "改地址",
    }),
    /只能修改/,
  );
  await assert.rejects(
    f.actions.propose("propose_asset_update", {
      asset: { kind: "server", id: "server-1" },
      patch: { expiresAt: "2026-02-30" },
      reason: "无效日期",
    }),
    /有效的 YYYY-MM-DD/,
  );
  const soon = new Date(Date.now() + 3 * 86_400_000);
  const day = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  const proposal = await f.actions.propose("propose_asset_update", {
    asset: { kind: "domain", id: "domain-1" },
    patch: { expiresAt: day, billing: { amount: 69, currency: "CNY", cycle: "year" }, tags: ["博客"] },
    reason: "用户说明了续费日期与价格。",
  });
  assert.equal(proposal.type, "asset-update");
  assert.match(proposal.before, /到期日：2030-01-01/);
  assert.match(proposal.after, /费用：¥69 · 每年/);
  await f.actions.apply(proposal.id);
  const domain = f.getSnapshot().domains[0];
  assert.equal(domain.expiresAt, day);
  assert.deepEqual(domain.billing, { amount: 69, currency: "CNY", cycle: "year" });
  assert.deepEqual(domain.tags, ["博客"]);
  assert.equal(domain.status, "offline");
});

test("资产修改建议在资产变化后拒绝应用；AI 月费写入时标记为已知", async (t) => {
  const f = await fixture(t);
  f.getSnapshot().aiAssets = [{ id: "ai-1", name: "测试订阅", monthlyUsd: 0, monthlyUsdKnown: false }];
  const proposal = await f.actions.propose("propose_asset_update", {
    asset: { kind: "ai", id: "ai-1" },
    patch: { monthlyUsd: 20, renewsAt: "2030-05-01" },
    reason: "账单显示每月 20 美元。",
  });
  const stale = await f.actions.propose("propose_asset_update", {
    asset: { kind: "ai", id: "ai-1" },
    patch: { notes: "旧建议" },
    reason: "测试并发。",
  });
  await f.actions.apply(proposal.id);
  const ai = f.getSnapshot().aiAssets[0];
  assert.equal(ai.monthlyUsd, 20);
  assert.equal(ai.monthlyUsdKnown, true);
  assert.equal(ai.renewsAt, "2030-05-01");
  await assert.rejects(f.actions.apply(stale.id), /已变化/);
});

test("新建文档建议：应用后创建并关联资产，关联资产缺失时拒绝", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.actions.propose("propose_document_create", {
      title: "恢复手册",
      markdown: "# 恢复",
      bindings: [{ kind: "server", id: "missing" }],
      reason: "缺失资产",
    }),
    /已不存在/,
  );
  const proposal = await f.actions.propose("propose_document_create", {
    title: "隔离主机恢复手册",
    markdown: "# 隔离主机恢复手册\n\n- [ ] 确认备份位置\n- [ ] 检查服务状态",
    bindings: [{ kind: "server", id: "server-1" }],
    reason: "用户要求整理恢复步骤。",
  });
  assert.equal(proposal.type, "document-create");
  assert.match(proposal.after, /关联：隔离主机/);
  const { document } = await f.actions.apply(proposal.id);
  assert.equal(document.title, "隔离主机恢复手册");
  assert.deepEqual(document.bindings, [{ kind: "server", id: "server-1" }]);
  const saved = await f.documents.get(document.id);
  assert.match(JSON.stringify(saved.content), /确认备份位置/);
  await assert.rejects(f.actions.apply(proposal.id), /已经应用/);
});
