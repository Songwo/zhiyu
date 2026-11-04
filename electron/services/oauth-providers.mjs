export const OAUTH_PROVIDERS = {
  google: {
    label: "Google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    usesSecret: true,
    // Google's downloaded client file registers `http://localhost`; loopback
    // redirects accept any port, but the host has to be the one on file.
    loopbackHost: "localhost",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    consoleUrl: "https://console.cloud.google.com/auth/clients",
    setupNote:
      "在 Google Cloud 控制台创建「桌面应用」类型的 OAuth 客户端，拿到客户端 ID 与密钥；并把应用发布到生产，否则 refresh token 只有 7 天有效期。",
  },
  microsoft: {
    label: "Microsoft",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/v1.0/me",
    scopes: ["openid", "email", "profile", "offline_access", "User.Read"],
    usesSecret: false,
    loopbackHost: "localhost",
    extraAuthParams: {},
    consoleUrl: "https://entra.microsoft.com/",
    setupNote:
      "在 Microsoft Entra 注册应用，平台选「移动和桌面应用程序」，重定向 URI 填 http://localhost。公共客户端不需要密钥。",
  },
};
