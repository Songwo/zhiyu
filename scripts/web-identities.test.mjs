import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { webResearchFixture } from "./web-research-fixture.mjs";

test("Web 旧独立身份：手动回调、会话隔离、预览确认、加密、重新授权保留资产", async () => {
  const calls = [];
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ path: req.url, body });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/oauth2/token"
          ? {
              access_token: "independent-private-access",
              refresh_token: "independent-private-refresh",
              expires_in: 3600,
              token_type: "Bearer",
            }
          : {
              id: 99,
              username: "independent",
              name: "合成独立身份",
              email: "identity@example.test",
              trust_level: 2,
            },
      ),
    );
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const f = await webResearchFixture({
    additionalFetch: (url, init) => {
      const target = new URL(url);
      if (target.origin === "https://auth.allinsong.top") return;
      assert.equal(target.origin, "https://connect.linux.do");
      assert.ok(["/oauth2/token", "/api/user"].includes(target.pathname));
      return fetch(`http://127.0.0.1:${upstream.address().port}${target.pathname}`, init);
    },
  });
  const configured = {
    clientId: "synthetic-connect-client",
    clientSecret: "independent-private-secret",
    redirectUri: "http://127.0.0.1:49283/oauth/linuxdo/callback",
  };
  const start = async () =>
    (await f.rpc("identities:start", [{ allowServerStorage: true }])).body.data;
  const callback = (s) => {
    const u = new URL(s.redirectUri);
    u.searchParams.set("code", "synthetic-code");
    u.searchParams.set("state", new URL(s.authorizationUrl).searchParams.get("state"));
    return u.href;
  };
  try {
    assert.match((await f.rpc("identities:configure", [configured])).body.error, /确认允许/);
    assert.equal(
      (await f.rpc("identities:configure", [{ ...configured, allowServerStorage: true }])).status,
      200,
    );
    assert.match((await f.rpc("identities:start")).body.error, /确认允许/);
    const session = await start();
    assert.equal(session.manualCallback, true);
    const login = await f.call("/api/web/login", {
      body: { username: "tester", password: f.password },
    });
    const other = login.headers.get("set-cookie").split(";")[0];
    assert.match(
      (await f.rpc("identities:finish", [session.id, callback(session)], other)).body.error,
      /不属于/,
    );
    const bad = new URL(callback(session));
    bad.searchParams.set("state", "wrong");
    assert.match((await f.rpc("identities:finish", [session.id, bad.href])).body.error, /校验失败/);
    assert.equal(calls.length, 0);
    const finish = await f.rpc("identities:finish", [session.id, callback(session)]);
    assert.equal(finish.status, 200, JSON.stringify(finish.body));
    assert.equal(finish.body.data.status, "ready");
    const result = await f.rpc("identities:commit", [{ sessionId: session.id }]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const id = result.body.data.asset.id;
    assert.equal(JSON.stringify(result.body).includes("independent-private"), false);
    assert.equal((await f.rpc("identities:get", [id])).body.data.connected, true);
    const stored = await f.call("/api/web/store", { cookie: f.cookie, method: "GET" });
    const snapshot = await stored.json();
    assert.equal(snapshot.data.state.secrets.length, 1);
    assert.equal(JSON.stringify(snapshot).includes("independent-private"), false);
    snapshot.data.state.secrets[0].name = "我自己的身份名称";
    await f.call("/api/web/store", { cookie: f.cookie, method: "PUT", body: snapshot });
    const repeated = await start();
    await f.rpc("identities:finish", [repeated.id, callback(repeated)]);
    const again = await f.rpc("identities:commit", [{ sessionId: repeated.id }]);
    assert.equal(again.body.data.asset.id, id);
    assert.equal(again.body.data.asset.name, "我自己的身份名称");
    assert.equal(
      (await readFile(join(f.root, "web/server/identity-accounts.json"), "utf8")).includes(
        "independent-private",
      ),
      false,
    );
    const disconnected = await f.rpc("identities:disconnect", [id]);
    assert.equal(disconnected.body.data.connected, false);
    const cancelled = await start();
    await f.rpc("identities:cancel", [cancelled.id]);
    assert.match(
      (await f.rpc("identities:finish", [cancelled.id, callback(cancelled)])).body.error,
      /不属于/,
    );
    const current = await (
      await f.call("/api/web/store", { cookie: f.cookie, method: "GET" })
    ).json();
    current.data.state.secrets = [];
    await f.call("/api/web/store", { cookie: f.cookie, method: "PUT", body: current });
    assert.equal((await f.rpc("identities:get", [id])).body.data, null);
  } finally {
    await f.close();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
});
