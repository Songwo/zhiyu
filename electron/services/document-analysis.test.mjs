import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentAnalysisService, normalizeAnalysisConfig } from "./document-analysis.mjs";

const secure = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from([...value].reverse().join("")),
  decryptString: (value) => [...value.toString()].reverse().join(""),
};
async function fixture(handler, task) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-jev-test-"));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const events = [];
  const service = new DocumentAnalysisService({
    file: join(root, "jev.json"),
    secureStorage: secure,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    emit: (event) => events.push(event),
  });
  try {
    await service.saveConfig({
      ...normalizeAnalysisConfig(),
      enabled: true,
      apiKey: "synthetic-jev-api-key",
    });
    await task(service, events, root);
  } finally {
    service.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
const payload = {
  id: "analysis_1",
  blocks: [
    { id: "p1", text: "合成资料：明天之前需要更新证书。" },
    { id: "p2", text: "合成资料：这是部署流程中的关键配置。" },
  ],
  allowDocumentContent: true,
};
test("Jev 配置验证分类规则、颜色与显示方式，拒绝注入与未知类型", () => {
  assert.equal(normalizeAnalysisConfig({ mode: "sidebar" }).mode, "sidebar");
  for (const patch of [
    { threshold: 2 },
    { model: "bad\nmodel" },
    { mode: "script" },
    { rules: [{ id: "bad", label: "x", description: "x", color: "red;display:none" }] },
    { rules: [] },
  ])
    assert.throws(() => normalizeAnalysisConfig(patch));
});
test("真实 HTTP 按段调用 System One，逐条进度与分类均来自响应，密钥不落明文", async () => {
  const received = [];
  await fixture(
    async (req, res) => {
      assert.equal(req.url, "/v1/systemone");
      assert.equal(req.headers.authorization, "Bearer synthetic-jev-api-key");
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "jev-latest",
          answers: {
            category: {
              type: "choice",
              choice: received.length === 1 ? "action" : "important",
              confidence: 0.9,
            },
          },
          usage: { input_tokens: 20, output_tokens: 3 },
        }),
      );
    },
    async (service, events, root) => {
      const result = await service.run(payload);
      assert.equal(received.length, 2);
      assert.equal(received[0].state, payload.blocks[0].text);
      assert.equal(received[0].questions.category.type, "choice");
      assert.deepEqual(
        result.results.map((r) => r.choice),
        ["action", "important"],
      );
      assert.ok(
        events.some(
          (event) =>
            event.results.length === 1 && event.items.some((item) => item.status === "running"),
        ),
      );
      assert.ok(
        result.items.every((item) => item.status === "done" && item.endedAt >= item.startedAt),
      );
      assert.ok(
        !(await readFile(join(root, "jev.json"), "utf8")).includes("synthetic-jev-api-key"),
      );
      assert.ok(!JSON.stringify(await service.config()).includes("synthetic-jev-api-key"));
    },
  );
});
test("没有本次正文授权时不会调用供应商", async () => {
  let requests = 0;
  await fixture(
    (_req, res) => {
      requests++;
      res.end("{}");
    },
    async (service) => {
      await assert.rejects(service.run({ ...payload, allowDocumentContent: false }), /授权/);
      assert.equal(requests, 0);
    },
  );
});
test("Jev 额度不足立即停止，失败段落不生成高亮结果", async () => {
  let requests = 0;
  await fixture(
    (_req, res) => {
      requests++;
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end("{}");
    },
    async (service, events) => {
      await assert.rejects(service.run(payload), /额度不足/);
      assert.equal(requests, 1);
      assert.equal(events.at(-1).results.length, 0);
      assert.equal(events.at(-1).items.at(-1).status, "error");
    },
  );
});
test("取消会中断真实请求，不继续发送后续段落", async () => {
  let requests = 0;
  await fixture(
    (_req, _res) => {
      requests++;
    },
    async (service, events) => {
      const run = service.run(payload);
      while (requests === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      service.cancel(payload.id);
      const result = await run;
      assert.equal(result.cancelled, true);
      assert.equal(requests, 1);
      assert.equal(events.at(-1).items.at(-1).status, "cancelled");
    },
  );
});

test("关闭 Jev 功能立即中断活动请求，不继续消耗后续段落", async () => {
  let requests = 0;
  await fixture(
    (_req, _res) => {
      requests++;
    },
    async (service) => {
      const run = service.run(payload);
      while (!requests) await new Promise((resolve) => setTimeout(resolve, 5));
      await service.saveConfig({ ...(await service.config()), enabled: false });
      assert.equal((await run).cancelled, true);
      assert.equal(requests, 1);
    },
  );
});
