import { MAIL_OAUTH_SCOPES, OAUTH_PROVIDERS } from "./oauth-providers.mjs";
import { MAIL_PROVIDERS } from "./mail.mjs";

export class MailOAuthError extends Error {}

export function createMailOAuthResolver(vault, fetchImpl = fetch) {
  const pending = new Map();
  return async function resolveMailOAuth(account, credential, protocol) {
    const oauth = credential.oauth;
    const provider = OAUTH_PROVIDERS[oauth.provider];
    const scopes = MAIL_OAUTH_SCOPES[oauth.provider];
    const hosts = MAIL_PROVIDERS[oauth.provider === "google" ? "gmail" : "outlook"];
    const connection = account[protocol];
    const hostAllowed =
      connection?.host === hosts[protocol].host ||
      (protocol === "smtp" &&
        oauth.provider === "microsoft" &&
        connection?.host === "smtp-mail.outlook.com");
    const validTls =
      protocol === "imap"
        ? connection?.secure !== false
        : connection?.security === (hosts.smtp.port === 465 ? "tls" : "starttls");
    if (
      !provider ||
      !Array.isArray(scopes) ||
      !oauth.refreshToken ||
      !oauth.mailAddress ||
      !validTls ||
      !hostAllowed ||
      connection.port !== hosts[protocol].port ||
      account.address?.toLowerCase() !== oauth.mailAddress.toLowerCase() ||
      credential.username?.toLowerCase() !== oauth.mailAddress.toLowerCase()
    )
      throw new MailOAuthError("邮件 OAuth 仅适用于已授权地址及服务商的标准连接。请重新授权。");

    const key = `account:${account.id}`;
    const session = vault.session;
    const existing = pending.get(key);
    if (existing && existing.session === session && existing.token === oauth.refreshToken)
      return existing.promise;

    const refresh = async () => {
      const client = await vault.get(`oauth-client:${oauth.provider}`);
      if (client?.username !== oauth.mailClientId || (provider.usesSecret && !client.password))
        throw new MailOAuthError("邮件 OAuth 客户端配置已变动，请重新授权。");
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: client.username,
      });
      if (provider.usesSecret) body.set("client_secret", client.password);
      if (oauth.provider === "microsoft") body.set("scope", scopes.join(" "));
      let tokens;
      try {
        const response = await fetchImpl(provider.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) throw new Error();
        tokens = await response.json();
        if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error();
      } catch {
        throw new MailOAuthError("邮件授权刷新失败，请检查网络，或在邮箱编辑页重新授权。");
      }
      const latest = await vault.get(key);
      if (session !== vault.session || JSON.stringify(latest) !== JSON.stringify(credential))
        throw new MailOAuthError("邮箱凭据已更新或密钥库已锁定，请重试。");
      if (
        typeof tokens.refresh_token === "string" &&
        tokens.refresh_token &&
        tokens.refresh_token !== oauth.refreshToken
      )
        await vault.set(
          key,
          { ...credential, oauth: { ...oauth, refreshToken: tokens.refresh_token } },
          { expected: credential },
        );
      return tokens.access_token;
    };

    const job = {
      session,
      token: oauth.refreshToken,
      promise: refresh().finally(() => {
        if (pending.get(key) === job) pending.delete(key);
      }),
    };
    pending.set(key, job);
    return job.promise;
  };
}
