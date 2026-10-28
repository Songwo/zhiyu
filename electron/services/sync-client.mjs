/**
 * 桌面端的同步客户端：与网页版按 ZSP 协议配对、认证并同步资产、文档和（可选的）密钥库。
 * 协议与威胁模型见 docs/SYNC.md。合并在这里做，因为只有这一端持有「上次同步后的基线」；
 * 服务器只做认证、传输和比较后写入。
 *
 * 数据通过 adapters 读写，这样主进程可以接到真实的存储，测试可以接到内存。
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  ZspError,
  b64u,
  deviceIdOf,
  equalBytes,
  exportIdentity,
  fingerprint,
  generateIdentity,
  importIdentity,
  manifestDigest,
  pairChannel,
  pairDeviceMessage,
  pairInitiate,
  pairServerMessage,
  pairTag,
  sessionClientFinish,
  sessionClientStart,
  signWith,
  unb64u,
  verifyManifest,
  verifyWith,
} from "./sync-crypto.mjs";
import { hashAssetsFile, hashDocumentFile, hashVaultFile } from "./sync-hash.mjs";
import { mergeAssets, mergeDocument, mergeVault } from "./sync-merge.mjs";

const CHUNK = 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const REQUEST_TIMEOUT = 30_000;
const MAX_ROUNDS = 4;
const LOG_LIMIT = 60;
const INTERVAL = 2 * 60_000;
const DEBOUNCE = 5_000;
const SCOPES = ["assets", "documents", "vault"];
const DEFAULT_SCOPE = { assets: true, documents: true, vault: false };

export class SyncError extends Error {
  constructor(message, code = "sync") {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}
/** 本轮需要重来（本机或服务器在同步中途变了）。 */
class Retry extends Error {}

export function normalizeServerUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    throw new SyncError("服务器地址格式不正确，例如 https://zhiyu.example.com");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new SyncError("服务器地址需要以 http:// 或 https:// 开头");
  if (url.username || url.password) throw new SyncError("服务器地址里不要包含用户名或密码");
  return url.origin;
}
const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactJson = (buffer, what) => {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new SyncError(`${what}内容不是有效的 JSON`, "invalid");
  }
};

export class SyncClient {
  #dir;
  #file;
  #storage;
  #fetch;
  #adapters;
  #now;
  #emit;
  #state = null;
  #loaded = false;
  #running = null;
  #timer = null;
  #debounce = null;
  #failures = 0;
  #attention = null;
  #lastError = "";

  constructor({
    directory,
    secureStorage,
    fetchImpl = fetch,
    adapters,
    now = Date.now,
    emit = () => {},
  }) {
    this.#dir = directory;
    this.#file = join(directory, "sync.json");
    this.#storage = secureStorage;
    this.#fetch = fetchImpl;
    this.#adapters = adapters;
    this.#now = now;
    this.#emit = emit;
  }

  // ———— 状态 ————

  async #load() {
    if (this.#loaded) return this.#state;
    try {
      const data = JSON.parse(await readFile(this.#file, "utf8"));
      if (data?.v === 1) this.#state = data;
    } catch (error) {
      if (error.code !== "ENOENT") throw new SyncError("同步配置读取失败，请检查本地文件。");
    }
    this.#loaded = true;
    return this.#state;
  }
  async #save() {
    await mkdir(this.#dir, { recursive: true });
    const tmp = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#state), { mode: 0o600 });
    await rename(tmp, this.#file);
  }
  #secure() {
    if (
      !this.#storage?.isEncryptionAvailable?.() ||
      this.#storage.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new SyncError("操作系统加密存储不可用，不能保存同步所需的设备密钥。", "secure-storage");
  }
  #log(kind, text) {
    if (!this.#state) return;
    this.#state.log = [
      { at: new Date(this.#now()).toISOString(), kind, text },
      ...(this.#state.log ?? []),
    ].slice(0, LOG_LIMIT);
  }
  async #baseFile(name, value) {
    const file = join(this.#dir, "base", name);
    if (value === undefined) return JSON.parse(await readFile(file, "utf8").catch(() => "null"));
    await mkdir(join(this.#dir, "base"), { recursive: true });
    if (value === null) return rm(file, { force: true });
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  }

  async status() {
    const state = await this.#load();
    if (!state)
      return { paired: false, running: Boolean(this.#running), scope: { ...DEFAULT_SCOPE } };
    return {
      paired: true,
      running: Boolean(this.#running),
      server: { url: state.server.url, fingerprint: state.server.fingerprint },
      device: { id: state.device.id, name: state.device.name },
      scope: state.scope,
      lastSyncAt: state.lastSyncAt ?? null,
      lastResult: state.lastResult ?? null,
      attention: this.#attention,
      error: this.#lastError,
      log: state.log ?? [],
    };
  }

  async setScope(scope) {
    const state = await this.#load();
    if (!state) throw new SyncError("还没有配对");
    for (const key of SCOPES) if (typeof scope?.[key] === "boolean") state.scope[key] = scope[key];
    // 关掉某类数据后，下次再打开时从头对照：旧基线不能当作共同祖先。
    for (const key of SCOPES) if (!state.scope[key]) this.#dropBase(key);
    await this.#save();
    return this.status();
  }
  #dropBase(key) {
    if (!this.#state.base) return;
    if (key === "documents") this.#state.base.documents = {};
    else this.#state.base[key] = null;
  }

  // ———— 传输 ————

  async #post(origin, path, body, timeout = REQUEST_TIMEOUT) {
    let response;
    try {
      response = await this.#fetch(origin + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Zhiyu": "1" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const text = String(error?.cause?.code ?? error?.name ?? "");
      throw new SyncError(
        text === "TimeoutError" || text === "AbortError"
          ? "连接服务器超时"
          : "无法连接服务器，请检查地址与网络（服务器是否在运行）",
        "network",
      );
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* 非 JSON 响应按状态码处理 */
    }
    if (!response.ok) {
      const code =
        response.status === 401 ? "revoked" : response.status === 429 ? "limited" : "http";
      throw new SyncError(data?.error ?? `服务器返回 ${response.status}`, code);
    }
    return data;
  }

  // ———— 配对 ————

  async pair({ url, code, name }) {
    if (await this.#load()) throw new SyncError("已经配对，请先解除配对再重新配对");
    this.#secure();
    const origin = normalizeServerUrl(url);
    const { sid: sidText } = await this.#post(origin, "/api/sync/pair/start", {});
    const sid = unb64u(sidText, 16, "会话");
    let initiate;
    try {
      initiate = pairInitiate(code, sid);
    } catch (error) {
      throw new SyncError(error instanceof ZspError ? error.message : "配对码格式不正确", "code");
    }
    const exchange = await this.#post(origin, "/api/sync/pair/exchange", {
      sid: sidText,
      Ya: b64u(initiate.Ya),
    });
    let keys;
    try {
      keys = initiate.finish(unb64u(exchange.Yb, 32, "服务器的点"));
    } catch {
      throw new SyncError("配对失败：服务器返回的数据无效", "protocol");
    }
    const { Ya } = initiate;
    const { Yb } = keys;
    const identity = generateIdentity();
    const channel = pairChannel(keys, "client", sid, Ya, Yb);
    const hello = channel.seal(
      Buffer.from(
        JSON.stringify({
          pub: b64u(identity.publicKey),
          sig: b64u(signWith(identity, pairDeviceMessage(sid, Ya, Yb, identity.publicKey))),
          name: String(name ?? "桌面端").slice(0, 60),
        }),
      ),
    );
    // 桌面端先证明知道配对码；服务器验证通过后才回应，所以猜错的人每次都会被服务器记一笔。
    const finish = await this.#post(origin, "/api/sync/pair/finish", {
      sid: sidText,
      tag: b64u(pairTag(keys.kC, "C", sid, Ya, Yb)),
      counter: hello.counter,
      data: b64u(hello.data),
    }).catch((error) => {
      if (error.code === "http" && /配对码不正确/.test(error.message)) error.code = "code";
      throw error;
    });
    let info;
    try {
      if (!equalBytes(unb64u(finish.tag, 32, "确认标签"), pairTag(keys.kS, "S", sid, Ya, Yb)))
        throw new ZspError("服务器确认标签不一致");
      info = JSON.parse(
        channel
          .open(Number(finish.counter), unb64u(finish.data, undefined, "身份"))
          .toString("utf8"),
      );
      const serverPub = unb64u(info.pub, 32, "服务器公钥");
      const signature = unb64u(info.sig, 64, "服务器签名");
      if (
        !verifyWith(
          serverPub,
          pairServerMessage(sid, Ya, Yb, serverPub, identity.publicKey),
          signature,
        )
      )
        throw new ZspError("服务器签名无效");
      if (info.deviceId !== deviceIdOf(identity.publicKey)) throw new ZspError("设备标识不一致");
      info.serverPub = serverPub;
    } catch {
      throw new SyncError("配对失败：服务器身份无法验证，已放弃", "protocol");
    }
    this.#state = {
      v: 1,
      server: {
        url: origin,
        publicKey: b64u(info.serverPub),
        fingerprint: fingerprint(info.serverPub),
      },
      device: {
        id: deviceIdOf(identity.publicKey),
        name: String(name ?? "桌面端").slice(0, 60),
        publicKey: b64u(identity.publicKey),
        key: this.#storage
          .encryptString(exportIdentity(identity).toString("base64"))
          .toString("base64"),
      },
      scope: { ...DEFAULT_SCOPE },
      base: { assets: null, vault: null, documents: {} },
      lastSeq: 0,
      lastDigest: "",
      lastSyncAt: null,
      lastResult: null,
      log: [],
    };
    this.#log("paired", `已与 ${origin} 配对`);
    await this.#save();
    this.#schedule();
    return this.status();
  }

  async unpair() {
    const state = await this.#load();
    if (!state) return this.status();
    this.stop();
    try {
      const session = await this.#session();
      await session.call({ op: "unpair" }).catch(() => {});
    } catch {
      /* 服务器连不上也要能解除本机配对；之后在网页版撤销这台设备即可 */
    }
    this.#state = null;
    this.#attention = null;
    this.#lastError = "";
    await rm(this.#file, { force: true });
    await rm(join(this.#dir, "base"), { recursive: true, force: true });
    this.#emit("sync:changed", {});
    return this.status();
  }

  // ———— 会话 ————

  async #session() {
    const state = await this.#load();
    if (!state) throw new SyncError("还没有配对");
    this.#secure();
    const origin = state.server.url;
    const serverPublicKey = unb64u(state.server.publicKey, 32);
    const deviceIdentity = importIdentity(
      Buffer.from(this.#storage.decryptString(Buffer.from(state.device.key, "base64")), "base64"),
    );
    const start = sessionClientStart(state.device.id);
    const reply = await this.#post(origin, "/api/sync/session/start", start.message);
    let handshake;
    try {
      handshake = sessionClientFinish({ start, reply, serverPublicKey, deviceIdentity });
    } catch (error) {
      if (error?.code === "server-identity")
        throw new SyncError(
          "服务器的身份与配对时不一致，已拒绝连接。若服务器重装过，请解除配对后重新配对。",
          "server-identity",
        );
      throw new SyncError("服务器返回的数据无效", "protocol");
    }
    const { channel, auth } = handshake;
    await this.#post(origin, "/api/sync/session/auth", {
      sid: reply.sid,
      counter: auth.counter,
      data: b64u(auth.data),
    });
    let chain = Promise.resolve();
    const call = (request) => {
      const job = chain.then(async () => {
        const sealed = channel.seal(Buffer.from(JSON.stringify(request)));
        const response = await this.#post(origin, "/api/sync/session/message", {
          sid: reply.sid,
          counter: sealed.counter,
          data: b64u(sealed.data),
        });
        let result;
        try {
          result = JSON.parse(
            channel
              .open(Number(response.counter), unb64u(response.data, undefined, "响应"))
              .toString("utf8"),
          );
        } catch {
          throw new SyncError("服务器的响应无法验证，已中止", "protocol");
        }
        if (!result.ok)
          throw new SyncError(result.error ?? "服务器拒绝了请求", result.code ?? "remote");
        return result;
      });
      chain = job.catch(() => {});
      return job;
    };
    return {
      call,
      end: () =>
        this.#post(origin, "/api/sync/session/end", { sid: reply.sid }, 5000).catch(() => {}),
    };
  }

  async #readRemote(session, path) {
    const chunks = [];
    let offset = 0;
    for (;;) {
      const part = await session.call({ op: "read", path, offset });
      if (part.missing) return null;
      const bytes = unb64u(part.data, undefined, "数据块");
      chunks.push(bytes);
      offset += bytes.length;
      if (offset > MAX_FILE) throw new SyncError("服务器上的文件过大", "too-large");
      if (part.eof) break;
      if (!bytes.length) throw new SyncError("服务器返回了空的数据块", "protocol");
    }
    return Buffer.concat(chunks);
  }
  async #writeRemote(session, path, value, expect) {
    const raw = Buffer.from(JSON.stringify(value));
    if (raw.length > MAX_FILE) throw new SyncError("文件过大，无法同步", "too-large");
    await session.call({ op: "writeBegin", path, expect, size: raw.length, sha: hex(raw) });
    for (let offset = 0; offset < raw.length; offset += CHUNK)
      await session.call({ op: "writeChunk", data: b64u(raw.subarray(offset, offset + CHUNK)) });
    try {
      return await session.call({ op: "writeCommit" });
    } catch (error) {
      if (error.code === "conflict") throw new Retry();
      throw error;
    }
  }

  // ———— 同步 ————

  /** 立即同步一次。同一时间只跑一轮，重复调用共用同一个结果。 */
  syncNow({ reason = "manual" } = {}) {
    if (this.#running) return this.#running;
    this.#running = this.#syncSafely(reason).finally(() => {
      this.#running = null;
      this.#emit("sync:changed", {});
    });
    this.#emit("sync:changed", {});
    return this.#running;
  }

  async #syncSafely(reason) {
    const state = await this.#load();
    if (!state) throw new SyncError("还没有配对");
    let session;
    const summary = { pulled: 0, pushed: 0, merged: 0, deleted: 0, warnings: [] };
    try {
      session = await this.#session();
      for (let round = 1; ; round += 1) {
        try {
          await this.#round(session, summary);
          break;
        } catch (error) {
          if (!(error instanceof Retry) || round >= MAX_ROUNDS) throw error;
        }
      }
      state.lastSyncAt = new Date(this.#now()).toISOString();
      state.lastResult = { ok: true, at: state.lastSyncAt, ...summary };
      this.#lastError = "";
      this.#failures = 0;
      if (summary.pulled || summary.pushed || summary.merged || summary.deleted)
        this.#log(
          "sync",
          `同步完成：拉取 ${summary.pulled}、推送 ${summary.pushed}、合并 ${summary.merged}、删除 ${summary.deleted}`,
        );
      for (const warning of summary.warnings) this.#log("warning", warning);
      await this.#save();
      return await this.status();
    } catch (error) {
      this.#failures += 1;
      const message = error instanceof SyncError ? error.message : "同步失败，请稍后重试";
      this.#lastError = message;
      state.lastResult = { ok: false, at: new Date(this.#now()).toISOString(), error: message };
      if (error?.code === "revoked")
        this.#attention = {
          kind: "revoked",
          message: "这台设备已被撤销或未配对。请解除配对后重新配对。",
        };
      this.#log("error", message);
      await this.#save().catch(() => {});
      if (reason === "manual") throw error instanceof SyncError ? error : new SyncError(message);
      return await this.status();
    } finally {
      await session?.end();
    }
  }

  async #checkManifest(session) {
    const state = this.#state;
    const manifest = await session.call({ op: "manifest" });
    const digest = manifestDigest(manifest.files ?? {});
    let valid = false;
    try {
      valid =
        b64u(digest) === manifest.digest &&
        verifyManifest(
          unb64u(state.server.publicKey, 32),
          manifest.seq,
          digest,
          unb64u(manifest.sig, 64),
        );
    } catch {
      valid = false;
    }
    if (!valid || !Number.isSafeInteger(manifest.seq))
      throw new SyncError("服务器的清单签名无效，已中止同步", "protocol");
    if (
      manifest.seq < state.lastSeq ||
      (manifest.seq === state.lastSeq && state.lastDigest && manifest.digest !== state.lastDigest)
    ) {
      this.#attention = {
        kind: "rollback",
        message:
          "服务器上的数据比上次同步时更旧或出现分叉（可能服务器恢复过旧备份）。请确认后选择「接受服务器当前状态」。",
      };
      throw new SyncError(this.#attention.message, "rollback");
    }
    if (this.#attention?.kind === "rollback") this.#attention = null;
    return manifest;
  }

  async #round(session, summary) {
    const state = this.#state;
    const manifest = await this.#checkManifest(session);
    if (state.scope.assets) await this.#syncAssets(session, manifest, summary);
    if (state.scope.documents) await this.#syncDocuments(session, manifest, summary);
    if (state.scope.vault) await this.#syncVault(session, manifest, summary);
    const final = await this.#checkManifest(session);
    state.lastSeq = final.seq;
    state.lastDigest = final.digest;
  }

  /** 用户确认服务器状态是对的（例如自己恢复了备份）：清掉基线，之后按首次同步处理，只合并不删除。 */
  async acceptServerState() {
    const state = await this.#load();
    if (!state) throw new SyncError("还没有配对");
    state.lastSeq = 0;
    state.lastDigest = "";
    state.base = { assets: null, vault: null, documents: {} };
    await rm(join(this.#dir, "base"), { recursive: true, force: true });
    this.#attention = null;
    this.#log("accepted", "已接受服务器当前状态，重新对照");
    await this.#save();
    return this.syncNow({ reason: "manual" });
  }

  // 资产：记录级三方合并。
  async #syncAssets(session, manifest, summary) {
    const state = this.#state;
    const local = await this.#adapters.assets.read();
    const hL = hashAssetsFile({ state: local.state, version: 0 });
    const entry = manifest.files["assets.json"];
    const hR = entry?.h ?? null;
    const hB = state.base.assets?.h ?? null;
    if (hL === hR) {
      if (hB !== hL) await this.#setAssetsBase(local.state, hL);
      return;
    }
    const remoteRaw = hR ? await this.#readRemote(session, "assets.json") : null;
    const remoteParsed = remoteRaw ? exactJson(remoteRaw, "网页版的资产") : null;
    const remoteState = remoteParsed ? (remoteParsed.state ?? remoteParsed) : null;
    if (hR && remoteState && hashAssetsFile({ state: remoteState, version: 0 }) !== hR)
      throw new Retry(); // 读到的内容与清单不符：服务器在读取期间变了
    let baseState = hB ? await this.#baseFile("assets.json") : undefined;
    // 基线文件与记录的哈希对不上（中途崩溃）时当作没有基线，只合并、不删除。
    if (baseState && hashAssetsFile({ state: baseState, version: 0 }) !== hB) baseState = undefined;
    const newer = (entry?.m ?? 0) > (local.mtimeMs ?? 0) ? "remote" : "local";
    let merged;
    let conflicts = [];
    if (hB && hL === hB && remoteState)
      merged = remoteState; // 桌面没动
    else if (hB && hR === hB)
      merged = local.state; // 网页没动
    else
      ({ merged, conflicts } = mergeAssets(baseState ?? undefined, local.state, remoteState ?? {}, {
        newer,
      }));
    const hM = hashAssetsFile({ state: merged, version: 0 });
    const localChanges = hM !== hL;
    const remoteChanges = hM !== hR;
    if (localChanges)
      await this.#adapters.assets.apply((before) => {
        if (hashAssetsFile({ state: before, version: 0 }) !== hL) throw new Retry();
        return merged;
      });
    if (remoteChanges)
      await this.#writeRemote(session, "assets.json", { state: merged, version: 0 }, hR);
    if (localChanges && remoteChanges) summary.merged += 1;
    else if (localChanges) summary.pulled += 1;
    else if (remoteChanges) summary.pushed += 1;
    for (const conflict of conflicts)
      summary.warnings.push(
        `${conflict.path} 两边都改了，保留了${conflict.kept === "local" ? "桌面版" : "网页版"}`,
      );
    await this.#setAssetsBase(merged, hM);
  }
  async #setAssetsBase(stateValue, hash) {
    await this.#baseFile("assets.json", stateValue);
    this.#state.base.assets = { h: hash };
  }

  // 文档：逐篇比较哈希，冲突时另存副本。
  async #syncDocuments(session, manifest, summary) {
    const state = this.#state;
    const docs = this.#adapters.documents;
    const remote = Object.fromEntries(
      Object.entries(manifest.files)
        .filter(([path]) => path.startsWith("documents/"))
        .map(([path, value]) => [path, value]),
    );
    const localList = await docs.list();
    const local = new Map();
    for (const summaryItem of localList) {
      const hash = await this.#localDocumentHash(summaryItem);
      if (hash)
        local.set(`documents/${summaryItem.id}.json`, {
          id: summaryItem.id,
          h: hash,
          updatedAt: summaryItem.updatedAt,
        });
    }
    const base = state.base.documents ?? (state.base.documents = {});
    const paths = new Set([...local.keys(), ...Object.keys(remote), ...Object.keys(base)]);
    for (const path of [...paths].sort()) {
      const id = path.slice("documents/".length, -".json".length);
      const hL = local.get(path)?.h ?? null;
      const hR = remote[path]?.h ?? null;
      const hB = base[path] ?? null;
      const setBase = (value) => (value ? (base[path] = value) : delete base[path]);
      if (hL === hR) {
        setBase(hL);
        continue;
      }
      if (hL === hB) {
        // 桌面没动：网页删除就删除，否则拉取。
        if (hR === null) {
          await docs.remove(id);
          summary.deleted += 1;
          setBase(null);
        } else {
          setBase(await this.#pullDocument(session, path, hR, summary));
        }
      } else if (hR === hB) {
        // 网页没动：桌面删除就删除网页的，否则推送。
        if (hL === null) {
          await session.call({ op: "remove", path, expect: hR }).catch((error) => {
            if (error.code === "conflict") throw new Retry();
            throw error;
          });
          summary.deleted += 1;
          setBase(null);
        } else setBase(await this.#pushDocument(session, id, path, hR, summary));
      } else if (hL === null) {
        setBase(await this.#pullDocument(session, path, hR, summary)); // 删除与修改冲突：保留修改
      } else if (hR === null) {
        setBase(await this.#pushDocument(session, id, path, null, summary));
      } else {
        const remoteDoc = await this.#readRemoteDocument(session, path, hR);
        const localDoc = await docs.get(id);
        const newer =
          (remote[path]?.m ?? 0) > Date.parse(local.get(path)?.updatedAt ?? "")
            ? "remote"
            : "local";
        const result = mergeDocument(undefined, localDoc, remoteDoc, { newer });
        if (hashDocumentFile(result.local) !== hL) {
          await docs.save(result.local);
          this.#documentHashes.delete(id);
          summary.pulled += 1;
        }
        if (hashDocumentFile(result.remote) !== hR) {
          await this.#writeRemote(session, path, result.remote, hR);
          summary.pushed += 1;
        }
        if (result.copy) {
          const copyPath = `documents/${result.copy.doc.id}.json`;
          await docs.save(result.copy.doc);
          this.#documentHashes.delete(result.copy.doc.id);
          await this.#writeRemote(session, copyPath, result.copy.doc, remote[copyPath]?.h ?? null);
          base[copyPath] = hashDocumentFile(result.copy.doc);
          summary.warnings.push(
            `文档「${localDoc.title}」两边都改了，较旧的一份另存为「冲突副本」`,
          );
        }
        setBase(hashDocumentFile(result.local));
      }
    }
  }
  #documentHashes = new Map();
  async #localDocumentHash(item) {
    const cached = this.#documentHashes.get(item.id);
    if (cached && cached.updatedAt === item.updatedAt) return cached.h;
    try {
      const h = hashDocumentFile(await this.#adapters.documents.get(item.id));
      this.#documentHashes.set(item.id, { updatedAt: item.updatedAt, h });
      return h;
    } catch {
      return null; // 无法读取的文档不参与同步，也不会被当作已删除
    }
  }
  async #readRemoteDocument(session, path, expectHash) {
    const raw = await this.#readRemote(session, path);
    if (!raw) throw new Retry();
    const doc = exactJson(raw, "网页版的文档");
    if (hashDocumentFile(doc) !== expectHash) throw new Retry();
    return doc;
  }
  async #pullDocument(session, path, hR, summary) {
    const doc = await this.#readRemoteDocument(session, path, hR);
    const saved = await this.#adapters.documents.save(doc);
    this.#documentHashes.delete(saved.id);
    summary.pulled += 1;
    return hashDocumentFile(saved);
  }
  async #pushDocument(session, id, path, expect, summary) {
    const doc = await this.#adapters.documents.get(id);
    const result = await this.#writeRemote(session, path, doc, expect);
    summary.pushed += 1;
    return result.h ?? hashDocumentFile(doc);
  }

  // 密钥库：只比较和合并密文。
  async #syncVault(session, manifest, summary) {
    const state = this.#state;
    const vault = this.#adapters.vault;
    const { doc: localDoc, stamp, mtimeMs } = await vault.exportDocument();
    const hL = localDoc ? hashVaultFile(localDoc) : null;
    const entry = manifest.files["vault.enc"];
    const hR = entry?.h ?? null;
    const hB = state.base.vault?.h ?? null;
    if (hL === hR) {
      if (hB !== hL) await this.#setVaultBase(localDoc, hL);
      return;
    }
    const remoteRaw = hR ? await this.#readRemote(session, "vault.enc") : null;
    const remoteDoc = remoteRaw ? exactJson(remoteRaw, "网页版的密钥库") : null;
    if (remoteDoc && hashVaultFile(remoteDoc) !== hR) throw new Retry();
    let baseDoc = hB ? await this.#baseFile("vault.json") : null;
    if (baseDoc && hashVaultFile(baseDoc) !== hB) baseDoc = null;
    const newer = (entry?.m ?? 0) > (mtimeMs ?? 0) ? "remote" : "local";
    const result = mergeVault(baseDoc ?? undefined, localDoc, remoteDoc, { newer });
    if (result.hard) {
      this.#attention = {
        kind: "vault-conflict",
        message: "桌面版和网页版的密钥库主密码不同，且都有改动，无法自动合并。请选择以哪一边为准。",
      };
      summary.warnings.push(this.#attention.message);
      return;
    }
    if (this.#attention?.kind === "vault-conflict") this.#attention = null;
    if (!result.doc) return;
    const hM = hashVaultFile(result.doc);
    if (result.losers.length) await this.#keepLosers(result.losers);
    if (hM !== hL) {
      await vault.importDocument(result.doc, stamp).catch((error) => {
        throw new SyncError(error.message, "vault");
      });
      summary.pulled += 1;
    }
    if (hM !== hR) {
      await this.#writeRemote(session, "vault.enc", result.doc, hR);
      summary.pushed += 1;
    }
    for (const conflict of result.conflicts)
      summary.warnings.push(
        `密钥库记录两边都改了，保留了${conflict.kept === "local" ? "桌面版" : "网页版"}，另一份密文已保存到本机`,
      );
    await this.#setVaultBase(result.doc, hM);
  }
  async #setVaultBase(doc, hash) {
    await this.#baseFile("vault.json", doc ?? null);
    this.#state.base.vault = doc ? { h: hash } : null;
  }
  async #keepLosers(losers) {
    const dir = join(this.#dir, "conflicts");
    await mkdir(dir, { recursive: true });
    const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, "-");
    await writeFile(join(dir, `vault-conflict-${stamp}.json`), JSON.stringify({ losers }), {
      mode: 0o600,
    });
  }

  /** 主密码不同且都改过时，由用户指定以哪一边为准。 */
  async resolveVault(choice) {
    const state = await this.#load();
    if (!state) throw new SyncError("还没有配对");
    if (!["local", "remote"].includes(choice)) throw new SyncError("请选择以桌面版还是网页版为准");
    const session = await this.#session();
    try {
      const manifest = await this.#checkManifest(session);
      const hR = manifest.files["vault.enc"]?.h ?? null;
      const { doc: localDoc, stamp } = await this.#adapters.vault.exportDocument();
      if (choice === "local") {
        if (!localDoc) throw new SyncError("桌面版还没有密钥库");
        await this.#writeRemote(session, "vault.enc", localDoc, hR);
        await this.#setVaultBase(localDoc, hashVaultFile(localDoc));
      } else {
        const raw = hR ? await this.#readRemote(session, "vault.enc") : null;
        if (!raw) throw new SyncError("网页版还没有密钥库");
        const remoteDoc = exactJson(raw, "网页版的密钥库");
        await this.#adapters.vault.importDocument(remoteDoc, stamp);
        await this.#setVaultBase(remoteDoc, hashVaultFile(remoteDoc));
      }
      this.#attention = null;
      this.#log("vault-resolved", `密钥库已按${choice === "local" ? "桌面版" : "网页版"}为准`);
      await this.#save();
    } finally {
      await session.end();
    }
    return this.status();
  }

  // ———— 后台调度 ————

  #schedule() {
    clearTimeout(this.#timer);
    if (!this.#state) return;
    const wait = Math.min(15 * 60_000, INTERVAL * 2 ** Math.min(this.#failures, 3));
    this.#timer = setTimeout(async () => {
      if (this.#state && !this.#attention) await this.syncNow({ reason: "auto" }).catch(() => {});
      this.#schedule();
    }, wait);
    this.#timer.unref?.();
  }
  async start() {
    if (await this.#load()) this.#schedule();
  }
  stop() {
    clearTimeout(this.#timer);
    clearTimeout(this.#debounce);
  }
  /** 本机资料变了：稍等一会儿再同步，合并连续的多次修改。 */
  notifyLocalChange() {
    if (!this.#state || this.#running || this.#attention) return;
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(
      () => void this.syncNow({ reason: "auto" }).catch(() => {}),
      DEBOUNCE,
    );
    this.#debounce.unref?.();
  }
}
