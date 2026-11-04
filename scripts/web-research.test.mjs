import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { webResearchFixture } from "./web-research-fixture.mjs";

async function rig(t) {
  const f = await webResearchFixture();
  t.after(() => f.close());
  return f;
}
async function value(f, channel, ...args) {
  const result = await f.rpc(channel, args);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
}
async function bind(f) {
  const preview = await value(f, "main-identity:start");
  assert.equal((await f.authorize(preview)).status, 200);
  const state = await value(f, "main-identity:status", preview.id);
  assert.equal(state.status, "ready");
  await value(f, "main-identity:bind", {
    sessionId: preview.id,
    syncName: true,
    syncAvatar: false,
  });
}
async function until(work, done) {
  for (let n = 0; n < 100; n++) {
    const value = await work();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("任务未在限定时间完成");
}

test("Web 授权：未登录与跨站拒绝；PKCE 授权预览和绑定只属于发起会话", async (t) => {
  const f = await rig(t);
  assert.equal((await f.rpc("main-identity:start", [], "")).status, 401);
  assert.equal(
    (
      await f.call("/api/web/rpc", {
        cookie: f.cookie,
        headers: { origin: "https://evil.test" },
        body: { channel: "main-identity:start" },
      })
    ).status,
    403,
  );
  assert.equal((await value(f, "main-identity:availability")).configured, true);
  const preview = await value(f, "main-identity:start");
  assert.match(preview.authorizationUrl, /^https:\/\/connect.linux.do\/oauth2\/authorize/);
  assert.equal((await value(f, "main-identity:status", preview.id)).status, "waiting");
  const another = await f.call("/api/web/login", {
    body: { username: "tester", password: f.password },
  });
  const otherCookie = another.headers.get("set-cookie").split(";")[0];
  assert.equal((await f.rpc("main-identity:status", [preview.id], otherCookie)).status, 400);
  assert.equal(
    (
      await f.rpc(
        "main-identity:bind",
        [{ sessionId: preview.id, syncName: true, syncAvatar: false }],
        otherCookie,
      )
    ).status,
    400,
  );
  await f.authorize(preview);
  const states = await Promise.all([
    value(f, "main-identity:status", preview.id),
    value(f, "main-identity:status", preview.id),
  ]);
  assert.ok(states.every((state) => state.status === "ready"));
  assert.equal(await value(f, "main-identity:get"), null, "预览不能自动绑定");
  await value(f, "main-identity:bind", {
    sessionId: preview.id,
    syncName: true,
    syncAvatar: false,
  });
  const profile = await value(f, "profile:get");
  assert.equal(profile.name, "合成社区用户");
  assert.equal(profile.mainIdentity.profile.subject, "73");
  assert.equal(JSON.stringify(profile).includes("credential"), false);
  const disk = await readFile(join(f.root, "web/server/main-identity.enc"));
  assert.equal(disk.includes(Buffer.from("合成社区用户")), false);
  await f.restart();
  assert.equal((await value(f, "main-identity:get")).connected, true);
  await value(f, "profile:save", { name: "自定义名字" });
  assert.equal((await value(f, "profile:get")).name, "自定义名字");
  assert.equal((await value(f, "main-identity:get")).syncName, false);
});

test("Web 授权取消、拒绝和退出网页登录不能继续绑定旧预览", async (t) => {
  const f = await rig(t);
  const cancelled = await value(f, "main-identity:start");
  await value(f, "main-identity:cancel", cancelled.id);
  assert.equal((await f.authorize(cancelled)).status, 400);
  assert.equal(
    (
      await f.rpc("main-identity:bind", [
        { sessionId: cancelled.id, syncName: false, syncAvatar: false },
      ])
    ).status,
    400,
  );
  f.behavior.denied = true;
  const denied = await value(f, "main-identity:start");
  await f.authorize(denied);
  assert.equal((await value(f, "main-identity:status", denied.id)).status, "error");
  f.behavior.denied = false;
  const stale = await value(f, "main-identity:start");
  await f.call("/api/web/logout", { cookie: f.cookie });
  assert.equal((await f.rpc("main-identity:status", [stale.id])).status, 401);
  assert.equal((await f.authorize(stale)).status, 400);
});

test("Web Exa：免费和已购余额、逐条进度、记录、幂等及余额不明禁止购买", async (t) => {
  const f = await rig(t);
  assert.equal((await f.rpc("research:quota")).status, 400);
  await bind(f);
  const quota = await value(f, "research:quota");
  assert.equal(quota.freeRemaining, 50);
  assert.equal(quota.paidRemaining, 0);
  assert.equal(quota.paymentConfigured, false);
  assert.equal(quota.purchaseGuardConfigured, false);
  f.behavior.delay = 180;
  const input = { requestId: randomUUID(), query: "合成公开问题" };
  const job = await value(f, "research:start", input);
  const pending = await value(f, "research:status", { id: job.id });
  assert.ok(pending.items.some((item) => item.status === "running"));
  const complete = await until(
    () => value(f, "research:status", { id: job.id }),
    (job) => job.state === "complete",
  );
  assert.equal(complete.results.length, 1);
  assert.equal((await value(f, "research:quota")).freeRemaining, 49);
  assert.equal((await value(f, "research:start", input)).id, job.id);
  assert.equal(f.calls.filter((c) => c.path === "/search").length, 1);
  assert.equal((await value(f, "research:records", { offset: 0 })).entries[0].consumed, 1);
  // 已成功交付的任务刷新 checkout 是幂等读取，不会创建付款；不能把此场景当成新购买。
  assert.equal((await value(f, "research:checkout", { id: job.id })).paymentUrl, null);
  f.behavior.exaStatus = 402;
  const failed = await value(f, "research:start", {
    requestId: randomUUID(),
    query: "合成额度不足",
  });
  await until(
    () => value(f, "research:status", { id: failed.id }),
    (job) => job.state === "failed",
  );
  assert.equal((await value(f, "research:quota")).freeRemaining, 49);
  f.behavior.exaStatus = 200;
  f.behavior.delay = 0;
  for (let n = 0; n < 49; n++) {
    const next = await value(f, "research:start", {
      requestId: randomUUID(),
      query: `合成公开问题 ${n}`,
    });
    await until(
      () => value(f, "research:status", { id: next.id }),
      (job) => job.state === "complete",
    );
  }
  assert.equal((await value(f, "research:quota")).freeRemaining, 0);
  const callsBeforePurchase = f.calls.length;
  const unpaid = await f.rpc("research:start", [
    { requestId: randomUUID(), query: "合成购买保护" },
  ]);
  assert.equal(unpaid.status, 400);
  assert.match(unpaid.body.error, /暂未启用积分支付/);
  assert.equal(f.calls.length, callsBeforePurchase, "无额度且购买禁用时不发起供应商请求");
  assert.equal((await value(f, "research:quota")).paidTotal, 0);
});

test("Web Jev：授权后才发送、逐段轮询、取消、密钥加密和任务会话隔离", async (t) => {
  const f = await rig(t);
  const config = await value(f, "document-analysis:config");
  const saved = await value(f, "document-analysis:saveConfig", {
    ...config,
    enabled: true,
    apiKey: "synthetic-typesafe",
  });
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.apiKey, undefined);
  const text = await readFile(join(f.root, "web/server/document-analysis.json"), "utf8");
  assert.equal(text.includes("synthetic-typesafe"), false);
  const blocks = [
    { id: "p1", text: "这是关键配置。" },
    { id: "p2", text: "更新证书。" },
  ];
  const denied = await value(f, "document-analysis:start", {
    id: "no-consent",
    blocks,
    allowDocumentContent: false,
  });
  const error = await until(
    () => value(f, "document-analysis:status", denied.id),
    (s) => s.done,
  );
  assert.match(error.error, /授权/);
  assert.equal(f.calls.filter((c) => c.path === "/v1/systemone").length, 0);
  f.behavior.delay = 180;
  const job = await value(f, "document-analysis:start", {
    id: "analysis1",
    blocks,
    allowDocumentContent: true,
  });
  const partial = await until(
    () => value(f, "document-analysis:status", job.id),
    (s) => s.results.length === 1,
  );
  assert.equal(partial.done, false);
  const another = await f.call("/api/web/login", {
    body: { username: "tester", password: f.password },
  });
  const cookie = another.headers.get("set-cookie").split(";")[0];
  assert.equal((await f.rpc("document-analysis:status", [job.id], cookie)).status, 400);
  assert.equal((await f.rpc("document-analysis:cancel", [job.id], cookie)).status, 400);
  const complete = await until(
    () => value(f, "document-analysis:status", job.id),
    (s) => s.done,
  );
  assert.equal(complete.result.results.length, 2);
  await value(f, "document-analysis:start", {
    id: "cancelled",
    blocks,
    allowDocumentContent: true,
  });
  await until(
    () => value(f, "document-analysis:status", "cancelled"),
    (s) => s.items.some((i) => i.status === "running"),
  );
  await value(f, "document-analysis:cancel", "cancelled");
  const cancelled = await until(
    () => value(f, "document-analysis:status", "cancelled"),
    (s) => s.done,
  );
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(
    (await readdir(join(f.root, "web/workspace"))).includes("document-analysis.json"),
    false,
  );
});
