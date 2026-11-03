import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { dirname } from "node:path";
import { IdentityAccounts } from "./identity-accounts.mjs";
import { validateImageDataUrl } from "./image-data.mjs";
import { loginResultPage } from "./login-result-page.mjs";

const ISSUER = "https://connect.linux.do";
const CALLBACK = "/oauth/zhiyu/callback";
const TTL = 300_000;
const MAX_BYTES = 1024 * 1024;
const nonce = () => randomBytes(32).toString("base64url");
const plain = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const assetIdFor = (subject) =>
  `secret-linuxdo-${createHash("sha256").update(`${ISSUER}\n${subject}`).digest("hex").slice(0, 32)}`;
const emptyPosts = () => ({
  items: [],
  fetchedAt: null,
  status: "idle",
  message: "仅获取 Linux.do 公开主题和回复。",
  nextOffset: 0,
  hasMore: true,
});
class MainIdentityError extends Error {}
const fail = (message) => new MainIdentityError(message);
const safeError = (error) =>
  error instanceof MainIdentityError
    ? error
    : fail("身份连接失败，请检查网络后重试；已保存的资料会保留。");

function profileFrom(value) {
  if (
    !plain(value) ||
    typeof value.subject !== "string" ||
    !value.subject ||
    value.subject.length > 200 ||
    /\s/.test(value.subject) ||
    [...value.subject].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    typeof value.username !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(value.username)
  )
    throw fail("登录服务返回的身份资料无效。");
  const optional = (key, type) => value[key] === null || typeof value[key] === type;
  if (
    typeof value.name !== "string" ||
    value.name.length > 300 ||
    !optional("email", "string") ||
    (value.email !== null &&
      (value.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email))) ||
    !optional("active", "boolean") ||
    !optional("silenced", "boolean") ||
    !(
      value.trustLevel === null ||
      (Number.isInteger(value.trustLevel) && value.trustLevel >= 0 && value.trustLevel <= 4)
    )
  )
    throw fail("登录服务返回的身份资料无效。");
  let avatarUrl = null;
  if (value.avatarUrl !== null && value.avatarUrl !== undefined) {
    try {
      const url = new URL(value.avatarUrl);
      if (
        url.protocol === "https:" &&
        (url.hostname === "linux.do" || url.hostname.endsWith(".linux.do")) &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.href.length <= 2000
      )
        avatarUrl = url.href;
    } catch {
      /* 无效头像不影响已核验身份。 */
    }
  }
  return {
    subject: value.subject,
    username: value.username,
    name: value.name || value.username,
    email: value.email,
    trustLevel: value.trustLevel,
    avatarUrl,
    profileUrl: `https://linux.do/u/${encodeURIComponent(value.username)}`,
    active: value.active,
    silenced: value.silenced,
  };
}

function envelopeFrom(value) {
  if (
    !plain(value) ||
    typeof value.credential !== "string" ||
    !/^[\x21-\x7e]{16,32768}$/.test(value.credential) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now()
  )
    throw fail("登录服务返回的会话无效或已过期，请重新登录。");
  return {
    credential: value.credential,
    profile: profileFrom(value.profile),
    expiresAt: value.expiresAt,
  };
}

/** 主身份独立于资产密钥库，服务凭据和帖子缓存只写入系统加密文件。 */
export class MainIdentityService {
  #file;
  #storage;
  #fetch;
  #open;
  #normalize;
  #origin;
  #record = null;
  #loaded = false;
  #loading;
  #queue = Promise.resolve();
  #generation = 0;
  #authGeneration = 0;
  #sessions = new Map();
  #requests = new Set();
  #listeners = new Set();
  #posts;
  #stopped = false;
  #refreshPending = null;

  constructor({
    file,
    safeStorage,
    fetchImpl = globalThis.fetch,
    openExternal,
    normalizeImage = validateImageDataUrl,
    origin = "https://auth.allinsong.top",
  }) {
    const url = new URL(origin);
    if (url.href !== "https://auth.allinsong.top/") throw new Error("主身份登录服务地址无效。");
    this.#file = file;
    this.#storage = safeStorage;
    this.#fetch = fetchImpl;
    this.#open = openExternal;
    this.#normalize = normalizeImage;
    this.#origin = url.origin;
    const isUnlocked = () =>
      !this.#stopped && Boolean(this.#record?.credential && this.#record.expiresAt > Date.now());
    const currentGeneration = () => this.#generation;
    // 旧帖子客户端只能访问这一条虚拟记录，无法触达资产密钥库或服务凭据。
    this.#posts = new IdentityAccounts({
      fetchImpl,
      vault: {
        get unlocked() {
          return isUnlocked();
        },
        get session() {
          return currentGeneration();
        },
        onLock: (listener) => {
          this.#listeners.add(listener);
          return () => this.#listeners.delete(listener);
        },
        get: async (key) => {
          const capture = this.captureSession();
          if (key !== `identity-auth:${assetIdFor(capture.subject)}`)
            throw fail("身份帖子缓存访问无效。");
          const record = this.#record;
          return structuredClone({
            assetId: assetIdFor(capture.subject),
            provider: "linuxdo",
            issuer: ISSUER,
            profile: record.profile,
            tokens: { accessToken: "public-posts-only" },
            updatedAt: record.updatedAt,
            posts: record.posts || emptyPosts(),
            postContents: record.postContents || {},
            postsAttemptedAt: record.postsAttemptedAt,
          });
        },
        batch: async (entries, { beforeCommit } = {}) => {
          const capture = this.captureSession();
          if (
            entries.length !== 1 ||
            entries[0].id !== `identity-auth:${assetIdFor(capture.subject)}` ||
            entries[0].secret?.profile?.subject !== capture.subject
          )
            throw fail("身份帖子缓存写入无效。");
          return this.#run(async () => {
            this.assertCurrent(capture);
            beforeCommit?.();
            const value = entries[0].secret;
            if (value.profile.username !== this.#record.profile.username)
              throw fail("主身份用户名已变更，本次帖子操作已取消。");
            const postContents = Object.fromEntries(
              Object.entries(value.postContents || {})
                .sort((a, b) => Date.parse(b[1].fetchedAt) - Date.parse(a[1].fetchedAt))
                .slice(0, 20),
            );
            await this.#write(
              {
                ...this.#record,
                posts: value.posts,
                postContents,
                postsAttemptedAt: value.postsAttemptedAt,
              },
              () => {
                this.assertCurrent(capture);
                beforeCommit?.();
              },
            );
          });
        },
      },
    });
  }

  #secure() {
    if (
      !this.#storage?.isEncryptionAvailable() ||
      this.#storage.getSelectedStorageBackend?.() === "basic_text"
    )
      throw fail("系统安全加密不可用，请启用系统钥匙串或凭据保护后再登录。");
  }
  async #load() {
    if (this.#stopped) throw fail("身份服务已停止。");
    if (this.#loaded) return;
    if (!this.#loading)
      this.#loading = (async () => {
        try {
          const info = await stat(this.#file);
          if (info.size > 16 * MAX_BYTES) throw new Error("oversized");
          this.#secure();
          const saved = JSON.parse(this.#storage.decryptString(await readFile(this.#file)));
          if (!plain(saved) || saved.version !== 1) throw new Error("invalid record");
          if (saved.identity !== null) {
            const value = saved.identity;
            if (
              !plain(value) ||
              !(
                (value.credential === null && value.expiresAt === null) ||
                (typeof value.credential === "string" &&
                  /^[\x21-\x7e]{16,32768}$/.test(value.credential) &&
                  Number.isSafeInteger(value.expiresAt))
              ) ||
              typeof value.syncName !== "boolean" ||
              typeof value.syncAvatar !== "boolean" ||
              !Number.isFinite(Date.parse(value.updatedAt))
            )
              throw new Error("invalid record");
            this.#record = {
              ...value,
              profile: profileFrom(value.profile),
              avatarDataUrl: this.#normalize(value.avatarDataUrl || ""),
            };
          }
          this.#loaded = true;
        } catch (error) {
          if (error.code === "ENOENT") {
            this.#loaded = true;
            return;
          }
          if (error instanceof MainIdentityError && error.message.includes("系统")) throw error;
          throw fail("主身份资料读取失败，请检查系统加密和本地文件；原文件未被覆盖。");
        }
      })().finally(() => {
        this.#loading = null;
      });
    return this.#loading;
  }
  #run(action) {
    const task = this.#queue.then(async () => {
      await this.#load();
      return action();
    });
    this.#queue = task.catch(() => {});
    return task;
  }
  async #write(record, assert = () => {}) {
    this.#secure();
    assert();
    const encrypted = this.#storage.encryptString(JSON.stringify({ version: 1, identity: record }));
    const temp = `${this.#file}.${nonce()}.tmp`;
    try {
      await mkdir(dirname(this.#file), { recursive: true });
      await writeFile(temp, encrypted, { mode: 0o600, flag: "wx" });
      assert();
      // 最后的代次校验、原子替换与内存更新不让出事件循环，取消不能插入提交中间。
      renameSync(temp, this.#file);
      this.#record = record;
    } catch (error) {
      throw error instanceof MainIdentityError
        ? error
        : fail("身份资料保存失败，原有资料已保留，请检查本地文件权限后重试。");
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
  #dto() {
    if (!this.#record) return null;
    const { profile, updatedAt, syncName, syncAvatar, avatarDataUrl, avatarMessage } = this.#record;
    return structuredClone({
      provider: "linuxdo",
      profile,
      connected: Boolean(this.#record.credential && this.#record.expiresAt > Date.now()),
      updatedAt,
      syncName,
      syncAvatar,
      avatarDataUrl: avatarDataUrl || "",
      ...(avatarMessage ? { avatarMessage } : {}),
    });
  }
  async get() {
    await this.#load();
    return this.#dto();
  }

  async #request(url, { body, credential, binary = false, research = false } = {}) {
    const controller = new AbortController();
    this.#requests.add(controller);
    const timer = setTimeout(() => controller.abort(), research ? 20000 : 15000);
    timer.unref?.();
    try {
      const response = await this.#fetch(url, {
        method: body !== undefined ? "POST" : "GET",
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          Accept: binary ? "image/png,image/jpeg,image/webp" : "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (controller.signal.aborted) throw fail("身份操作已取消或请求超时。");
      if (!response.ok || response.redirected) {
        if (research && response.status === 404)
          throw fail("联网检索服务尚未升级或配置，未产生积分支付。");
        if (research && response.body) {
          const reader = response.body.getReader();
          const chunks = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 16384) break;
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          if (size <= 16384) {
            let result;
            try {
              result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              result = null;
            }
            if (typeof result?.message === "string" && result.message.length <= 500)
              throw fail(result.message);
          }
          throw fail("联网检索服务暂时不可用，未创建新的积分支付。");
        }
        if (response.status === 401)
          throw fail("登录状态已过期，请重新使用 Linux.do 登录；本机资料仍然保留。");
        if (response.status === 503) throw fail("Linux.do 登录服务尚未配置完成，请稍后重试。");
        throw fail("身份服务暂时无法连接，请稍后重试；已保存的资料会保留。");
      }
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (
        binary
          ? !["image/png", "image/jpeg", "image/webp"].includes(type)
          : type !== "application/json"
      )
        throw fail("身份服务返回的数据格式无效。");
      if (Number(response.headers.get("content-length")) > MAX_BYTES)
        throw fail("身份服务返回的数据过大。");
      const chunks = [];
      let length = 0;
      if (!response.body) throw fail("身份服务未返回数据。");
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_BYTES) {
            controller.abort();
            throw fail("身份服务返回的数据过大。");
          }
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (controller.signal.aborted) throw fail("身份操作已取消或请求超时。");
      const bytes = Buffer.concat(chunks);
      return binary ? { bytes, type } : JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (controller.signal.aborted) throw fail("身份操作已取消或请求超时。");
      throw safeError(error);
    } finally {
      clearTimeout(timer);
      this.#requests.delete(controller);
    }
  }
  async research(method, input = {}) {
    await this.#load();
    if (!["quota", "records", "start", "status", "cancel", "checkout"].includes(method))
      throw fail("未知的联网检索操作。");
    if (!this.#record?.credential || this.#record.expiresAt <= Date.now())
      throw fail("联网检索需要先在个人资料中使用 Linux.do 登录。");
    const session = this.captureSession();
    const result = await this.#request(`${this.#origin}/v1/research/${method}`, {
      body: input,
      credential: this.#record.credential,
      research: true,
    });
    this.assertCurrent(session);
    return result;
  }

  async availability() {
    try {
      this.#secure();
      const result = await this.#request(`${this.#origin}/healthz`);
      if (!plain(result) || result.ok !== true || typeof result.configured !== "boolean")
        throw fail("登录服务状态无效。");
      return {
        configured: result.configured,
        message: result.configured
          ? "可以使用 Linux.do 登录并绑定主身份。"
          : "Linux.do 登录服务尚未配置完成，暂可使用本地账户。",
      };
    } catch (error) {
      return { configured: false, message: safeError(error).message };
    }
  }
  #close(session) {
    clearTimeout(session.timer);
    session.server?.close();
    session.server?.closeAllConnections?.();
    session.server = null;
    session.verifier = "";
    session.state = "";
  }
  #invalidateSessions() {
    this.#authGeneration++;
    for (const session of this.#sessions.values()) {
      session.status = "cancelled";
      session.envelope = null;
      this.#close(session);
    }
    this.#sessions.clear();
  }
  async start() {
    await this.#load();
    this.#secure();
    this.#invalidateSessions();
    const generation = this.#authGeneration;
    const session = {
      id: nonce(),
      state: nonce(),
      verifier: nonce(),
      expiresAt: Date.now() + TTL,
      status: "waiting",
      server: null,
      envelope: null,
    };
    this.#sessions.set(session.id, session);
    session.timer = setTimeout(() => {
      session.status = "error";
      session.error = "登录预览已过期，请重新登录。";
      session.envelope = null;
      this.#close(session);
    }, TTL);
    session.timer.unref?.();
    const valid = () => {
      if (
        this.#stopped ||
        generation !== this.#authGeneration ||
        this.#sessions.get(session.id) !== session ||
        session.status !== "waiting" ||
        Date.now() >= session.expiresAt
      )
        throw fail("本次登录已取消或失效。");
    };
    try {
      const server = createServer(async (request, response) => {
        const reply = (status, message, success = false) => {
          const page = loginResultPage({ message, success });
          response.writeHead(status, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": page.csp,
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            Connection: "close",
          });
          response.end(page.html);
        };
        try {
          valid();
          const url = new URL(request.url, session.redirectUri);
          const states = url.searchParams.getAll("state"),
            codes = url.searchParams.getAll("code"),
            errors = url.searchParams.getAll("error");
          if (
            request.method !== "GET" ||
            request.headers.host !== new URL(session.redirectUri).host ||
            !request.url.startsWith(`${CALLBACK}?`) ||
            url.pathname !== CALLBACK ||
            states.length !== 1 ||
            [...url.searchParams.keys()].some((key) => !["code", "state", "error"].includes(key))
          )
            return reply(400, "登录回调无效，请返回知屿重新登录。");
          const expected = Buffer.from(session.state),
            actual = Buffer.from(states[0]);
          if (
            actual.length !== expected.length ||
            !timingSafeEqual(actual, expected) ||
            session.exchanging
          )
            return reply(400, "登录回调无效或已经使用。");
          if (errors.length) {
            if (errors.length !== 1 || codes.length || !errors[0] || errors[0].length > 200)
              return reply(400, "登录回调无效，请返回知屿重新登录。");
            session.status = "error";
            session.error =
              errors[0] === "access_denied"
                ? "你已取消 Linux.do 授权，可以重新登录或继续使用本地账户。"
                : "Linux.do 登录未完成，请重新登录；本机资料未改变。";
            session.envelope = null;
            session.verifier = "";
            session.state = "";
            clearTimeout(session.timer);
            reply(200, "登录未完成，请返回知屿查看提示并重试。此页面可以关闭。");
            server.close();
            session.server = null;
            return;
          }
          if (codes.length !== 1 || !/^[A-Za-z0-9_-]{1,2048}$/.test(codes[0]))
            return reply(400, "登录回调无效，请返回知屿重新登录。");
          session.exchanging = true;
          const result = envelopeFrom(
            await this.#request(`${this.#origin}/v1/login/exchange`, {
              body: { code: codes[0], verifier: session.verifier },
            }),
          );
          valid();
          session.envelope = result;
          session.status = "ready";
          reply(200, "身份验证成功，请返回知屿确认绑定。此页面可以关闭。", true);
          // 保留预览过期计时，只关闭一次性回调监听。
          server.close();
          session.server = null;
          session.verifier = "";
          session.state = "";
        } catch (error) {
          if (session.status === "waiting") {
            session.status = "error";
            session.error = safeError(error).message;
            session.envelope = null;
          }
          reply(400, "登录未完成，请返回知屿查看提示并重试。");
          clearTimeout(session.timer);
          session.verifier = "";
          session.state = "";
          server.close();
          session.server = null;
        }
      });
      session.server = server;
      server.requestTimeout = 15000;
      server.headersTimeout = 15000;
      server.maxConnections = 8;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      valid();
      session.redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK}`;
      const result = await this.#request(`${this.#origin}/v1/login/start`, {
        body: {
          redirectUri: session.redirectUri,
          state: session.state,
          challenge: createHash("sha256").update(session.verifier).digest("base64url"),
        },
      });
      valid();
      if (
        !plain(result) ||
        typeof result.id !== "string" ||
        result.id.length > 200 ||
        !Number.isSafeInteger(result.expiresAt) ||
        result.expiresAt <= Date.now() ||
        result.expiresAt > Date.now() + TTL + 10000
      )
        throw fail("登录服务返回的授权请求无效。");
      const authorization = new URL(result.authorizationUrl);
      if (
        authorization.origin !== ISSUER ||
        authorization.pathname !== "/oauth2/authorize" ||
        authorization.username ||
        authorization.password ||
        authorization.hash ||
        authorization.href.length > 8192
      )
        throw fail("登录服务返回了非官方授权地址，已阻止打开。");
      session.expiresAt = Math.min(session.expiresAt, result.expiresAt);
      await this.#open(authorization.href);
      if (
        this.#stopped ||
        generation !== this.#authGeneration ||
        this.#sessions.get(session.id) !== session ||
        !["waiting", "ready"].includes(session.status) ||
        Date.now() >= session.expiresAt
      )
        throw fail("本次登录已取消或失效。");
      return { id: session.id, expiresAt: session.expiresAt };
    } catch (error) {
      session.status = "error";
      session.error = safeError(error).message;
      session.envelope = null;
      this.#close(session);
      throw safeError(error);
    }
  }
  async status(id) {
    const session = this.#sessions.get(id);
    if (!session) return { id, status: "cancelled" };
    if (Date.now() >= session.expiresAt) {
      session.status = "error";
      session.error = "登录预览已过期，请重新登录。";
      session.envelope = null;
      this.#close(session);
    }
    return {
      id,
      status: session.status,
      ...(session.status === "ready" && session.envelope
        ? { preview: structuredClone(session.envelope.profile) }
        : {}),
      ...(session.error ? { error: session.error } : {}),
    };
  }
  async cancel(id) {
    const session = this.#sessions.get(id);
    if (session) {
      session.status = "cancelled";
      session.envelope = null;
      this.#close(session);
      this.#sessions.delete(id);
    }
  }

  async #avatar(profile, enabled, previous = "") {
    if (!enabled) return { avatarDataUrl: previous, avatarMessage: "" };
    if (!profile.avatarUrl)
      return {
        avatarDataUrl: "",
        avatarMessage: "Linux.do 未提供可同步的头像，可继续使用本地头像。",
      };
    try {
      const { bytes, type } = await this.#request(profile.avatarUrl, { binary: true });
      const avatarDataUrl = await this.#normalize(
        `data:${type};base64,${bytes.toString("base64")}`,
      );
      return { avatarDataUrl, avatarMessage: "" };
    } catch {
      return {
        avatarDataUrl: previous,
        avatarMessage: "头像同步暂时失败，已保留现有头像，可稍后刷新。",
      };
    }
  }
  #bumpIdentity() {
    this.#generation++;
    for (const listener of this.#listeners) listener();
  }
  bind(options) {
    return this.#run(async () => {
      if (
        !plain(options) ||
        typeof options.syncName !== "boolean" ||
        typeof options.syncAvatar !== "boolean"
      )
        throw fail("请选择昵称和头像同步方式。");
      const session = this.#sessions.get(options.sessionId);
      const generation = this.#generation;
      const assert = () => {
        if (
          this.#stopped ||
          generation !== this.#generation ||
          !session ||
          this.#sessions.get(session.id) !== session ||
          session.status !== "ready" ||
          !session.envelope ||
          session.expiresAt <= Date.now() ||
          session.envelope.expiresAt <= Date.now()
        )
          throw fail("登录预览已失效，请重新登录。");
      };
      assert();
      const old = this.#record;
      const envelope = session.envelope;
      if (
        old &&
        old.profile.subject !== envelope.profile.subject &&
        options.replaceSubject !== old.profile.subject
      )
        throw fail("正在更换主身份，请先确认替换当前已绑定的账户。");
      const same = old?.profile.subject === envelope.profile.subject;
      const avatar = await this.#avatar(
        envelope.profile,
        options.syncAvatar,
        same ? old.avatarDataUrl : "",
      );
      assert();
      await this.#write(
        {
          ...envelope,
          provider: "linuxdo",
          syncName: options.syncName,
          syncAvatar: options.syncAvatar,
          ...avatar,
          updatedAt: new Date().toISOString(),
          posts:
            same && old.profile.username === envelope.profile.username ? old.posts : emptyPosts(),
          postContents:
            same && old.profile.username === envelope.profile.username ? old.postContents : {},
        },
        assert,
      );
      this.#bumpIdentity();
      this.#invalidateSessions();
      return this.#dto();
    });
  }
  captureSession() {
    if (this.#stopped || !this.#record?.credential || this.#record.expiresAt <= Date.now())
      throw fail("请先登录并绑定 Linux.do 主身份。");
    return Object.freeze({ generation: this.#generation, subject: this.#record.profile.subject });
  }
  assertCurrent(capture) {
    if (
      this.#stopped ||
      !capture ||
      capture.generation !== this.#generation ||
      capture.subject !== this.#record?.profile.subject ||
      !this.#record?.credential ||
      this.#record.expiresAt <= Date.now()
    )
      throw fail("主身份已变更，本次操作已取消。");
  }
  preferences(options) {
    return this.#run(async () => {
      if (!this.#record) throw fail("请先绑定 Linux.do 主身份。");
      const generation = this.#generation;
      const subject = this.#record.profile.subject;
      const assert = () => {
        if (
          this.#stopped ||
          generation !== this.#generation ||
          this.#record?.profile.subject !== subject
        )
          throw fail("主身份已变更，本次操作已取消。");
      };
      if (
        !plain(options) ||
        typeof options.syncName !== "boolean" ||
        typeof options.syncAvatar !== "boolean"
      )
        throw fail("请选择昵称和头像同步方式。");
      const avatar =
        options.syncAvatar &&
        !this.#record.syncAvatar &&
        this.#record.credential &&
        this.#record.expiresAt > Date.now()
          ? await this.#avatar(this.#record.profile, true, this.#record.avatarDataUrl)
          : {
              avatarDataUrl: this.#record.avatarDataUrl,
              avatarMessage: this.#record.avatarMessage || "",
            };
      await this.#write(
        { ...this.#record, syncName: options.syncName, syncAvatar: options.syncAvatar, ...avatar },
        assert,
      );
      return this.#dto();
    });
  }
  async refresh() {
    await this.#load();
    const capture = this.captureSession();
    if (this.#refreshPending?.generation === capture.generation)
      return this.#refreshPending.promise;
    const promise = this.#refresh(capture, this.#record);
    this.#refreshPending = { generation: capture.generation, promise };
    try {
      return await promise;
    } finally {
      if (this.#refreshPending?.promise === promise) this.#refreshPending = null;
    }
  }
  async #refresh(capture, initial) {
    const envelope = envelopeFrom(
      await this.#request(`${this.#origin}/v1/session/profile`, {
        body: {},
        credential: initial.credential,
      }),
    );
    this.assertCurrent(capture);
    if (envelope.profile.subject !== capture.subject)
      throw fail("登录服务返回了不同账户的身份，已拒绝覆盖主身份。");
    const avatar = await this.#avatar(envelope.profile, initial.syncAvatar, initial.avatarDataUrl);
    return this.#run(async () => {
      this.assertCurrent(capture);
      const old = this.#record;
      await this.#write(
        {
          ...old,
          ...envelope,
          ...(old.syncAvatar === initial.syncAvatar ? avatar : {}),
          updatedAt: new Date().toISOString(),
          posts: old.profile.username === envelope.profile.username ? old.posts : emptyPosts(),
          postContents: old.profile.username === envelope.profile.username ? old.postContents : {},
        },
        () => this.assertCurrent(capture),
      );
      if (old.profile.username !== envelope.profile.username) this.#bumpIdentity();
      return this.#dto();
    });
  }
  disconnect() {
    this.#bumpIdentity();
    this.#invalidateSessions();
    for (const controller of this.#requests) controller.abort();
    const generation = this.#generation;
    return this.#run(async () => {
      const signedOut = this.#record
        ? {
            ...this.#record,
            credential: null,
            expiresAt: null,
            posts: emptyPosts(),
            postContents: {},
            postsAttemptedAt: null,
          }
        : null;
      await this.#write(signedOut, () => {
        if (this.#generation !== generation) throw fail("主身份已变更，本次断开已取消。");
      });
    });
  }
  async loadPosts(options = {}) {
    await this.#load();
    const capture = this.captureSession();
    const result = await this.#posts.loadPosts(assetIdFor(capture.subject), options);
    this.assertCurrent(capture);
    return result;
  }
  async readPosts(postIds, options = {}) {
    await this.#load();
    const capture = this.captureSession();
    const result = await this.#posts.readPosts(assetIdFor(capture.subject), postIds, options);
    this.assertCurrent(capture);
    return result;
  }
  stop() {
    this.#stopped = true;
    this.#bumpIdentity();
    this.#invalidateSessions();
    this.#posts.stop();
    for (const controller of this.#requests) controller.abort();
    this.#listeners.clear();
  }
}
