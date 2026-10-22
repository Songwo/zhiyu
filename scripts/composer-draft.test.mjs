import assert from "node:assert/strict";
import test from "node:test";
import {
  initialWorkspaceName,
  initialServerMode,
  initialAiMode,
  sshDraftForSave,
  serverAccountKey,
  serverAccountDraft,
  serverAssetFromDraft,
} from "../src/lib/composer-draft.mjs";

test("首次进入无需先填写个人资料，空名称使用工作区默认值并保留已有名称", () => {
  assert.equal(initialWorkspaceName(undefined, "我的工作区"), "我的工作区");
  assert.equal(initialWorkspaceName("   ", "我的工作区"), "我的工作区");
  assert.equal(initialWorkspaceName("  已有工作区  ", "我的工作区"), "已有工作区");
});
test("新主机默认简录，编辑和已解析的SSH信息沿用连接入口", () => {
  assert.equal(initialServerMode(null, { name: "记录", host: "host.example.test" }), "record");
  assert.equal(initialServerMode({ id: "existing" }, {}), "ssh");
  assert.equal(initialServerMode(null, { _privateKeyPath: "qa-key" }), "ssh");
  assert.equal(initialServerMode(null, { _password: "qa-ssh" }), "ssh");
});
test("首次AI录入先选择来源，编辑旧资产仍直达原表单", () => {
  assert.equal(initialAiMode(null), "choose");
  assert.equal(initialAiMode({ id: "manual" }), "manual");
  assert.equal(initialAiMode({ id: "linked", oauthAccountId: "oauth-1" }), "manual");
  // 从订阅模板新建：名称、月费已预填，直接进入手动表单。
  assert.equal(initialAiMode(null, { name: "ChatGPT Plus" }), "manual");
  assert.equal(initialAiMode(null, {}), "choose");
});
test("切回仅记录不会把隐藏的SSH草稿写入密钥库", () => {
  const form = { _authKind: "agent", _password: "unsubmitted-ssh" };
  assert.equal(sshDraftForSave(form, "record"), null);
  assert.deepEqual(sshDraftForSave(form, "ssh"), form);
});
test("面板密码和SSH密码在同一录入会话内互不覆盖", () => {
  const form = { _password: "ssh-only", _privateKey: "ssh-private", _authKind: "key" };
  form[serverAccountKey("_password")] = "panel-only";
  form[serverAccountKey("_username")] = "panel-owner";
  form[serverAccountKey("_url")] = "https://panel.example.test";
  assert.equal(form._password, "ssh-only");
  const account = serverAccountDraft(form);
  assert.equal(account._password, "panel-only");
  assert.equal(account._username, "panel-owner");
  assert.equal(account._url, "https://panel.example.test");
  assert.equal(account._privateKey, undefined);
  assert.equal(serverAccountDraft({ _password: "ssh-only" })._password, undefined);
});
test("只改名称地址时保留隐藏元信息、节点、文档、探测和原认证方式", () => {
  const existing = {
    id: "server",
    imageDataUrl: "data:image/png;base64,qa",
    name: "old",
    label: "生产",
    host: "old.example.test",
    port: 2222,
    username: "deploy",
    os: "Debian",
    region: "SG",
    tags: ["prod"],
    notes: "notes",
    status: "online",
    cpu: 9,
    memory: 22,
    disk: 33,
    uptime: "3d",
    lastSeen: "2026-09-01",
    authKind: "key",
    probedAt: "2026-09-02",
    docs: "# 原文",
    nodes: [{ id: "node" }],
    customSecrets: [{ id: "secret" }],
    loadavg: "0.1",
  };
  const saved = serverAssetFromDraft({
    id: "server",
    existing,
    form: { name: "renamed", host: "new.example.test", _authKind: "password" },
    mode: "record",
    tags: existing.tags,
    now: "2026-09-30",
    pendingLabel: "未采集",
  });
  assert.equal(saved.name, "renamed");
  assert.equal(saved.host, "new.example.test");
  for (const key of [
    "imageDataUrl",
    "label",
    "port",
    "username",
    "os",
    "region",
    "notes",
    "authKind",
    "cpu",
    "memory",
    "disk",
    "uptime",
    "lastSeen",
    "probedAt",
    "loadavg",
  ])
    assert.equal(saved[key], existing[key], key);
  assert.deepEqual(saved.nodes, existing.nodes);
  assert.deepEqual(saved.customSecrets, existing.customSecrets);
  assert.equal(saved.docs, existing.docs);
  assert.equal(existing.host, "old.example.test");
});
test("最低字段的新主机不虚构采集指标或保存任何凭据", () => {
  const saved = serverAssetFromDraft({
    id: "new",
    existing: null,
    form: {
      name: "  笔记主机  ",
      host: " example.test ",
      _password: "do-not-persist",
      _panel_password: "private",
    },
    mode: "record",
    tags: [],
    now: "2026-09-30",
    pendingLabel: "未采集",
  });
  assert.equal(saved.name, "笔记主机");
  assert.equal(saved.host, "example.test");
  assert.equal(saved.port, 22);
  assert.equal(saved.cpu, 0);
  assert.equal(saved.memory, 0);
  assert.equal(saved.disk, 0);
  assert.equal(saved.uptime, "未采集");
  assert.equal(saved._password, undefined);
  assert.equal(saved._panel_password, undefined);
});

test("仅记录主机再次编辑保持简录，配置 SSH 后才启用探测", () => {
  const pending = serverAssetFromDraft({
    id: "note",
    form: { name: "note", host: "example.test" },
    existing: null,
    mode: "record",
    tags: [],
    now: "2026-09-30",
    pendingLabel: "未采集",
  });
  assert.equal(pending.sshConfigured, false);
  assert.equal(initialServerMode(pending, {}), "record");
  const configured = serverAssetFromDraft({
    id: "note",
    form: { _authKind: "agent" },
    existing: pending,
    mode: "ssh",
    tags: [],
    now: "2026-09-30",
    pendingLabel: "未采集",
  });
  assert.equal(configured.sshConfigured, true);
  assert.equal(initialServerMode(configured, {}), "ssh");
  const preserved = serverAssetFromDraft({
    id: "note",
    form: { name: "renamed" },
    existing: configured,
    mode: "record",
    tags: [],
    now: "2026-09-30",
    pendingLabel: "未采集",
  });
  assert.equal(preserved.sshConfigured, true);
});
