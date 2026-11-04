import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OAUTH_PROVIDERS } from "../electron/services/oauth-providers.mjs";
import { createWebMailPush } from "../selfhost/mail-push.mjs";
import { createServerCredentialStore } from "../selfhost/bridge.mjs";
import { createServerSecureStorage } from "../selfhost/secure-storage.mjs";
import { webResearchFixture } from "./web-research-fixture.mjs";

for (const name of Object.keys(OAUTH_PROVIDERS))
  test(`Web 邮箱 ${name}：手动授权、PKCE、会话隔离、一次性回调和无令牌落盘`, async () => {
    const p = OAUTH_PROVIDERS[name],
      calls = [];
    const upstream = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      calls.push({ path: req.url, raw, headers: req.headers });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/token"
            ? { access_token: "mail-access", refresh_token: "mail-refresh", expires_in: 3600 }
            : { email: "mail@example.test", email_verified: true, displayName: "合成邮箱" },
        ),
      );
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const f = await webResearchFixture({
      additionalFetch: (url, init) => {
        if (new URL(url).origin === "https://auth.allinsong.top") return;
        assert.ok([p.tokenUrl, p.userInfoUrl].includes(String(url)), "禁止访问未声明的上游");
        return fetch(
          `http://127.0.0.1:${upstream.address().port}/${String(url) === p.tokenUrl ? "token" : "user"}`,
          init,
        );
      },
    });
    try {
      const input = {
        provider: name,
        clientId: "synthetic-mail-client",
        clientSecret: name === "google" ? "synthetic-mail-secret" : "",
      };
      assert.match((await f.rpc("mail:oauth-start", [input])).body.error, /确认允许/);
      const s = (await f.rpc("mail:oauth-start", [{ ...input, allowServerProcessing: true }])).body
        .data;
      const auth = new URL(s.authorizationUrl);
      assert.equal(auth.origin, new URL(p.authUrl).origin);
      assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
      assert.equal(auth.searchParams.get("scope"), p.scopes.join(" "));
      const login = await f.call("/api/web/login", {
        body: { username: "tester", password: f.password },
      });
      const other = login.headers.get("set-cookie").split(";")[0];
      assert.match(
        (
          await f.rpc(
            "mail:oauth-finish",
            [s.id, "http://localhost:53148/?code=test&state=bad"],
            other,
          )
        ).body.error,
        /不属于/,
      );
      const callback = new URL(s.redirectUri);
      callback.searchParams.set("state", auth.searchParams.get("state"));
      callback.searchParams.set("code", "synthetic-code");
      const wrong = new URL(callback);
      wrong.port = "53149";
      assert.match((await f.rpc("mail:oauth-finish", [s.id, wrong.href])).body.error, /不匹配/);
      assert.equal(calls.length, 0);
      const result = await f.rpc("mail:oauth-finish", [s.id, callback.href]);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.address, "mail@example.test");
      assert.equal(result.body.data.refreshToken, "mail-refresh");
      assert.equal(JSON.stringify(result.body).includes("mail-access"), false);
      const token = new URLSearchParams(calls[0].raw);
      assert.ok(token.get("code_verifier").length >= 43);
      assert.equal(token.has("client_secret"), name === "google");
      assert.match((await f.rpc("mail:oauth-finish", [s.id, callback.href])).body.error, /已失效/);
      const cancelled = (
        await f.rpc("mail:oauth-start", [{ ...input, allowServerProcessing: true }])
      ).body.data;
      await f.rpc("mail:oauth-cancel", [cancelled.id]);
      assert.match(
        (await f.rpc("mail:oauth-finish", [cancelled.id, callback.href])).body.error,
        /已失效/,
      );
      const files = ["ai-accounts.json", "background-mail.json"];
      for (const file of files)
        assert.equal(
          (await readFile(join(f.root, "web/server", file), "utf8").catch(() => "")).includes(
            "mail-refresh",
          ),
          false,
        );
    } finally {
      await f.close();
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
    }
  });

test("Web 后台邮件：明确同意、原子加密、首轮不推送、关闭清理、只发送数量", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-background-mail-"));
  const file = join(root, "background.json"),
    store = createServerCredentialStore(file, createServerSecureStorage(join(root, "key")));
  let snapshot = {
      mailboxes: [
        { id: "m1", kind: "mailbox" },
        { id: "m2", kind: "mailbox" },
      ],
    },
    checks = 0;
  const sent = [],
    upstream = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      sent.push(body);
      res.setHeader("Content-Type", "application/json");
      res.end('{"ok":true}');
    });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const service = createWebMailPush({
    store,
    getSnapshot: () => snapshot,
    checkMailbox: async (id, credential, { signal }) => {
      signal.throwIfAborted();
      assert.equal(credential.password, "private-mail-app-password");
      checks++;
      return { newMessages: 2, unseen: 3, checkedAt: new Date().toISOString() };
    },
    fetchImpl: (url, init) => {
      assert.equal(new URL(url).origin, "https://api.telegram.org");
      return fetch(`http://127.0.0.1:${upstream.address().port}`, init);
    },
  });
  const input = {
    enabled: true,
    provider: "telegram",
    destination: "42",
    token: `123456789:${"A".repeat(35)}`,
    mailboxIds: ["m1"],
    intervalMinutes: 5,
  };
  const credentials = {
    m1: { username: "private@example.test", password: "private-mail-app-password" },
  };
  const now = Date.now;
  try {
    await assert.rejects(service.save(input, credentials), /确认允许/);
    assert.equal(checks, 0);
    await service.save({ ...input, serverConsent: true }, credentials);
    assert.equal((await readFile(file, "utf8")).includes("private-mail"), false);
    assert.equal(JSON.stringify(await service.config()).includes("private-mail"), false);
    assert.equal((await service.tick()).checked, 1);
    assert.equal(sent.length, 0);
    Date.now = () => now() + 6 * 60000;
    assert.equal((await service.tick()).sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].includes("private@example.test"), false);
    assert.equal(sent[0].includes("private-mail-app-password"), false);
    assert.match(sent[0], /新增邮件/);
    await service.save({ ...input, enabled: false }, {});
    assert.deepEqual((await store.get("state")).credentials, {});
    const prior = checks;
    Date.now = () => now() + 12 * 60000;
    await service.tick();
    assert.equal(checks, prior);
    await assert.rejects(
      service.save({ ...input, serverConsent: true, mailboxIds: ["missing"] }, credentials),
      /缺少/,
    );
    await service.save({ ...input, serverConsent: true }, credentials);
    snapshot = { mailboxes: [] };
    await service.tick();
    assert.deepEqual((await store.get("state")).credentials, {});
  } finally {
    Date.now = now;
    service.stop();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
