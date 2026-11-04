import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { convert } from "html-to-text";

const ISSUER = "https://connect.linux.do";
const CONFIG = "identity-config:linuxdo";
const PREFIX = "identity-auth:";
const CALLBACK = "/oauth/linuxdo/callback";
const DEFAULT_REDIRECT = `http://127.0.0.1:49283${CALLBACK}`;
const AUTH_TTL = 5 * 60_000;
const POSTS_TTL = 15 * 60_000;
const MAX_BYTES = 1024 * 1024;
const PAGE_SIZE = 30;
const MAX_POSTS = 200;
const nonce = () => randomBytes(32).toString("base64url");
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 300) => (typeof value === "string" ? value.slice(0, limit) : "");
const iso = (value) => {
  const stamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
};
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

class IdentityError extends Error {}
const fail = (message) => new IdentityError(message);
const safeMessage = (error) =>
  error instanceof IdentityError
    ? error.message
    : "Linux.do 连接失败，请检查网络或应用配置后重试。";

function redirectUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("回调地址无效。");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^\d+$/.test(url.port) ||
    Number(url.port) < 1024 ||
    Number(url.port) > 65535 ||
    url.pathname !== CALLBACK ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.href !== value
  )
    throw fail(`回调地址须为 http://127.0.0.1:端口${CALLBACK}，端口范围 1024–65535。`);
  return url;
}

function normalizedProfile(value) {
  if (!plain(value)) throw fail("Linux.do 未返回有效的用户资料。");
  const rawSubject = value.sub ?? value.id;
  const subject =
    typeof rawSubject === "number" && Number.isSafeInteger(rawSubject) && rawSubject > 0
      ? String(rawSubject)
      : rawSubject;
  if (
    typeof subject !== "string" ||
    !subject ||
    subject.length > 200 ||
    Array.from(subject).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    throw fail("Linux.do 用户标识无效，未导入账号。");
  const username = text(value.username ?? value.preferred_username, 101);
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(username)) throw fail("Linux.do 用户名无效，未导入账号。");
  let avatarUrl = null;
  try {
    const rawAvatar = text(value.avatar_url ?? value.picture ?? value.avatar_template, 2000);
    if (!rawAvatar) throw new Error("missing avatar");
    const avatar = new URL(rawAvatar.replaceAll("{size}", "120"), "https://linux.do");
    if (
      avatar.protocol === "https:" &&
      ["linux.do", "connect.linux.do"].includes(avatar.hostname) &&
      !avatar.username &&
      !avatar.password &&
      !avatar.port
    )
      avatarUrl = avatar.href;
  } catch {
    /* 头像缺失不影响账号导入。 */
  }
  const email = text(value.email, 320);
  return {
    subject,
    username,
    name: text(value.name) || username,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    trustLevel:
      Number.isInteger(value.trust_level) && value.trust_level >= 0 && value.trust_level <= 4
        ? value.trust_level
        : null,
    avatarUrl,
    profileUrl: `https://linux.do/u/${encodeURIComponent(username)}`,
    active: typeof value.active === "boolean" ? value.active : null,
    silenced: typeof value.silenced === "boolean" ? value.silenced : null,
  };
}

function tokensFrom(value, old = {}) {
  if (
    !plain(value) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    value.access_token.length > 16384 ||
    /[\r\n]/.test(value.access_token) ||
    (value.token_type && String(value.token_type).toLowerCase() !== "bearer")
  )
    throw fail("Linux.do 未返回有效的授权令牌。");
  const expires = Number(value.expires_in);
  return {
    accessToken: value.access_token,
    refreshToken:
      typeof value.refresh_token === "string" && value.refresh_token.length <= 16384
        ? value.refresh_token
        : old.refreshToken || "",
    expiresAt:
      Number.isFinite(expires) && expires > 0
        ? Date.now() + Math.min(expires, 365 * 86400) * 1000
        : null,
  };
}

function publicAccount(record) {
  return structuredClone({
    assetId: record.assetId,
    provider: "linuxdo",
    profile: record.profile,
    connected: Boolean(record.tokens?.accessToken),
    updatedAt: record.updatedAt,
    posts: record.posts,
  });
}

function publicAsset(value, id) {
  if (
    !plain(value) ||
    value.id !== id ||
    value.kind !== "account" ||
    typeof value.name !== "string"
  )
    return null;
  return {
    id,
    name: text(value.name),
    kind: "account",
    identityProvider: "linuxdo",
    hint: "",
    value: "",
    notes: text(value.notes, 10000),
    lastRotated: text(value.lastRotated, 40),
    status: ["online", "warning", "offline"].includes(value.status) ? value.status : "online",
    tags: Array.isArray(value.tags)
      ? value.tags
          .filter((tag) => typeof tag === "string")
          .map((tag) => tag.slice(0, 100))
          .slice(0, 100)
      : [],
    ...(typeof value.folderId === "string" ? { folderId: value.folderId.slice(0, 200) } : {}),
  };
}

function postFrom(value, username) {
  if (
    !plain(value) ||
    ![4, 5].includes(value.action_type) ||
    typeof value.username !== "string" ||
    value.username.toLowerCase() !== username.toLowerCase() ||
    !Number.isSafeInteger(value.topic_id) ||
    value.topic_id < 1 ||
    !Number.isSafeInteger(value.post_number) ||
    value.post_number < 1
  )
    return null;
  if ((value.action_type === 4) !== (value.post_number === 1)) return null;
  const toText = (html, max) =>
    convert(text(html, 32000), {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
      ],
    }).slice(0, max);
  return {
    id: `${value.topic_id}:${value.post_number}`,
    ...(Number.isSafeInteger(value.post_id) && value.post_id > 0 ? { postId: value.post_id } : {}),
    title: toText(value.title, 300) || `主题 ${value.topic_id}`,
    url: `https://linux.do/t/topic/${value.topic_id}/${value.post_number}`,
    kind: value.action_type === 4 ? "topic" : "reply",
    excerpt: toText(value.excerpt ?? value.cooked, 2000),
    createdAt: iso(value.created_at),
  };
}

/** Linux.do 官方授权只在主进程运行，渲染层仅收到脱敏配置和确认预览。 */
export class IdentityAccounts {
  #vault;
  #fetch;
  #openExternal;
  #getAssets;
  #queue = Promise.resolve();
  #sessions = new Map();
  #requests = new Set();
  #unsubscribe;
  #manualLoopback;

  constructor({
    vault,
    fetchImpl = globalThis.fetch,
    openExternal,
    getAssets = () => ({ secrets: [] }),
    manualLoopback = false,
  }) {
    this.#vault = vault;
    this.#fetch = fetchImpl;
    this.#openExternal = openExternal;
    this.#getAssets = getAssets;
    this.#manualLoopback = manualLoopback;
    this.#unsubscribe = vault.onLock(() => this.#clear());
  }

  #capture() {
    if (!this.#vault.unlocked) throw fail("请先解锁密钥库，再连接 Linux.do。");
    return this.#vault.session;
  }

  #assert(generation) {
    if (!this.#vault.unlocked || this.#vault.session !== generation)
      throw fail("密钥库已锁定，本次身份操作已取消。");
  }

  #run(action) {
    let generation;
    try {
      generation = this.#capture();
    } catch (error) {
      return Promise.reject(error);
    }
    const task = this.#queue.then(async () => {
      this.#assert(generation);
      try {
        return await action(generation);
      } catch (error) {
        this.#assert(generation);
        throw fail(safeMessage(error));
      }
    });
    this.#queue = task.catch(() => {});
    return task;
  }

  async #read(key, generation) {
    const result = await this.#vault.get(key);
    this.#assert(generation);
    return result;
  }

  async #write(entries, generation) {
    await this.#vault.batch(entries, { beforeCommit: () => this.#assert(generation) });
    this.#assert(generation);
  }

  #close(session) {
    clearTimeout(session.timer);
    session.server?.close();
    session.server = null;
    session.verifier = "";
    session.state = "";
    session.config = null;
  }

  #clear() {
    for (const session of this.#sessions.values()) {
      this.#close(session);
      session.tokens = null;
      session.preview = null;
      session.status = "cancelled";
    }
    this.#sessions.clear();
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear();
  }

  stop() {
    this.#clear();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  async #json(url, options, generation, publicPosts = false) {
    this.#assert(generation);
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      !(
        (target.origin === ISSUER && ["/oauth2/token", "/api/user"].includes(target.pathname)) ||
        (publicPosts &&
          target.origin === "https://linux.do" &&
          (target.pathname === "/user_actions.json" ||
            /^\/posts\/[1-9]\d*\.json$/.test(target.pathname)))
      )
    )
      throw fail("身份接口地址无效。");
    const controller = new AbortController();
    this.#requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    timer.unref?.();
    let reader;
    let response;
    try {
      response = await this.#fetch(target.href, {
        ...options,
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: { Accept: "application/json", ...options.headers },
      });
      this.#assert(generation);
      if (!response.ok) {
        if (publicPosts && response.status === 403)
          throw fail("Linux.do 暂不允许读取公开帖子（403）；已保留上次缓存，请稍后手动重试。");
        if (publicPosts && response.status === 429)
          throw fail("Linux.do 请求过于频繁（429）；已保留上次缓存，请稍后手动重试。");
        if ([400, 401, 403].includes(response.status)) {
          const error = fail("Linux.do 授权已失效或应用配置不匹配，请检查配置后重新连接。");
          error.status = response.status;
          throw error;
        }
        throw fail("Linux.do 服务暂时不可用，请稍后重试。");
      }
      if (
        !/\bapplication\/(?:[a-z.+-]*\+)?json\b/i.test(response.headers.get("content-type") || "")
      )
        throw fail(
          publicPosts
            ? "Linux.do 返回了验证页面，无法读取公开帖子；已保留上次缓存。"
            : "Linux.do 返回的内容不是有效 JSON，未读取账号资料。",
        );
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_BYTES) throw fail("Linux.do 响应过大，已停止读取。");
      reader = response.body?.getReader();
      if (!reader) throw fail("Linux.do 返回了空响应。");
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        this.#assert(generation);
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) throw fail("Linux.do 响应过大，已停止读取。");
        chunks.push(Buffer.from(value));
      }
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw fail("Linux.do 返回的数据格式无效。");
      }
      if (!plain(data)) throw fail("Linux.do 返回的数据格式无效。");
      return data;
    } catch (error) {
      this.#assert(generation);
      if (error instanceof IdentityError) throw error;
      throw fail(safeMessage(error));
    } finally {
      if (reader) reader.cancel().catch(() => {});
      else response?.body?.cancel().catch(() => {});
      clearTimeout(timer);
      this.#requests.delete(controller);
    }
  }

  #configDto(value) {
    return {
      clientId: text(value?.clientId, 500),
      redirectUri: value?.redirectUri || DEFAULT_REDIRECT,
      hasClientSecret: Boolean(value?.clientSecret),
      configured: Boolean(value?.clientId && value?.clientSecret && value?.redirectUri),
    };
  }

  config() {
    return this.#run(async (generation) => this.#configDto(await this.#read(CONFIG, generation)));
  }

  configure(value) {
    return this.#run(async (generation) => {
      if (
        !plain(value) ||
        typeof value.clientId !== "string" ||
        !value.clientId.trim() ||
        value.clientId.length > 500 ||
        /[\r\n]/.test(value.clientId)
      )
        throw fail("请填写有效的 Client ID。");
      const redirect = redirectUrl(value.redirectUri);
      const old = await this.#read(CONFIG, generation);
      if (
        value.clientSecret !== undefined &&
        (typeof value.clientSecret !== "string" ||
          value.clientSecret.length > 4096 ||
          /[\r\n]/.test(value.clientSecret))
      )
        throw fail("Client Secret 格式无效。");
      const clientSecret = value.clientSecret || old?.clientSecret || "";
      if (!clientSecret) throw fail("首次配置请填写 Client Secret；它只保存在本机加密密钥库。");
      const config = { clientId: value.clientId.trim(), clientSecret, redirectUri: redirect.href };
      await this.#write([{ id: CONFIG, secret: config }], generation);
      this.#clear();
      return this.#configDto(config);
    });
  }

  async #token(config, fields, generation, old) {
    const encode = (value) => new URLSearchParams({ v: value }).toString().slice(2);
    const authorization = Buffer.from(
      `${encode(config.clientId)}:${encode(config.clientSecret)}`,
    ).toString("base64");
    const value = await this.#json(
      `${ISSUER}/oauth2/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${authorization}`,
        },
        body: new URLSearchParams(fields).toString(),
      },
      generation,
    );
    return tokensFrom(value, old);
  }

  async #profile(tokens, generation) {
    return normalizedProfile(
      await this.#json(
        `${ISSUER}/api/user`,
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
        generation,
      ),
    );
  }

  start() {
    return this.#run(async (generation) => {
      const config = await this.#read(CONFIG, generation);
      if (!this.#configDto(config).configured) throw fail("请先配置 Linux.do Connect 应用。");
      const redirect = redirectUrl(config.redirectUri);
      this.#clear();
      const session = {
        id: nonce(),
        status: "waiting",
        expiresAt: Date.now() + AUTH_TTL,
        state: nonce(),
        verifier: nonce(),
        config,
        generation,
        preview: null,
        tokens: null,
        claimed: false,
      };
      const server =
        !this.#manualLoopback &&
        createServer((req, res) => {
          void this.#callback(session, req, res);
        });
      session.server = server || null;
      if (server) {
        server.requestTimeout = 10000;
        server.headersTimeout = 10000;
        server.keepAliveTimeout = 1000;
        await new Promise((resolve, reject) => {
          server.once("error", () =>
            reject(
              fail(
                `本机回调端口 ${redirect.port} 已被占用或无法监听。请在应用和 Linux.do Connect 中同时修改登记地址。`,
              ),
            ),
          );
          server.listen(Number(redirect.port), "127.0.0.1", resolve);
        }).catch((error) => {
          this.#close(session);
          throw error;
        });
      }
      try {
        this.#assert(generation);
        this.#sessions.set(session.id, session);
        session.timer = setTimeout(() => {
          if (session.status === "waiting" || session.status === "ready") {
            session.status = "error";
            session.error = "登录授权已超时，请重新连接。";
            session.tokens = null;
            session.preview = null;
            this.#close(session);
          }
        }, AUTH_TTL);
        session.timer.unref?.();
        const authorization = new URL(`${ISSUER}/oauth2/authorize`);
        authorization.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          response_type: "code",
          scope: "openid profile email",
          state: session.state,
          code_challenge: createHash("sha256").update(session.verifier).digest("base64url"),
          code_challenge_method: "S256",
        }).toString();
        await this.#openExternal(authorization.href);
        this.#assert(generation);
        return {
          id: session.id,
          expiresAt: session.expiresAt,
          ...(this.#manualLoopback
            ? {
                manualCallback: true,
                authorizationUrl: authorization.href,
                redirectUri: config.redirectUri,
              }
            : {}),
        };
      } catch (error) {
        this.#close(session);
        this.#sessions.delete(session.id);
        throw error;
      }
    });
  }

  async finish(id, input) {
    if (!this.#manualLoopback) throw fail("当前环境不支持手动回调。");
    const session = this.#sessions.get(id);
    if (!session?.config || typeof input !== "string" || input.length > 8192)
      throw fail("授权回调已失效。");
    let url;
    try {
      url = new URL(input);
    } catch {
      throw fail("请粘贴完整回调地址。");
    }
    const redirect = new URL(session.config.redirectUri);
    if (
      url.origin !== redirect.origin ||
      url.pathname !== redirect.pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw fail("授权回调地址不匹配。");
    let status;
    await this.#callback(
      session,
      { method: "GET", url: url.pathname + url.search, headers: { host: redirect.host } },
      {
        writeHead(value) {
          status = value;
        },
        end() {},
      },
    );
    if (status !== 200) throw fail(session.error || "登录回调校验失败。");
    return this.status(id);
  }

  async #callback(session, req, res) {
    let claimedHere = false;
    const reply = (status, message) => {
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        Connection: "close",
      });
      res.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>知屿 · Linux.do</title><body><h1>${message}</h1><p>请返回知屿查看结果，此页面可以关闭。</p></body></html>`,
      );
    };
    try {
      if (
        session.status !== "waiting" ||
        session.claimed ||
        !session.config ||
        Date.now() >= session.expiresAt
      )
        return reply(409, "此登录回调已使用或已失效");
      const redirect = new URL(session.config.redirectUri);
      const url = new URL(req.url, redirect.origin);
      if (
        req.method !== "GET" ||
        req.headers.host !== redirect.host ||
        url.origin !== redirect.origin ||
        url.pathname !== CALLBACK ||
        req.url.length > 8192
      )
        return reply(400, "无效的登录回调");
      if (session.status !== "waiting" || session.claimed || Date.now() >= session.expiresAt)
        return reply(409, "此登录回调已使用或已失效");
      const states = url.searchParams.getAll("state"),
        codes = url.searchParams.getAll("code"),
        errors = url.searchParams.getAll("error");
      if (
        states.length !== 1 ||
        Buffer.byteLength(states[0]) !== Buffer.byteLength(session.state) ||
        !timingSafeEqual(Buffer.from(states[0]), Buffer.from(session.state)) ||
        codes.length > 1 ||
        errors.length > 1 ||
        (codes.length && errors.length) ||
        (!codes.length && !errors.length)
      )
        return reply(400, "登录回调校验失败");
      if (codes.length && (!codes[0] || codes[0].length > 4096))
        return reply(400, "登录授权码无效");
      session.claimed = true;
      claimedHere = true;
      this.#assert(session.generation);
      if (errors.length) throw fail("你已取消或拒绝 Linux.do 授权，可重新连接。");
      const tokens = await this.#token(
        session.config,
        {
          grant_type: "authorization_code",
          code: codes[0],
          redirect_uri: session.config.redirectUri,
          code_verifier: session.verifier,
        },
        session.generation,
      );
      if (session.status !== "waiting" || Date.now() >= session.expiresAt)
        throw fail("登录授权已取消或超时，请重新连接。");
      const profile = await this.#profile(tokens, session.generation);
      this.#assert(session.generation);
      if (session.status !== "waiting" || Date.now() >= session.expiresAt)
        throw fail("登录授权已取消或超时，请重新连接。");
      session.tokens = tokens;
      session.preview = profile;
      session.status = "ready";
      reply(200, "Linux.do 授权成功，请返回知屿确认导入");
    } catch (error) {
      if (!claimedHere) return reply(400, "无效的登录回调");
      if (session.status !== "cancelled") {
        session.status = "error";
        session.error = safeMessage(error);
      }
      session.tokens = null;
      session.preview = null;
      reply(400, "登录未完成，请返回知屿查看详情");
    } finally {
      if (claimedHere) {
        // 成功后保留预览有效期，确认前仍可取消，过期会清除内存中的令牌。
        const timer = session.timer;
        this.#close(session);
        if (session.status === "ready") {
          session.timer = setTimeout(
            () => {
              session.status = "error";
              session.error = "导入预览已过期，请重新连接。";
              session.tokens = null;
              session.preview = null;
            },
            Math.max(1, session.expiresAt - Date.now()),
          );
          session.timer.unref?.();
        }
        clearTimeout(timer);
      }
    }
  }

  status(id) {
    return this.#run(() => {
      const session = this.#sessions.get(id);
      if (!session) return { id, status: "cancelled" };
      return {
        id,
        status: session.status,
        ...(session.preview && session.status === "ready"
          ? { preview: structuredClone(session.preview) }
          : {}),
        ...(session.error ? { error: session.error } : {}),
      };
    });
  }

  cancel(id) {
    const session = this.#sessions.get(id);
    if (session) {
      session.status = "cancelled";
      session.tokens = null;
      session.preview = null;
      this.#close(session);
      this.#sessions.delete(id);
    }
    return Promise.resolve();
  }

  commit(options) {
    return this.#run(async (generation) => {
      const session = this.#sessions.get(options?.sessionId);
      const assertPreview = () => {
        this.#assert(generation);
        if (
          !session ||
          session.status !== "ready" ||
          !session.preview ||
          !session.tokens ||
          Date.now() >= session.expiresAt ||
          !this.#sessions.has(session.id)
        )
          throw fail("导入预览已失效，请重新连接 Linux.do。");
      };
      assertPreview();
      const id = assetIdFor(session.preview.subject);
      const old = await this.#read(PREFIX + id, generation);
      const assets = await this.#getAssets();
      assertPreview();
      const existing = (Array.isArray(assets) ? assets : assets?.secrets || []).find(
        (asset) => asset.id === id,
      );
      const updatedAt = new Date().toISOString();
      const asset = publicAsset(existing || old?._asset, id) || {
        id,
        name: `Linux.do · ${session.preview.name}`,
        kind: "account",
        identityProvider: "linuxdo",
        hint: "",
        value: "",
        notes: "",
        status: "online",
        lastRotated: updatedAt.slice(0, 10),
        tags: ["Linux.do"],
        ...(typeof options.folderId === "string" && options.folderId
          ? { folderId: options.folderId.slice(0, 200) }
          : {}),
      };
      const record = {
        assetId: id,
        provider: "linuxdo",
        issuer: ISSUER,
        profile: session.preview,
        tokens: session.tokens,
        updatedAt,
        posts:
          old?.profile?.username === session.preview.username
            ? old.posts || emptyPosts()
            : emptyPosts(),
        ...(old?.profile?.username === session.preview.username && old.postContents
          ? { postContents: old.postContents }
          : {}),
        _asset: asset,
      };
      await this.#vault.batch(
        [
          { id: PREFIX + id, secret: record },
          {
            id: `account:${id}`,
            merge: true,
            secret: {
              username: record.profile.username,
              url: record.profile.profileUrl,
              updatedAt,
            },
          },
        ],
        { beforeCommit: assertPreview },
      );
      this.#assert(generation);
      session.status = "cancelled";
      session.tokens = null;
      session.preview = null;
      this.#close(session);
      this.#sessions.delete(session.id);
      return { account: publicAccount(record), asset };
    });
  }

  async #record(id, generation) {
    if (typeof id !== "string" || !/^secret-linuxdo-[a-f0-9]{32}$/.test(id))
      throw fail("Linux.do 账号标识无效。");
    const record = await this.#read(PREFIX + id, generation);
    if (
      record &&
      (record.assetId !== id ||
        record.issuer !== ISSUER ||
        assetIdFor(record.profile?.subject) !== id)
    )
      throw fail("Linux.do 账号记录无效，请重新连接。");
    return record;
  }

  get(assetId) {
    return this.#run(async (generation) => {
      const record = await this.#record(assetId, generation);
      return record ? publicAccount(record) : null;
    });
  }

  refresh(assetId) {
    return this.#run(async (generation) => {
      const record = await this.#record(assetId, generation);
      if (!record?.tokens?.accessToken)
        throw fail("此账号已断开，请重新连接 Linux.do 后刷新资料。");
      let tokens = record.tokens;
      let refreshed = false;
      const renew = async () => {
        if (!tokens.refreshToken) throw fail("Linux.do 授权已过期，请重新连接。");
        const config = await this.#read(CONFIG, generation);
        if (!this.#configDto(config).configured) throw fail("请先配置 Linux.do Connect 应用。");
        tokens = await this.#token(
          config,
          { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
          generation,
          tokens,
        );
        refreshed = true;
      };
      if (tokens.expiresAt && tokens.expiresAt <= Date.now() + 30_000) await renew();
      let profile;
      try {
        profile = await this.#profile(tokens, generation);
      } catch (error) {
        if (error.status !== 401 || refreshed || !tokens.refreshToken) throw error;
        await renew();
        profile = await this.#profile(tokens, generation);
      }
      if (profile.subject !== record.profile.subject)
        throw fail("Linux.do 返回了不同账号的身份，已拒绝覆盖原账号。");
      const updatedAt = new Date().toISOString();
      const updated = {
        ...record,
        tokens,
        profile,
        updatedAt,
        posts: profile.username === record.profile.username ? record.posts : emptyPosts(),
        postContents: profile.username === record.profile.username ? record.postContents || {} : {},
      };
      await this.#write(
        [
          { id: PREFIX + assetId, secret: updated },
          {
            id: `account:${assetId}`,
            merge: true,
            secret: {
              username: profile.username,
              url: profile.profileUrl,
              updatedAt,
            },
          },
        ],
        generation,
      );
      return publicAccount(updated);
    });
  }

  loadPosts(assetId, options = {}) {
    return this.#run(async (generation) => {
      const record = await this.#record(assetId, generation);
      if (!record) throw fail("未找到此 Linux.do 账号，请重新导入。");
      const posts = record.posts || emptyPosts();
      if (
        !options.force &&
        posts.status === "unavailable" &&
        record.postsAttemptedAt &&
        Date.now() - Date.parse(record.postsAttemptedAt) < POSTS_TTL
      )
        return publicAccount(record);
      if (
        !options.force &&
        !options.more &&
        posts.fetchedAt &&
        Date.now() - Date.parse(posts.fetchedAt) < POSTS_TTL
      )
        return publicAccount(record);
      if (options.more && !options.force && (!posts.hasMore || posts.items.length >= MAX_POSTS))
        return publicAccount(record);
      const offset = options.more && !options.force ? posts.nextOffset : 0;
      const url = new URL("https://linux.do/user_actions.json");
      url.search = new URLSearchParams({
        username: record.profile.username,
        filter: "4,5",
        offset: String(offset),
        limit: String(PAGE_SIZE),
      }).toString();
      let next;
      try {
        const data = await this.#json(url.href, {}, generation, true);
        if (!Array.isArray(data.user_actions) || data.user_actions.length > 100)
          throw fail("Linux.do 返回的帖子列表无效；已保留上次缓存。");
        const incoming = data.user_actions
          .map((post) => postFrom(post, record.profile.username))
          .filter(Boolean);
        const items = [
          ...new Map(
            [...(offset ? posts.items : []), ...incoming].map((post) => [post.id, post]),
          ).values(),
        ].slice(0, MAX_POSTS);
        next = {
          items,
          fetchedAt: new Date().toISOString(),
          status: "ready",
          message: "仅包含接口返回的公开主题和回复，不含私信或受限帖子。",
          nextOffset: offset + data.user_actions.length,
          hasMore: data.user_actions.length >= PAGE_SIZE && items.length < MAX_POSTS,
        };
      } catch (error) {
        this.#assert(generation);
        next = { ...posts, status: "unavailable", message: safeMessage(error) };
      }
      const updated = {
        ...record,
        posts: next,
        postsAttemptedAt: new Date().toISOString(),
        ...(options.force && next.status === "ready"
          ? {
              postContents: Object.fromEntries(
                Object.entries(record.postContents || {}).filter(([, cached]) => !cached.error),
              ),
            }
          : {}),
      };
      await this.#write([{ id: PREFIX + assetId, secret: updated }], generation);
      return publicAccount(updated);
    });
  }

  /** 按用户选择读取自己的公开帖子全文；摘要永远不能替代获取失败的正文。 */
  readPosts(assetId, postIds, options = {}) {
    return this.#run(async (generation) => {
      const record = await this.#record(assetId, generation);
      if (!record) throw fail("未找到此 Linux.do 账号，请重新导入。");
      if (
        !Array.isArray(postIds) ||
        !postIds.length ||
        postIds.length > 20 ||
        postIds.some((id) => typeof id !== "string")
      )
        throw fail("每次请选择 1–20 篇已加载的公开帖子读取正文。");
      const selected = [...new Set(postIds)].map((id) => {
        const post = record.posts?.items?.find((item) => item.id === id);
        if (!post) throw fail("部分帖子已不在列表中，请刷新列表后重新选择。");
        return post;
      });
      const cache = { ...(plain(record.postContents) ? record.postContents : {}) };
      const results = new Array(selected.length);
      let cursor = 0;
      const readOne = async (post) => {
        const cached = cache[post.id];
        if (
          !options.force &&
          cached &&
          cached.postId === post.postId &&
          Date.now() - Date.parse(cached.fetchedAt) < POSTS_TTL
        )
          return { post, ...cached };
        const fetchedAt = new Date().toISOString();
        try {
          if (!Number.isSafeInteger(post.postId) || post.postId < 1)
            throw fail("此条旧缓存缺少帖子编号，请先刷新公开帖子列表再导入正文。");
          const data = await this.#json(
            `https://linux.do/posts/${post.postId}.json`,
            {},
            generation,
            true,
          );
          if (
            data.id !== post.postId ||
            data.topic_id !== Number(post.id.split(":")[0]) ||
            data.post_number !== Number(post.id.split(":")[1]) ||
            typeof data.username !== "string" ||
            data.username.toLowerCase() !== record.profile.username.toLowerCase()
          )
            throw fail("帖子编号或作者与所选身份不一致，未导入正文。");
          if (
            /^[1-9]\d*$/.test(record.profile.subject) &&
            Number.isSafeInteger(data.user_id) &&
            String(data.user_id) !== record.profile.subject
          )
            throw fail("帖子作者的用户标识不一致，未导入正文。");
          let content, format;
          if (typeof data.raw === "string" && data.raw.trim()) {
            content = data.raw;
            format = "markdown";
          } else if (typeof data.cooked === "string" && data.cooked.trim()) {
            content = convert(data.cooked, {
              wordwrap: false,
              selectors: [
                { selector: "img", format: "skip" },
                { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
              ],
            });
            format = "text";
          }
          if (!content?.trim())
            throw fail("平台未提供此帖完整正文，请打开原帖查看；不会将摘要当作全文导入。");
          // 过大内容明确失败，不静默截断成看似完整的文章。
          if (Buffer.byteLength(content, "utf8") > 256 * 1024)
            throw fail("此帖正文超过 256 KiB，请打开原帖查看或手动导入文档。");
          return { post, postId: post.postId, content, format, fetchedAt };
        } catch (error) {
          this.#assert(generation);
          return { post, postId: post.postId, fetchedAt, error: safeMessage(error) };
        }
      };
      const worker = async () => {
        while (cursor < selected.length) {
          const index = cursor++;
          results[index] = await readOne(selected[index]);
          this.#assert(generation);
        }
      };
      await Promise.all([worker(), worker()]);
      this.#assert(generation);
      for (const result of results) {
        const { post, ...stored } = result;
        cache[post.id] = stored;
      }
      // 只保留当前列表最多 200 篇的短期正文缓存，身份普通读取不返回这些全文。
      const currentIds = new Set((record.posts?.items || []).map((post) => post.id));
      const postContents = Object.fromEntries(
        Object.entries(cache).filter(
          ([id, value]) =>
            currentIds.has(id) && Date.now() - Date.parse(value.fetchedAt) < POSTS_TTL,
        ),
      );
      await this.#write(
        [{ id: PREFIX + assetId, secret: { ...record, postContents } }],
        generation,
      );
      return {
        items: results
          .filter((result) => !result.error)
          .map(({ post, content, format, fetchedAt }) => ({ post, content, format, fetchedAt })),
        errors: results
          .filter((result) => result.error)
          .map(({ post, error }) => ({ id: post.id, message: error })),
      };
    });
  }

  disconnect(assetId) {
    return this.#run(async (generation) => {
      const record = await this.#record(assetId, generation);
      if (!record) throw fail("未找到此 Linux.do 账号。");
      const updated = { ...record, tokens: null };
      await this.#write([{ id: PREFIX + assetId, secret: updated }], generation);
      return publicAccount(updated);
    });
  }

  managedAssets() {
    return this.#run(async (generation) => {
      const records = await this.#vault.readAll(PREFIX);
      this.#assert(generation);
      return Object.entries(records).flatMap(([key, record]) => {
        const id = key.slice(PREFIX.length);
        if (
          record.issuer !== ISSUER ||
          record.assetId !== id ||
          assetIdFor(record.profile?.subject) !== id
        )
          return [];
        const asset = publicAsset(record._asset, id);
        return asset ? [asset] : [];
      });
    });
  }

  remove(assetId) {
    return this.#run(async (generation) => {
      await this.#record(assetId, generation);
      // 身份、账号与验证码必须一起删除，失败时不能只丢失其中一项。
      try {
        await this.#vault.removeMany([PREFIX + assetId, `account:${assetId}`, `totp:${assetId}`], {
          beforeCommit: () => this.#assert(generation),
        });
      } catch {
        this.#assert(generation);
        throw fail("账号删除失败，身份、账号和验证码记录均已保留。请检查本地文件权限后重试。");
      }
      this.#assert(generation);
    });
  }
}
