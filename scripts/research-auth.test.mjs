import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentityLoginServer } from "../services/identity-login/server.mjs";
import { createResearchService } from "../services/identity-login/research-service.mjs";

test("检索 HTTP 接口只信任加密会话中的身份，拒绝伪造主体、无凭据与跨站请求", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhiyu-research-auth-"));
  const key = randomBytes(32);
  const origin = "https://auth.example.test";
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    calls++;
    let encoded="";
    for await (const part of req) encoded+=part;
    assert.equal(JSON.parse(encoded).query,"合成公开问题");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        results: [
          { url: "https://docs.example.test/", title: "合成说明", highlights: ["合成片段"] },
        ],
        costDollars: { total: 0.005 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const research = await createResearchService({
    file: join(directory, "ledger.sqlite"),
    apiKey: "synthetic-key",
    encryptionKey: randomBytes(32),
    publicOrigin: origin,
    exaOrigin: `http://127.0.0.1:${upstream.address().port}`,
  });
  const server = createIdentityLoginServer({
    config: {
      publicOrigin: origin,
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      sessionEncryptionKey: key.toString("base64"),
    },
    research,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  function credential(subject) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const purpose = "zhiyu-linuxdo-primary-identity:v1";
    cipher.setAAD(Buffer.from(`${purpose}\n${origin}`));
    const data = Buffer.concat([
      cipher.update(
        JSON.stringify({
          purpose,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60000,
          subject,
          tokens: { accessToken: "synthetic-provider-token" },
        }),
      ),
      cipher.final(),
    ]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
  }
  async function post(path, token, body = {}, extra = {}) {
    const encoded = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        `${base}/v1/research/${path}`,
        {
          method: "POST",
          headers: {
            Host: "auth.example.test",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(encoded),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...extra,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers: response.headers,
              }),
            ),
          );
        },
      );
      request.on("error", reject);
      request.end(encoded);
    });
  }
  try {
    assert.equal((await post("quota", null)).status, 401);
    assert.equal((await post("quota", "invalid")).status, 401);
    const one = credential("one"),
      two = credential("two");
    assert.equal(
      (await post("quota", one, {}, { Origin: "https://attacker.example.test" })).status,
      403,
    );
    const response = await post("start", one, {
      requestId: "authenticated_query_one",
      query: "合成公开问题",
      subject: "two",
    });
    assert.equal(response.status, 200);
    let job = await response.json();
    while (["queued", "searching"].includes(job.state)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await (await post("status", one, { id: job.id })).json();
    }
    assert.equal(job.state, "complete");
    assert.equal(calls, 1);
    assert.equal((await (await post("quota", one)).json()).freeRemaining, 49);
    assert.equal((await (await post("quota", two)).json()).freeRemaining, 50);
    assert.equal((await post("status", two, { id: job.id })).status, 404);
    const records = await (await post("records", one)).json();
    assert.equal(records.entries[0].consumed, 1);
    assert.equal((await (await post("records", two)).json()).entries.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await research.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
