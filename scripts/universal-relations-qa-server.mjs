import { createServer, request } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, extname, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { createWebServer } from "../selfhost/server.mjs";
import { DocumentsStore } from "../electron/services/documents.mjs";
import { ProfileService } from "../electron/services/profile.mjs";
import { Vault, vaultPath } from "../electron/services/vault.mjs";
import { LocalUsageMonitor } from "../electron/services/local-usage.mjs";
import { universalRelationFixture, RELATION_TIME } from "./universal-relations-fixture.mjs";

// 独立测试目录和回环 HTTP，不读取用户资料，不调用真实服务。
const privateRoot = resolve(".claude/codex-handoff");
await mkdir(privateRoot, { recursive: true });
const root = await mkdtemp(join(privateRoot, "relations-qa-"));
const sub = relative(privateRoot, root);
if (!sub || sub.startsWith("..") || isAbsolute(sub)) throw Error("测试目录越界");
const { snapshot, documents } = universalRelationFixture();
for (const item of snapshot.servers)
  Object.assign(item, {
    demo: true,
    collect: false,
    sshConfigured: false,
    port: 22,
    username: "root",
    label: "独立测试资料",
    os: "Linux",
    region: "",
    cpu: 0,
    memory: 0,
    disk: 0,
    uptime: "",
    lastSeen: "",
  });
for (const item of snapshot.domains)
  Object.assign(item, { registrar: "test", expiresAt: "2029-01-01", dns: "", nameservers: [] });
for (const item of snapshot.mailboxes)
  Object.assign(item, {
    address: item.id + "@example.test",
    domain: "example.test",
    kind: "mailbox",
    usedMb: 0,
    quotaMb: 0,
  });
for (const item of snapshot.aiAssets)
  Object.assign(item, { plan: "test", monthlyUsd: 0, usagePct: 0, renewsAt: "", keyHint: "" });
for (const item of snapshot.secrets)
  Object.assign(item, { kind: "account", value: "", hint: "", lastRotated: RELATION_TIME });
for (const item of snapshot.certs)
  Object.assign(item, {
    cn: item.id + ".example.test",
    issuer: "test",
    sans: [],
    expiresAt: "2029-01-01",
    daysLeft: 800,
    checkedAt: "",
  });
const document = (doc) => ({
  ...doc,
  content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "关联验收原文，操作不能改变。" }] },
    ],
  },
});
const backend = await createWebServer({
  root: join(root, "web"),
  staticDir: resolve("dist-web"),
  schedulePush: false,
  sampleHost: false,
  log: { log() {}, warn() {}, error() {} },
  fetchImpl: async (url) => {
    if (String(url) === "https://api.github.com/repos/Songwo/zhiyu/releases/latest")
      return Response.json({ tag_name: "v0.0.0" });
    throw Error("测试禁止外部调用");
  },
});
await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
const backendPort = backend.server.address().port;
const token = randomBytes(24).toString("hex");
let failStore = false;
const proxy = createServer((req, res) => {
  if (req.url === "/__qa/fail-next-store" && req.method === "POST") {
    if (req.headers["x-qa-token"] !== token) {
      res.writeHead(403).end();
      return;
    }
    failStore = true;
    res.writeHead(200, { "content-type": "application/json" }).end('{"armed":true}');
    return;
  }
  if (failStore && req.url === "/api/web/store" && req.method === "PUT") {
    failStore = false;
    req.resume();
    res.writeHead(503, { "content-type": "application/json" }).end('{"error":"合成存储失败"}');
    return;
  }
  const upstream = request(
    {
      hostname: "127.0.0.1",
      port: backendPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + proxy.address().port;
let cookie = "";
const call = (path, method = "GET", body) =>
  fetch(base + "/api/web/" + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method !== "GET" ? { "content-type": "application/json", "x-zhiyu": "1" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const setup = await call("setup", "POST", {
  username: "relation-tester",
  password: "relations-web-qa-2026",
  token: backend.setupToken,
});
if (!setup.ok) throw Error(await setup.text());
cookie = setup.headers.get("set-cookie").split(";")[0];
const initial = await call("store", "PUT", {
  revision: null,
  data: { version: 0, state: snapshot },
});
if (!initial.ok) throw Error(await initial.text());
for (const doc of documents) {
  const saved = await call("documents/" + doc.id, "PUT", document(doc));
  if (!saved.ok) throw Error(await saved.text());
}

const nativeRoot = join(root, "desktop");
await mkdir(nativeRoot, { recursive: true });
const vault = new Vault(vaultPath(nativeRoot));
await new ProfileService(join(nativeRoot, "profile.json"), vault).save({
  name: "知屿关联验收",
  password: "relations-native-qa-2026",
});
vault.lock();
await writeFile(join(nativeRoot, "assets.json"), JSON.stringify({ version: 0, state: snapshot }));
await writeFile(
  join(nativeRoot, "preferences.json"),
  JSON.stringify({ locale: "zh", notifications: false, closeToTray: false }),
);
const usage = new LocalUsageMonitor({ file: join(nativeRoot, "local-usage.json") });
await usage.configure({ enabled: false });
usage.closeIndex();
const nativeDocs = new DocumentsStore(join(nativeRoot, "documents"));
for (const doc of documents) await nativeDocs.save(document(doc));
const rendererRoot = resolve(".claude/codex-handoff/relations-renderer");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const renderer = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const file = resolve(rendererRoot, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(rendererRoot + sep)) {
      res.writeHead(403).end();
      return;
    }
    const content = await readFile(file);
    res.writeHead(200, {
      "content-type": mime[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => renderer.listen(0, "127.0.0.1", r));
const metadata = {
  base,
  cookie,
  token,
  root,
  nativeRoot,
  rendererBase: "http://127.0.0.1:" + renderer.address().port,
  resourceCount: 23,
};
await writeFile(join(privateRoot, "relations-qa.json"), JSON.stringify(metadata, null, 2));
console.log(
  JSON.stringify({ ready: true, base, rendererBase: metadata.rendererBase, directory: root }),
);
const stop = () => {
  proxy.closeAllConnections();
  renderer.closeAllConnections();
  backend.server.closeAllConnections();
  proxy.close();
  renderer.close();
  backend.server.close();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
