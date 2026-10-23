/**
 * 知屿网页版（自托管）。
 *
 * 一个不依赖框架的 Node 服务：登录保护整站，资料文件与桌面版的资料目录完全相同
 * （assets.json、documents/、vault.enc），所以桌面版的加密备份可以直接恢复到这里，
 * 这里做的备份也能在桌面版恢复。密钥库在浏览器里用主密码加解密，服务器只保存密文。
 *
 * 目录：
 *   <ZHIYU_DATA>/workspace  资料（与桌面版资料目录一致，备份与恢复的范围）
 *   <ZHIYU_DATA>/server     网页登录账号与会话（不进入备份，恢复时不受影响）
 */
import { createServer } from "node:http";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeSnapshotImages } from "../electron/services/image-data.mjs";
import { DocumentsStore } from "../electron/services/documents.mjs";
import {
  BACKUP_LIMITS,
  applyPendingRestore,
  backupStamp,
  createBackup,
  openBackup,
  stageRestore,
} from "../electron/services/backup.mjs";

const derive = promisify(scrypt);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const VERSION = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const LOGIN_KDF = { N: 2 ** 15, r: 8, p: 1 };
const SESSION_DAYS = 30;
const COOKIE = "zhiyu_session";
const JSON_LIMIT = 64 * 1024 * 1024;
const RESTORE_LIMIT = BACKUP_LIMITS.bytes + 1024 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};
const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** 先写临时文件再改名，中断时不会留下半个文件。 */
async function writeAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, file);
}
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertPassword(value, label = "密码") {
  if (typeof value !== "string" || value.length < 10)
    throw new HttpError(400, `${label}至少 10 位`);
  if (value.length > 256) throw new HttpError(400, `${label}最多 256 位`);
}
function assertUsername(value) {
  if (typeof value !== "string" || !/^[\p{L}\p{N}_.@-]{2,40}$/u.test(value.trim()))
    throw new HttpError(400, "用户名需为 2 到 40 位字母、数字或 _ . @ -");
  return value.trim();
}

/** 保险库文件结构检查：只看格式，不需要也不可能解密。 */
function assertVaultDoc(doc) {
  const sealed = (rec) =>
    rec &&
    typeof rec === "object" &&
    ["iv", "tag", "data"].every(
      (k) => typeof rec[k] === "string" && /^[A-Za-z0-9+/=]*$/.test(rec[k]),
    );
  if (
    !doc ||
    typeof doc !== "object" ||
    ![1, 2].includes(doc.v) ||
    typeof doc.salt !== "string" ||
    !sealed(doc.check) ||
    !doc.records ||
    typeof doc.records !== "object" ||
    Array.isArray(doc.records) ||
    !Object.entries(doc.records).every(([id, rec]) => id.length <= 512 && sealed(rec))
  )
    throw new HttpError(400, "密钥库格式不正确");
  if (doc.v === 2) {
    const { N, r, p } = doc.kdf ?? {};
    if (
      ![N, r, p].every(Number.isInteger) ||
      N < 2 ** 14 ||
      N > 2 ** 20 ||
      r < 1 ||
      r > 32 ||
      p < 1 ||
      p > 16
    )
      throw new HttpError(400, "密钥库参数不正确");
  }
}

export async function createWebServer({
  root = resolve(process.env.ZHIYU_DATA ?? "./zhiyu-data"),
  staticDir = resolve(HERE, "../dist-web"),
  secureCookie = process.env.ZHIYU_SECURE_COOKIE === "1",
  trustProxy = process.env.ZHIYU_TRUST_PROXY === "1",
  setupToken = process.env.ZHIYU_SETUP_TOKEN,
  log = console,
} = {}) {
  const workspace = join(root, "workspace");
  const serverDir = join(root, "server");
  await mkdir(workspace, { recursive: true });
  await mkdir(serverDir, { recursive: true, mode: 0o700 });
  // 上次恢复中途退出时，先把暂存的恢复做完。
  await applyPendingRestore(workspace).catch((error) => log.error("restore:apply", error.message));

  const files = {
    account: join(serverDir, "account.json"),
    sessions: join(serverDir, "sessions.json"),
    token: join(serverDir, "setup-token.txt"),
    store: join(workspace, "assets.json"),
    vault: join(workspace, "vault.enc"),
  };
  let documents = new DocumentsStore(join(workspace, "documents"));
  let account = await readJson(files.account);
  const sessions = new Map(Object.entries((await readJson(files.sessions)) ?? {}));
  const failures = new Map();
  let queue = Promise.resolve();
  const serial = (work) => {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  };

  // 首次启动：生成一次性的设置口令，只写进服务器日志与 server 目录，防止陌生人抢先注册。
  if (!account) {
    setupToken ||=
      (await readFile(files.token, "utf8").catch(() => "")).trim() ||
      randomBytes(12).toString("hex");
    await writeAtomic(files.token, setupToken);
    log.log(
      `[知屿] 首次使用：打开网页，用设置口令 ${setupToken} 创建账号（也保存在 ${files.token}）`,
    );
  }

  const persistSessions = () =>
    writeAtomic(files.sessions, JSON.stringify(Object.fromEntries(sessions)));
  async function hashPassword(password, salt, kdf = LOGIN_KDF) {
    return (
      await derive(password.normalize("NFKC"), salt, 32, { ...kdf, maxmem: 64 * 1024 * 1024 })
    ).toString("base64");
  }
  async function newSession(res, req, username) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    sessions.set(sha256(token), {
      username,
      created: now,
      expires: now + SESSION_DAYS * 86_400_000,
    });
    for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
    await persistSessions();
    const secure = secureCookie || (trustProxy && req.headers["x-forwarded-proto"] === "https");
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`,
    );
  }
  function sessionOf(req) {
    const cookie = req.headers.cookie ?? "";
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
    if (!match) return null;
    const key = sha256(match[1]);
    const session = sessions.get(key);
    if (!session || session.expires < Date.now() || session.username !== account?.username)
      return null;
    return { key, ...session };
  }
  const clientIp = (req) =>
    (trustProxy &&
      String(req.headers["x-forwarded-for"] ?? "")
        .split(",")[0]
        .trim()) ||
    req.socket.remoteAddress ||
    "?";
  function limitLogin(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const list = (failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    failures.set(ip, list);
    if (list.length >= 8) throw new HttpError(429, "尝试次数过多，请 15 分钟后再试");
    return () => {
      list.push(now);
      failures.set(ip, list);
    };
  }

  async function body(req, limit = JSON_LIMIT) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, "请求内容过大");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function json(req) {
    try {
      return JSON.parse((await body(req)).toString("utf8") || "null");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "请求格式不正确");
    }
  }
  function send(res, status, payload, headers = {}) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(payload));
  }
  async function fileRevision(file) {
    try {
      return sha256(await readFile(file));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function serveStatic(res, dir, path, { csp = APP_CSP, fallback = "index.html" } = {}) {
    const clean = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
    let file = resolve(dir, clean || fallback);
    if (!file.startsWith(resolve(dir) + sep) && file !== resolve(dir))
      throw new HttpError(404, "Not found");
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (extname(clean)) throw new HttpError(404, "Not found");
      file = join(dir, fallback);
      info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new HttpError(503, "网页文件尚未构建，请先运行 npm run web:build");
    }
    const type = MIME[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Security-Policy": csp,
      "Cache-Control":
        extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(await readFile(file));
  }

  const routes = {
    "GET /api/web/state": async (req, res) =>
      send(res, 200, {
        setup: !account,
        username: sessionOf(req)?.username ?? null,
        version: VERSION,
      }),

    "POST /api/web/setup": async (req, res) => {
      const input = await json(req);
      if (account) throw new HttpError(409, "账号已经创建，请直接登录");
      const fail = limitLogin(req);
      const given = Buffer.from(String(input?.token ?? ""));
      const expected = Buffer.from(setupToken ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        fail();
        throw new HttpError(403, "设置口令不正确，请查看服务器日志");
      }
      const username = assertUsername(input?.username);
      assertPassword(input?.password, "登录密码");
      const salt = randomBytes(16);
      account = {
        v: 1,
        username,
        salt: salt.toString("base64"),
        kdf: LOGIN_KDF,
        hash: await hashPassword(input.password, salt),
        createdAt: new Date().toISOString(),
      };
      await writeAtomic(files.account, JSON.stringify(account));
      await rm(files.token, { force: true });
      setupToken = undefined;
      await newSession(res, req, username);
      send(res, 200, { username });
    },

    "POST /api/web/login": async (req, res) => {
      const input = await json(req);
      if (!account) throw new HttpError(409, "还没有创建账号");
      const fail = limitLogin(req);
      const hash = await hashPassword(
        String(input?.password ?? ""),
        Buffer.from(account.salt, "base64"),
        account.kdf,
      );
      const ok =
        typeof input?.username === "string" &&
        input.username.trim() === account.username &&
        timingSafeEqual(Buffer.from(hash), Buffer.from(account.hash));
      if (!ok) {
        fail();
        await new Promise((r) => setTimeout(r, 400));
        throw new HttpError(401, "用户名或密码不正确");
      }
      await newSession(res, req, account.username);
      send(res, 200, { username: account.username });
    },

    "POST /api/web/logout": async (req, res) => {
      const session = sessionOf(req);
      if (session) {
        sessions.delete(session.key);
        await persistSessions();
      }
      res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      send(res, 200, { ok: true });
    },
  };

  const authed = {
    "GET /api/web/session": async (req, res, session) =>
      send(res, 200, { username: session.username, version: VERSION }),

    "POST /api/web/password": async (req, res, session) => {
      const input = await json(req);
      const hash = await hashPassword(
        String(input?.current ?? ""),
        Buffer.from(account.salt, "base64"),
        account.kdf,
      );
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(account.hash)))
        throw new HttpError(403, "当前登录密码不正确");
      assertPassword(input?.next, "新登录密码");
      const salt = randomBytes(16);
      account = {
        ...account,
        salt: salt.toString("base64"),
        kdf: LOGIN_KDF,
        hash: await hashPassword(input.next, salt),
      };
      await writeAtomic(files.account, JSON.stringify(account));
      // 改密后其他设备的会话全部失效，只保留当前这一个。
      for (const key of [...sessions.keys()]) if (key !== session.key) sessions.delete(key);
      await persistSessions();
      send(res, 200, { ok: true });
    },

    "GET /api/web/store": async (req, res) =>
      serial(async () => {
        const raw = await readFile(files.store).catch((e) =>
          e.code === "ENOENT" ? null : Promise.reject(e),
        );
        const data = raw
          ? normalizeSnapshotImages(JSON.parse(raw.toString("utf8")), { strict: false })
          : null;
        send(res, 200, { revision: raw ? sha256(raw) : null, data });
      }),

    "PUT /api/web/store": async (req, res) => {
      const input = await json(req);
      if (!input || typeof input.data !== "object" || input.data === null)
        throw new HttpError(400, "资料格式不正确");
      let normalized;
      try {
        normalized = normalizeSnapshotImages(input.data);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      await serial(async () => {
        const current = await fileRevision(files.store);
        if ((input.revision ?? null) !== current) throw new HttpError(409, "资料已在其他设备更新");
        const text = JSON.stringify(normalized);
        await writeAtomic(files.store, text);
        send(res, 200, { revision: sha256(text) });
      });
    },

    "GET /api/web/vault": async (req, res) =>
      serial(async () => {
        const raw = await readFile(files.vault).catch((e) =>
          e.code === "ENOENT" ? null : Promise.reject(e),
        );
        send(res, 200, {
          revision: raw ? sha256(raw) : null,
          doc: raw ? JSON.parse(raw.toString("utf8")) : null,
        });
      }),

    "PUT /api/web/vault": async (req, res) => {
      const input = await json(req);
      assertVaultDoc(input?.doc);
      await serial(async () => {
        const current = await fileRevision(files.vault);
        if ((input.revision ?? null) !== current)
          throw new HttpError(409, "密钥库已在其他设备更新");
        const text = JSON.stringify(input.doc);
        await writeAtomic(files.vault, text);
        send(res, 200, { revision: sha256(text) });
      });
    },

    "GET /api/web/documents": async (req, res) => send(res, 200, await documents.list()),

    "POST /api/web/backup": async (req, res) => {
      const input = await json(req);
      const { data } = await serial(() =>
        createBackup({
          root: workspace,
          password: input?.password,
          appVersion: VERSION,
          platform: "web",
        }),
      );
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="zhiyu-web-${backupStamp()}.zhiyu-backup"`,
        "Cache-Control": "no-store",
      });
      res.end(data);
    },

    "POST /api/web/restore": async (req, res) => {
      const password = Buffer.from(
        String(req.headers["x-zhiyu-backup-password"] ?? ""),
        "base64",
      ).toString("utf8");
      const data = await body(req, RESTORE_LIMIT);
      const backup = await openBackup(data, password).catch((error) => {
        throw new HttpError(400, error.message);
      });
      const result = await serial(async () => {
        await stageRestore({ root: workspace, backup });
        const applied = await applyPendingRestore(workspace);
        documents = new DocumentsStore(join(workspace, "documents"));
        return applied;
      });
      send(res, 200, { ok: true, preview: backup.preview, files: result?.files ?? 0 });
    },
  };

  async function documentRoute(req, res, id) {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) throw new HttpError(400, "文档标识无效");
    if (req.method === "GET") return send(res, 200, await documents.get(id));
    if (req.method === "PUT") {
      const doc = await json(req);
      if (!doc || doc.id !== id) throw new HttpError(400, "文档标识不一致");
      return send(res, 200, await documents.save(doc));
    }
    if (req.method === "DELETE") {
      await documents.remove(id);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, "Method not allowed");
  }

  async function handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url ?? "/", "http://zhiyu.local");
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      // 改动类请求必须带自定义头，并且来源与站点一致：跨站页面无法伪造。
      if (req.method !== "GET") {
        if (req.headers["x-zhiyu"] !== "1") throw new HttpError(403, "请求被拒绝");
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host)
          throw new HttpError(403, "请求来源不一致");
      }
      const key = `${req.method} ${path}`;
      if (routes[key]) return routes[key](req, res);
      const session = sessionOf(req);
      if (!session) throw new HttpError(401, "请先登录");
      if (authed[key]) return authed[key](req, res, session);
      const doc = path.match(/^\/api\/web\/documents\/([^/]+)$/);
      if (doc) return documentRoute(req, res, decodeURIComponent(doc[1]));
      throw new HttpError(404, "Not found");
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "Method not allowed");
    if (["/login", "/login.css", "/login.js", "/favicon.svg"].includes(path)) {
      if (path === "/login" && sessionOf(req)) {
        res.writeHead(302, { Location: "/" });
        return res.end();
      }
      return serveStatic(res, join(HERE, "public"), path === "/login" ? "login.html" : path, {
        csp: "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
      });
    }
    if (!sessionOf(req)) {
      res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
      return res.end();
    }
    return serveStatic(res, staticDir, path);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log.error("request", req.method, req.url, error);
      if (res.headersSent) return res.end();
      send(res, status, { error: status === 500 ? "服务器出错了，请查看日志" : error.message });
    });
  });
  return {
    server,
    root,
    get setupToken() {
      return setupToken;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ZHIYU_PORT ?? 8848);
  const host = process.env.ZHIYU_HOST ?? "0.0.0.0";
  const { server, root } = await createWebServer();
  server.listen(port, host, () =>
    console.log(`[知屿] 网页版 ${VERSION} 已启动：http://${host}:${port}  资料目录 ${root}`),
  );
}
