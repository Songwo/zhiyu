import test from "node:test";
import assert from "node:assert/strict";
import { CloudflareClient, normalizeDnsInput } from "./cloudflare.mjs";

const TOKEN = "synthetic-cloudflare-token-for-tests";
const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);
const RECORD = "c".repeat(32);
const dns = (patch = {}) => ({
  type: "A",
  name: "www.example.test",
  content: "192.0.2.10",
  ttl: 300,
  proxied: false,
  ...patch,
});
const reply = (result, info) =>
  Response.json({ success: true, result, ...(info ? { result_info: info } : {}) });
const failure = (status) =>
  Response.json({ success: false, errors: [{ message: TOKEN }] }, { status });
function client(handler, options = {}) {
  const calls = [];
  const instance = new CloudflareClient({
    token: TOKEN,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, init });
      assert.equal(parsed.origin, "https://api.cloudflare.com");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return handler(parsed, init);
    },
    ...options,
  });
  return { instance, calls };
}

test("Cloudflare 逐页获取账户、域名和 Pages，不分页查询 Workers，不回传私密原始字段", async () => {
  const { instance, calls } = client((url) => {
    const page = Number(url.searchParams.get("page") || 1);
    if (url.pathname.endsWith("/accounts"))
      return reply([{ id: ACCOUNT, name: "测试账户", token: TOKEN }], { page: 1, total_pages: 1 });
    if (url.pathname.endsWith("/zones"))
      return reply(
        [
          {
            id: page === 1 ? ZONE : "d".repeat(32),
            name: page === 1 ? "example.test" : "second.test",
            status: "active",
            account: { id: ACCOUNT },
            name_servers: ["Ada.NS.Cloudflare.com", "bob.ns.cloudflare.com"],
            created_on: "2025-01-02T03:04:05Z",
            paused: false,
          },
        ],
        { page, total_pages: 2 },
      );
    if (url.pathname.endsWith("/registrar/registrations"))
      return url.searchParams.get("cursor")
        ? reply(
            [{ domain_name: "second.test", expires_at: null, status: "registration_pending" }],
            {
              count: 1,
              cursor: "",
              per_page: 50,
            },
          )
        : reply(
            [
              {
                domain_name: "Example.test",
                expires_at: "2027-03-08T00:00:00Z",
                auto_renew: true,
                status: "active",
                locked: true,
                credentials: TOKEN,
              },
            ],
            { count: 1, cursor: "next-page", per_page: 50 },
          );
    if (url.pathname.endsWith("/workers/scripts"))
      return reply([{ id: "hello", bindings: [{ value: TOKEN }] }]);
    if (url.pathname.endsWith("/pages/projects"))
      return reply(
        [
          {
            id: `pages-${page}`,
            name: `site-${page}`,
            subdomain: `site-${page}.pages.dev`,
            deployment_configs: { env_vars: { key: TOKEN } },
          },
        ],
        { page, total_pages: 2 },
      );
    if (url.pathname.endsWith("/cfd_tunnel"))
      return reply(
        [
          {
            id: "11111111-2222-3333-4444-555555555555",
            name: "家用主机",
            status: "healthy",
            credentials_file: TOKEN,
          },
        ],
        { page: 1, total_pages: 1 },
      );
    throw new Error("不应请求该地址");
  });
  const result = await instance.inventory();
  assert.equal(result.resources.length, 6);
  assert.equal(new Set(result.resources.map((r) => r.key)).size, 6);
  assert.equal(result.cached, false);
  assert.deepEqual(result.warnings, []);
  assert.ok(!Number.isNaN(Date.parse(result.fetchedAt)));
  assert.equal(result.resources.find((r) => r.type === "worker").status, "unknown");
  const zone = result.resources.find((r) => r.name === "example.test").zone;
  assert.deepEqual(zone.nameServers, ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
  assert.equal(zone.createdOn, "2025-01-02T03:04:05.000Z");
  assert.equal(zone.registrar, "Cloudflare");
  assert.equal(zone.expiresAt, "2027-03-08T00:00:00.000Z");
  assert.equal(zone.autoRenew, true);
  const pending = result.resources.find((r) => r.name === "second.test").zone;
  assert.equal(pending.registrar, "Cloudflare");
  assert.equal(pending.expiresAt, undefined);
  assert.equal(result.resources.find((r) => r.type === "pages").url, "https://site-1.pages.dev/");
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/workers/scripts")).length, 1);
  assert.equal(calls.find((c) => c.url.pathname.endsWith("/workers/scripts")).url.search, "");
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(instance).includes(TOKEN));
});

test("部分权限不足返回成功资源和警告；账户列表无权限时仍可用 Zone 所属账户发现资源", async () => {
  const { instance } = client((url) => {
    if (url.pathname.endsWith("/accounts")) return failure(403);
    if (url.pathname.endsWith("/zones"))
      return reply([
        { id: ZONE, name: "example.test", status: "active", account: { id: ACCOUNT } },
      ]);
    if (url.pathname.endsWith("/workers/scripts")) return reply([{ id: "readable-worker" }]);
    return failure(403);
  });
  const result = await instance.inventory();
  assert.equal(result.resources.length, 2);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings.join(" "), /权限/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("所有资源查询失败不能当作空列表成功，也不显示服务商错误正文", async () => {
  const { instance } = client(() => failure(401));
  await assert.rejects(
    instance.inventory(),
    (error) => /认证|授权/.test(error.message) && !error.message.includes(TOKEN),
  );
});

test("DNS 分页不能静默截断，重复页和超大页数返回明确错误", async () => {
  const repeated = client((url) =>
    reply([{ id: RECORD, ...dns() }], {
      page: Number(url.searchParams.get("page")),
      total_pages: 2,
    }),
  ).instance;
  await assert.rejects(repeated.dnsList(ZONE), /重复|分页/);
  const oversized = client(() =>
    reply([{ id: RECORD, ...dns() }], { page: 1, total_pages: 99999 }),
  ).instance;
  await assert.rejects(oversized.dnsList(ZONE), /上限/);
});

test("429 按 Retry-After 有界重试，过长等待和耗尽重试都明确失败", async () => {
  let attempts = 0;
  const { instance } = client(() =>
    ++attempts < 3
      ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
      : reply([{ id: RECORD, ...dns() }]),
  );
  assert.equal((await instance.dnsList(ZONE)).length, 1);
  assert.equal(attempts, 3);
  const exhausted = client(
    () => new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
  );
  await assert.rejects(exhausted.instance.dnsList(ZONE), /频繁|限流/);
  assert.equal(exhausted.calls.length, 3);
  const long = client(() => new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
  await assert.rejects(long.instance.dnsList(ZONE), /频繁|限流/);
  assert.equal(long.calls.length, 1);
});

test("重定向拒绝携带 Token 跳转，网络错误和格式错误均不会泄露凭据", async () => {
  const redirect = client(
    () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }),
  );
  await assert.rejects(redirect.instance.dnsList(ZONE), /重定向/);
  assert.equal(redirect.calls.length, 1);
  for (const handler of [
    () => {
      throw new Error(`network failed ${TOKEN}`);
    },
    () => new Response(`<html>${TOKEN}</html>`, { status: 200 }),
    () => Response.json({ success: false, errors: [{ message: TOKEN }] }),
  ]) {
    await assert.rejects(
      client(handler).instance.dnsList(ZONE),
      (error) => !error.message.includes(TOKEN),
    );
  }
});

test("请求和响应体读取都有超时保护，取消能及时中断", async () => {
  const stuck = client(() => new Promise(() => {}), { timeoutMs: 20 });
  await assert.rejects(stuck.instance.dnsList(ZONE), /超时/);
  const bodyStuck = client(() => new Response(new ReadableStream({ start() {} })), {
    timeoutMs: 20,
  });
  await assert.rejects(bodyStuck.instance.dnsList(ZONE), /超时/);
  const controller = new AbortController();
  const aborted = client(() => new Promise(() => {}), { signal: controller.signal });
  const pending = aborted.instance.inventory();
  controller.abort();
  await assert.rejects(pending, /取消/);
});

test("DNS CRUD 使用官方路径与字段白名单；更新采用 PATCH 保留高级配置", async () => {
  const { instance, calls } = client((url, init) => {
    if (init.method === "DELETE") return reply({ id: RECORD });
    if (init.method === "POST" || init.method === "PATCH")
      return reply({
        id: RECORD,
        ...JSON.parse(init.body),
        modified_on: "2026-10-12T00:00:00Z",
        meta: { secret: TOKEN },
      });
    if (url.pathname.endsWith(RECORD))
      return reply({
        id: RECORD,
        ...dns(),
        modified_on: "2026-10-12T00:00:00Z",
        meta: { secret: TOKEN },
      });
    return reply([{ id: RECORD, ...dns() }]);
  });
  assert.equal((await instance.dnsList(ZONE)).length, 1);
  assert.equal((await instance.dnsGet(ZONE, RECORD)).id, RECORD);
  const created = await instance.dnsWrite(ZONE, {
    action: "create",
    record: dns({ extra: TOKEN }),
  });
  assert.equal(created.id, RECORD);
  assert.equal(created.modifiedOn, "2026-10-12T00:00:00.000Z");
  await instance.dnsWrite(ZONE, {
    action: "update",
    recordId: RECORD,
    record: dns({ content: "192.0.2.20" }),
  });
  await instance.dnsWrite(ZONE, { action: "delete", recordId: RECORD });
  assert.deepEqual(
    calls.map((c) => c.init.method),
    ["GET", "GET", "POST", "PATCH", "DELETE"],
  );
  assert.equal(JSON.parse(calls[2].init.body).extra, undefined);
  assert.equal(calls[3].url.pathname, `/client/v4/zones/${ZONE}/dns_records/${RECORD}`);
  assert.ok(!JSON.stringify(created).includes(TOKEN));
});

test("DNS 输入验证覆盖协议类型、域名、IP、TTL、代理及 MX 优先级", () => {
  assert.equal(normalizeDnsInput(dns({ name: "WWW.Example.Test." })).name, "www.example.test");
  assert.equal(
    normalizeDnsInput(dns({ name: "*.例子.测试", proxied: true, ttl: 1 })).name,
    "*.xn--fsqu00a.xn--0zwm56d",
  );
  assert.equal(
    normalizeDnsInput(dns({ type: "AAAA", content: "2001:db8::1" })).content,
    "2001:db8::1",
  );
  assert.equal(
    normalizeDnsInput(
      dns({ type: "TXT", name: "_dmarc.example.test", content: "v=DMARC1; p=none" }),
    ).content,
    "v=DMARC1; p=none",
  );
  assert.equal(
    normalizeDnsInput(dns({ type: "MX", content: "mail.example.test", priority: 10 })).priority,
    10,
  );
  for (const patch of [
    { type: "BOGUS" },
    { type: "SRV" },
    { type: "CAA" },
    { name: "https://example.test" },
    { name: "a..test" },
    { name: "@" },
    { name: "*.a.*.test" },
    { content: "999.0.0.1" },
    { type: "AAAA", content: "127.0.0.1" },
    { ttl: 0 },
    { ttl: 59 },
    { ttl: 86401 },
    { ttl: 60.5 },
    { proxied: "true" },
    { proxied: true, ttl: 300 },
    { type: "TXT", content: "test", proxied: true },
    { type: "MX", content: "mail.example.test" },
    { type: "MX", content: "mail.example.test", priority: -1 },
    { type: "MX", content: "mail.example.test", priority: 65536 },
    { priority: 1 },
    { type: "CNAME", content: "https://evil.example" },
    { type: "NS", content: "ns..test" },
    { data: { value: "unsupported" } },
    { comment: "bad\u0000value" },
  ])
    assert.throws(() => normalizeDnsInput(dns(patch)), undefined, JSON.stringify(patch));
});

test("非法 ID 或 DNS 写请求在发网前被拒绝", async () => {
  const { instance, calls } = client(() => {
    throw new Error("不应请求");
  });
  for (const id of ["../elsewhere", "x?token=leak", "https://evil.test", ""])
    await assert.rejects(instance.dnsList(id));
  await assert.rejects(instance.dnsWrite(ZONE, { action: "drop-all" }));
  await assert.rejects(instance.dnsWrite(ZONE, { action: "update", record: dns() }));
  await assert.rejects(
    instance.dnsWrite(ZONE, { action: "create", record: dns({ content: "wrong" }) }),
  );
  assert.equal(calls.length, 0);
});

test("响应大小和缺失字段校验拒绝异常结果", async () => {
  await assert.rejects(
    client(
      () => new Response("{}", { headers: { "Content-Length": "99999999" } }),
    ).instance.dnsList(ZONE),
    /过大/,
  );
  await assert.rejects(
    client(() => reply([{ type: "A", name: "example.test" }])).instance.dnsList(ZONE),
    /格式|字段/,
  );
});

test("高级 DNS 类型可读可删除，预览仅接收安全标量且不能修改高级记录", async () => {
  const { instance } = client((url, init) =>
    init.method === "DELETE"
      ? reply({ id: RECORD })
      : reply([
          {
            id: RECORD,
            ...dns({ type: "HTTPS", content: '1 . alpn="h2"' }),
            data: {
              priority: 1,
              target: ".",
              value: 'alpn="h2"',
              private_token: TOKEN,
              nested: { secret: TOKEN },
            },
            meta: { key: TOKEN },
          },
        ]),
  );
  const [record] = await instance.dnsList(ZONE);
  assert.equal(record.type, "HTTPS");
  assert.deepEqual(record.data, { priority: 1, target: ".", value: 'alpn="h2"' });
  assert.equal(record.meta, undefined);
  await assert.rejects(
    instance.dnsWrite(ZONE, { action: "update", recordId: RECORD, record }),
    /暂不支持编辑/,
  );
  await instance.dnsWrite(ZONE, { action: "delete", recordId: RECORD });
});

test("分页 total_count 和服务商较小 per_page 均可读完整 DNS 列表", async () => {
  for (const mode of ["count", "size"]) {
    const { instance, calls } = client((url) => {
      const page = Number(url.searchParams.get("page"));
      return reply(
        page <= 2 ? [{ id: page === 1 ? RECORD : "d".repeat(32), ...dns() }] : [],
        mode === "count" ? { page, total_count: 2, per_page: 1 } : { page, per_page: 1 },
      );
    });
    assert.equal((await instance.dnsList(ZONE)).length, 2);
    assert.equal(calls.length, mode === "count" ? 2 : 3);
  }
});

test("等待非零 Retry-After 后才重试，退避期间取消立即停止后续请求", async () => {
  let count = 0;
  const start = performance.now();
  const { instance } = client(() =>
    ++count === 1
      ? new Response(null, { status: 429, headers: { "Retry-After": "0.03" } })
      : reply([]),
  );
  await instance.dnsList(ZONE);
  assert.ok(performance.now() - start >= 25);
  const controller = new AbortController();
  const aborting = client(
    () => {
      setTimeout(() => controller.abort(), 10);
      return new Response(null, { status: 429, headers: { "Retry-After": "3" } });
    },
    { signal: controller.signal },
  );
  await assert.rejects(aborting.instance.dnsList(ZONE), /取消/);
  assert.equal(aborting.calls.length, 1);
});

test("无 Content-Length 的超大响应也拒绝，服务商错误字段和网络错误始终脱敏", async () => {
  const large = new Uint8Array(9 * 1024 * 1024);
  await assert.rejects(
    client(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(large);
              controller.close();
            },
          }),
        ),
    ).instance.dnsList(ZONE),
    /过大/,
  );
  const result = await client(() =>
    reply([{ id: RECORD, ...dns({ type: "TXT", content: TOKEN, comment: TOKEN }), token: TOKEN }]),
  ).instance.dnsList(ZONE);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.throws(() => normalizeDnsInput(dns({ name: 42 })), /域名格式/);
});

test("没有 Registrar 权限或域名不在 Cloudflare 注册时静默跳过，其他错误才提示", async () => {
  const run = (registrar) =>
    client((url) => {
      if (url.pathname.endsWith("/accounts")) return reply([{ id: ACCOUNT }]);
      if (url.pathname.endsWith("/zones"))
        return reply([
          { id: ZONE, name: "example.test", status: "active", account: { id: ACCOUNT } },
        ]);
      if (url.pathname.endsWith("/registrar/registrations")) return registrar();
      return reply([]);
    }).instance.inventory();
  for (const status of [401, 403, 404]) {
    const result = await run(() => failure(status));
    assert.deepEqual(result.warnings, [], `HTTP ${status}`);
    assert.equal(result.resources.find((r) => r.type === "zone").zone.expiresAt, undefined);
  }
  const broken = await run(() => failure(500));
  assert.equal(broken.warnings.length, 1);
  assert.ok(broken.warnings[0].startsWith("域名注册信息："));
  assert.equal(broken.resources.find((r) => r.type === "zone").name, "example.test");
});
