import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { shell, net } from "electron";

/**
 * Desktop OAuth providers.
 *
 * Only non-sensitive scopes: the verified address is all a credential vault
 * wants from OAuth, and asking for mailbox scopes would drag the project into
 * Google's verification process for no gain. The IMAP path already reads real
 * mailbox data, and it does so with a credential the user can actually store.
 *
 * `usesSecret` is not a style choice — Google's "desktop app" clients must send
 * a client secret at the token endpoint, and Microsoft's public clients must
 * not send one at all.
 */
import { OAUTH_PROVIDERS } from "./oauth-providers.mjs";
export { OAUTH_PROVIDERS } from "./oauth-providers.mjs";

const base64url = (buf) => buf.toString("base64url");

/**
 * Run the authorization-code flow with PKCE against a loopback redirect.
 *
 * The browser is the user's own, not an embedded window: an embedded one would
 * see the password being typed, which is the entire thing OAuth exists to
 * avoid — and most providers refuse to render in one anyway.
 */
export async function signIn({ provider, clientId, clientSecret }) {
  const config = OAUTH_PROVIDERS[provider];
  if (!config) throw new Error(`不支持的登录方式：${provider}`);
  if (!clientId) throw new Error("请先填写客户端 ID");
  if (config.usesSecret && !clientSecret)
    throw new Error(`${config.label} 的桌面客户端还需要客户端密钥`);

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const { server, port } = await listenOnFreePort(config.loopbackHost);
  const redirectUri = `http://${config.loopbackHost}:${port}`;

  const codePromise = waitForCode(server, state);

  const authUrl = new URL(config.authUrl);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", config.scopes.join(" "));
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  for (const [k, v] of Object.entries(config.extraAuthParams)) authUrl.searchParams.set(k, v);

  await shell.openExternal(authUrl.toString());

  let code;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (config.usesSecret) body.set("client_secret", clientSecret);

  const tokens = await postForm(config.tokenUrl, body);
  if (tokens.error) {
    throw new Error(`换取令牌失败：${tokens.error_description ?? tokens.error}`);
  }

  const profile = await getJson(config.userInfoUrl, tokens.access_token);
  const address =
    profile.email ?? profile.mail ?? profile.userPrincipalName ?? claimFromIdToken(tokens.id_token);
  if (!address) throw new Error("登录成功，但没有拿到邮箱地址");

  return {
    ok: true,
    provider,
    providerLabel: config.label,
    address,
    name: profile.name ?? profile.displayName ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: tokens.expires_in
      ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
      : null,
    scope: tokens.scope ?? config.scopes.join(" "),
    at: new Date().toISOString(),
  };
}

/** Ask the OS for a spare port so two sign-ins never collide. */
function listenOnFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, host, () => resolve({ server, port: server.address().port }));
  });
}

/** Resolve when the provider redirects back with a matching state. */
function waitForCode(server, expectedState) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("登录超时，浏览器没有返回结果")), 5 * 60_000);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");

      const done = (message, ok) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(message, ok));
      };

      if (error) {
        done(`授权被拒绝：${error}`, false);
        clearTimeout(timer);
        reject(new Error(`授权被拒绝：${error}`));
        return;
      }
      // A stray request on the loopback port must not be able to inject a code.
      if (!code || state !== expectedState) {
        done("这次回调不属于当前的登录请求。", false);
        return;
      }
      done("登录完成，可以回到知屿了。", true);
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function page(message, ok) {
  return `<!doctype html><meta charset="utf-8"><title>知屿</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#f4f5f5;
font:15px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif;color:#0f1419">
<div style="text-align:center">
<div style="font-size:34px;margin-bottom:12px">${ok ? "✓" : "×"}</div>
<div>${message}</div>
</div></body>`;
}

function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: "POST" });
    request.setHeader("content-type", "application/x-www-form-urlencoded");
    let text = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => (text += chunk.toString("utf8")));
      response.on("end", () => {
        try {
          resolve(JSON.parse(text || "{}"));
        } catch {
          reject(new Error(`令牌端点返回了无法解析的内容（HTTP ${response.statusCode}）`));
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.write(body.toString());
    request.end();
  });
}

function getJson(url, accessToken) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: "GET" });
    request.setHeader("authorization", `Bearer ${accessToken}`);
    let text = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => (text += chunk.toString("utf8")));
      response.on("end", () => {
        try {
          resolve(JSON.parse(text || "{}"));
        } catch {
          reject(new Error("读取账号信息失败"));
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

/** Fallback when the userinfo endpoint omits the address but the id_token has it. */
function claimFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return payload.email ?? payload.preferred_username ?? null;
  } catch {
    return null;
  }
}
