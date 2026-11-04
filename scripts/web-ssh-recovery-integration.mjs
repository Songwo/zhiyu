import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ssh2 from "ssh2";
import { chromium } from "playwright";
import { Vault } from "../electron/services/vault.mjs";
import { webResearchFixture } from "./web-research-fixture.mjs";

const f = await webResearchFixture({ built: true });
const master = "synthetic-ssh-master-2026",
  password = "synthetic-ssh-password";
const vault = new Vault(join(f.root, "web/workspace/vault.enc"));
await vault.create(master);
await vault.set("ssh:qa-host", { kind: "password", password });
vault.lock();
const clients = new Set();
const ssh = new ssh2.Server(
  {
    hostKeys: [
      generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
    ],
  },
  (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) =>
      ctx.method === "password" && ctx.password === password ? ctx.accept() : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        accept().on("exec", (acceptExec) => {
          const stream = acceptExec();
          stream.write("tester\n");
          stream.exit(0);
          stream.end();
        });
      }),
    );
  },
);
await new Promise((resolve) => ssh.listen(0, "127.0.0.1", resolve));
const target = { id: "qa-host", host: "127.0.0.1", port: ssh.address().port, username: "tester" };
const hostFile = join(f.root, "web/server/ssh-known-hosts.json"),
  address = `${target.host}:${target.port}`;
await writeFile(hostFile, JSON.stringify({ [address]: "SHA256:previous-server-key" }));
await f.call("/api/web/store", {
  cookie: f.cookie,
  method: "PUT",
  body: {
    revision: null,
    data: {
      version: 0,
      state: {
        servers: [
          {
            ...target,
            name: "指纹恢复测试",
            label: "",
            os: "Linux",
            region: "",
            lastSeen: "",
            expiresAt: "",
            status: "unknown",
            sshConfigured: true,
            tags: [],
            cpu: 0,
            mem: 0,
          },
        ],
      },
    },
  },
});
const browser = await chromium.launch(),
  errors = [],
  checks = [];
await mkdir("screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  await context.addCookies([{ name: "zhiyu_session", value: f.cookie.split("=")[1], url: f.base }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.base + "/login");
  // 已登录会重定向；未登录页面的风险提醒另由匿名窗口验证。
  const anonymous = await browser.newPage();
  await anonymous.goto(f.base + "/login");
  await anonymous.getByLabel("Web 安全提醒").waitFor();
  await anonymous.close();
  await page.goto(f.base);
  await page.locator('[data-app-ready="true"]').waitFor();
  const notice = page.getByLabel("Web 安全提醒");
  await notice.waitFor();
  await notice.locator("summary").click();
  assert.match(await notice.innerText(), /服务器加密存储不等于端到端加密/);
  await notice.locator("summary").click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^服务器/ })
    .click();
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.getByRole("button", { name: "编辑 指纹恢复测试", exact: true }).click();
  const form = page.getByRole("dialog", { name: "服务器", exact: true });
  await form.getByText("SSH 凭据", { exact: true }).waitFor();
  assert.equal(await form.locator('input[type="password"]').first().inputValue(), "");
  await form.getByRole("button", { name: "测试连接", exact: true }).click();
  const gate = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await gate.getByLabel("主密码", { exact: true }).fill(master);
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await form.getByText(/主机指纹已变更/).waitFor();
  assert.equal(JSON.parse(await readFile(hostFile, "utf8"))[address], "SHA256:previous-server-key");
  checks.push("解锁后测试沿用保存凭据，真实 SSH 指纹不匹配被拒绝且保留原记录");
  await form.getByRole("button", { name: "重置主机指纹", exact: true }).click();
  const confirm = form.getByRole("button", { name: "确认清除旧指纹", exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await form.getByLabel("输入完整主机地址和端口以确认").fill("wrong-host:22");
  assert.equal(await confirm.isDisabled(), true);
  await form.getByRole("button", { name: "取消", exact: true }).first().click();
  assert.equal(JSON.parse(await readFile(hostFile, "utf8"))[address], "SHA256:previous-server-key");
  await form.getByRole("button", { name: "重置主机指纹", exact: true }).click();
  await form.getByLabel("输入完整主机地址和端口以确认").fill(address);
  await page.screenshot({ path: "screenshots/web-ssh-reset-desktop.png" });
  await confirm.click();
  await form.getByText(/已清除旧指纹/).waitFor();
  assert.equal(JSON.parse(await readFile(hostFile, "utf8"))[address], undefined);
  await form.getByRole("button", { name: "测试连接", exact: true }).click();
  await form.getByText(/已连接，登录为/).waitFor();
  assert.match(JSON.parse(await readFile(hostFile, "utf8"))[address], /^SHA256:/);
  checks.push("错误输入和取消不会清除；确认后不自动连接，再次测试成功记录新指纹");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/web-security-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  checks.push("登录页和工作区风险提示，390px 无横向溢出，控制台无异常");
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  for (const page of browser.contexts().flatMap((c) => c.pages()))
    console.error((await page.locator("body").innerText()).slice(-5000));
  throw error;
} finally {
  await browser.close();
  for (const client of clients) client.destroy();
  await new Promise((resolve) => ssh.close(resolve));
  await f.close();
}
