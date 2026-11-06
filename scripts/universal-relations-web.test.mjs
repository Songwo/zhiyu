import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../selfhost/server.mjs";
import { universalRelationFixture, RELATION_TIME } from "./universal-relations-fixture.mjs";
import { resourcePairKey } from "../electron/services/resource-links.mjs";

test(
  "真实 Web 存储保留全部 253 种关联；绑定 PATCH 鉴权、防跨站、正文和删除清理",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zhiyu-relations-http-"));
    const web = await createWebServer({
      root,
      schedulePush: false,
      sampleHost: false,
      log: { log() {}, warn() {}, error() {} },
    });
    await new Promise((resolve) => web.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      web.server.closeAllConnections();
      await new Promise((resolve) => web.server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const base = "http://127.0.0.1:" + web.server.address().port;
    let cookie = "";
    const call = (path, { method = "GET", body, headers = {}, auth = true } = {}) =>
      fetch(base + "/api/web/" + path, {
        method,
        redirect: "manual",
        headers: {
          ...(auth && cookie ? { cookie } : {}),
          ...(method !== "GET" ? { "content-type": "application/json", "x-zhiyu": "1" } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const setup = await call("setup", {
      method: "POST",
      body: {
        username: "relation-tester",
        password: "relation-test-password-2026",
        token: web.setupToken,
      },
    });
    assert.equal(setup.status, 200, await setup.clone().text());
    cookie = setup.headers.get("set-cookie").split(";")[0];
    const { snapshot, documents, resources } = universalRelationFixture();
    let revision = null;
    const put = async (state) => {
      const response = await call("store", {
        method: "PUT",
        body: { revision, data: { version: 0, state } },
      });
      assert.equal(response.status, 200, await response.clone().text());
      revision = (await response.json()).revision;
    };
    await put(snapshot);
    for (const doc of documents) {
      const response = await call("documents/" + doc.id, {
        method: "PUT",
        body: {
          ...doc,
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "原文不可被关联覆盖" }] },
            ],
          },
        },
      });
      assert.equal(response.status, 200, await response.clone().text());
    }
    for (let i = 0; i < resources.length; i++)
      for (let j = i + 1; j < resources.length; j++) {
        const from = { kind: resources[i].kind, id: resources[i].id },
          to = { kind: resources[j].kind, id: resources[j].id };
        await put({
          ...snapshot,
          links: [
            { from, to },
            { from: to, to: from },
          ],
        });
        const response = await call("store"),
          saved = await response.json();
        assert.equal(saved.data.state.links.length, 1, resourcePairKey(from, to));
        assert.equal(
          resourcePairKey(saved.data.state.links[0].from, saved.data.state.links[0].to),
          resourcePairKey(from, to),
        );
      }
    const body = { binding: { kind: "server", id: "server-a" }, remove: false };
    assert.equal(
      (await call("documents/doc-a", { method: "PATCH", body, auth: false })).status,
      401,
    );
    assert.equal(
      (await call("documents/doc-a", { method: "PATCH", body, headers: { "x-zhiyu": "" } })).status,
      403,
    );
    assert.equal(
      (
        await call("documents/doc-a", {
          method: "PATCH",
          body,
          headers: { origin: "https://attacker.invalid" },
        })
      ).status,
      403,
    );
    const before = await (await call("documents/doc-a")).json();
    const bound = await call("documents/doc-a", { method: "PATCH", body });
    assert.equal(bound.status, 200, await bound.clone().text());
    assert.deepEqual((await bound.json()).content, before.content);
    const stale = {
      ...before,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "继续编辑正文" }] }],
      },
      preserveBindings: true,
    };
    assert.equal((await call("documents/doc-a", { method: "PUT", body: stale })).status, 200);
    const latest = await (await call("documents/doc-a")).json();
    assert.equal(latest.bindings.length, 1);
    assert.deepEqual(latest.content, stale.content);
    const rejected = await call("documents/doc-a", {
      method: "PATCH",
      body: { binding: { kind: "server", id: "removed" }, remove: false },
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      (await call("documents/doc-a", { method: "PATCH", body: { ...body, remove: true } })).status,
      200,
    );
    assert.equal((await (await call("documents/doc-a")).json()).bindings.length, 0);
    await put({
      ...snapshot,
      links: [
        { from: { kind: "phone", id: "phone-a" }, to: { kind: "document", id: "doc-a" } },
        { from: { kind: "document", id: "doc-a" }, to: { kind: "document", id: "doc-b" } },
      ],
    });
    assert.equal((await call("documents/doc-a", { method: "DELETE", body: {} })).status, 200);
    const after = await (await call("store")).json();
    assert.equal(after.data.state.links.length, 0);
    assert.equal(
      (await call("documents/doc-a", { method: "PUT", body: stale })).ok,
      false,
      "删除后不能被旧草稿复活",
    );
    assert.equal(
      (await call("documents/doc-a", { method: "DELETE", body: {} })).status,
      200,
      "删除可重试",
    );
    assert.ok(RELATION_TIME);
  },
);
