import { createServer, request } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createIdentityLoginServer } from "../services/identity-login/server.mjs";
import { createResearchService } from "../services/identity-login/research-service.mjs";
import { createWebServer } from "../selfhost/server.mjs";

/** 真实 HTTP 链路：Web → 身份服务 → 合成 OAuth / Exa / TypeSafe；不花真实额度。 */
export async function webResearchFixture({ built = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-web-research-"));
  const behavior = { delay: 100, exaStatus: 200, jevStatus: 200, denied: false };
  const calls = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, body: raw, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/oauth2/token")
      res.end(
        JSON.stringify({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          expires_in: 3600,
        }),
      );
    else if (req.url === "/api/user")
      res.end(
        JSON.stringify({
          id: 73,
          username: "sample",
          name: "合成社区用户",
          trust_level: 2,
        }),
      );
    else if (req.url === "/search") {
      await new Promise((r) => setTimeout(r, behavior.delay));
      res.statusCode = behavior.exaStatus;
      res.end(
        JSON.stringify({
          results: [
            {
              title: "合成官方说明",
              url: "https://docs.example.test/",
              highlights: ["合成搜索结果"],
            },
          ],
          costDollars: { total: 0.005 },
        }),
      );
    } else if (req.url === "/v1/systemone") {
      await new Promise((r) => setTimeout(r, behavior.delay));
      res.statusCode = behavior.jevStatus;
      res.end(
        JSON.stringify({
          answers: {
            category: {
              type: "choice",
              choice: JSON.parse(raw).state.includes("证书") ? "warning" : "important",
              confidence: 0.94,
            },
          },
        }),
      );
    } else if (req.url === "/v1/models") res.end(JSON.stringify({ models: ["jev-latest"] }));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const providerBase = `http://127.0.0.1:${provider.address().port}`;
  const research = await createResearchService({
    file: join(root, "ledger.sqlite"),
    apiKey: "synthetic-exa",
    encryptionKey: randomBytes(32),
    publicOrigin: "https://auth.allinsong.top",
    exaOrigin: providerBase,
  });
  const broker = createIdentityLoginServer({
    config: {
      publicOrigin: "https://auth.allinsong.top",
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      sessionEncryptionKey: randomBytes(32).toString("base64"),
    },
    research,
    limits: { rateLimit: 2000 },
    fetchImpl: (url, options) => fetch(`${providerBase}${new URL(url).pathname}`, options),
  });
  await new Promise((r) => broker.listen(0, "127.0.0.1", r));
  const brokerBase = `http://127.0.0.1:${broker.address().port}`;
  const brokerRequest = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        brokerBase + path,
        {
          ...options,
          headers: {
            ...options.headers,
            host: "auth.allinsong.top",
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  const staticDir = built ? resolve("dist-web") : root;
  if (!built)
    await writeFile(join(root, "index.html"), "<!doctype html><title>Web research test</title>");
  const webOptions = {
    root: join(root, "web"),
    staticDir,
    log: { log() {}, error() {} },
    schedulePush: false,
    analysisBaseUrl: providerBase,
    fetchImpl: (url, options) =>
      new URL(url).origin === "https://auth.allinsong.top"
        ? brokerRequest(new URL(url).pathname, options)
        : fetch(url, options),
  };
  let web, base;
  const startWeb = async () => {
    web = await createWebServer(webOptions);
    await new Promise((r) => web.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${web.server.address().port}`;
  };
  await startWeb();
  const password = "synthetic-web-password-2026";
  const call = (path, { cookie, method = "POST", body = {}, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-zhiyu": "1",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    });
  const setup = await call("/api/web/setup", {
    body: { username: "tester", password, token: web.setupToken },
  });
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const rpc = async (channel, args = [], token = cookie) => {
    const response = await call("/api/web/rpc", { cookie: token, body: { channel, args } });
    return { status: response.status, body: await response.json() };
  };
  const authorize = async (session) => {
    const state = new URL(session.authorizationUrl).searchParams.get("state");
    return brokerRequest(
      `/oauth/linuxdo/callback?state=${state}&${behavior.denied ? "error=access_denied" : "code=synthetic-code"}`,
    );
  };
  const stopWeb = async () => {
    web.server.closeAllConnections();
    await new Promise((r) => web.server.close(r));
  };
  return {
    root,
    calls,
    behavior,
    brokerRequest,
    rpc,
    call,
    cookie,
    authorize,
    password,
    get web() {
      return web;
    },
    get base() {
      return base;
    },
    async restart() {
      await stopWeb();
      await startWeb();
    },
    async close() {
      await stopWeb();
      broker.closeAllConnections();
      provider.closeAllConnections();
      await Promise.all([
        new Promise((r) => broker.close(r)),
        new Promise((r) => provider.close(r)),
        research.close(),
      ]);
      await rm(root, { recursive: true, force: true });
    },
  };
}
