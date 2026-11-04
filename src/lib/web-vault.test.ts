import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { webVault } from "./web-vault.ts";

const MASTER = "correct horse battery staple";

/** 真服务器 + 浏览器同款加密：网页写的桌面能读，桌面写的网页能读。 */
// 服务器只在运行时需要；不让类型检查顺着它进入未标注类型的备份模块。
const SERVER = "../../selfhost/server.mjs";
const DESKTOP_VAULT = "../../electron/services/vault.mjs";

test("网页版密钥库与桌面版同一文件格式，双向可读", async (t) => {
  const { createWebServer } = await import(SERVER);
  const { Vault } = await import(DESKTOP_VAULT);
  const root = await mkdtemp(join(tmpdir(), "zhiyu-web-vault-"));
  const web = await createWebServer({ root, staticDir: root, log: { log() {}, error() {} } });
  await new Promise<void>((r) => web.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    web.server.close();
    await rm(root, { recursive: true, force: true });
  });
  const setup = await realFetch(`${base}/api/web/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zhiyu": "1" },
    body: JSON.stringify({
      token: web.setupToken,
      username: "song",
      password: "home-and-office-2026",
    }),
  });
  const cookie = setup.headers.get("set-cookie")!.split(";")[0];
  globalThis.fetch = ((input: string, init: RequestInit = {}) =>
    realFetch(base + input, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), cookie },
    })) as typeof fetch;

  assert.deepEqual(await webVault.status(), { exists: false, unlocked: false });
  await assert.rejects(webVault.create("short"), /至少 10 位/);
  await webVault.create(MASTER);
  await webVault.set("account:gh", {
    username: "deploy",
    password: "s3cret-from-web",
    updatedAt: new Date().toISOString(),
  });
  await webVault.lock();
  await assert.rejects(webVault.get("account:gh"), /已锁定/);
  await assert.rejects(webVault.unlock("wrong master password"), /主密码不正确/);
  await webVault.unlock(MASTER);
  assert.equal((await webVault.get("account:gh"))?.password, "s3cret-from-web");

  // 桌面版直接读服务器上的 vault.enc
  const desktop = new Vault(join(root, "workspace", "vault.enc"));
  await desktop.unlock(MASTER);
  assert.equal((await desktop.get("account:gh")).password, "s3cret-from-web");
  await desktop.set("account:cf", { username: "ops", password: "from-desktop" });

  // 网页版读取桌面写入的新记录（版本号变化后重新读取）
  await webVault.unlock(MASTER);
  assert.equal((await webVault.get("account:cf"))?.password, "from-desktop");
  assert.deepEqual((await webVault.list()).sort(), ["account:cf", "account:gh"]);

  // 文档批量提取必须一次写入；确认中途失败或密钥库锁定不能留下部分账号。
  let checks = 0;
  await assert.rejects(
    webVault.batch(
      [
        { id: "account:batch1", secret: { password: "first" } },
        { id: "account:batch2", secret: { password: "second" } },
      ],
      {
        beforeCommit: () => {
          if (++checks === 2) throw new Error("preview expired");
        },
      },
    ),
    /preview expired/,
  );
  assert.equal(await webVault.get("account:batch1"), null);
  await webVault.batch([
    { id: "account:batch1", secret: { password: "first" } },
    { id: "account:batch2", secret: { password: "second" } },
  ]);
  assert.deepEqual(Object.keys(await webVault.readAll("account:batch")).sort(), [
    "account:batch1",
    "account:batch2",
  ]);
  checks = 0;
  await assert.rejects(
    webVault.batch([{ id: "account:locked", secret: { password: "private" } }], {
      beforeCommit: () => {
        if (++checks === 2) void webVault.lock();
      },
    }),
    /已锁定/,
  );
  await webVault.unlock(MASTER);
  assert.equal(await webVault.get("account:locked"), null);
  await webVault.remove("account:batch1");
  await webVault.remove("account:batch2");
  await Promise.all([
    webVault.batch([{ id: "account:parallel1", secret: { password: "one" } }]),
    webVault.set("account:parallel2", { password: "two", updatedAt: new Date().toISOString() }),
  ]);
  assert.equal((await webVault.get("account:parallel1"))?.password, "one");
  assert.equal((await webVault.get("account:parallel2"))?.password, "two");
  await webVault.remove("account:parallel1");
  await webVault.remove("account:parallel2");

  // 改主密码后两边都只认新密码
  const changed = await webVault.changePassword(MASTER, "a whole new master pw");
  assert.equal(changed.count, 2);
  const desktop2 = new Vault(join(root, "workspace", "vault.enc"));
  await assert.rejects(desktop2.unlock(MASTER));
  await desktop2.unlock("a whole new master pw");
  assert.equal((await desktop2.get("account:gh")).password, "s3cret-from-web");
  await webVault.remove("account:cf");
  assert.deepEqual(await webVault.list(), ["account:gh"]);
});

test("经 http:// 局域网地址访问（没有 WebCrypto）时密钥库仍可用，与桌面版互通", async (t) => {
  const { createWebServer } = await import(SERVER);
  const { Vault } = await import(DESKTOP_VAULT);
  const root = await mkdtemp(join(tmpdir(), "zhiyu-web-vault-http-"));
  const web = await createWebServer({
    root,
    staticDir: root,
    log: { log() {}, error() {} },
    schedulePush: false,
  });
  await new Promise<void>((r) => web.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  const realCrypto = globalThis.crypto;
  // 浏览器在非安全上下文里只保留 getRandomValues
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
    configurable: true,
  });
  t.after(async () => {
    Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
    globalThis.fetch = realFetch;
    await webVault.lock();
    web.server.close();
    await rm(root, { recursive: true, force: true });
  });
  const setup = await realFetch(`${base}/api/web/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zhiyu": "1" },
    body: JSON.stringify({
      token: web.setupToken,
      username: "song",
      password: "home-and-office-2026",
    }),
  });
  const cookie = setup.headers.get("set-cookie")!.split(";")[0];
  globalThis.fetch = ((input: string, init: RequestInit = {}) =>
    realFetch(base + input, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), cookie },
    })) as typeof fetch;

  assert.equal(globalThis.crypto.subtle, undefined);
  await webVault.create(MASTER);
  await webVault.set("account:lan", {
    username: "home",
    password: "typed-over-http",
    updatedAt: new Date().toISOString(),
  });
  await webVault.lock();
  await assert.rejects(webVault.unlock("wrong master password"), /主密码不正确/);
  await webVault.unlock(MASTER);
  assert.equal((await webVault.get("account:lan"))?.password, "typed-over-http");

  const desktop = new Vault(join(root, "workspace", "vault.enc"));
  await desktop.unlock(MASTER);
  assert.equal((await desktop.get("account:lan")).password, "typed-over-http");
  await desktop.set("account:desk", { username: "ops", password: "from-desktop" });
  await webVault.unlock(MASTER);
  assert.equal((await webVault.get("account:desk"))?.password, "from-desktop");
});
