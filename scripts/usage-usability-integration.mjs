import { chooseOption } from "./select-helper.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "nanpad-usage-flow-"));
await writeFile(
  join(directory, "local-usage.json"),
  JSON.stringify({ version: 1, enabled: false, events: [], checkpoints: [], records: [] }),
);
await writeFile(
  join(directory, "preferences.json"),
  JSON.stringify({ locale: "zh", notifications: false, closeToTray: false }),
);
let forbidden = true;
let loginRequests = 0;
const server = createServer((req, res) => {
  if (req.url === "/qa/") {
    res.end("<html>QA panel</html>");
    return;
  }
  if (req.url === "/qa/login") {
    loginRequests++;
    if (forbidden) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    res.setHeader("Set-Cookie", "qa_session=isolated; HttpOnly; Path=/qa");
    res.end(JSON.stringify({ success: true }));
    return;
  }
  if (req.url === "/qa/panel/api/inbounds/list") {
    assert.match(req.headers.cookie ?? "", /qa_session=isolated/);
    res.end(
      JSON.stringify({
        success: true,
        obj: [{ id: 1, remark: "QA inbound", up: 1024, down: 4096, total: 1048576, expiryTime: 0 }],
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/qa`;
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
try {
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await completeOnboarding(page);
  await page.evaluate(async () => {
    await window.sinan.preferences.set({ notifications: false });
    await window.sinan.store.save({
      version: 0,
      state: {
        servers: [
          {
            id: "qa-node-host",
            name: "用量回归主机",
            host: "example.test",
            port: 22,
            username: "",
            label: "",
            os: "",
            region: "",
            status: "warning",
            cpu: 0,
            memory: 0,
            disk: 0,
            uptime: "未采集",
            lastSeen: "",
            tags: [],
            notes: "",
          },
        ],
        domains: [],
        certs: [],
        mailboxes: [],
        aiAssets: [],
        secrets: [],
        activity: [],
        links: [],
      },
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: /^自建节点/ })
    .first()
    .click();
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  await page
    .getByLabel("粘贴分享链接（一行一个）")
    .fill("hysteria2://qa-only-secret@example.test:443?insecure=0#QA-HY2");
  await page.getByRole("button", { name: "导入链接", exact: true }).click();
  await page.getByText("节点已保存", { exact: true }).waitFor();
  await page.getByRole("button", { name: "连接流量统计", exact: true }).first().click();
  assert.equal(await page.getByLabel("来源名称", { exact: true }).inputValue(), "QA-HY2");
  assert.equal(await page.getByLabel("面板密码", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("入站 ID（可选）").isVisible(), false);
  await page.getByLabel("面板根地址（含自定义路径）").fill(url);
  await page.getByLabel("面板用户名", { exact: true }).fill("qa-user");
  await page.getByLabel("面板密码", { exact: true }).fill("qa-only-panel-secret");
  await page.getByRole("button", { name: "保存并验证连接", exact: true }).click();
  await page
    .getByRole("dialog", { name: "连接用量来源", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("tab", { name: /订阅与来源/ }).getAttribute("aria-selected"),
    "true",
    "保存失败也应关闭弹窗并定位到可操作的来源卡",
  );
  const sourceCard = page.locator(".usage-source-card").filter({
    has: page.getByRole("heading", { name: "QA-HY2", exact: true }),
  });
  await sourceCard.getByRole("alert").waitFor();
  assert.equal(loginRequests, 1, "点击保存后只发起一次验证");
  assert.match(await sourceCard.getByRole("alert").innerText(), /3x-ui 登录 HTTP 403/);
  assert.doesNotMatch(await sourceCard.getByRole("alert").innerText(), /Admin Key/);
  assert.equal(
    await sourceCard.getByRole("button", { name: "编辑 QA-HY2", exact: true }).isEnabled(),
    true,
  );
  let usage = await page.evaluate(() => window.sinan.usage.list());
  assert.equal(usage.sources.length, 1, "验证失败保留来源供重试");
  assert.match(usage.sources[0].nodeId, /^qa-node-host:nod-/);
  assert.equal(usage.records.length, 0, "失败不伪造用量");
  assert.doesNotMatch(JSON.stringify(usage), /qa-only-panel-secret/);
  forbidden = false;
  await sourceCard.getByRole("button", { name: "刷新 QA-HY2", exact: true }).click();
  await sourceCard.getByRole("alert").waitFor({ state: "detached" });
  // 来源类型与连接状态分开显示，状态是单独的胶囊。
  await sourceCard.locator(".usage-source-state").getByText("已连接", { exact: true }).waitFor();
  await sourceCard.getByText("3x-ui 面板", { exact: false }).first().waitFor();
  usage = await page.evaluate(() => window.sinan.usage.list());
  assert.equal(usage.sources.length, 1);
  assert.equal(usage.records[0].upload, 1024);
  assert.equal(usage.records[0].download, 4096);
  assert.equal(loginRequests, 2);
  await page
    .getByRole("button", { name: /^自建节点/ })
    .first()
    .click();
  await page.getByText("流量统计已连接", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看流量记录", exact: true }).click();
  await page.getByRole("tab", { name: /订阅与来源/ }).click();
  forbidden = true;
  await page.getByRole("button", { name: "刷新 QA-HY2", exact: true }).click();
  await sourceCard.getByText(/采集失败，保留上次有效数据/).waitFor();
  usage = await page.evaluate(() => window.sinan.usage.list());
  assert.equal(usage.records[0].download, 4096, "后续连接失败保留上次真实用量");
  await page.getByRole("button", { name: "连接用量来源", exact: true }).click();
  await page.getByLabel("面板密码", { exact: true }).fill("qa-unused-draft");
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "来源类型", exact: true }),
    "OpenAI API",
  );
  assert.equal(await page.getByLabel("面板密码", { exact: true }).count(), 0);
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "来源类型", exact: true }),
    "3x-ui 面板",
  );
  assert.equal(
    await page.getByLabel("面板密码", { exact: true }).inputValue(),
    "",
    "切换来源清理不相关凭据",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await mkdir("release/screenshots", { recursive: true });
  await page.screenshot({ path: "release/screenshots/v1.1-usage.png" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      importedHy2: true,
      linkedNode: true,
      firstVerification: true,
      forbiddenRetained: true,
      retry: true,
      historyRetained: true,
      credentialIsolation: true,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
