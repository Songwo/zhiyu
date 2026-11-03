import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createResearchService,
  creditSignature,
} from "../services/identity-login/research-service.mjs";
import { publicResearchQuery } from "../src/lib/research-query.mjs";

async function fixture(task, { proof = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zhiyu-research-"));
  const state = {
    status: 200,
    searches: 0,
    checkouts: 0,
    paid: false,
    lastOrder: null,
    proof: proof ? { availableUsd: 100, source: "operator-verified", checkedAt: Date.now() } : null,
  };
  const key = randomBytes(32);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://local.test");
    if (url.pathname === "/search") {
      state.searches++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      assert.equal(req.headers["x-api-key"], "synthetic-exa-key");
      assert.equal(input.numResults, 5);
      assert.equal(input.contents.highlights, true);
      res.writeHead(state.status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          state.status === 200
            ? {
                results: [
                  {
                    title: "合成官方文档",
                    url: "https://docs.example.test/guide",
                    highlights: ["仅用于自动回归的合成搜索摘录"],
                  },
                ],
                costDollars: { total: 0.005 },
              }
            : { error: "synthetic error" },
        ),
      );
      return;
    }
    if (url.pathname === "/epay/pay/submit.php") {
      state.checkouts++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = Object.fromEntries(new URLSearchParams(body));
      assert.equal(input.sign, creditSignature(input, "synthetic-merchant-key"));
      assert.equal(input.money, "10.00");
      state.lastOrder = input.out_trade_no;
      res.writeHead(302, { Location: `/paying?order_no=${state.lastOrder}` });
      res.end();
      return;
    }
    if (url.pathname === "/epay/api.php") {
      assert.equal(url.searchParams.get("key"), "synthetic-merchant-key");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 1,
          status: state.paid ? 1 : 0,
          pid: "test-merchant",
          out_trade_no: url.searchParams.get("out_trade_no"),
          trade_no: `trade_${url.searchParams.get("out_trade_no")}`,
          money: "10.00",
          type: "epay",
        }),
      );
      return;
    }
    res.writeHead(501);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = {
    file: join(directory, "research.db"),
    apiKey: "synthetic-exa-key",
    encryptionKey: key,
    publicOrigin: "https://auth.example.test",
    merchantId: "test-merchant",
    merchantKey: "synthetic-merchant-key",
    balanceReader: async () => state.proof,
    exaOrigin: origin,
    creditOrigin: origin,
  };
  let service = await createResearchService(options);
  try {
    await task({
      service,
      state,
      directory,
      options,
      restart: async () => {
        await service.close();
        service = await createResearchService(options);
        return service;
      },
    });
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
async function run(service, subject, index = 0) {
  let job = service.start(subject, {
    requestId: `request_${index}_${Math.random().toString(36).slice(2)}`,
    query: "合成服务的官方说明",
  });
  const deadline = Date.now() + 10000;
  while (["queued", "searching"].includes(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = await service.status(subject, job.id);
  }
  assert.ok(!["queued", "searching"].includes(job.state), "检索必须结束");
  return job;
}
async function exhaustFree(service, subject = "user-one") {
  for (let i = 0; i < 50; i++) {
    const job = await run(service, subject, i);
    assert.equal(job.state, "complete");
  }
  assert.equal(service.quota(subject).freeRemaining, 0);
}

test("真实 Exa HTTP 结果与条目进度，免费计数持久化，失败不扣次数", async () =>
  fixture(async ({ service, state, restart, directory }) => {
    const first = await run(service, "user-one");
    assert.equal(first.results[0].title, "合成官方文档");
    assert.ok(first.items.every((item) => item.status === "done"));
    assert.equal(service.quota("user-one").freeRemaining, 49);
    state.status = 402;
    const failure = await run(service, "user-one");
    assert.equal(failure.state, "failed");
    assert.match(failure.items.at(-1).detail, /Exa 额度不足/);
    assert.equal(service.quota("user-one").freeRemaining, 49);
    assert.equal(state.checkouts, 0);
    const restored = await restart();
    assert.equal(restored.quota("user-one").freeUsed, 1);
    assert.equal(restored.quota("another-user").freeRemaining, 50);
    assert.ok(
      !(await readFile(join(directory, "research.db"))).includes(
        Buffer.from("仅用于自动回归的合成搜索摘录"),
      ),
    );
  }));
test("缺失、过期与不足的余额证据都禁止创建 LDC 订单", async () =>
  fixture(async ({ service, state }) => {
    await exhaustFree(service);
    const job = await run(service, "user-one", 51);
    assert.equal(job.state, "awaiting_payment");
    for (const proof of [
      null,
      { availableUsd: 100, source: "operator-verified", checkedAt: Date.now() - 120000 },
      { availableUsd: 0.01, source: "operator-verified", checkedAt: Date.now() },
    ]) {
      state.proof = proof;
      await assert.rejects(service.checkout("user-one", job.id), /余额|预算/);
      assert.equal(state.checkouts, 0);
      assert.equal(service.quota("user-one").paidTotal, 0);
    }
  }));
test("购买100次、已用1次、余额99，重复回调与并发查单不重复入账，账本可分页", async () =>
  fixture(async ({ service, state, restart }) => {
    await exhaustFree(service);
    const job = await run(service, "user-one", 51);
    const [one, two] = await Promise.all([
      service.checkout("user-one", job.id),
      service.checkout("user-one", job.id),
    ]);
    assert.equal(one.paymentUrl, two.paymentUrl);
    assert.equal(state.checkouts, 1);
    state.paid = true;
    const callback = {
      pid: "test-merchant",
      out_trade_no: job.id,
      trade_no: `trade_${job.id}`,
      type: "epay",
      name: "知屿联网检索 100 次",
      money: "10.00",
      trade_status: "TRADE_SUCCESS",
    };
    callback.sign = creditSignature(callback, "synthetic-merchant-key");
    await Promise.all([service.notify(callback), service.notify(callback)]);
    let quota = service.quota("user-one");
    assert.equal(quota.paidTotal, 100);
    assert.equal(quota.paidUsed, 1);
    assert.equal(quota.paidRemaining, 99);
    assert.equal((await service.status("user-one", job.id)).state, "complete");
    state.status = 402;
    await run(service, "user-one", 52);
    assert.equal(service.quota("user-one").paidRemaining, 99);
    const page1 = service.records("user-one");
    assert.equal(page1.entries.length, 50);
    assert.ok(page1.nextOffset);
    const page2 = service.records("user-one", { offset: page1.nextOffset });
    assert.ok(page2.entries.length > 0);
    const restored = await restart();
    quota = restored.quota("user-one");
    assert.equal(quota.paidRemaining, 99);
    assert.equal(quota.freeUsed, 50);
  }));
test("相同请求重放不会重复发出 Exa 请求，不能读取别人的结果", async () =>
  fixture(async ({ service, state }) => {
    const input = { requestId: "idempotent_request_001", query: "合成查询" };
    let job = service.start("user-one", input);
    while (["queued", "searching"].includes(job.state)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await service.status("user-one", job.id);
    }
    assert.equal(service.start("user-one", input).id, job.id);
    assert.equal(state.searches, 1);
    await assert.rejects(service.status("another-user", job.id), /没有找到/);
    assert.throws(() => service.start("user-one", { ...input, query: "另一个问题" }), /不同问题/);
  }));
test("搜索种子只取公开字段，不包含主机、卡号、邮箱与文档内容", () => {
  const data = {
    provider: "测试银行",
    os: "Debian",
    host: "private-host.test",
    number: "6222020000000000000",
    address: "private@example.test",
    notes: "private-note",
    card: { kind: "payment" },
  };
  for (const kind of ["server", "ai", "service", "domain", "cert", "mail", "secret"])
    assert.doesNotMatch(
      publicResearchQuery(kind, data),
      /private-host|622202|private@|private-note/,
    );
});

test("已准备结果后其他请求报告 Exa 不足，也不创建积分订单；错误金额通知不能入账", async () =>
  fixture(async ({ service, state }) => {
    await exhaustFree(service);
    const job = await run(service, "user-one", 51);
    state.status = 402;
    await run(service, "another-user", 1);
    await assert.rejects(service.checkout("user-one", job.id), /Exa 额度不足/);
    assert.equal(state.checkouts, 0);
    const forged = {
      pid: "test-merchant",
      out_trade_no: job.id,
      trade_status: "TRADE_SUCCESS",
      money: "0.01",
      sign: "0".repeat(32),
    };
    await assert.rejects(service.notify(forged), /回调无效/);
    assert.equal(service.quota("user-one").paidTotal, 0);
  }));
