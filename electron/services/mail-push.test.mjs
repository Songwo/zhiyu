import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailPushService } from "./mail-push.mjs";
import { MailboxService } from "./mailbox-service.mjs";
import { Vault } from "./vault.mjs";

const TELEGRAM_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
const SERVERCHAN_TOKEN = "SCTabcdefghijklmnopqrst";
const WECOM_TOKEN = "11111111-2222-3333-4444-555555555555";
const WXPUSHER_TOKEN = "AT_syntheticWxpusherToken2026";
const WXPUSHER_UID = "UID_syntheticRecipient2026";
const RECORD = "notification:mail-push";

function setup(t, options = {}) {
  let now = Date.parse("2026-09-08T00:00:00.000Z");
  t.mock.method(Date, "now", () => now);
  const records = new Map();
  const requests = [];
  const checks = [];
  const responses = [];
  const mailboxes = [
    { id: "mail-1", kind: "mailbox", address: "private@example.test" },
    { id: "mail-2", kind: "mailbox", address: "another@example.test" },
  ];
  const vault = {
    unlocked: true,
    async get(id) {
      assert.equal(this.unlocked, true);
      return structuredClone(records.get(id) ?? null);
    },
    async set(id, value) {
      assert.equal(this.unlocked, true);
      records.set(id, structuredClone(value));
    },
  };
  const service = new MailPushService({
    vault,
    getSnapshot: () => ({ mailboxes }),
    checkMailbox: async (id, settings) => {
      checks.push({ id, settings });
      if (options.checkMailbox) return options.checkMailbox(id, settings);
      return {
        assetId: id,
        address: "private@example.test",
        messages: 100,
        unseen: 7,
        newMessages: 0,
        checkedAt: new Date(now).toISOString(),
        ...(responses.shift() ?? {}),
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      return { ok: true, json: async () => ({ ok: true, code: 0, errcode: 0 }) };
    },
  });
  const config = {
    enabled: true,
    provider: "telegram",
    destination: "-10012345",
    token: TELEGRAM_TOKEN,
    mailboxIds: ["mail-1"],
    intervalMinutes: 5,
  };
  return {
    service,
    config,
    vault,
    records,
    requests,
    checks,
    responses,
    mailboxes,
    advance: () => {
      now += 5 * 60_000;
    },
  };
}

test("邮件推送默认关闭且公开配置不包含凭据", async (t) => {
  const rig = setup(t);
  assert.deepEqual(await rig.service.config(), {
    enabled: false,
    provider: "telegram",
    destination: "",
    hasToken: false,
    mailboxIds: [],
    intervalMinutes: 15,
    reminders: false,
  });
  const result = await rig.service.save({ ...rig.config, enabled: false });
  assert.equal(result.hasToken, true);
  assert.equal(JSON.stringify(result).includes(TELEGRAM_TOKEN), false);
  assert.equal(rig.records.get(RECORD).token, TELEGRAM_TOKEN);
  await rig.service.tick();
  assert.equal(rig.requests.length, 0);
  assert.equal(rig.checks.length, 0);
});

test("WxPusher 使用官方 HTTPS API、纯文本及指定 UID，公开配置不泄露 AppToken", async (t) => {
  const rig = setup(t, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ code: 1000, data: [{ uid: WXPUSHER_UID, code: 1000 }] }),
    }),
  });
  const result = await rig.service.save({
    ...rig.config,
    provider: "wxpusher",
    destination: WXPUSHER_UID,
    token: WXPUSHER_TOKEN,
  });
  assert.equal(result.hasToken, true);
  assert.doesNotMatch(JSON.stringify(result), /AT_synthetic/);
  await rig.service.test();
  const request = rig.requests[0];
  assert.equal(request.url, "https://wxpusher.zjiecode.com/api/send/message");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.body.appToken, WXPUSHER_TOKEN);
  assert.equal(request.body.contentType, 1);
  assert.deepEqual(request.body.uids, [WXPUSHER_UID]);
  assert.match(request.body.content, /推送测试/);
  assert.doesNotMatch(request.body.content, /private@example|another@example/);
  assert.equal(rig.checks.length, 0);
});

test("WxPusher 首次采集建立基线并仅推送后续新增数量", async (t) => {
  const rig = setup(t, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ code: 1000, data: [{ uid: WXPUSHER_UID, code: 1000 }] }),
    }),
  });
  await rig.service.save({
    ...rig.config,
    provider: "wxpusher",
    destination: WXPUSHER_UID,
    token: WXPUSHER_TOKEN,
  });
  rig.responses.push({ newMessages: 12 });
  assert.equal((await rig.service.tick()).sent, false);
  rig.advance();
  rig.responses.push({ newMessages: 2 });
  assert.equal((await rig.service.tick()).sent, true);
  assert.match(rig.requests[0].body.content, /新增邮件：2 封/);
  assert.doesNotMatch(rig.requests[0].body.content, /private@example|another@example/);
});

test("WxPusher HTTP 或顶层成功不能掩盖指定接收人失败", async (t) => {
  let response;
  const rig = setup(t, { fetchImpl: async () => ({ ok: true, json: async () => response }) });
  await rig.service.save({
    ...rig.config,
    provider: "wxpusher",
    destination: WXPUSHER_UID,
    token: WXPUSHER_TOKEN,
  });
  for (response of [
    { code: 1002, msg: WXPUSHER_TOKEN },
    { code: 1000, data: [] },
    { code: 1000, data: [{ uid: WXPUSHER_UID, code: 1006, status: WXPUSHER_TOKEN }] },
    { code: 1000, data: [{ uid: "UID_unexpected", code: 1000 }] },
  ]) {
    await assert.rejects(rig.service.test(), (error) => {
      assert.match(error.message, /推送失败/);
      assert.equal(error.message.includes(WXPUSHER_TOKEN), false);
      return true;
    });
  }
});

test("WxPusher 拒绝错误目标及令牌，切换接收人不沿用旧凭据", async (t) => {
  const rig = setup(t);
  const config = {
    ...rig.config,
    provider: "wxpusher",
    destination: WXPUSHER_UID,
    token: WXPUSHER_TOKEN,
  };
  for (const destination of ["", "https://evil.test", "UID_bad\nrecipient", "12345"])
    await assert.rejects(rig.service.save({ ...config, destination }));
  await assert.rejects(rig.service.save({ ...config, token: TELEGRAM_TOKEN }));
  await rig.service.save(config);
  const changed = await rig.service.save({
    ...config,
    destination: "UID_anotherRecipient",
    token: undefined,
    enabled: false,
  });
  assert.equal(changed.hasToken, false);
  await assert.rejects(rig.service.test(), /先保存/);
  assert.equal(rig.requests.length, 0);
});

test("首次检查仅建立基线，后续只发送数量和时间", async (t) => {
  const rig = setup(t);
  await rig.service.save(rig.config);
  rig.responses.push({ newMessages: 20 });
  assert.equal((await rig.service.tick()).sent, false);
  assert.equal(rig.requests.length, 0);
  rig.advance();
  rig.responses.push({ newMessages: 3, unseen: 10 });
  assert.equal((await rig.service.tick()).sent, true);
  assert.match(rig.requests[0].body.text, /新增邮件：3 封/);
  assert.match(rig.requests[0].body.text, /相关邮箱未读：10 封/);
  assert.doesNotMatch(rig.requests[0].body.text, /private|example|password|subject/);
  assert.equal(rig.checks[0].settings.cursor, "push");
  assert.equal(rig.requests[0].init.redirect, "error");
  assert.equal(rig.requests[0].init.signal instanceof AbortSignal, true);
  await rig.service.tick();
  assert.equal(rig.requests.length, 1);
  rig.advance();
  await rig.service.tick();
  assert.equal(rig.requests.length, 1);
});

test("新增为 null 或 0 时不发送", async (t) => {
  const rig = setup(t);
  await rig.service.save(rig.config);
  await rig.service.tick();
  for (const newMessages of [null, 0, -1, Number.NaN]) {
    rig.advance();
    rig.responses.push({ newMessages });
    await rig.service.tick();
  }
  assert.equal(rig.requests.length, 0);
});

test("推送失败保留加密待发队列并在成功后清除", async (t) => {
  let attempts = 0;
  const rig = setup(t, {
    fetchImpl: async () => {
      if (++attempts === 1) throw new Error(`private network failure ${TELEGRAM_TOKEN}`);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await rig.service.save(rig.config);
  await rig.service.tick();
  rig.advance();
  rig.responses.push({ newMessages: 4 });
  const failed = await rig.service.tick();
  assert.equal(failed.sent, false);
  assert.doesNotMatch(failed.error, /private|abcdefghijklmnopqrstuvwxyz|http/);
  assert.equal(rig.records.get(RECORD).pending["mail-1"].newMessages, 4);
  rig.advance();
  assert.equal((await rig.service.tick()).sent, true);
  assert.match(rig.requests[1].body.text, /新增邮件：4 封/);
  assert.deepEqual(rig.records.get(RECORD).pending, {});
  rig.advance();
  await rig.service.tick();
  assert.equal(rig.requests.length, 2);
});

test("切换渠道或目标不会继承旧 Token", async (t) => {
  const rig = setup(t);
  await rig.service.save(rig.config);
  const { token: _token, ...withoutToken } = rig.config;
  await assert.rejects(rig.service.save({ ...withoutToken, destination: "-10099999" }), /启用前/);
  const moved = await rig.service.save({
    ...withoutToken,
    enabled: false,
    destination: "-10099999",
  });
  assert.equal(moved.hasToken, false);
  await rig.service.save(rig.config);
  const changed = await rig.service.save({
    ...withoutToken,
    enabled: false,
    provider: "wecom",
    destination: "",
  });
  assert.equal(changed.hasToken, false);
});

test("可清除凭据但启用状态下拒绝删除必需凭据", async (t) => {
  const rig = setup(t);
  await rig.service.save(rig.config);
  const { token: _token, ...withoutToken } = rig.config;
  await assert.rejects(rig.service.save({ ...withoutToken, clearToken: true }), /启用前/);
  assert.equal(
    (await rig.service.save({ ...withoutToken, enabled: false, clearToken: true })).hasToken,
    false,
  );
  await assert.rejects(rig.service.save({ ...rig.config, clearToken: true }), /同时/);
});

test("校验渠道、邮箱、目标、间隔及凭据", async (t) => {
  const rig = setup(t);
  for (const patch of [
    { provider: "custom" },
    { enabled: "yes" },
    { intervalMinutes: 4 },
    { intervalMinutes: 1441 },
    { intervalMinutes: 5.5 },
    { destination: "https://evil.test" },
    { mailboxIds: ["absent"] },
    { mailboxIds: ["__proto__"] },
    { token: "bad\nsecret" },
    { clearToken: "yes" },
    { mailboxIds: Array(26).fill("mail-1") },
    { provider: "wecom", token: WECOM_TOKEN },
  ])
    await assert.rejects(rig.service.save({ ...rig.config, ...patch }));
  rig.mailboxes[0].kind = "alias";
  await assert.rejects(rig.service.save(rig.config), /不支持/);
  rig.mailboxes[0].kind = "mailbox";
  rig.mailboxes[0].demo = true;
  await assert.rejects(rig.service.save(rig.config), /不支持/);
  assert.equal(rig.requests.length, 0);
});

test("锁库阻止配置和真实发送", async (t) => {
  const rig = setup(t);
  await rig.service.save(rig.config);
  rig.vault.unlocked = false;
  await assert.rejects(rig.service.config(), /解锁/);
  await assert.rejects(rig.service.save(rig.config), /解锁/);
  await assert.rejects(rig.service.test(), /解锁/);
  assert.equal((await rig.service.tick()).skipped, true);
  assert.equal(rig.requests.length, 0);
});

test("三个渠道的测试消息仅使用官方地址且不包含用户数据", async (t) => {
  const rig = setup(t);
  const providers = [
    {
      provider: "telegram",
      token: TELEGRAM_TOKEN,
      destination: "-10012345",
      host: "api.telegram.org",
    },
    { provider: "serverchan", token: SERVERCHAN_TOKEN, destination: "", host: "sctapi.ftqq.com" },
    { provider: "wecom", token: WECOM_TOKEN, destination: "", host: "qyapi.weixin.qq.com" },
  ];
  for (const provider of providers) {
    await rig.service.save({ ...rig.config, ...provider, enabled: false });
    assert.deepEqual(await rig.service.test(), { ok: true });
    const request = rig.requests.at(-1);
    assert.equal(new URL(request.url).hostname, provider.host);
    assert.equal(new URL(request.url).protocol, "https:");
    assert.match(request.init.body, /推送测试/);
    assert.doesNotMatch(request.init.body, /private@example|another@example/);
  }
  assert.equal(rig.checks.length, 0);
});

test("HTTP 成功但服务商业务失败时仍报告脱敏错误", async (t) => {
  let json = { ok: false, description: TELEGRAM_TOKEN };
  const rig = setup(t, { fetchImpl: async () => ({ ok: true, json: async () => json }) });
  for (const provider of [
    {
      provider: "telegram",
      token: TELEGRAM_TOKEN,
      destination: "-10012345",
      response: { ok: false, description: TELEGRAM_TOKEN },
    },
    {
      provider: "serverchan",
      token: SERVERCHAN_TOKEN,
      destination: "",
      response: { code: 0, data: { errno: 1, error: SERVERCHAN_TOKEN } },
    },
    {
      provider: "wecom",
      token: WECOM_TOKEN,
      destination: "",
      response: { errcode: 40001, errmsg: WECOM_TOKEN },
    },
  ]) {
    json = provider.response;
    await rig.service.save({ ...rig.config, ...provider });
    await assert.rejects(rig.service.test(), (error) => {
      assert.match(error.message, /推送失败/);
      assert.equal(error.message.includes(provider.token), false);
      return true;
    });
  }
});

test("HTTP 错误和非 JSON 响应均不回显正文", async (t) => {
  let httpOk = false;
  const rig = setup(t, {
    fetchImpl: async () => ({
      ok: httpOk,
      json: async () => {
        throw new Error(TELEGRAM_TOKEN);
      },
    }),
  });
  await rig.service.save(rig.config);
  await assert.rejects(rig.service.test(), /^Error: 推送失败/);
  httpOk = true;
  await assert.rejects(rig.service.test(), /^Error: 推送失败/);
});

test("并发 tick 复用在途任务，stop 中止检查", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const rig = setup(t, {
    checkMailbox: async (_id, { signal }) => {
      entered();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    },
  });
  await rig.service.save(rig.config);
  const first = rig.service.tick();
  const second = rig.service.tick();
  assert.equal(first, second);
  await started;
  await assert.rejects(rig.service.test(), /正在进行/);
  rig.service.stop();
  const result = await first;
  assert.equal(result.sent, false);
  assert.equal(rig.checks.length, 1);
  assert.equal(rig.requests.length, 0);
});

test("删除邮箱后不继续检查或发送旧待发消息", async (t) => {
  const rig = setup(t);
  await rig.service.save(rig.config);
  rig.records.get(RECORD).pending = {
    "mail-1": { newMessages: 3, unseen: 4, checkedAt: "2026-09-08T00:00:00Z" },
  };
  rig.mailboxes.length = 0;
  await rig.service.tick();
  assert.equal(rig.checks.length, 0);
  assert.equal(rig.requests.length, 0);
  assert.deepEqual(rig.records.get(RECORD).pending, {});
});

test("关闭后重新启用从新基线开始，不推送停用期间累计量", async (t) => {
  const rig = setup(t);
  await rig.service.save(rig.config);
  await rig.service.tick();
  await rig.service.save({ ...rig.config, enabled: false });
  await rig.service.save(rig.config);
  rig.responses.push({ newMessages: 40 });
  await rig.service.tick();
  assert.equal(rig.requests.length, 0);
});

test("重启服务后仍重试加密保存的待发队列", async (t) => {
  const rig = setup(t);
  await rig.service.save(rig.config);
  rig.records.get(RECORD).observed = { "mail-1": "2026-09-08T00:00:00.000Z" };
  rig.records.get(RECORD).pending = {
    "mail-1": { newMessages: 6, unseen: 9, checkedAt: "2026-09-08T00:00:00.000Z" },
  };
  const bodies = [];
  const restarted = new MailPushService({
    vault: rig.vault,
    getSnapshot: () => ({ mailboxes: rig.mailboxes }),
    checkMailbox: async () => ({
      newMessages: 0,
      unseen: 9,
      checkedAt: "2026-09-08T00:05:00.000Z",
    }),
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal((await restarted.tick()).sent, true);
  assert.match(bodies[0].text, /新增邮件：6 封/);
  assert.deepEqual(rig.records.get(RECORD).pending, {});
});

test("stop 中止在途测试发送且不回显网络错误", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const rig = setup(t, {
    fetchImpl: async (_url, { signal }) => {
      entered();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error(TELEGRAM_TOKEN)), { once: true }),
      );
    },
  });
  await rig.service.save({ ...rig.config, enabled: false });
  const pending = rig.service.test();
  await started;
  rig.service.stop();
  await assert.rejects(pending, /^Error: 邮件推送已停止。$/);
  assert.equal(rig.requests.length, 1);
});

async function realServices(t) {
  const directory = await mkdtemp(join(tmpdir(), "nanpad-push-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "vault.enc");
  const master = "checkpoint-test-master";
  let vault = new Vault(file);
  await vault.create(master);
  await vault.set("account:mail-1", {
    username: "fixture@example.test",
    password: "fixture-private-password",
  });
  let uidNext = 11;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let afterCheck = null;
  let failDelivery = false;
  let mailboxService;
  let push;
  const deliveries = [];
  const getSnapshot = () => ({
    mailboxes: [
      {
        id: "mail-1",
        kind: "mailbox",
        address: "fixture@example.test",
        imap: { host: "imap.example.test", port: 993, secure: true },
      },
    ],
  });
  const makeServices = () => {
    mailboxService = new MailboxService({
      directory,
      vault,
      getSnapshot,
      queryMailbox: async ({ baseline }) => ({
        messages: uidNext - 1,
        unseen: 4,
        uidValidity: "100",
        uidNext,
        newMessages: baseline ? uidNext - baseline.uidNext : null,
      }),
    });
    push = new MailPushService({
      vault,
      getSnapshot,
      checkMailbox: async (id, options) => {
        const result = await mailboxService.check(id, options);
        const hook = afterCheck;
        afterCheck = null;
        if (hook) await hook();
        return result;
      },
      fetchImpl: async (_url, options) => {
        if (failDelivery) throw new Error("fixture delivery failure");
        deliveries.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
  };
  makeServices();
  await push.save({
    enabled: true,
    provider: "telegram",
    destination: "-10012345",
    token: TELEGRAM_TOKEN,
    mailboxIds: ["mail-1"],
    intervalMinutes: 5,
  });
  return {
    directory,
    file,
    deliveries,
    get push() {
      return push;
    },
    get vault() {
      return vault;
    },
    addMessages(count) {
      uidNext += count;
      now += 5 * 60_000;
    },
    afterCheck(hook) {
      afterCheck = hook;
    },
    failDelivery(value) {
      failDelivery = value;
    },
    async restart() {
      push.stop();
      mailboxService.stop();
      vault.lock();
      vault = new Vault(file);
      await vault.unlock(master);
      makeServices();
    },
  };
}

for (const fault of ["lock", "stop", "disk"]) {
  test(`真实邮箱与推送服务：检查完成后 ${fault} 不消费未提交的新增邮件`, async (t) => {
    const fixture = await realServices(t);
    assert.equal((await fixture.push.tick()).sent, false);
    const initial = await fixture.vault.get(RECORD);
    assert.equal(initial.checkpoints["mail-1"].uidNext, 11);
    fixture.addMessages(3);
    const backup = join(fixture.directory, "original.enc");
    fixture.afterCheck(async () => {
      if (fault === "lock") fixture.vault.lock();
      if (fault === "stop") fixture.push.stop();
      if (fault === "disk") {
        await rename(fixture.file, backup);
        await mkdir(fixture.file);
      }
    });
    assert.equal((await fixture.push.tick()).sent, false);
    assert.equal(fixture.deliveries.length, 0);
    if (fault === "disk") {
      await rm(fixture.file, { recursive: true });
      await rename(backup, fixture.file);
    }
    await fixture.restart();
    const beforeRetry = await fixture.vault.get(RECORD);
    assert.equal(beforeRetry.checkpoints["mail-1"].uidNext, 11);
    assert.deepEqual(beforeRetry.pending, {});
    assert.equal((await fixture.push.tick()).sent, true);
    assert.match(fixture.deliveries[0].text, /新增邮件：3 封/);
    const committed = await fixture.vault.get(RECORD);
    assert.equal(committed.checkpoints["mail-1"].uidNext, 14);
    assert.deepEqual(committed.pending, {});
    assert.equal("checkpoints" in (await fixture.push.config()), false);
    await assert.rejects(readFile(join(fixture.directory, "mailbox-baselines.json")), {
      code: "ENOENT",
    });
    assert.doesNotMatch(
      await readFile(fixture.file, "utf8"),
      /"checkpoints"|fixture-private-password|imap.example.test/,
    );
    await fixture.restart();
    assert.equal((await fixture.push.tick()).sent, false);
    assert.equal(fixture.deliveries.length, 1);
  });
}

test("真实邮箱与推送服务：首次基线提交失败后重试仍不推历史邮件", async (t) => {
  const fixture = await realServices(t);
  fixture.afterCheck(() => fixture.vault.lock());
  assert.equal((await fixture.push.tick()).sent, false);
  fixture.addMessages(3);
  await fixture.restart();
  assert.equal((await fixture.push.tick()).sent, false);
  assert.equal(fixture.deliveries.length, 0);
  fixture.addMessages(1);
  assert.equal((await fixture.push.tick()).sent, true);
  assert.match(fixture.deliveries[0].text, /新增邮件：1 封/);
});

test("真实邮箱与推送服务：游标与待发消息一起持久化，发送失败重启只补发一次", async (t) => {
  const fixture = await realServices(t);
  await fixture.push.tick();
  fixture.addMessages(2);
  fixture.failDelivery(true);
  assert.equal((await fixture.push.tick()).sent, false);
  const pending = await fixture.vault.get(RECORD);
  assert.equal(pending.checkpoints["mail-1"].uidNext, 13);
  assert.equal(pending.pending["mail-1"].newMessages, 2);
  fixture.failDelivery(false);
  await fixture.restart();
  assert.equal((await fixture.push.tick()).sent, true);
  assert.match(fixture.deliveries[0].text, /新增邮件：2 封/);
  await fixture.restart();
  assert.equal((await fixture.push.tick()).sent, false);
  assert.equal(fixture.deliveries.length, 1);
});

test("续费与备忘提醒：开启「提醒也推送」才发送，不需要勾选邮箱", async (t) => {
  const rig = setup(t);
  await rig.service.save({ ...rig.config, enabled: false, mailboxIds: [] });
  assert.equal(await rig.service.remind("知屿提醒\n宽带续费: 3 天后"), false);
  assert.equal(rig.requests.length, 0);
  const saved = await rig.service.save({
    ...rig.config,
    enabled: false,
    mailboxIds: [],
    reminders: true,
  });
  assert.equal(saved.reminders, true);
  assert.equal(await rig.service.remind("知屿提醒\n宽带续费: 3 天后"), true);
  assert.equal(rig.requests.length, 1);
  assert.match(rig.requests[0].body.text, /宽带续费: 3 天后/);
  rig.vault.unlocked = false;
  assert.equal(await rig.service.remind("x"), false);
  rig.vault.unlocked = true;
  await assert.rejects(
    rig.service.save({
      ...rig.config,
      token: undefined,
      enabled: false,
      mailboxIds: [],
      reminders: true,
      clearToken: true,
    }),
    /推送提醒前/,
  );
});
