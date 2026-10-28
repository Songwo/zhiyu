/**
 * 网页版的同步主机：接受桌面端按 ZSP 协议配对与同步（协议见 docs/SYNC.md）。
 *
 * 这个模块只做认证、传输和「比较后写入」，不做合并——合并发生在持有基线的桌面端。
 * 对外的 HTTP 接口都在 /api/sync/ 下，不使用登录 Cookie：身份来自配对时固定的设备公钥。
 * 生成配对码、查看和撤销设备这些主人操作由 server.mjs 里已登录的接口调用本模块的方法。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ZspError,
  b64u,
  deviceIdOf,
  equalBytes,
  exportIdentity,
  fingerprint,
  formatPairCode,
  generateIdentity,
  generatePairCode,
  importIdentity,
  manifestDigest,
  pairChannel,
  pairDeviceMessage,
  pairRespond,
  pairServerMessage,
  pairTag,
  sessionServerRespond,
  sessionServerVerify,
  signManifest,
  signWith,
  unb64u,
  verifyWith,
} from "../electron/services/sync-crypto.mjs";
import {
  hashAssetsFile,
  hashDocumentFile,
  hashVaultFile,
} from "../electron/services/sync-hash.mjs";

export const SYNC_PAIR_TTL = 5 * 60_000;
const PAIR_SESSION_TTL = 30_000;
const MAX_PAIR_SESSIONS = 4;
const MAX_PAIR_EXCHANGES = 8;
const MAX_PAIR_FAILURES = 3;
const SESSION_TTL = 15 * 60_000;
const SESSION_IDLE = 5 * 60_000;
const MAX_SESSIONS = 16;
const MAX_MESSAGES = 50_000;
const MAX_DEVICES = 10;
const MAX_FILE = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const BODY_LIMIT = 4 * 1024 * 1024;
const MAX_EVENTS = 100;
const FAIL_LIMIT = 10;
const FAIL_WINDOW = 15 * 60_000;

const DOCUMENT_PATH = /^documents\/(doc-[a-zA-Z0-9-]{1,80})\.json$/;
/** 只有这三类文件参与同步；系统加密保存的凭据文件永远不在其中。 */
export const isSyncPath = (path) =>
  path === "assets.json" ||
  path === "vault.enc" ||
  (typeof path === "string" && DOCUMENT_PATH.test(path));

export class SyncHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
  }
}

export function createSyncHost({
  workspace,
  serverDir,
  secureStorage,
  version,
  serial,
  writeAtomic,
  readJson,
  getDocuments,
  normalizeAssets,
  validateVault,
  onAssetsWritten,
  emit = () => {},
  log = console,
  clientIp = (req) => req.socket.remoteAddress ?? "?",
  now = Date.now,
  limits = {},
}) {
  const maxPairSessions = limits.pairSessions ?? MAX_PAIR_SESSIONS;
  const files = {
    identity: join(serverDir, "sync-identity.json"),
    devices: join(serverDir, "sync-devices.json"),
    state: join(serverDir, "sync-state.json"),
    assets: join(workspace, "assets.json"),
    vault: join(workspace, "vault.enc"),
  };
  let identity = null;
  let devices = [];
  let state = { v: 1, seq: 0, digest: "", events: [] };
  let pairing = null;
  const pairSessions = new Map();
  const sessions = new Map();
  const failures = new Map();
  const hashCache = new Map();
  const ready = (async () => {
    await mkdir(serverDir, { recursive: true, mode: 0o700 });
    const stored = await readJson(files.identity);
    if (stored?.key) {
      identity = importIdentity(
        Buffer.from(secureStorage.decryptString(Buffer.from(stored.key, "base64")), "base64"),
      );
    } else {
      identity = generateIdentity();
      await writeAtomic(
        files.identity,
        JSON.stringify({
          v: 1,
          createdAt: new Date(now()).toISOString(),
          key: secureStorage
            .encryptString(exportIdentity(identity).toString("base64"))
            .toString("base64"),
        }),
      );
    }
    devices = (await readJson(files.devices))?.devices ?? [];
    const saved = await readJson(files.state);
    if (saved && Number.isSafeInteger(saved.seq)) state = { ...state, ...saved };
  })();

  const persistDevices = () => writeAtomic(files.devices, JSON.stringify({ v: 1, devices }));
  const persistState = () => writeAtomic(files.state, JSON.stringify(state));
  function addEvent(kind, detail = {}) {
    // 自动同步每隔几分钟一次，同一台设备 30 分钟内只留一条，免得把真正要看的记录刷掉。
    const last = state.events[0];
    if (
      kind === "sync" &&
      last?.kind === "sync" &&
      last.device === detail.device &&
      now() - Date.parse(last.at) < 30 * 60_000
    ) {
      last.at = new Date(now()).toISOString();
      persistState().catch((error) => log.error("sync:state", error.message));
      return;
    }
    state.events = [{ at: new Date(now()).toISOString(), kind, ...detail }, ...state.events].slice(
      0,
      MAX_EVENTS,
    );
    persistState().catch((error) => log.error("sync:state", error.message));
  }

  function limited(req) {
    const ip = clientIp(req);
    const at = now();
    const list = (failures.get(ip) ?? []).filter((time) => at - time < FAIL_WINDOW);
    failures.set(ip, list);
    if (list.length >= FAIL_LIMIT) throw new SyncHttpError(429, "尝试次数过多，请稍后再试");
    return () => {
      list.push(now());
      failures.set(ip, list);
    };
  }
  const publicDevice = (device) => ({
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt ?? null,
    revokedAt: device.revokedAt ?? null,
  });

  // ———— 主人操作（由已登录的网页接口调用） ————

  const owner = {
    async info() {
      await ready;
      return {
        fingerprint: fingerprint(identity.publicKey),
        devices: devices.map(publicDevice),
        pairing: pairing && pairing.expiresAt > now() ? { expiresAt: pairing.expiresAt } : null,
        events: state.events,
      };
    },
    async createPairing() {
      await ready;
      if (devices.filter((d) => !d.revokedAt).length >= MAX_DEVICES)
        throw new SyncHttpError(409, `最多配对 ${MAX_DEVICES} 台设备，请先撤销不用的设备`);
      const code = generatePairCode();
      pairing = { code, expiresAt: now() + SYNC_PAIR_TTL, failures: 0, exchanges: 0 };
      pairSessions.clear();
      addEvent("pairing-created");
      return {
        code: formatPairCode(code),
        expiresAt: pairing.expiresAt,
        fingerprint: fingerprint(identity.publicKey),
      };
    },
    cancelPairing() {
      if (pairing) addEvent("pairing-cancelled");
      pairing = null;
      pairSessions.clear();
    },
    async revoke(id) {
      await ready;
      const device = devices.find((d) => d.id === id);
      if (!device) throw new SyncHttpError(404, "没有这台设备");
      if (!device.revokedAt) {
        device.revokedAt = new Date(now()).toISOString();
        await persistDevices();
        addEvent("device-revoked", { device: device.name });
      }
      for (const [sid, session] of sessions) if (session.device.id === id) sessions.delete(sid);
    },
    async remove(id) {
      await ready;
      devices = devices.filter((d) => d.id !== id);
      await persistDevices();
      for (const [sid, session] of sessions) if (session.device.id === id) sessions.delete(sid);
    },
  };

  // ———— 配对 ————

  function pairingLive() {
    if (!pairing || pairing.expiresAt <= now()) {
      pairing = null;
      throw new SyncHttpError(403, "没有可用的配对码，或配对码已过期。请在网页版重新生成");
    }
    return pairing;
  }
  function sweepPairSessions() {
    const at = now();
    for (const [sid, session] of pairSessions)
      if (at - session.at > PAIR_SESSION_TTL) pairSessions.delete(sid);
  }

  const pair = {
    async start(req) {
      await ready;
      const fail = limited(req);
      try {
        pairingLive();
      } catch (error) {
        fail();
        throw error;
      }
      sweepPairSessions();
      if (pairSessions.size >= maxPairSessions)
        throw new SyncHttpError(429, "正在处理其他配对请求，请稍后再试");
      const sid = randomBytes(16);
      pairSessions.set(b64u(sid), { at: now(), sid, step: "started" });
      return { sid: b64u(sid) };
    },
    async exchange(req, input) {
      await ready;
      const live = pairingLive();
      const session = pairSessions.get(String(input?.sid));
      if (!session || session.step !== "started") throw new SyncHttpError(400, "配对会话无效");
      // 每个配对码的密钥交换次数有上限，无论成败：不给在线猜测留下计数之外的空间。
      if (++live.exchanges > MAX_PAIR_EXCHANGES) {
        pairing = null;
        pairSessions.clear();
        addEvent("pairing-exhausted");
        throw new SyncHttpError(403, "配对尝试次数过多，配对码已作废，请重新生成");
      }
      try {
        const Ya = unb64u(input.Ya, 32, "客户端的点");
        const result = pairRespond(live.code, session.sid, Ya);
        Object.assign(session, { step: "exchanged", keys: result, Ya, Yb: result.Yb });
        return { Yb: b64u(result.Yb) };
      } catch (error) {
        pairSessions.delete(String(input.sid));
        throw error instanceof ZspError ? new SyncHttpError(400, "配对请求无效") : error;
      }
    },
    async finish(req, input) {
      await ready;
      const fail = limited(req);
      const live = pairingLive();
      const key = String(input?.sid);
      const session = pairSessions.get(key);
      if (!session || session.step !== "exchanged") throw new SyncHttpError(400, "配对会话无效");
      pairSessions.delete(key);
      const { keys, Ya, Yb, sid } = session;
      let tagC;
      try {
        tagC = unb64u(input.tag, 32, "确认标签");
      } catch {
        throw new SyncHttpError(400, "配对请求无效");
      }
      if (!equalBytes(tagC, pairTag(keys.kC, "C", sid, Ya, Yb))) {
        fail();
        live.failures += 1;
        addEvent("pairing-failed", { count: live.failures });
        if (live.failures >= MAX_PAIR_FAILURES) {
          pairing = null;
          pairSessions.clear();
          addEvent("pairing-exhausted");
        }
        throw new SyncHttpError(403, "配对码不正确");
      }
      const channel = pairChannel(keys, "server", sid, Ya, Yb);
      let info;
      try {
        info = JSON.parse(
          channel
            .open(Number(input.counter), unb64u(input.data, undefined, "身份"))
            .toString("utf8"),
        );
        const devicePub = unb64u(info.pub, 32, "设备公钥");
        const signature = unb64u(info.sig, 64, "设备签名");
        if (!verifyWith(devicePub, pairDeviceMessage(sid, Ya, Yb, devicePub), signature))
          throw new ZspError("设备签名无效");
        info.devicePub = devicePub;
      } catch {
        throw new SyncHttpError(400, "配对请求无效");
      }
      const name =
        [...String(info.name ?? "桌面端")]
          .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
          .join("")
          .trim()
          .slice(0, 60) || "桌面端";
      const id = deviceIdOf(info.devicePub);
      devices = devices.filter((d) => d.id !== id);
      devices.push({
        id,
        name,
        publicKey: b64u(info.devicePub),
        createdAt: new Date(now()).toISOString(),
      });
      await persistDevices();
      pairing = null;
      pairSessions.clear();
      addEvent("paired", { device: name });
      const sigS = signWith(
        identity,
        pairServerMessage(sid, Ya, Yb, identity.publicKey, info.devicePub),
      );
      const reply = channel.seal(
        Buffer.from(
          JSON.stringify({
            pub: b64u(identity.publicKey),
            sig: b64u(sigS),
            deviceId: id,
            fingerprint: fingerprint(identity.publicKey),
          }),
        ),
      );
      return {
        tag: b64u(pairTag(keys.kS, "S", sid, Ya, Yb)),
        counter: reply.counter,
        data: b64u(reply.data),
      };
    },
  };

  // ———— 会话 ————

  function sweepSessions() {
    const at = now();
    for (const [sid, session] of sessions)
      if (at - session.created > SESSION_TTL || at - session.touched > SESSION_IDLE)
        sessions.delete(sid);
  }
  const session = {
    async start(req, input) {
      await ready;
      const fail = limited(req);
      const id = String(input?.dev ?? "");
      const device = devices.find((d) => d.id === id && !d.revokedAt);
      if (!device) {
        fail();
        throw new SyncHttpError(401, "这台设备没有配对或已被撤销");
      }
      sweepSessions();
      if (sessions.size >= MAX_SESSIONS) throw new SyncHttpError(429, "同步会话过多，请稍后再试");
      let result;
      try {
        result = sessionServerRespond({
          message: input,
          device: { id: device.id, publicKey: unb64u(device.publicKey, 32) },
          serverIdentity: identity,
        });
      } catch {
        fail();
        throw new SyncHttpError(400, "同步请求无效");
      }
      const sid = b64u(randomBytes(16));
      sessions.set(sid, {
        device,
        state: result.state,
        channel: null,
        created: now(),
        touched: now(),
        messages: 0,
        upload: null,
      });
      return { sid, ...result.reply };
    },
    async auth(req, input) {
      await ready;
      const fail = limited(req);
      const entry = sessions.get(String(input?.sid));
      if (!entry || entry.channel) throw new SyncHttpError(400, "会话无效");
      try {
        entry.channel = sessionServerVerify({
          state: entry.state,
          auth: { counter: Number(input.counter), data: unb64u(input.data, undefined, "认证") },
        });
      } catch {
        sessions.delete(String(input.sid));
        fail();
        throw new SyncHttpError(401, "设备身份验证失败");
      }
      entry.touched = now();
      entry.device.lastSeenAt = new Date(now()).toISOString();
      addEvent("sync", { device: entry.device.name });
      persistDevices().catch(() => {});
      return { ok: true };
    },
    async message(req, input) {
      await ready;
      const key = String(input?.sid);
      const entry = sessions.get(key);
      if (!entry?.channel) throw new SyncHttpError(400, "会话无效");
      if (
        entry.device.revokedAt ||
        now() - entry.created > SESSION_TTL ||
        ++entry.messages > MAX_MESSAGES
      ) {
        sessions.delete(key);
        throw new SyncHttpError(401, "会话已失效，请重新连接");
      }
      let request;
      try {
        request = JSON.parse(
          entry.channel
            .open(Number(input.counter), unb64u(input.data, undefined, "消息"))
            .toString("utf8"),
        );
      } catch {
        // 重放、篡改或乱序：销毁会话，不给对方继续试探的机会。
        sessions.delete(key);
        throw new SyncHttpError(400, "消息无效，会话已关闭");
      }
      entry.touched = now();
      let response;
      try {
        response = { ok: true, ...(await operate(entry, request)) };
      } catch (error) {
        response = {
          ok: false,
          code: error?.code ?? "error",
          error:
            error instanceof SyncOpError || error instanceof SyncHttpError
              ? error.message
              : "服务器处理失败",
        };
        if (!(error instanceof SyncOpError)) log.error("sync:op", request?.op, error?.message);
      }
      const sealed = entry.channel.seal(Buffer.from(JSON.stringify(response)));
      return { counter: sealed.counter, data: b64u(sealed.data) };
    },
    end(input) {
      sessions.delete(String(input?.sid));
      return { ok: true };
    },
  };

  // ———— 文件与清单 ————

  class SyncOpError extends Error {
    constructor(message, code = "op") {
      super(message);
      this.code = code;
    }
  }

  async function currentContent(path) {
    const file = join(workspace, path);
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!info.isFile() || info.size > MAX_FILE)
      throw new SyncOpError("文件无法同步", "unsupported");
    const cacheKey = `${path}:${info.mtimeMs}:${info.size}`;
    const cached = hashCache.get(path);
    if (cached?.key === cacheKey)
      return { ...cached.value, mtimeMs: info.mtimeMs, size: info.size };
    const raw = await readFile(file);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new SyncOpError(`${path} 不是有效的 JSON`, "unsupported");
    }
    const value = { hash: contentHash(path, parsed) };
    hashCache.set(path, { key: cacheKey, value });
    return { ...value, mtimeMs: info.mtimeMs, size: info.size };
  }
  function contentHash(path, parsed) {
    if (path === "assets.json") return hashAssetsFile(parsed);
    if (path === "vault.enc") return hashVaultFile(parsed);
    return hashDocumentFile(parsed);
  }

  async function buildManifest() {
    const out = {};
    const add = async (path) => {
      const content = await currentContent(path);
      if (content) out[path] = { h: content.hash, n: content.size, m: Math.round(content.mtimeMs) };
    };
    await add("assets.json");
    await add("vault.enc");
    const names = await readdir(join(workspace, "documents")).catch(() => []);
    for (const name of names.sort())
      if (/^doc-[a-zA-Z0-9-]{1,80}\.json$/.test(name))
        await add(`documents/${name}`).catch(() => {});
    const digest = manifestDigest(out);
    const digestText = b64u(digest);
    if (digestText !== state.digest) {
      state.seq += 1;
      state.digest = digestText;
      await persistState();
    }
    return {
      seq: state.seq,
      files: out,
      digest: digestText,
      sig: b64u(signManifest(identity, state.seq, digest)),
    };
  }

  function requirePath(path) {
    if (!isSyncPath(path)) throw new SyncOpError("这个文件不参与同步", "path");
    return path;
  }

  async function operate(entry, request) {
    switch (request?.op) {
      case "info":
        return { version, serverTime: new Date(now()).toISOString(), name: entry.device.name };
      case "manifest":
        return serial(buildManifest);
      case "read": {
        const path = requirePath(request.path);
        const offset = Number(request.offset ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new SyncOpError("读取位置无效");
        return serial(async () => {
          let raw;
          try {
            raw = await readFile(join(workspace, path));
          } catch (error) {
            if (error.code === "ENOENT") return { missing: true };
            throw error;
          }
          if (raw.length > MAX_FILE) throw new SyncOpError("文件过大", "too-large");
          const part = raw.subarray(offset, offset + CHUNK);
          return { size: raw.length, data: b64u(part), eof: offset + part.length >= raw.length };
        });
      }
      case "unpair": {
        // 桌面端主动解除配对：直接从设备列表里移除，不留撤销记录。
        const name = entry.device.name;
        await owner.remove(entry.device.id);
        addEvent("device-unpaired", { device: name });
        return {};
      }
      case "writeBegin": {
        const path = requirePath(request.path);
        const size = Number(request.size);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE)
          throw new SyncOpError("文件大小无效", "too-large");
        entry.upload = {
          path,
          expect: request.expect ?? null,
          size,
          sha: String(request.sha ?? ""),
          chunks: [],
          received: 0,
        };
        return { chunk: CHUNK };
      }
      case "writeChunk": {
        const upload = entry.upload;
        if (!upload) throw new SyncOpError("没有进行中的上传");
        const bytes = unb64u(request.data, undefined, "数据块");
        if (bytes.length > CHUNK || upload.received + bytes.length > upload.size)
          throw new SyncOpError("数据块超出声明的大小", "too-large");
        upload.chunks.push(bytes);
        upload.received += bytes.length;
        return {};
      }
      case "writeCommit": {
        const upload = entry.upload;
        entry.upload = null;
        if (!upload || upload.received !== upload.size) throw new SyncOpError("上传不完整");
        const raw = Buffer.concat(upload.chunks);
        if (createHash("sha256").update(raw).digest("hex") !== upload.sha)
          throw new SyncOpError("上传内容校验失败", "checksum");
        return serial(() => commit(entry, upload, raw));
      }
      case "remove": {
        const path = requirePath(request.path);
        const match = DOCUMENT_PATH.exec(path);
        if (!match) throw new SyncOpError("只能删除文档", "path");
        return serial(async () => {
          const current = await currentContent(path);
          if (!current) return { removed: false };
          if (current.hash !== request.expect)
            throw new SyncOpError("文件已在网页版更新", "conflict");
          await getDocuments().remove(match[1]);
          hashCache.delete(path);
          emit("documents:changed", { removedId: match[1] });
          return { removed: true };
        });
      }
      default:
        throw new SyncOpError("不支持的操作", "unsupported");
    }
  }

  async function commit(entry, upload, raw) {
    const { path } = upload;
    const current = await currentContent(path);
    if ((current?.hash ?? null) !== upload.expect)
      throw new SyncOpError("文件已在网页版更新，请重新同步", "conflict");
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new SyncOpError("内容不是有效的 JSON", "invalid");
    }
    let hash;
    if (path === "assets.json") {
      const wrapped =
        parsed?.state && typeof parsed.state === "object" ? parsed : { state: parsed, version: 0 };
      let normalized;
      try {
        normalized = normalizeAssets(wrapped);
      } catch (error) {
        throw new SyncOpError(error.message, "invalid");
      }
      await writeAtomic(files.assets, JSON.stringify(normalized));
      onAssetsWritten(normalized.state);
      emit("assets:changed", {});
      hash = hashAssetsFile(normalized);
    } else if (path === "vault.enc") {
      try {
        validateVault(parsed);
      } catch (error) {
        throw new SyncOpError(error.message, "invalid");
      }
      await writeAtomic(files.vault, JSON.stringify(parsed));
      hash = hashVaultFile(parsed);
    } else {
      const id = DOCUMENT_PATH.exec(path)[1];
      if (parsed?.id !== id) throw new SyncOpError("文档标识不一致", "invalid");
      let saved;
      try {
        saved = await getDocuments().save(parsed);
      } catch (error) {
        throw new SyncOpError(error.message, "invalid");
      }
      emit("documents:changed", { document: saved });
      hash = hashDocumentFile(saved);
    }
    hashCache.delete(path);
    return { h: hash };
  }

  // ———— HTTP ————

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new SyncHttpError(413, "请求内容过大");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    } catch {
      throw new SyncHttpError(400, "请求格式不正确");
    }
  }
  const routes = {
    "POST /api/sync/pair/start": pair.start,
    "POST /api/sync/pair/exchange": pair.exchange,
    "POST /api/sync/pair/finish": pair.finish,
    "POST /api/sync/session/start": session.start,
    "POST /api/sync/session/auth": session.auth,
    "POST /api/sync/session/message": session.message,
    "POST /api/sync/session/end": (req, input) => session.end(input),
  };
  /** 返回 true 表示这个请求属于同步接口且已处理。 */
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://zhiyu.local");
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return false;
    const send = (status, payload) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(payload));
    };
    try {
      send(200, await route(req, await readBody(req)));
    } catch (error) {
      if (error instanceof SyncHttpError) send(error.status, { error: error.message });
      else {
        log.error("sync", url.pathname, error?.message);
        send(500, { error: "服务器出错了，请查看日志" });
      }
    }
    return true;
  }

  return {
    handle,
    ready,
    owner,
    get publicKey() {
      return identity?.publicKey;
    },
    stop() {
      sessions.clear();
      pairSessions.clear();
      pairing = null;
    },
    /** 仅供测试：当前会话数。 */
    get sessionCount() {
      return sessions.size;
    },
    id: randomUUID(),
  };
}
