import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { ResearchError } from "./research-service.mjs";

const ISSUER = "https://connect.linux.do";
const CALLBACK = "/oauth/linuxdo/callback";
const DESKTOP_CALLBACK = "/oauth/zhiyu/callback";
const AUTH_TTL = 5 * 60_000;
const HANDOFF_TTL = 60_000;
const SESSION_TTL = 30 * 86400_000;
const BODY_LIMIT = 16_384;
const PROVIDER_LIMIT = 1024 * 1024;
const PURPOSE = "zhiyu-linuxdo-primary-identity:v1";
const nonce = () => randomBytes(32).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value).digest("base64url");
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const hasInvisible = (value) =>
  Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127);
const cleanText = (value, max = 300) =>
  typeof value === "string"
    ? Array.from(value)
        .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
        .join("")
        .slice(0, max)
    : "";

class LoginError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalid = () => new LoginError(400, "invalid_request", "登录请求无效，请回到知屿重新登录。");
const expired = () =>
  new LoginError(401, "session_expired", "登录状态已失效，请重新使用 Linux.do 登录。");
const unavailable = () =>
  new LoginError(502, "provider_unavailable", "Linux.do 暂时无法连接，请稍后重试。");

function normalizeConfig(config) {
  const rawOrigin = config.publicOrigin || "https://auth.allinsong.top";
  let origin;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new Error("PUBLIC_ORIGIN 必须是 HTTPS 域名。");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !origin.hostname.includes(".")
  )
    throw new Error("PUBLIC_ORIGIN 必须是没有路径或端口的 HTTPS 域名。");
  const clientId = typeof config.clientId === "string" ? config.clientId.trim() : "";
  const clientSecret = typeof config.clientSecret === "string" ? config.clientSecret : "";
  if (clientId.length > 500 || clientSecret.length > 4096 || /[\r\n]/.test(clientId + clientSecret))
    throw new Error("Linux.do 应用配置格式无效。");
  let key = null;
  if (config.sessionEncryptionKey) {
    if (
      typeof config.sessionEncryptionKey !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(config.sessionEncryptionKey)
    )
      throw new Error("SESSION_ENCRYPTION_KEY 必须是 32 字节随机密钥的 Base64 编码。");
    key = Buffer.from(config.sessionEncryptionKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== config.sessionEncryptionKey)
      throw new Error("SESSION_ENCRYPTION_KEY 格式无效。");
  }
  return {
    publicOrigin: origin.origin,
    clientId,
    clientSecret,
    key,
    configured: Boolean(clientId && clientSecret && key),
    trustCloudflareProxy: config.trustCloudflareProxy === true,
  };
}

function desktopRedirect(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    typeof value !== "string" ||
    url.href !== value ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^\d+$/.test(url.port) ||
    Number(url.port) < 1024 ||
    Number(url.port) > 65535 ||
    url.pathname !== DESKTOP_CALLBACK ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw invalid();
  return url.href;
}

function normalizedProfile(value) {
  if (!plain(value)) throw unavailable();
  const rawSubject = value.sub ?? value.id;
  const subject =
    Number.isSafeInteger(rawSubject) && rawSubject > 0 ? String(rawSubject) : rawSubject;
  if (typeof subject !== "string" || !subject || subject.length > 200 || hasInvisible(subject))
    throw unavailable();
  const username = value.username ?? value.preferred_username;
  if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(username))
    throw unavailable();
  let avatarUrl = null;
  try {
    const raw = value.avatar_url ?? value.picture ?? value.avatar_template;
    if (typeof raw === "string" && raw.length > 0 && raw.length < 2000) {
      const avatar = new URL(raw.replaceAll("{size}", "120"), "https://linux.do");
      if (
        avatar.protocol === "https:" &&
        (avatar.hostname === "linux.do" || avatar.hostname.endsWith(".linux.do")) &&
        !avatar.username &&
        !avatar.password &&
        !avatar.port
      )
        avatarUrl = avatar.href;
    }
  } catch {
    /* 无效头像不影响身份绑定。 */
  }
  const email = cleanText(value.email, 320);
  return {
    subject,
    username,
    name: cleanText(value.name) || username,
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

function tokensFrom(value, previous, now) {
  const valid = (token) =>
    typeof token === "string" && token.length > 0 && token.length <= 8192 && !hasInvisible(token);
  if (
    !plain(value) ||
    !valid(value.access_token) ||
    (value.token_type && String(value.token_type).toLowerCase() !== "bearer") ||
    (value.refresh_token !== undefined && value.refresh_token !== "" && !valid(value.refresh_token))
  )
    throw unavailable();
  const lifetime = Number(value.expires_in);
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token || previous?.refreshToken || "",
    expiresAt:
      Number.isFinite(lifetime) && lifetime > 0
        ? now + Math.min(lifetime, 365 * 86400) * 1000
        : null,
  };
}

async function requestBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || ""))
    throw new LoginError(415, "unsupported_media_type", "请使用 JSON 格式提交登录请求。");
  if (Number(req.headers["content-length"]) > BODY_LIMIT)
    throw new LoginError(413, "request_too_large", "登录请求过大。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new LoginError(413, "request_too_large", "登录请求过大。");
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (plain(data)) return data;
  } catch {
    /* 仅返回固定错误文本。 */
  }
  throw invalid();
}

function headers(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
}
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function html(res, status, message) {
  // message 仅由服务端固定文案组成，不插入请求、令牌、用户资料或上游错误。
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知屿 · Linux.do 登录</title><style>body{margin:0;background:#f2f6f8;color:#183c43;font:16px/1.8 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}main{max-width:520px;margin:24px;padding:40px;border:1px solid #dae4e8;border-radius:24px;background:white;box-shadow:0 16px 50px #173a4412}h1{margin:0 0 16px;font-size:28px}p{margin:0;color:#52676d}</style><main><h1>知屿 Zhiyu</h1><p>${message}</p></main></html>`,
  );
}

/** 独立登录中转服务；外部令牌仅存在服务端内存或经过认证加密的凭据中。 */
export function createIdentityLoginServer({
  config = {},
  fetchImpl = fetch,
  now = Date.now,
  limits = {},
  onDiagnostic = () => {},
  research = null,
} = {}) {
  const settings = normalizeConfig(config);
  const pending = new Map();
  const handoffs = new Map();
  const rates = new Map();
  const maxPending = limits.maxPending ?? 1024;
  const maxHandoffs = limits.maxHandoffs ?? 1024;
  const maxConcurrent = limits.maxConcurrent ?? 64;
  const rateLimit = limits.rateLimit ?? 120;
  const maxRateKeys = limits.maxRateKeys ?? 4096;
  const timeoutMs = limits.providerTimeoutMs ?? 15_000;
  let active = 0;
  const aad = Buffer.from(`${PURPOSE}\n${settings.publicOrigin}`);
  const callback = `${settings.publicOrigin}${CALLBACK}`;

  function clean() {
    const stamp = now();
    for (const map of [pending, handoffs, rates])
      for (const [key, entry] of map) if (entry.expiresAt <= stamp) map.delete(key);
  }
  function requireConfiguration() {
    if (!settings.configured)
      throw new LoginError(
        503,
        "not_configured",
        "知屿登录服务尚未配置 Linux.do 应用，请稍后重试。",
      );
  }
  function rate(req) {
    let key = req.socket.remoteAddress || "unknown";
    const cloudflareIp = req.headers["cf-connecting-ip"];
    if (
      settings.trustCloudflareProxy &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(key) &&
      typeof cloudflareIp === "string" &&
      isIP(cloudflareIp)
    )
      key = cloudflareIp;
    let value = rates.get(key);
    if (!value) {
      if (rates.size >= maxRateKeys)
        throw new LoginError(503, "service_busy", "登录服务繁忙，请稍后重试。");
      value = { count: 0, expiresAt: now() + 60_000 };
      rates.set(key, value);
    }
    if (++value.count > rateLimit)
      throw new LoginError(429, "rate_limited", "请求过于频繁，请一分钟后重试。");
  }
  function seal(payload) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", settings.key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
  }
  function unseal(credential) {
    try {
      if (
        typeof credential !== "string" ||
        credential.length > 32768 ||
        !/^v1\.[A-Za-z0-9_-]+$/.test(credential)
      )
        throw expired();
      const bytes = Buffer.from(credential.slice(3), "base64url");
      if (bytes.length < 29 || bytes.toString("base64url") !== credential.slice(3)) throw expired();
      const decipher = createDecipheriv("aes-256-gcm", settings.key, bytes.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(bytes.subarray(12, 28));
      const value = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
      );
      if (
        value.purpose !== PURPOSE ||
        !Number.isSafeInteger(value.issuedAt) ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.issuedAt > now() ||
        value.expiresAt <= now() ||
        value.expiresAt > value.issuedAt + SESSION_TTL ||
        typeof value.subject !== "string" ||
        !plain(value.tokens) ||
        !value.tokens.accessToken
      )
        throw expired();
      return value;
    } catch {
      throw expired();
    }
  }
  async function provider(path, options = {}) {
    const controller = new AbortController();
    const diagnostic = {
      stage: path === "/oauth2/token" ? "token" : "profile",
      reason: "network_error",
      httpStatus: null,
      contentType: "missing",
      challenge: false,
    };
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${ISSUER}${path}`, {
        ...options,
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: { Accept: "application/json", ...options.headers },
      });
      diagnostic.httpStatus = response.status;
      const contentType = response.headers.get("content-type") || "";
      diagnostic.contentType = /^application\/json\b/i.test(contentType)
        ? "json"
        : /^text\/html\b/i.test(contentType)
          ? "html"
          : contentType
            ? "other"
            : "missing";
      diagnostic.challenge = response.headers.get("cf-mitigated") === "challenge";
      if (!response.ok) {
        diagnostic.reason = "http_error";
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw expired();
        throw unavailable();
      }
      if (Number(response.headers.get("content-length")) > PROVIDER_LIMIT) {
        diagnostic.reason = "response_too_large";
        await response.body?.cancel();
        throw unavailable();
      }
      const parts = [];
      let size = 0;
      if (!response.body) {
        diagnostic.reason = "empty_response";
        throw unavailable();
      }
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > PROVIDER_LIMIT) {
            diagnostic.reason = "response_too_large";
            await reader.cancel();
            throw unavailable();
          }
          parts.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      diagnostic.reason = "invalid_json";
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch (error) {
      if (controller.signal.aborted) diagnostic.reason = "timeout";
      const networkCode = error?.cause?.code ?? error?.code;
      if (
        [
          "ENOTFOUND",
          "EAI_AGAIN",
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "ENETUNREACH",
          "EHOSTUNREACH",
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT",
          "CERT_HAS_EXPIRED",
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
        ].includes(networkCode)
      )
        diagnostic.networkCode = networkCode;
      const failure = error instanceof LoginError ? error : unavailable();
      failure.diagnostic = diagnostic;
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
  async function token(fields, previous) {
    const encode = (value) => new URLSearchParams({ value }).toString().slice(6);
    const basic = Buffer.from(
      `${encode(settings.clientId)}:${encode(settings.clientSecret)}`,
    ).toString("base64");
    return tokensFrom(
      await provider("/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams(fields).toString(),
      }),
      previous,
      now(),
    );
  }
  const user = async (tokens) =>
    normalizedProfile(
      await provider("/api/user", { headers: { Authorization: `Bearer ${tokens.accessToken}` } }),
    );
  function redirect(res, session, fields) {
    const target = new URL(session.redirectUri);
    target.search = new URLSearchParams({ ...fields, state: session.state }).toString();
    res.setHeader("Location", target.href);
    html(res, 302, "正在返回知屿。若未自动返回，请重新打开软件继续。");
  }
  async function completeAuthorization(url, res) {
    const params = url.searchParams;
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) throw invalid();
    const state = params.get("state");
    if (!identifier(state)) throw invalid();
    const session = pending.get(state);
    if (!session || session.expiresAt <= now()) throw invalid();
    pending.delete(state);
    if (params.has("error")) {
      redirect(res, session, {
        error: params.get("error") === "access_denied" ? "access_denied" : "login_failed",
      });
      return;
    }
    const code = params.get("code");
    if (!code || code.length > 4096 || hasInvisible(code)) {
      redirect(res, session, { error: "login_failed" });
      return;
    }
    let stage = "token";
    try {
      const tokens = await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: callback,
        code_verifier: session.verifier,
      });
      stage = "profile";
      const profile = await user(tokens);
      stage = "handoff";
      if (session.expiresAt <= now() || handoffs.size >= maxHandoffs) throw invalid();
      const handoff = nonce();
      handoffs.set(handoff, {
        challenge: session.challenge,
        profile,
        tokens,
        expiresAt: now() + HANDOFF_TTL,
      });
      redirect(res, session, { code: handoff });
    } catch (error) {
      // 仅输出固定分类和状态，不记录 URL、上游正文、凭据或任何用户资料。
      const diagnostic =
        error instanceof LoginError && error.diagnostic
          ? error.diagnostic
          : {
              stage,
              reason:
                stage === "token"
                  ? "invalid_token"
                  : stage === "profile"
                    ? "invalid_profile"
                    : "handoff_unavailable",
            };
      try {
        onDiagnostic(diagnostic);
      } catch {
        // 诊断输出失败不能阻止浏览器返回客户端。
      }
      redirect(res, session, { error: "login_failed" });
    }
  }
  async function route(req, res) {
    headers(res);
    clean();
    const address = server.address();
    const acceptedHosts = [
      new URL(settings.publicOrigin).host,
      ...(req.url === "/healthz" && address && typeof address !== "string"
        ? [`127.0.0.1:${address.port}`]
        : []),
    ];
    if (
      !acceptedHosts.includes(req.headers.host) ||
      !req.url?.startsWith("/") ||
      req.url.startsWith("//") ||
      req.url.length > 8192
    )
      throw invalid();
    const url = new URL(req.url, settings.publicOrigin);
    if (url.origin !== settings.publicOrigin) throw invalid();
    if (
      url.pathname !== CALLBACK &&
      req.headers.origin &&
      req.headers.origin !== settings.publicOrigin
    )
      throw new LoginError(403, "origin_rejected", "不允许来自其他网站的登录请求。");
    if (req.method !== "GET" && req.headers["sec-fetch-site"] === "cross-site")
      throw new LoginError(403, "origin_rejected", "不允许跨站提交登录请求。");
    const getPaths = [
      "/",
      "/healthz",
      CALLBACK,
      "/v1/research/payment/notify",
      "/v1/research/payment/return",
    ];
    const researchPaths = [
      "/v1/research/quota",
      "/v1/research/records",
      "/v1/research/start",
      "/v1/research/status",
      "/v1/research/cancel",
      "/v1/research/checkout",
    ];
    const postPaths = [
      "/v1/login/start",
      "/v1/login/exchange",
      "/v1/session/profile",
      ...researchPaths,
    ];
    if (!getPaths.includes(url.pathname) && !postPaths.includes(url.pathname))
      throw new LoginError(404, "not_found", "请求的页面不存在。");
    if (
      (getPaths.includes(url.pathname) && req.method !== "GET") ||
      (postPaths.includes(url.pathname) && req.method !== "POST")
    )
      throw new LoginError(405, "method_not_allowed", "该接口不支持此请求方式。");
    if (
      url.pathname !== CALLBACK &&
      !url.pathname.startsWith("/v1/research/payment/") &&
      url.search
    )
      throw invalid();
    if (url.pathname === "/healthz") {
      json(res, 200, {
        ok: true,
        configured: settings.configured,
        ...(research ? { researchConfigured: true } : {}),
      });
      return;
    }
    if (url.pathname === "/") {
      html(res, 200, "Linux.do 主身份登录服务。请在知屿的欢迎页面或个人资料中发起登录。");
      return;
    }
    rate(req);
    requireConfiguration();
    if (url.pathname === "/v1/research/payment/return") {
      html(res, 200, "积分确认已返回。请回到知屿刷新检索结果；是否支付成功以服务端核实结果为准。");
      return;
    }
    if (url.pathname === "/v1/research/payment/notify") {
      if (!research) throw new LoginError(503, "research_unavailable", "联网检索尚未启用。");
      const parameters = Object.fromEntries(url.searchParams);
      if (Object.keys(parameters).length !== [...url.searchParams].length) throw invalid();
      await research.notify(parameters);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("success");
      return;
    }
    if (url.pathname === CALLBACK) {
      await completeAuthorization(url, res);
      return;
    }
    const body = await requestBody(req);
    if (researchPaths.includes(url.pathname)) {
      if (!research)
        throw new LoginError(
          503,
          "research_unavailable",
          "站点尚未配置 Exa 检索服务，未产生积分支付。",
        );
      const authorization = req.headers.authorization;
      if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
        throw expired();
      const session = unseal(authorization.slice(7));
      const method = url.pathname.split("/").at(-1);
      const result =
        method === "quota"
          ? research.quota(session.subject)
          : method === "records"
            ? research.records(session.subject, body)
            : method === "start"
              ? research.start(session.subject, body)
              : await research[method](session.subject, body.id);
      json(res, 200, result);
      return;
    }
    if (url.pathname === "/v1/login/start") {
      const redirectUri = desktopRedirect(body.redirectUri);
      if (!identifier(body.state) || !identifier(body.challenge)) throw invalid();
      if (pending.size >= maxPending)
        throw new LoginError(503, "service_busy", "登录服务繁忙，请稍后重试。");
      const state = nonce();
      const verifier = nonce();
      const id = nonce();
      const expiresAt = now() + AUTH_TTL;
      pending.set(state, {
        id,
        state: body.state,
        challenge: body.challenge,
        redirectUri,
        verifier,
        expiresAt,
      });
      const authorize = new URL(`${ISSUER}/oauth2/authorize`);
      authorize.search = new URLSearchParams({
        client_id: settings.clientId,
        redirect_uri: callback,
        response_type: "code",
        scope: "openid profile email",
        state,
        code_challenge: sha256(verifier),
        code_challenge_method: "S256",
      }).toString();
      json(res, 200, { id, authorizationUrl: authorize.href, expiresAt });
      return;
    }
    if (url.pathname === "/v1/login/exchange") {
      if (
        !identifier(body.code) ||
        typeof body.verifier !== "string" ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier)
      )
        throw invalid();
      const handoff = handoffs.get(body.code);
      if (
        !handoff ||
        handoff.expiresAt <= now() ||
        !timingSafeEqual(Buffer.from(handoff.challenge), Buffer.from(sha256(body.verifier)))
      )
        throw invalid();
      handoffs.delete(body.code);
      const expiresAt = now() + SESSION_TTL;
      const payload = {
        purpose: PURPOSE,
        issuedAt: now(),
        expiresAt,
        subject: handoff.profile.subject,
        tokens: handoff.tokens,
      };
      json(res, 200, { credential: seal(payload), profile: handoff.profile, expiresAt });
      return;
    }
    const match = /^Bearer (v1\.[A-Za-z0-9_-]+)$/.exec(req.headers.authorization || "");
    if (!match) throw expired();
    const payload = unseal(match[1]);
    let tokens = payload.tokens;
    let refreshed = false;
    const refresh = async () => {
      if (!tokens.refreshToken) throw expired();
      tokens = await token(
        { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
        tokens,
      );
      refreshed = true;
    };
    if (tokens.expiresAt !== null && tokens.expiresAt <= now() + 15_000) await refresh();
    let profile;
    try {
      profile = await user(tokens);
    } catch (error) {
      if (
        !(error instanceof LoginError) ||
        error.status !== 401 ||
        refreshed ||
        !tokens.refreshToken
      )
        throw error;
      await refresh();
      profile = await user(tokens);
    }
    if (profile.subject !== payload.subject || payload.expiresAt <= now()) throw expired();
    json(res, 200, {
      credential: seal({ ...payload, tokens }),
      profile,
      expiresAt: payload.expiresAt,
    });
  }
  const server = createServer({ maxHeaderSize: 65536 }, (req, res) => {
    if (active >= maxConcurrent) {
      headers(res);
      json(res, 503, { error: "service_busy", message: "登录服务繁忙，请稍后重试。" });
      return;
    }
    active++;
    void route(req, res)
      .catch((error) => {
        if (res.destroyed || res.headersSent) return;
        const safe =
          error instanceof LoginError || error instanceof ResearchError
            ? error
            : new LoginError(500, "internal_error", "登录服务暂时不可用，请稍后重试。");
        if (safe.status === 429) res.setHeader("Retry-After", "60");
        if ([413, 415].includes(safe.status)) res.setHeader("Connection", "close");
        if (req.url?.startsWith(CALLBACK))
          html(res, safe.status, "登录已过期或无法验证。请回到知屿重新发起登录。");
        else json(res, safe.status, { error: safe.code, message: safe.message });
      })
      .finally(() => {
        active--;
      });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.timeout = 35_000;
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 64;
  server.once("close", () => {
    pending.clear();
    handoffs.clear();
    rates.clear();
  });
  return server;
}
