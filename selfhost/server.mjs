/**
 * 知屿网页版（自托管）。
 *
 * 一个不依赖框架的 Node 服务：登录保护整站，资料文件与桌面版的资料目录完全相同
 * （assets.json、documents/、vault.enc），所以桌面版的加密备份可以直接恢复到这里，
 * 这里做的备份也能在桌面版恢复。密钥库在浏览器里用主密码加解密，服务器只保存密文。
 *
 * 目录：
 *   <ZHIYU_DATA>/workspace  资料（与桌面版资料目录一致，备份与恢复的范围）
 *   <ZHIYU_DATA>/server     网页登录账号与会话、服务器密钥（不进入备份，恢复时不受影响）
 *
 * 桌面版主进程里能在服务器上做的事（SSH、主机探测、Cloudflare、AI 助手……）见 bridge.mjs，
 * 服务所在主机自己的 CPU / 内存 / 磁盘 / 网络见 host-stats.mjs。
 */
import { createServer } from "node:http";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeSnapshotImages } from "../electron/services/image-data.mjs";
import { DocumentsStore } from "../electron/services/documents.mjs";
import { ReminderPushError, WebReminderPush } from "./reminder-push.mjs";
import { BridgeError, createWebBridge } from "./bridge.mjs";
import { HostStats } from "./host-stats.mjs";
import { SyncHttpError, createSyncHost } from "./sync.mjs";
import {
  LoginGuard,
  appendLog,
  base32Encode,
  hashRecovery,
  isKnownIp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  parseAllowedNets,
  shortAgent,
  verifyTotp,
} from "./security.mjs";
import { createServerSecureStorage } from "./secure-storage.mjs";
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
// 超过这么久没有任何操作的登录自动失效，丢在别处的浏览器不会一直有效。
const SESSION_IDLE_DAYS = 7;
const PUBLIC_BODY_LIMIT = 8 * 1024;
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
  fetchImpl = fetch,
  schedulePush = true,
  sampleHost = schedulePush,
  hostStats,
  syncLimits,
  allowedNets = process.env.ZHIYU_ALLOWED_NETS,
} = {}) {
  // 来源白名单写错时直接报错退出：不能因为手误把服务开放给所有人。
  const allowed = parseAllowedNets(allowedNets);
  const workspace = join(root, "workspace");
  const serverDir = join(root, "server");
  await mkdir(workspace, { recursive: true });
  await mkdir(serverDir, { recursive: true, mode: 0o700 });
  // 上次恢复中途退出时，先把暂存的恢复做完。
  await applyPendingRestore(workspace).catch((error) => log.error("restore:apply", error.message));

  const files = {
    account: join(serverDir, "account.json"),
    sessions: join(serverDir, "sessions.json"),
    securityLog: join(serverDir, "security-log.json"),
    token: join(serverDir, "setup-token.txt"),
    store: join(workspace, "assets.json"),
    vault: join(workspace, "vault.enc"),
  };
  let documents = new DocumentsStore(join(workspace, "documents"));
  const readSnapshotFile = async () => {
    const data = await readJson(files.store);
    return data?.state && typeof data.state === "object" ? data.state : (data ?? {});
  };
  // AI 助手与 Cloudflare 同步按同步接口读取资料，这里保留一份与 assets.json 一致的副本。
  let currentSnapshot = await readSnapshotFile().catch(() => ({}));
  // 浏览器关着时也按时推送续费与备忘提醒；凭据只存在 server 目录。
  const push = new WebReminderPush({
    dir: serverDir,
    fetchImpl,
    log,
    readSnapshot: readSnapshotFile,
  });
  const pushError = (error) => {
    throw error instanceof ReminderPushError ? new HttpError(400, error.message) : error;
  };
  // 服务器推送给已登录页面的事件：SSH 输出、AI 助手进度、服务器端改动了资料等。
  const streams = new Set();
  const emit = (channel, payload) => {
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const stream of streams) stream.res.write(frame);
  };
  /** 服务器自己改资料（Cloudflare 同步、AI 助手的修改建议）时，与浏览器保存走同一个队列。 */
  const mutateAssets = (mutate) =>
    serial(async () => {
      const raw = await readJson(files.store);
      const before = raw?.state && typeof raw.state === "object" ? raw.state : (raw ?? {});
      const next = mutate(before);
      await writeAtomic(
        files.store,
        JSON.stringify({ ...(raw ?? {}), state: next, version: raw?.version ?? 0 }),
      );
      currentSnapshot = next;
      emit("assets:changed", {});
      return { before, snapshot: next };
    });
  const monitor = hostStats ?? new HostStats({ dataDir: root });
  const stopSampling = sampleHost ? monitor.start() : () => {};
  const secureStorage = createServerSecureStorage(join(serverDir, "secure.key"));
  const bridge = createWebBridge({
    workspace,
    serverDir,
    root,
    version: VERSION,
    documents: () => documents,
    getSnapshot: () => currentSnapshot,
    mutateAssets,
    emit,
    secureStorage,
    fetchImpl,
    hostStats: monitor,
  });
  await bridge.clearDownloads().catch(() => {});
  if (schedulePush) bridge.startSchedules();
  let account = await readJson(files.account);
  const sessions = new Map(Object.entries((await readJson(files.sessions)) ?? {}));
  const guard = new LoginGuard();
  let securityLog = (await readJson(files.securityLog).catch(() => null)) ?? [];
  // 正在设置的两步验证密钥：确认验证码正确之前只在内存里，不落盘。
  let pendingTotp = null;
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
      seen: now,
      ip: clientIp(req),
      agent: shortAgent(req.headers["user-agent"]),
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
    const now = Date.now();
    if (
      !session ||
      session.expires < now ||
      now - (session.seen ?? session.created) > SESSION_IDLE_DAYS * 86_400_000 ||
      session.username !== account?.username
    )
      return null;
    // 活动时间每 10 分钟更新一次，避免每个请求都写文件。
    if (now - (session.seen ?? 0) > 600_000) {
      session.seen = now;
      persistSessions().catch(() => {});
    }
    return { key, ...session };
  }
  // 放在反向代理后面时取代理追加的最后一项：第一项是客户端自己填的，可以伪造来绕过限流和白名单。
  // 只支持一层代理（Caddy / Nginx）。
  // 只有来自本机或私网的连接（也就是同一台机器 / 同一个 Docker 网络里的反向代理）带来的
  // X-Forwarded-For 才可信；公网直连的人填什么都不算数。
  const proxyPeers = parseAllowedNets("private");
  const loopback = parseAllowedNets("127.0.0.0/8,::1");
  const clientIp = (req) => {
    const peer = req.socket.remoteAddress || "?";
    if (!trustProxy || !proxyPeers.allows(peer)) return peer;
    return (
      String(req.headers["x-forwarded-for"] ?? "")
        .split(",")
        .at(-1)
        .trim() || peer
    );
  };
  const secureRequest = (req) =>
    secureCookie ||
    Boolean(req.socket.encrypted) ||
    (trustProxy && req.headers["x-forwarded-proto"] === "https");
  /** 记一条登录或安全事件，供设置里查看；写盘失败不影响请求。 */
  function record(kind, req, extra = {}) {
    securityLog = appendLog(securityLog, {
      kind,
      ip: clientIp(req),
      agent: shortAgent(req.headers["user-agent"]),
      ...extra,
    });
    writeAtomic(files.securityLog, JSON.stringify(securityLog)).catch(() => {});
  }
  let lastFailureAlert = 0;
  /** 登录和首次设置共用：先检查限流（不进入昂贵的密码哈希），返回失败时要调用的记账函数。 */
  async function limitLogin(req) {
    const ip = clientIp(req);
    const gate = guard.check(ip);
    if (gate.blocked) {
      record("blocked", req, { reason: gate.reason });
      throw new HttpError(
        429,
        gate.reason === "ip" ? "尝试次数过多，请 15 分钟后再试" : "登录请求过于频繁，请稍后再试",
      );
    }
    const delay = guard.delayMs();
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return () => {
      const count = guard.fail(ip);
      // 同一来源连续失败达到 3 次就提醒一次，每小时最多一条，免得被刷屏。
      if (count >= 3 && Date.now() - lastFailureAlert > 3_600_000) {
        lastFailureAlert = Date.now();
        void push.notify(
          `有人在 ${ip} 反复尝试登录你的知屿网页版，已失败 ${count} 次。如果不是你，请检查访问来源限制和登录密码。`,
        );
      }
    };
  }

  /**
   * 第二因素：没开两步验证时直接通过；开启后接受验证码，或一次性的恢复码（用过即作废）。
   * `passwordOk` 为假时也照样比较一遍，响应一致，不泄露「密码是否正确」。
   */
  async function checkSecondFactor(code, passwordOk = true) {
    if (!account?.totp) return { ok: true };
    return serial(async () => {
      let secret;
      try {
        secret = Buffer.from(
          secureStorage.decryptString(Buffer.from(account.totp.secret, "base64")),
          "base64",
        );
      } catch {
        return { ok: false };
      }
      const verified = verifyTotp(secret, code, Date.now(), account.totp.lastStep ?? 0);
      if (verified.ok) {
        if (!passwordOk) return { ok: false };
        account.totp.lastStep = verified.step;
        await writeAtomic(files.account, JSON.stringify(account));
        return { ok: true };
      }
      const index = account.totp.recovery.indexOf(hashRecovery(code, account.totp.salt));
      if (index >= 0 && passwordOk) {
        account.totp.recovery.splice(index, 1);
        await writeAtomic(files.account, JSON.stringify(account));
        return { ok: true, recovery: true };
      }
      return { ok: false };
    });
  }
  /** 改安全设置前重新确认登录密码；错误同样计入登录限流。 */
  async function requirePassword(req, password) {
    const fail = await limitLogin(req);
    const hash = await hashPassword(
      String(password ?? ""),
      Buffer.from(account.salt, "base64"),
      account.kdf,
    );
    if (!timingSafeEqual(Buffer.from(hash), Buffer.from(account.hash))) {
      fail();
      throw new HttpError(403, "当前登录密码不正确");
    }
  }

  // 桌面端按 ZSP 协议配对与同步（docs/SYNC.md）；对外接口在 /api/sync/，不用登录 Cookie。
  const syncHost = createSyncHost({
    workspace,
    serverDir,
    secureStorage,
    version: VERSION,
    serial,
    writeAtomic,
    readJson,
    getDocuments: () => documents,
    normalizeAssets: (input) => normalizeSnapshotImages(input),
    validateVault: assertVaultDoc,
    onAssetsWritten: (state) => {
      currentSnapshot = state;
    },
    emit,
    log,
    clientIp,
    limits: syncLimits,
  });
  const syncGuard = (work) =>
    work().catch((error) => {
      if (error instanceof SyncHttpError) throw new HttpError(error.status, error.message);
      throw error;
    });

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
  async function json(req, limit = JSON_LIMIT) {
    try {
      return JSON.parse((await body(req, limit)).toString("utf8") || "null");
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
    // 未登录的人只能知道「要不要先设置」「要不要验证码」，不暴露用户名和版本号。
    "GET /api/web/state": async (req, res) => {
      const session = sessionOf(req);
      send(res, 200, {
        setup: !account,
        username: session?.username ?? null,
        totp: Boolean(account?.totp),
        ...(session ? { version: VERSION } : {}),
        insecure: !secureRequest(req),
      });
    },

    "POST /api/web/setup": async (req, res) => {
      const input = await json(req, PUBLIC_BODY_LIMIT);
      if (account) throw new HttpError(409, "账号已经创建，请直接登录");
      const fail = await limitLogin(req);
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
      record("setup", req);
      send(res, 200, { username });
    },

    "POST /api/web/login": async (req, res) => {
      const input = await json(req, PUBLIC_BODY_LIMIT);
      if (!account) throw new HttpError(409, "还没有创建账号");
      const fail = await limitLogin(req);
      const hash = await hashPassword(
        String(input?.password ?? ""),
        Buffer.from(account.salt, "base64"),
        account.kdf,
      );
      const passwordOk =
        typeof input?.username === "string" &&
        input.username.trim() === account.username &&
        timingSafeEqual(Buffer.from(hash), Buffer.from(account.hash));
      // 开了两步验证时，密码和验证码都要对；密码错误时也照样走一遍验证，响应一致。
      const second = await checkSecondFactor(input?.code, passwordOk);
      if (!passwordOk || !second.ok) {
        fail();
        record("fail", req, { reason: !passwordOk ? "password" : "code" });
        await new Promise((r) => setTimeout(r, 400));
        throw new HttpError(
          401,
          account.totp ? "用户名、密码或验证码不正确" : "用户名或密码不正确",
        );
      }
      const knownIp = isKnownIp(securityLog, clientIp(req));
      guard.success(clientIp(req));
      await newSession(res, req, account.username);
      record("login", req, second.recovery ? { recovery: true } : {});
      if (!knownIp)
        void push.notify(
          `你的知屿网页版有一次来自新地址 ${clientIp(req)} 的登录${second.recovery ? "（使用了恢复码）" : ""}。如果不是你，请在「设置 → 个人资料 → 账号安全」里退出所有设备并修改密码。`,
        );
      send(res, 200, { username: account.username });
    },

    "POST /api/web/logout": async (req, res) => {
      const session = sessionOf(req);
      if (session) {
        record("logout", req);
        sessions.delete(session.key);
        await persistSessions();
        dropStreams();
      }
      res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      send(res, 200, { ok: true });
    },
  };

  const authed = {
    "GET /api/web/session": async (req, res, session) =>
      send(res, 200, { username: session.username, version: VERSION }),

    "GET /api/web/push": async (req, res) => send(res, 200, await push.config()),
    "PUT /api/web/push": async (req, res) =>
      send(res, 200, await push.save(await json(req)).catch(pushError)),
    "POST /api/web/push/test": async (req, res) =>
      send(res, 200, await push.test().catch(pushError)),

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
      dropStreams();
      record("password", req);
      send(res, 200, { ok: true });
    },

    "GET /api/web/security": async (req, res, session) => {
      const now = Date.now();
      send(res, 200, {
        totp: { enabled: Boolean(account.totp), recoveryLeft: account.totp?.recovery.length ?? 0 },
        sessions: [...sessions.entries()]
          .filter(([, item]) => item.username === account.username && item.expires > now)
          .map(([key, item]) => ({
            id: key.slice(0, 12),
            current: key === session.key,
            ip: item.ip ?? "",
            agent: item.agent ?? "",
            createdAt: new Date(item.created).toISOString(),
            seenAt: new Date(item.seen ?? item.created).toISOString(),
          }))
          .sort((a, b) => b.seenAt.localeCompare(a.seenAt)),
        log: securityLog.slice(0, 50),
        encrypted: secureRequest(req),
        allowlist: allowed.empty ? null : allowed.entries,
        recentFailures: guard.recentFailures,
      });
    },

    "POST /api/web/totp/start": async (req, res) => {
      const input = await json(req, PUBLIC_BODY_LIMIT);
      await requirePassword(req, input?.password);
      if (account.totp) throw new HttpError(409, "两步验证已经开启");
      const secret = newTotpSecret();
      pendingTotp = { secret, expires: Date.now() + 10 * 60_000 };
      send(res, 200, {
        secret: base32Encode(secret),
        uri: otpauthUri({ secret, account: account.username }),
      });
    },

    "POST /api/web/totp/enable": async (req, res) => {
      const input = await json(req, PUBLIC_BODY_LIMIT);
      if (!pendingTotp || pendingTotp.expires < Date.now())
        throw new HttpError(409, "请先点「开启两步验证」获取密钥");
      const fail = await limitLogin(req);
      const verified = verifyTotp(pendingTotp.secret, input?.code);
      if (!verified.ok) {
        fail();
        throw new HttpError(400, "验证码不正确，请核对手机上的时间和刚才扫描的密钥");
      }
      const salt = randomBytes(16).toString("base64");
      const codes = newRecoveryCodes();
      account = {
        ...account,
        totp: {
          secret: secureStorage
            .encryptString(pendingTotp.secret.toString("base64"))
            .toString("base64"),
          enabledAt: new Date().toISOString(),
          lastStep: verified.step,
          salt,
          recovery: codes.map((code) => hashRecovery(code, salt)),
        },
      };
      pendingTotp = null;
      await writeAtomic(files.account, JSON.stringify(account));
      record("totp-on", req);
      send(res, 200, { recovery: codes });
    },

    "POST /api/web/totp/disable": async (req, res) => {
      const input = await json(req, PUBLIC_BODY_LIMIT);
      await requirePassword(req, input?.password);
      if (!account.totp) return send(res, 200, { ok: true });
      const second = await checkSecondFactor(input?.code, true);
      if (!second.ok) throw new HttpError(403, "验证码或恢复码不正确");
      const { totp: _removed, ...rest } = account;
      account = rest;
      await writeAtomic(files.account, JSON.stringify(account));
      record("totp-off", req);
      send(res, 200, { ok: true });
    },

    "POST /api/web/sessions/revoke": async (req, res, session) => {
      const input = await json(req, PUBLIC_BODY_LIMIT);
      const id = String(input?.id ?? "");
      const matches = [...sessions.keys()].filter(
        (key) => /^[0-9a-f]{12}$/.test(id) && key.startsWith(id),
      );
      if (matches.length !== 1) throw new HttpError(404, "没有这个登录设备");
      if (matches[0] === session.key) throw new HttpError(400, "这是当前设备，请用「退出登录」");
      sessions.delete(matches[0]);
      await persistSessions();
      dropStreams();
      record("revoke", req);
      send(res, 200, { ok: true });
    },

    "POST /api/web/sessions/revoke-others": async (req, res, session) => {
      for (const key of [...sessions.keys()]) if (key !== session.key) sessions.delete(key);
      await persistSessions();
      dropStreams();
      record("revoke-others", req);
      send(res, 200, { ok: true });
    },

    "GET /api/web/sync": async (req, res) =>
      send(res, 200, await syncGuard(() => syncHost.owner.info())),
    "POST /api/web/sync/pairing": async (req, res) =>
      send(res, 200, await syncGuard(() => syncHost.owner.createPairing())),
    "POST /api/web/sync/pairing/cancel": async (req, res) => {
      syncHost.owner.cancelPairing();
      send(res, 200, { ok: true });
    },
    "POST /api/web/sync/revoke": async (req, res) => {
      const input = await json(req);
      await syncGuard(() => syncHost.owner.revoke(String(input?.id ?? "")));
      send(res, 200, { ok: true });
    },
    "POST /api/web/sync/remove": async (req, res) => {
      const input = await json(req);
      await syncGuard(() => syncHost.owner.remove(String(input?.id ?? "")));
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
        currentSnapshot =
          normalized?.state && typeof normalized.state === "object" ? normalized.state : normalized;
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

    /** 与桌面版 preload 同名的频道；只放行 bridge.mjs 里列出的方法。 */
    "POST /api/web/rpc": async (req, res) => {
      const input = await json(req);
      if (typeof input?.channel !== "string") throw new HttpError(400, "请求格式不正确");
      try {
        send(res, 200, { data: (await bridge.call(input.channel, input.args)) ?? null });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (!(error instanceof BridgeError)) log.error("rpc", input.channel, error?.message);
        throw new HttpError(400, String(error?.message ?? error));
      }
    },

    "GET /api/web/events": async (req, res, session) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        // Nginx 默认会缓冲响应，SSE 需要关掉。
        "X-Accel-Buffering": "no",
      });
      res.write(": ok\n\n");
      const stream = { res, key: session.key };
      streams.add(stream);
      const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
      beat.unref?.();
      req.on("close", () => {
        clearInterval(beat);
        streams.delete(stream);
      });
    },

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
        // 备份里带着明文的系统加密凭据时，改用这台服务器的密钥重新加密。
        await stageRestore({ root: workspace, backup, secureStorage });
        const applied = await applyPendingRestore(workspace);
        documents = new DocumentsStore(join(workspace, "documents"));
        currentSnapshot = await readSnapshotFile().catch(() => ({}));
        emit("assets:changed", {});
        return applied;
      });
      send(res, 200, { ok: true, preview: backup.preview, files: result?.files ?? 0 });
    },
  };

  /** 退出登录或改密后，已失效会话的事件流也一并断开。 */
  function dropStreams() {
    for (const stream of streams)
      if (!sessions.has(stream.key)) {
        streams.delete(stream);
        stream.res.end();
      }
  }

  async function downloadRoute(res, ticket) {
    const entry = await bridge.takeDownload(ticket);
    if (!entry) throw new HttpError(404, "下载链接已失效");
    try {
      const data = await readFile(entry.file);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        "Cache-Control": "no-store",
      });
      res.end(data);
    } finally {
      await rm(entry.file, { force: true });
    }
  }

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
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    // 不让搜索引擎收录，也不让登录页出现在公开索引里。
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (secureRequest(req)) res.setHeader("Strict-Transport-Security", "max-age=31536000");
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
      if (path.startsWith("/api/sync/")) {
        if (await syncHost.handle(req, res)) return;
        throw new HttpError(404, "Not found");
      }
      const key = `${req.method} ${path}`;
      if (routes[key]) return routes[key](req, res);
      const session = sessionOf(req);
      if (!session) throw new HttpError(401, "请先登录");
      if (authed[key]) return authed[key](req, res, session);
      const download = path.match(/^\/api\/web\/download\/([A-Za-z0-9_-]{20,})$/);
      if (download && req.method === "GET") return downloadRoute(res, download[1]);
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
    // 不在白名单里的来源：直接断开，不回任何内容；端口扫描只会看到一个什么都不说的服务。
    // 本机进程（容器自己的健康检查）直连、且没有经过代理时始终放行，免得白名单把自己锁在外面。
    const localProbe = loopback.allows(req.socket.remoteAddress) && !req.headers["x-forwarded-for"];
    if (!localProbe && !allowed.allows(clientIp(req))) {
      req.socket.destroy();
      return;
    }
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log.error("request", req.method, req.url, error);
      if (res.headersSent) return res.end();
      send(res, status, { error: status === 500 ? "服务器出错了，请查看日志" : error.message });
    });
  });
  // 慢速攻击：请求头必须在 20 秒内发完。
  server.headersTimeout = 20_000;
  server.maxHeadersCount = 100;
  if (schedulePush) server.on("close", push.start());
  server.on("close", () => {
    syncHost.stop();
    stopSampling();
    bridge.stop();
    for (const stream of streams) stream.res.end();
    streams.clear();
  });
  return {
    server,
    root,
    push,
    sync: syncHost,
    security: { allowlist: allowed.entries, secureCookie, trustProxy },
    bridge,
    hostStats: monitor,
    get setupToken() {
      return setupToken;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ZHIYU_PORT ?? 8848);
  const host = process.env.ZHIYU_HOST ?? "0.0.0.0";
  const { server, root, security } = await createWebServer();
  server.listen(port, host, () => {
    console.log(`[知屿] 网页版 ${VERSION} 已启动：http://${host}:${port}  资料目录 ${root}`);
    const exposed = !/^(127\.|localhost|::1)/.test(host);
    if (exposed && !security.secureCookie && !security.allowlist.length)
      console.log(
        "[知屿] 安全提示：现在是明文 HTTP，并且任何来源都能访问登录页。放到公网前请用 HTTPS（docker-compose.https.yml），或用 ZHIYU_ALLOWED_NETS 只允许自己的 IP / VPN；并在「设置 → 个人资料 → 账号安全」里开启两步验证。详见 docs/WEB.md「安全加固」。",
      );
  });
}
