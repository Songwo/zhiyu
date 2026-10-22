import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UsageStore,
  collectUsage,
  panelUsage,
  subscriptionUsage,
  usageNeedsRefresh,
  AUTOMATIC_USAGE_TTL_MS,
} from "./usage.mjs";
const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers });

test("用量缓存返回副本、识别外部修改和删除；原子写失败不能污染旧数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanpad-usage-cache-"));
  try {
    const file = join(dir, "history.json");
    const initial = {
      sources: [{ id: "usage-test", name: "甲" }],
      records: [{ nested: { value: 1 } }],
    };
    await writeFile(file, JSON.stringify(initial));
    const store = new UsageStore(file, {});
    const first = await store.list();
    first.sources[0].name = "调用方的修改";
    first.records[0].nested.value = 99;
    assert.deepEqual(await store.list(), initial);

    const before = await stat(file);
    const changed = structuredClone(initial);
    changed.sources[0].name = "乙";
    await writeFile(file, JSON.stringify(changed));
    // 即使外部程序保留文件mtime且字节数一致，ctime也会使旧缓存失效。
    await utimes(file, before.atime, before.mtime);
    assert.deepEqual(await store.list(), changed);
    await mkdir(file + ".tmp");
    await assert.rejects(store.markFailure("usage-test", "测试失败"));
    assert.deepEqual(await store.list(), changed);
    await rm(file + ".tmp", { recursive: true });
    await store.markFailure("usage-test", "一次真实失败");
    assert.equal((await store.list()).sources[0].error, "一次真实失败");
    await rm(file);
    assert.deepEqual(await store.list(), { sources: [], records: [] });
    await writeFile(file, JSON.stringify(initial));
    assert.deepEqual(await store.list(), initial);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("自动用量采集复用5分钟结果及失败退避，人工刷新强制采集且并发不重复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanpad-usage-ttl-"));
  const secrets = new Map();
  let calls = 0;
  let fail = false;
  const vault = {
    set: async (id, value) => secrets.set(id, value),
    get: async (id) => secrets.get(id),
  };
  const fetchImpl = async () => {
    calls++;
    return fail
      ? new Response("", { status: 403 })
      : new Response("", { headers: { "subscription-userinfo": "upload=10; download=20" } });
  };
  try {
    const file = join(dir, "history.json");
    const store = new UsageStore(file, vault, fetchImpl);
    const source = await store.add({
      name: "合成订阅",
      type: "subscription",
      url: "https://example.test/sub",
    });
    await store.refresh(source.id, { force: false });
    await store.refresh(source.id, { force: false });
    assert.equal(calls, 1);
    assert.equal((await store.list()).records.length, 1);
    await Promise.all([store.refresh(source.id, { force: false }), store.refresh(source.id)]);
    assert.equal(calls, 2, "人工调用升级自动缓存检查，执行一次请求");

    fail = true;
    await assert.rejects(store.refresh(source.id), /403/);
    assert.equal(calls, 3);
    const cached = await store.refresh(source.id, { force: false });
    assert.match(cached.sources[0].error, /403/);
    assert.equal(calls, 3, "失败后的自动任务应退避");
    assert.equal(cached.records.length, 2, "保留最近成功记录");
    cached.sources[0].checkedAt = new Date(
      Date.now() - AUTOMATIC_USAGE_TTL_MS - 1000,
    ).toISOString();
    cached.sources[0].attemptedAt = cached.sources[0].checkedAt;
    await writeFile(file, JSON.stringify(cached));
    fail = false;
    await store.refresh(source.id, { force: false });
    assert.equal(calls, 4, "过期后自动重新采集");
    assert.equal((await store.list()).sources[0].error, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("用量TTL边界、无效和未来时间不会无限阻止采集", () => {
  const now = Date.parse("2026-10-08T10:00:00Z");
  assert.equal(usageNeedsRefresh({}, now), true);
  assert.equal(
    usageNeedsRefresh(
      { checkedAt: "invalid", attemptedAt: new Date(now + 1000).toISOString() },
      now,
    ),
    true,
  );
  assert.equal(
    usageNeedsRefresh({ checkedAt: new Date(now - AUTOMATIC_USAGE_TTL_MS).toISOString() }, now),
    true,
  );
  assert.equal(
    usageNeedsRefresh(
      {
        checkedAt: new Date(now - AUTOMATIC_USAGE_TTL_MS - 1000).toISOString(),
        attemptedAt: new Date(now - 1000).toISOString(),
      },
      now,
    ),
    false,
  );
});
test("机场用量头按字节解析，缺字段不能生成假 0", () => {
  assert.deepEqual(
    subscriptionUsage("upload=123; download=456; total=1024; expire=1900000000")[0],
    {
      key: "traffic",
      label: "机场订阅",
      kind: "traffic",
      upload: 123,
      download: 456,
      total: 1024,
      expiresAt: new Date(1900000000000).toISOString(),
    },
  );
  assert.throws(() => subscriptionUsage(null));
  assert.throws(() => subscriptionUsage("download=456"));
  assert.throws(() => subscriptionUsage("upload=-1;download=0"));
});
test("3x-ui 按客户端过滤，不重复叠加入站和客户端计数", () => {
  const list = [
    {
      id: 1,
      remark: "入口",
      up: 100,
      down: 200,
      total: 0,
      clientStats: [
        { email: "alice", up: 10, down: 20, total: 50 },
        { email: "bob", up: 30, down: 40, total: 60 },
      ],
    },
  ];
  assert.equal(panelUsage(list).length, 1);
  assert.equal(panelUsage(list, { clientEmail: "alice" })[0].upload, 10);
  assert.throws(() => panelUsage(list, { inboundId: "2" }));
});
test("3x-ui 自定义面板路径登录携带 Cookie，失败不写伪数据", async () => {
  const calls = [];
  const mock = async (url, options) => {
    calls.push([String(url), options]);
    return calls.length === 1
      ? new Response("<html>legacy login</html>")
      : calls.length === 2
        ? json({ success: true }, { "set-cookie": "session=abc; HttpOnly" })
        : json({ success: true, obj: [{ id: 3, up: 20, down: 50, total: 100 }] });
  };
  const rows = await collectUsage(
    { type: "3x-ui", url: "https://panel.test/private/", username: "alice", password: "secret" },
    mock,
  );
  assert.equal(rows[0].download, 50);
  assert.equal(calls[1][0], "https://panel.test/private/login");
  assert.equal(calls[2][1].headers.Cookie, "session=abc");
  await assert.rejects(
    collectUsage(
      { type: "3x-ui", url: "https://panel.test", username: "a", password: "b" },
      async () => json({ success: false }),
    ),
    /登录失败/,
  );
});
test("OpenAI 按天读取多页，保留缓存 Token 且不重复计入输入", async () => {
  let calls = 0;
  const rows = await collectUsage({ type: "openai-api", apiKey: "test" }, async (url) => {
    calls++;
    if (calls === 2) assert.equal(url.searchParams.get("page"), "next");
    return json({
      data: [
        {
          start_time: 1700000000 + calls * 86400,
          results: [{ input_tokens: 100, output_tokens: 30, input_cached_tokens: 25 }],
        },
      ],
      has_more: calls === 1,
      next_page: "next",
    });
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].input, 100);
  assert.equal(rows[0].cached, 25);
  await assert.rejects(
    collectUsage(
      { type: "openai-api", apiKey: "test" },
      async () => new Response("", { status: 403 }),
    ),
    /Admin Key/,
  );
});
test("Anthropic 缓存读写归入输入，不将未知字段算成 0", async () => {
  const rows = await collectUsage({ type: "anthropic-api", apiKey: "test" }, async () =>
    json({
      data: [
        {
          starting_at: "2026-09-20T00:00:00Z",
          results: [
            {
              uncached_input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 20,
              cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 40 },
            },
          ],
        },
      ],
      has_more: false,
    }),
  );
  assert.equal(rows[0].input, 100);
  assert.equal(rows[0].cacheWrite, 70);
  await assert.rejects(
    collectUsage({ type: "openai-api", apiKey: "test" }, async () =>
      json({ data: [{ start_time: 1700000000, results: [{ output_tokens: 5 }] }] }),
    ),
    /不完整/,
  );
});
test("历史跨重启、累计增量、重置、API 桶去重、凭据不写明文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanpad-usage-"));
  const secrets = new Map();
  const vault = {
    set: async (k, v) => secrets.set(k, v),
    get: async (k) => secrets.get(k),
    remove: async (k) => secrets.delete(k),
  };
  try {
    const file = join(dir, "history.json");
    const store = new UsageStore(file, vault);
    const source = await store.add({
      name: "机场",
      type: "subscription",
      url: "https://example.com/sub?token=secret-token",
    });
    assert.ok(!JSON.stringify(source).includes("secret-token"));
    for (const [upload, download] of [
      [100, 200],
      [120, 250],
      [10, 20],
    ])
      await store.record(source.id, [{ key: "traffic", kind: "traffic", upload, download }]);
    await store.record(source.id, [{ key: "day1", kind: "tokens", input: 5, output: 1 }]);
    await store.record(source.id, [{ key: "day1", kind: "tokens", input: 10, output: 2 }]);
    const state = await new UsageStore(file, vault).list();
    assert.equal(state.records.length, 4);
    assert.equal(state.records[1].deltaDownload, 50);
    assert.equal(state.records[2].counterReset, true);
    assert.equal(state.records[2].deltaDownload, null);
    assert.equal(state.records[3].input, 10);
    assert.ok(!(await readFile(file, "utf8")).includes("secret-token"));
    await store.remove(source.id);
    assert.equal((await store.list()).records.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("订阅额度只记录百分比，重复快照去重，过期数据不冒充新记录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanpad-quota-"));
  try {
    const store = new UsageStore(join(dir, "history.json"), {});
    const account = {
      id: "abc",
      provider: "openai",
      email: "a@example.com",
      usage: {
        status: "available",
        checkedAt: "2026-09-21T00:00:00Z",
        scope: "codex",
        windows: [{ label: "5 小时", usedPercent: 25, resetsAt: null }],
      },
    };
    await store.recordAccount(account);
    await store.recordAccount(account);
    await store.recordAccount({ ...account, usage: { ...account.usage, status: "stale" } });
    const state = await store.list();
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].input, undefined);
    assert.equal(state.records[0].usedPercent, 25);
    await store.markFailure("oauth:abc", "授权已失效");
    assert.equal((await store.list()).sources[0].error, "授权已失效");
    assert.equal((await store.list()).records.length, 1);
    // 首次刷新就失败的账号也要留下来源和原因，不能静默丢弃。
    await store.markFailure("oauth:new", "当前套餐不提供额度查询", {
      type: "oauth",
      name: "grok · b@example.com",
    });
    const created = (await store.list()).sources.find((source) => source.id === "oauth:new");
    assert.equal(created?.name, "grok · b@example.com");
    assert.equal(created?.error, "当前套餐不提供额度查询");
    await store.markFailure("usage-missing", "非订阅来源不自动创建", { type: "oauth" });
    assert.equal((await store.list()).sources.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("采集失败保留上次数据，记录失败状态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanpad-failure-"));
  const map = new Map();
  const vault = { set: async (k, v) => map.set(k, v), get: async (k) => map.get(k) };
  try {
    const store = new UsageStore(
      join(dir, "h.json"),
      vault,
      async () => new Response("", { status: 403 }),
    );
    const source = await store.add({ name: "API", type: "openai-api", apiKey: "secret" });
    await store.record(source.id, [{ key: "day", kind: "tokens", input: 4, output: 2 }]);
    await assert.rejects(store.refresh(source.id), /403/);
    const state = await store.list();
    assert.equal(state.records.length, 1);
    assert.match(state.sources[0].error, /403/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3x-ui 与机场 403 显示对应来源和阶段，不误报组织 Admin Key", async () => {
  const config = {
    type: "3x-ui",
    url: "https://panel.test/private/",
    username: "test",
    password: "test",
  };
  await assert.rejects(
    collectUsage(config, async () => new Response("", { status: 403 })),
    (e) => e.message.includes("3x-ui 初始化登录 HTTP 403") && !e.message.includes("Admin Key"),
  );
  let calls = 0;
  await assert.rejects(
    collectUsage(config, async () =>
      ++calls === 1
        ? new Response("<html></html>")
        : calls === 2
          ? json({ success: true }, { "set-cookie": "session=abc; HttpOnly" })
          : new Response("", { status: 403 }),
    ),
    (e) => e.message.includes("3x-ui 读取入站流量 HTTP 403") && !e.message.includes("Admin Key"),
  );
  await assert.rejects(
    collectUsage(
      { type: "subscription", url: "https://airport.test/sub" },
      async () => new Response("", { status: 403 }),
    ),
    (e) => e.message.includes("机场订阅 HTTP 403") && !e.message.includes("Admin Key"),
  );
});
test("明确标注 Cloudflare 浏览器验证而非推测账号权限", async () => {
  await assert.rejects(
    collectUsage(
      { type: "3x-ui", url: "https://panel.test", username: "u", password: "p" },
      async () => new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    ),
    /Cloudflare challenge/,
  );
});

test("3x-ui 登录携带页面 CSRF 和登录前 Cookie，并更新认证会话", async () => {
  let calls = 0;
  const rows = await collectUsage(
    { type: "3x-ui", url: "https://panel.test/custom", username: "u", password: "p" },
    async (url, options) => {
      calls++;
      if (calls === 1) {
        assert.equal(String(url), "https://panel.test/custom/");
        return new Response('<meta name="csrf-token" content="csrf-test">', {
          headers: { "set-cookie": "session=prelogin; Path=/custom/; HttpOnly" },
        });
      }
      if (calls === 2) {
        assert.equal(options.headers["X-CSRF-Token"], "csrf-test");
        assert.equal(options.headers.Cookie, "session=prelogin");
        assert.equal(options.headers.Origin, "https://panel.test");
        return json({ success: true }, { "set-cookie": "session=authenticated; HttpOnly" });
      }
      assert.equal(options.headers.Cookie, "session=authenticated");
      assert.equal(options.headers["X-Requested-With"], "XMLHttpRequest");
      return json({ success: true, obj: [{ id: 1, up: 10, down: 20, total: 0 }] });
    },
  );
  assert.equal(rows[0].download, 20);
  assert.equal(calls, 3);
});
