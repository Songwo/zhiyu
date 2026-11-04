import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

// 协议参数核对自 sub2api v0.2.1；供应商接口变更时独立维护适配器。
export const AI_PROVIDERS = {
  grok: {
    name: "xAI / Grok",
    mode: "loopback",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorize: "https://auth.x.ai/oauth2/authorize",
    token: "https://auth.x.ai/oauth2/token",
    redirect: "http://127.0.0.1:56121/callback",
    scope: "openid profile email offline_access grok-cli:access api:access",
    userinfo: "https://auth.x.ai/oauth2/userinfo",
    usage: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    monthlyUsage: "https://cli-chat-proxy.grok.com/v1/billing",
  },
  gemini: {
    name: "Google / Gemini",
    mode: "loopback",
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    // Gemini CLI 随客户端公开分发的桌面 OAuth 参数，不是用户 API Key。
    clientSecret: "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",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    redirect: "http://localhost:0/oauth2callback",
    scope:
      "openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    usage: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    profile: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  },
  openai: {
    name: "OpenAI / ChatGPT",
    mode: "loopback",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorize: "https://auth.openai.com/oauth/authorize",
    token: "https://auth.openai.com/oauth/token",
    redirect: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
    usage: "https://chatgpt.com/backend-api/wham/usage",
  },
  claude: {
    name: "Anthropic / Claude",
    mode: "code",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorize: "https://claude.com/cai/oauth/authorize",
    token: "https://platform.claude.com/v1/oauth/token",
    redirect: "https://platform.claude.com/oauth/code/callback",
    scope:
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    usage: "https://api.anthropic.com/api/oauth/usage",
  },
};
const nonce = () => randomBytes(32).toString("base64url");
const PREFIX = "ai-oauth:";
const iso = (value) => {
  if (value == null || value === "") return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const str = (value) => (typeof value === "string" ? value.slice(0, 300) : "");
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => (Array.isArray(value) ? value : []);
const amount = (value) => {
  const raw = typeof value === "object" && value !== null ? value.val : value;
  if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw)))
    return undefined;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? number
    : undefined;
};
const percentage = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const USAGE_SCOPE = {
  openai: {
    source: "openai-wham",
    scope: "codex",
    scopeNote: "此处为 Codex 额度，不包含 ChatGPT 网页聊天、图片或深度研究的分类额度。",
  },
  claude: {
    source: "anthropic-oauth",
    scope: "claude",
    scopeNote: "此处为 Claude OAuth 返回的共享窗口及模型额度；服务商未提供完整的网页功能用量明细。",
  },
  grok: {
    source: "xai-cli-billing",
    scope: "grok-cli",
    scopeNote: "此处为 Grok CLI 周额度、产品额度与月度账单，不等同于 Grok 网页所有功能权益。",
  },
  gemini: {
    source: "google-code-assist",
    scope: "code-assist",
    scopeNote:
      "此处为 Gemini CLI / Code Assist 模型额度，不包含 Gemini 网页或 Google One 全部权益。",
  },
};
class AiServiceError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const safeFailure = (error) =>
  error instanceof AiServiceError
    ? error
    : new AiServiceError("REQUEST_FAILED", "额度刷新失败，请检查网络后重试。");

export function normalizeUsage(provider, value, { checkedAt = new Date().toISOString() } = {}) {
  value = object(value);
  const windows = [];
  if (provider === "openai") {
    const addRateLimit = (prefix, limit, model) => {
      for (const [label, entry] of Object.entries(object(limit))) {
        if (percentage(entry?.used_percent) === null) continue;
        windows.push({
          label: prefix ? `${prefix}/${label}` : label,
          usedPercent: entry.used_percent,
          resetsAt:
            iso(entry.reset_at) ??
            (amount(entry.reset_after_seconds) === undefined
              ? null
              : iso(Date.parse(checkedAt) / 1000 + Number(entry.reset_after_seconds))),
          ...(amount(entry.limit_window_seconds) === undefined
            ? {}
            : { windowSeconds: entry.limit_window_seconds }),
          ...(model ? { model } : {}),
        });
      }
    };
    addRateLimit("", value.rate_limit);
    addRateLimit("code_review", value.code_review_rate_limit);
    for (const entry of array(value.additional_rate_limits)) {
      addRateLimit(
        str(entry?.limit_name) || str(entry?.metered_feature) || "additional",
        entry?.rate_limit,
        str(entry?.normal_model_slug) || str(entry?.metered_feature),
      );
    }
    const balance = amount(value.credits?.balance);
    if (balance !== undefined && value.credits?.unlimited !== true)
      windows.push({
        label: "credits",
        usedPercent: null,
        remaining: balance,
        unit: "credits",
        resetsAt: null,
      });
  } else if (provider === "grok") {
    const config = object(value.config);
    if (percentage(config.creditUsagePercent) !== null)
      windows.push({
        label: "weekly",
        usedPercent: config.creditUsagePercent,
        resetsAt: iso(config.currentPeriod?.end),
      });
    for (const entry of array(config.productUsage))
      if (percentage(entry?.usagePercent) !== null)
        windows.push({
          label: `product/${str(entry.product)}`,
          usedPercent: entry.usagePercent,
          resetsAt: iso(config.currentPeriod?.end),
        });
    for (const [label, usedValue, limitValue, divisor] of [
      ["monthly", config.used, config.monthlyLimit, 100],
      ["on_demand", config.onDemandUsed, config.onDemandCap, 1],
    ]) {
      const used = amount(usedValue),
        limit = amount(limitValue);
      if (used !== undefined || limit !== undefined)
        windows.push({
          label,
          usedPercent: used !== undefined && limit > 0 ? (used / limit) * 100 : null,
          ...(used === undefined ? {} : { used: used / divisor }),
          ...(limit === undefined ? {} : { limit: limit / divisor }),
          unit: "USD",
          resetsAt: iso(config.billingPeriodEnd),
        });
    }
    const prepaid = amount(config.prepaidBalance);
    if (prepaid !== undefined)
      windows.push({
        label: "prepaid",
        usedPercent: null,
        remaining: prepaid,
        unit: "USD",
        resetsAt: null,
      });
  } else if (provider === "gemini") {
    for (const entry of array(value.buckets)) {
      const fraction =
        typeof entry?.remainingFraction === "number" &&
        entry.remainingFraction >= 0 &&
        entry.remainingFraction <= 1
          ? entry.remainingFraction
          : undefined;
      const remaining = amount(entry?.remainingAmount);
      if (fraction !== undefined || remaining !== undefined)
        windows.push({
          label: `${str(entry.modelId)} ${str(entry.tokenType)}`.trim(),
          usedPercent: fraction === undefined ? null : Math.round((1 - fraction) * 10000) / 100,
          resetsAt: iso(entry.resetTime),
          ...(remaining === undefined ? {} : { remaining }),
          ...(str(entry.tokenType) ? { unit: str(entry.tokenType) } : {}),
          ...(str(entry.modelId) ? { model: str(entry.modelId) } : {}),
        });
    }
    for (const entry of array(value.availableCredits)) {
      const remaining = amount(entry?.creditAmount);
      if (remaining !== undefined)
        windows.push({
          label: `credits/${str(entry.creditType)}`,
          usedPercent: null,
          remaining,
          unit: "credits",
          resetsAt: null,
        });
    }
  } else {
    for (const [label, entry] of Object.entries(value)) {
      if (percentage(entry?.utilization) === null) continue;
      windows.push({
        label,
        usedPercent: entry.utilization,
        resetsAt: iso(entry.resets_at),
        ...(label.startsWith("five_hour")
          ? { windowSeconds: 18000 }
          : label.startsWith("seven_day")
            ? { windowSeconds: 604800 }
            : {}),
      });
    }
  }
  return {
    ...USAGE_SCOPE[provider],
    webUsageAvailable: false,
    plan: str(value.plan_type),
    windows: windows.slice(0, 64),
    checkedAt,
    status: windows.length ? "available" : "unavailable",
    ...(!windows.length ? { unavailableReason: "额度接口未返回当前账号可读取的用量数据。" } : {}),
  };
}

export class AiAccounts {
  constructor({
    vault,
    openExternal,
    fetchImpl = fetch,
    providers = AI_PROVIDERS,
    timeoutMs = 300000,
    manualLoopback = false,
  }) {
    this.vault = vault;
    this.openExternal = openExternal;
    this.fetch = fetchImpl;
    this.providers = providers;
    this.timeoutMs = timeoutMs;
    this.manualLoopback = manualLoopback;
    this.sessions = new Map();
    this.queue = Promise.resolve();
  }
  exclusive(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  provider(id) {
    if (!Object.hasOwn(this.providers, id)) throw new Error("不支持的 AI 授权服务商。");
    return this.providers[id];
  }
  async request(url, options = {}) {
    let response;
    try {
      response = await this.fetch(url, {
        ...options,
        redirect: "error",
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    } catch {
      throw new AiServiceError("NETWORK_ERROR", "无法连接授权服务，请检查网络或重试。");
    }
    if (!response.ok) {
      const messages = {
        401: ["UNAUTHORIZED", "登录凭据已失效（HTTP 401），请重新授权。"],
        403: ["FORBIDDEN", "服务商拒绝了本次请求（HTTP 403），仅凭此状态码无法确定具体原因。"],
        429: ["RATE_LIMITED", "请求过于频繁（HTTP 429），请稍后重试。"],
      };
      const [code, message] = messages[response.status] ?? [
        "HTTP_ERROR",
        `授权服务请求失败（HTTP ${response.status}），请稍后重试。`,
      ];
      throw new AiServiceError(code, message, response.status);
    }
    let text;
    try {
      text = await response.text();
    } catch {
      throw new AiServiceError("NETWORK_ERROR", "授权服务响应中断，请稍后重试。");
    }
    if (text.length > 1048576) throw new AiServiceError("INVALID_RESPONSE", "授权服务响应过大。");
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new AiServiceError("INVALID_RESPONSE", "授权服务未返回有效 JSON 对象。");
    }
  }
  async start(provider) {
    const p = this.provider(provider);
    if (!this.vault.unlocked) throw new Error("请先解锁密钥库。");
    for (const session of this.sessions.values()) this.close(session, "cancelled");
    this.sessions.clear();
    const session = {
      id: nonce(),
      provider,
      state: nonce(),
      verifier: nonce(),
      status: "pending",
      controller: new AbortController(),
      redirect: p.redirect,
      manualCallback: p.mode === "code",
    };
    this.sessions.set(session.id, session);
    session.timer = setTimeout(() => this.close(session, "expired"), this.timeoutMs);
    session.timer.unref?.();
    try {
      if (p.mode === "loopback" && this.manualLoopback) {
        const redirect = new URL(p.redirect);
        if (redirect.port === "0") redirect.port = "53147";
        session.redirect = redirect.href;
        session.manualCallback = true;
      } else if (p.mode === "loopback") {
        const redirect = new URL(p.redirect);
        session.server = createServer((req, res) => {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          let incoming;
          try {
            incoming = new URL(req.url ?? "/", session.redirect);
          } catch {
            res.writeHead(400);
            res.end("无效的授权回调。");
            return;
          }
          if (
            req.method !== "GET" ||
            incoming.origin !== new URL(session.redirect).origin ||
            incoming.pathname !== redirect.pathname ||
            incoming.searchParams.getAll("state").length !== 1 ||
            incoming.searchParams.get("state") !== session.state ||
            session.status !== "pending"
          ) {
            res.writeHead(400);
            res.end("无效的授权回调。");
            return;
          }
          if (incoming.searchParams.has("error")) {
            this.close(session, "error");
            session.error = "授权已拒绝。";
            res.end("授权已取消，可以返回知屿。");
            return;
          }
          const code = incoming.searchParams.get("code");
          if (!code || incoming.searchParams.getAll("code").length !== 1) {
            res.writeHead(400);
            res.end("授权码无效或已使用。");
            return;
          }
          res.end("已收到授权结果，请返回知屿查看连接状态。");
          void this.finish(session.id, incoming.toString()).catch(() => {});
        });
        try {
          await new Promise((resolve, reject) => {
            session.server.once("error", reject);
            session.server.listen(Number(redirect.port), "127.0.0.1", resolve);
          });
          redirect.port = String(session.server.address().port);
          session.redirect = redirect.toString();
        } catch (error) {
          session.server.close();
          delete session.server;
          if (error.code !== "EADDRINUSE" || Number(redirect.port) === 0)
            throw new Error("无法启动本机授权回调，请稍后重试。");
          // 固定回调端口被其他应用占用时保留供应商登记地址，由用户粘贴本次回调。
          session.manualCallback = true;
        }
      }
      const url = new URL(p.authorize);
      for (const [key, value] of Object.entries({
        client_id: p.clientId,
        response_type: "code",
        redirect_uri: session.redirect,
        scope: p.scope,
        state: session.state,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(session.verifier).digest("base64url"),
      }))
        url.searchParams.set(key, value);
      if (provider === "openai") {
        url.searchParams.set("codex_cli_simplified_flow", "true");
        url.searchParams.set("id_token_add_organizations", "true");
      }
      if (provider === "claude") url.searchParams.set("code", "true");
      if (provider === "gemini") {
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "consent");
      }
      await this.openExternal(url.toString());
      return {
        id: session.id,
        mode: p.mode,
        redirectUri: session.redirect,
        manualCallback: session.manualCallback,
      };
    } catch (error) {
      this.close(session, "error");
      throw error;
    }
  }
  status(id) {
    const session = this.sessions.get(id);
    return session
      ? { status: session.status, error: session.error ?? "", accountId: session.accountId }
      : { status: "expired", error: "" };
  }
  close(session, status) {
    if (!session) return;
    clearTimeout(session.timer);
    session.server?.close();
    session.controller.abort();
    session.status = status;
    delete session.verifier;
  }
  cancel(id) {
    this.close(this.sessions.get(id), "cancelled");
    return true;
  }
  stop() {
    for (const session of this.sessions.values()) this.close(session, "cancelled");
  }
  async exchange(p, body, signal) {
    if (p.clientSecret) body = { ...body, client_secret: p.clientSecret };
    const form = p.mode === "loopback";
    const tokens = await this.request(p.token, {
      method: "POST",
      signal,
      headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    if (
      !tokens ||
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0
    )
      throw new AiServiceError("INVALID_TOKEN", "授权服务返回的令牌不完整。");
    return tokens;
  }
  finish(id, input) {
    const session = this.sessions.get(id);
    if (!session || session.status !== "pending")
      return Promise.reject(new Error("授权已结束，请重新登录。"));
    let code, state;
    try {
      const raw = typeof input === "string" ? input.trim() : "";
      if (!raw || raw.length > 16384) throw new Error("请粘贴完整回调链接或 code#state。");
      if (/^https?:\/\//i.test(raw)) {
        const callback = new URL(raw),
          expected = new URL(session.redirect);
        if (
          callback.origin !== expected.origin ||
          callback.pathname !== expected.pathname ||
          callback.username ||
          callback.password ||
          callback.hash
        )
          throw new Error("回调地址与本次授权不匹配，请粘贴本次登录生成的完整链接。");
        if (
          callback.searchParams.getAll("state").length !== 1 ||
          callback.searchParams.get("state") !== session.state
        )
          throw new Error("授权码或 state 不匹配，请粘贴本次登录的完整回调。");
        if (callback.searchParams.has("error")) {
          this.close(session, "error");
          session.error = "授权已拒绝。";
          throw new Error(session.error);
        }
        if (callback.searchParams.getAll("code").length !== 1) throw new Error("授权码不完整。");
        code = callback.searchParams.get("code");
        state = callback.searchParams.get("state");
      } else {
        const parts = raw.split("#");
        if (parts.length !== 2) throw new Error("请粘贴完整回调链接或 code#state。");
        [code, state] = parts;
      }
      if (
        !code ||
        !state ||
        state !== session.state ||
        /\s/.test(code) ||
        [...code].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error("授权码或 state 不匹配，请粘贴本次登录的完整回调。");
    } catch (error) {
      return Promise.reject(error);
    }
    session.status = "exchanging";
    return this.exclusive(async () => {
      try {
        if (session.controller.signal.aborted) throw new Error("授权已取消。");
        const p = this.provider(session.provider);
        const tokens = await this.exchange(
          p,
          {
            grant_type: "authorization_code",
            client_id: p.clientId,
            redirect_uri: session.redirect,
            code_verifier: session.verifier,
            code,
            ...(session.provider === "claude" ? { state } : {}),
          },
          session.controller.signal,
        );
        if (session.controller.signal.aborted) throw new Error("授权已取消。");
        const identity = this.identity(session.provider, tokens);
        if (p.userinfo) {
          const info = await this.request(p.userinfo, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
            signal: session.controller.signal,
          });
          identity.accountId = str(info.sub);
          identity.email = str(info.email);
        }
        if (session.controller.signal.aborted) throw new Error("授权已取消。");
        if (!identity.accountId) throw new Error("授权服务没有返回账号标识。");
        const account = {
          ...identity,
          provider: session.provider,
          tokens,
          tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          usage: null,
        };
        const key =
          PREFIX +
          createHash("sha256").update(`${session.provider}:${identity.accountId}`).digest("hex");
        const previous = await this.vault.get(key);
        if (session.controller.signal.aborted) throw new Error("授权已取消。");
        account.usage = previous?.usage ?? null;
        if (previous?.usageRefresh) account.usageRefresh = previous.usageRefresh;
        await this.vault.set(key, account, {
          beforeCommit: () => {
            if (session.controller.signal.aborted) throw new Error("授权已取消。");
          },
        });
        if (session.controller.signal.aborted) {
          if (previous) await this.vault.set(key, previous, { rollback: true });
          else await this.vault.remove(key, { rollback: true });
          throw new Error("授权已取消。");
        }
        session.accountId = key;
        this.close(session, "connected");
        return this.publicAccount(key, account);
      } catch (error) {
        session.error = error.message;
        if (session.status !== "cancelled" && session.status !== "expired")
          this.close(session, "error");
        throw error;
      }
    });
  }
  identity(provider, tokens) {
    if (provider === "claude")
      return {
        accountId: str(tokens.account?.uuid ?? tokens.organization?.uuid),
        email: str(tokens.account?.email_address),
        plan: "",
      };
    // 仅显示从 TLS 令牌响应解码的元信息，不将未验签 JWT 用于权限决策。
    const decode = (token) => {
      try {
        return object(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()));
      } catch {
        return {};
      }
    };
    const access = decode(tokens.access_token),
      identity = decode(tokens.id_token);
    const claims = { ...access, ...identity };
    const auth = {
      ...object(identity["https://api.openai.com/auth"]),
      ...object(access["https://api.openai.com/auth"]),
    };
    return {
      accountId: str(provider === "openai" ? auth.chatgpt_account_id : claims.sub),
      email: str(claims.email ?? access["https://api.openai.com/profile"]?.email),
      plan: str(auth.chatgpt_plan_type),
    };
  }
  publicAccount(id, account) {
    return {
      id,
      provider: account.provider,
      accountId: account.accountId,
      email: account.email,
      plan: account.plan,
      tokenExpiresAt: account.tokenExpiresAt,
      subscriptionExpiresAt: null,
      usage: account.usage
        ? { ...USAGE_SCOPE[account.provider], webUsageAvailable: false, ...account.usage }
        : null,
      ...(account.usageRefresh ? { usageRefresh: account.usageRefresh } : {}),
      refreshable: Boolean(account.tokens.refresh_token),
    };
  }
  async list() {
    if (!this.vault.unlocked) throw new Error("请先解锁密钥库。");
    const result = [];
    for (const id of await this.vault.list())
      if (id.startsWith(PREFIX)) {
        const account = await this.vault.get(id);
        if (account) result.push(this.publicAccount(id, account));
      }
    return result;
  }
  async get(id) {
    if (typeof id !== "string" || !id.startsWith(PREFIX)) throw new Error("无效的 AI 账号。");
    const account = await this.vault.get(id);
    if (!account) throw new Error("AI 账号不存在。");
    return account;
  }
  remove(id) {
    return this.exclusive(async () => {
      await this.get(id);
      await this.vault.remove(id);
      return true;
    });
  }
  refresh(id) {
    return this.exclusive(async () => {
      const account = await this.get(id),
        p = this.provider(account.provider);
      const attemptedAt = new Date().toISOString();
      let refreshed = false;
      const refreshTokens = async () => {
        if (!account.tokens.refresh_token)
          throw new AiServiceError("UNAUTHORIZED", "登录已过期，请重新授权。");
        const tokens = await this.exchange(p, {
          grant_type: "refresh_token",
          client_id: p.clientId,
          refresh_token: account.tokens.refresh_token,
        });
        const identity = this.identity(account.provider, tokens);
        if (identity.accountId && identity.accountId !== account.accountId)
          throw new AiServiceError(
            "ACCOUNT_MISMATCH",
            "服务商返回了其他账号的令牌，请重新授权当前账号。",
          );
        account.tokens = { ...account.tokens, ...tokens };
        account.tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
        if (identity.plan) account.plan = identity.plan;
        refreshed = true;
        // 先保存轮换后的刷新令牌，避免额度请求失败导致旧令牌被重复使用。
        await this.vault.set(id, account);
      };
      const readUsage = async (url, options = {}) => {
        const send = () => {
          const headers = {
            Authorization: `Bearer ${account.tokens.access_token}`,
            Accept: "application/json",
            ...options.headers,
          };
          if (account.provider === "claude") headers["anthropic-beta"] = "oauth-2025-04-20";
          else if (account.provider === "openai") {
            headers["ChatGPT-Account-Id"] = account.accountId;
            headers["OpenAI-Beta"] = "codex-1";
          } else if (account.provider === "grok") {
            headers["x-xai-token-auth"] = "xai-grok-cli";
            headers["x-grok-client-version"] = "0.2.120";
          }
          return this.request(url, { ...options, headers });
        };
        try {
          return await send();
        } catch (error) {
          if (error.status !== 401 || refreshed || !account.tokens.refresh_token) throw error;
          await refreshTokens();
          return send();
        }
      };
      try {
        if (
          !Number.isFinite(Date.parse(account.tokenExpiresAt)) ||
          Date.parse(account.tokenExpiresAt) < Date.now() + 60000
        )
          await refreshTokens();
        let usage;
        if (account.provider === "gemini") {
          const headers = { "Content-Type": "application/json" };
          const profile = await readUsage(p.profile, {
            method: "POST",
            headers,
            body: JSON.stringify({
              metadata: {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
              },
            }),
          });
          const tier = profile.paidTier ?? profile.currentTier;
          account.plan = str(tier?.name ?? tier?.id) || account.plan;
          if (
            typeof profile.cloudaicompanionProject !== "string" ||
            !profile.cloudaicompanionProject
          )
            throw new AiServiceError(
              "PROJECT_REQUIRED",
              "Google 未返回 Code Assist 项目，请先在 Gemini CLI 完成账号开通。",
            );
          usage = await readUsage(p.usage, {
            method: "POST",
            headers,
            body: JSON.stringify({ project: profile.cloudaicompanionProject }),
          });
          usage.availableCredits = tier?.availableCredits;
        } else if (account.provider === "grok" && p.monthlyUsage) {
          const results = [];
          for (const url of [p.usage, p.monthlyUsage]) {
            try {
              results.push({ value: await readUsage(url) });
            } catch (error) {
              results.push({ error });
            }
          }
          const failures = results.filter((result) => result.error);
          if (failures.length === 2) throw failures[0].error;
          const normalized = results.map((result) =>
            result.value ? normalizeUsage("grok", result.value, { checkedAt: attemptedAt }) : null,
          );
          const merged = new Map();
          if (failures.length) {
            for (const entry of account.usage?.windows ?? []) {
              const monthly = entry.label === "monthly";
              if (
                (results[0].error && !monthly) ||
                (results[1].error && (monthly || entry.label === "on_demand"))
              )
                merged.set(entry.label, { ...entry, stale: true });
            }
          }
          for (const snapshot of normalized)
            for (const entry of snapshot?.windows ?? []) merged.set(entry.label, entry);
          account.usage = {
            ...normalizeUsage("grok", {}, { checkedAt: attemptedAt }),
            windows: [...merged.values()].slice(0, 64),
          };
          account.usage.status = merged.size ? "available" : "unavailable";
          if (merged.size) delete account.usage.unavailableReason;
          if (failures.length) throw failures[0].error;
        } else usage = await readUsage(p.usage);
        if (usage) {
          if (
            account.provider === "openai" &&
            typeof usage.account_id === "string" &&
            usage.account_id !== account.accountId
          )
            throw new AiServiceError(
              "ACCOUNT_MISMATCH",
              "额度响应属于其他账号，未覆盖当前账号的数据。",
            );
          account.usage = normalizeUsage(account.provider, usage, { checkedAt: attemptedAt });
          if (account.usage.plan) account.plan = account.usage.plan;
          if (typeof usage.email === "string") account.email = str(usage.email);
        }
        account.usageRefresh = { status: "ok", attemptedAt };
        await this.vault.set(id, account);
        return this.publicAccount(id, account);
      } catch (error) {
        const failure = safeFailure(error);
        account.usageRefresh = {
          status: "error",
          attemptedAt,
          errorCode: failure.code,
          message: failure.message,
        };
        if (account.usage) account.usage = { ...account.usage, status: "stale" };
        await this.vault.set(id, account);
        throw failure;
      }
    });
  }
}
