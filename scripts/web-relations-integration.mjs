import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { webResearchFixture } from "./web-research-fixture.mjs";

const f = await webResearchFixture({ built: true }),
  browser = await chromium.launch();
const time = new Date().toISOString(),
  errors = [];
const server = {
  id: "relation-server",
  name: "恢复主机",
  host: "server.example.test",
  port: 22,
  username: "root",
  label: "",
  os: "Linux",
  region: "",
  status: "offline",
  cpu: 0,
  memory: 0,
  disk: 0,
  uptime: "",
  lastSeen: "",
  tags: [],
  notes: "",
  sshConfigured: false,
};
const secret = {
  id: "relation-account",
  name: "运维账号",
  kind: "account",
  value: "",
  hint: "",
  notes: "",
  lastRotated: time,
  status: "online",
  tags: [],
};
const mail = {
  id: "relation-mail",
  address: "primary@example.test",
  domain: "example.test",
  kind: "mailbox",
  tags: [],
  status: "online",
  notes: "",
  usedMb: 0,
  quotaMb: 0,
};
const ai = {
  id: "relation-ai",
  name: "合成订阅",
  provider: "synthetic",
  plan: "",
  tags: [],
  status: "online",
  monthlyUsd: 0,
  usagePct: 0,
  renewsAt: "",
  keyHint: "",
  notes: "",
};
const ref = (kind, id) => ({ kind, id });
await f.call("/api/web/store", {
  cookie: f.cookie,
  method: "PUT",
  body: {
    revision: null,
    data: {
      version: 0,
      state: {
        servers: [server],
        secrets: [secret],
        mailboxes: [mail],
        aiAssets: [ai],
        links: [
          { from: ref("mail", mail.id), to: ref("secret", secret.id) },
          { from: ref("secret", secret.id), to: ref("server", server.id) },
          { from: ref("secret", secret.id), to: ref("ai", ai.id) },
        ],
      },
    },
  },
});
const doc = {
  id: "doc-relation",
  title: "恢复运维手册",
  content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "合成原文不能被关联操作覆盖" }] },
    ],
  },
  bindings: [ref("server", server.id)],
  createdAt: time,
  updatedAt: time,
};
await f.call("/api/web/documents/" + doc.id, { cookie: f.cookie, method: "PUT", body: doc });
await mkdir("screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  await context.addCookies([{ name: "zhiyu_session", value: f.cookie.split("=")[1], url: f.base }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.base);
  await page.locator('[data-app-ready="true"]').waitFor();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^服务器/ })
    .click();
  await page.getByRole("button", { name: "关系图", exact: true }).click();
  await page.locator('.asset-graph-node[data-asset-kind="document"]').waitFor();
  await page.getByRole("button", { name: "管理资源关联", exact: true }).click();
  const panel = page.getByRole("region", { name: "管理资源关联", exact: true });
  await panel.getByRole("button", { name: "新增关联", exact: true }).click();
  await panel.getByRole("combobox", { name: "起始资源" }).click();
  await page.getByRole("option").filter({ hasText: "运维账号" }).click();
  await panel.getByRole("combobox", { name: "目标资源" }).click();
  await page.getByRole("option").filter({ hasText: "恢复运维手册" }).click();
  await panel.getByRole("button", { name: "保存关联", exact: true }).click();
  await page.waitForTimeout(600);
  const alerts = await panel.getByRole("alert").allTextContents();
  assert.deepEqual(alerts, [], "Web 文档必须从服务器读取，不能误报本地文档不存在");
  const read = async () =>
    await (
      await f.call("/api/web/documents/" + doc.id, { cookie: f.cookie, method: "GET" })
    ).json();
  const saved = await read();
  assert.ok(saved.bindings.some((b) => b.id === secret.id));
  assert.deepEqual(saved.content, doc.content);
  await page.getByRole("button", { name: "管理资源关联", exact: true }).click();
  const focus = page.getByRole("combobox", { name: "聚焦关联资源", exact: true });
  await focus.click();
  await page.getByRole("option").filter({ hasText: mail.address }).click();
  const chain = page.getByRole("region", { name: "关联链路", exact: true });
  await chain.getByText(/直接关联 1 项/).waitFor();
  assert.match(await chain.innerText(), /运维账号.*↔.*恢复运维手册/s);
  await page.screenshot({ path: "screenshots/web-mail-account-document-chain.png" });
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  assert.ok((await read()).bindings.some((b) => b.id === secret.id));
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "资产关系图", exact: true })
    .click();
  await page.getByRole("button", { name: "管理资源关联", exact: true }).click();
  await panel.getByRole("button", { name: /已确认关联/ }).click();
  await panel
    .getByRole("button", { name: "解除 恢复运维手册 与 运维账号 的关联", exact: true })
    .click();
  await page.waitForTimeout(500);
  const after = await read();
  assert.equal(
    after.bindings.some((b) => b.id === secret.id),
    false,
  );
  assert.deepEqual(after.content, doc.content);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        serverDocumentLinks: true,
        reloadPersistence: true,
        originalPreserved: true,
        indirectPaths: true,
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const page of browser.contexts().flatMap((c) => c.pages()))
    console.error((await page.locator("body").innerText()).slice(-5000));
  throw error;
} finally {
  await browser.close();
  await f.close();
}
