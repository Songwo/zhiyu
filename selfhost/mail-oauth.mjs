import { createHash, randomBytes } from "node:crypto";
import { OAUTH_PROVIDERS } from "../electron/services/oauth-providers.mjs";

const nonce = () => randomBytes(32).toString("base64url");
/** 仅核验邮箱身份。客户端密钥/令牌交换只在临时会话中，不落服务器磁盘。 */
export function createWebMailOAuth({ fetchImpl, sessionActive }) {
  const sessions = new Map();
  let stopped = false;
  const valid = (key) => {
    if (stopped || !sessionActive(key)) throw new Error("网页登录已过期，请重新登录。");
  };
  const clear = (id) => {
    const s = sessions.get(id);
    if (s) {
      s.controller.abort();
      clearTimeout(s.timer);
      s.secret = "";
      sessions.delete(id);
    }
  };
  const own = (id, key) => {
    valid(key);
    const s = sessions.get(id);
    if (!s || s.owner !== key) throw new Error("授权已失效或不属于当前网页登录会话。");
    return s;
  };
  const json = async (url, init, signal) => {
    const res = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`服务商请求失败（HTTP ${res.status}）。`);
    }
    const reader = res.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 1024 * 1024) throw new Error("服务商响应过大。");
        chunks.push(r.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("服务商响应无效。");
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
  return {
    channels: [
      "mail:oauth-providers",
      "mail:oauth-start",
      "mail:oauth-finish",
      "mail:oauth-cancel",
    ],
    async call(channel, args = [], context) {
      const key = context?.sessionKey;
      valid(key);
      if (channel === "mail:oauth-providers") return OAUTH_PROVIDERS;
      if (channel === "mail:oauth-start") {
        const input = args[0];
        if (input?.allowServerProcessing !== true)
          throw new Error("请先确认允许服务器临时处理邮箱授权。");
        const p = OAUTH_PROVIDERS[input.provider];
        if (
          !p ||
          typeof input.clientId !== "string" ||
          !input.clientId.trim() ||
          input.clientId.length > 512 ||
          typeof input.clientSecret !== "string" ||
          input.clientSecret.length > 4096 ||
          (p.usesSecret && !input.clientSecret)
        )
          throw new Error("OAuth 客户端配置不正确。");
        for (const [id, s] of sessions) if (s.owner === key || !sessionActive(s.owner)) clear(id);
        if (sessions.size >= 8) throw new Error("当前授权会话过多，请稍后重试。");
        const id = nonce(),
          verifier = nonce(),
          state = nonce(),
          redirectUri = "http://localhost:53148/";
        const session = {
          owner: key,
          provider: input.provider,
          clientId: input.clientId.trim(),
          secret: input.clientSecret,
          verifier,
          state,
          redirectUri,
          controller: new AbortController(),
          busy: false,
        };
        session.timer = setTimeout(() => clear(id), 5 * 60000);
        session.timer.unref?.();
        sessions.set(id, session);
        const url = new URL(p.authUrl);
        url.search = new URLSearchParams({
          client_id: session.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: p.scopes.join(" "),
          state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          ...p.extraAuthParams,
        }).toString();
        return { id, authorizationUrl: url.href, redirectUri };
      }
      const [id, input] = args,
        s = own(id, key);
      if (channel === "mail:oauth-cancel") {
        clear(id);
        return { ok: true };
      }
      if (channel !== "mail:oauth-finish" || s.busy)
        throw new Error("本次授权正在处理或操作无效。");
      let callback;
      try {
        callback = new URL(input);
      } catch {
        throw new Error("请粘贴本次授权的完整回调地址。");
      }
      if (
        typeof input !== "string" ||
        input.length > 8192 ||
        callback.origin !== new URL(s.redirectUri).origin ||
        callback.pathname !== "/" ||
        callback.username ||
        callback.password ||
        callback.hash ||
        callback.searchParams.getAll("state").length !== 1 ||
        callback.searchParams.get("state") !== s.state
      )
        throw new Error("授权回调或 state 不匹配。");
      if (callback.searchParams.has("error")) {
        clear(id);
        throw new Error("你已拒绝邮箱授权。");
      }
      const code = callback.searchParams.get("code");
      if (
        callback.searchParams.getAll("code").length !== 1 ||
        !code ||
        code.length > 4096 ||
        /\s/.test(code)
      )
        throw new Error("授权码无效。");
      s.busy = true;
      try {
        const p = OAUTH_PROVIDERS[s.provider],
          body = new URLSearchParams({
            client_id: s.clientId,
            code,
            code_verifier: s.verifier,
            grant_type: "authorization_code",
            redirect_uri: s.redirectUri,
          });
        if (p.usesSecret) body.set("client_secret", s.secret);
        const tokens = await json(
          p.tokenUrl,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          },
          s.controller.signal,
        );
        if (typeof tokens.access_token !== "string" || !tokens.access_token || tokens.error)
          throw new Error("服务商未返回有效授权令牌。");
        const profile = await json(
          p.userInfoUrl,
          { headers: { Authorization: `Bearer ${tokens.access_token}` } },
          s.controller.signal,
        );
        own(id, key);
        s.controller.signal.throwIfAborted();
        const address = profile.email ?? profile.mail ?? profile.userPrincipalName;
        if (
          typeof address !== "string" ||
          address.length > 320 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ||
          profile.email_verified === false
        )
          throw new Error("服务商没有返回已验证的邮箱地址。");
        const lifetime = Number(tokens.expires_in);
        return {
          ok: true,
          provider: s.provider,
          providerLabel: p.label,
          address,
          name: String(profile.name ?? profile.displayName ?? "").slice(0, 300),
          refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
          expiresAt:
            Number.isFinite(lifetime) && lifetime > 0 && lifetime < 31536000
              ? new Date(Date.now() + lifetime * 1000).toISOString()
              : null,
          scope: String(tokens.scope ?? p.scopes.join(" ")).slice(0, 4000),
          at: new Date().toISOString(),
        };
      } finally {
        clear(id);
      }
    },
    dropSessions() {
      for (const [id, s] of sessions) if (!sessionActive(s.owner)) clear(id);
    },
    stop() {
      stopped = true;
      for (const id of sessions.keys()) clear(id);
    },
  };
}
