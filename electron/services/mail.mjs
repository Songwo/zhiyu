import { ImapFlow } from "imapflow";

/**
 * IMAP/SMTP endpoints for the providers people actually have.
 *
 * `authNote` is what the provider calls the thing you paste — none of the big
 * Chinese providers accept your login password over IMAP, they issue a separate
 * 授权码, and telling people that up front saves a failed attempt.
 */
export const MAIL_PROVIDERS = {
  qq: {
    label: "QQ 邮箱",
    imap: { host: "imap.qq.com", port: 993 },
    smtp: { host: "smtp.qq.com", port: 465 },
    domains: ["qq.com", "foxmail.com", "vip.qq.com"],
    authNote: "在 QQ 邮箱设置 → 账号中开启 IMAP 服务，用生成的授权码而不是登录密码。",
  },
  163: {
    label: "网易 163",
    imap: { host: "imap.163.com", port: 993 },
    smtp: { host: "smtp.163.com", port: 465 },
    domains: ["163.com"],
    authNote: "在 163 邮箱设置 → POP3/SMTP/IMAP 中开启 IMAP，用客户端授权码。",
  },
  126: {
    label: "网易 126",
    imap: { host: "imap.126.com", port: 993 },
    smtp: { host: "smtp.126.com", port: 465 },
    domains: ["126.com"],
    authNote: "在 126 邮箱设置中开启 IMAP，用客户端授权码。",
  },
  gmail: {
    label: "Gmail",
    imap: { host: "imap.gmail.com", port: 993 },
    smtp: { host: "smtp.gmail.com", port: 465 },
    domains: ["gmail.com", "googlemail.com"],
    authNote: "开启两步验证后生成「应用专用密码」；普通账号密码会被拒绝。",
  },
  outlook: {
    label: "Outlook / Microsoft",
    imap: { host: "outlook.office365.com", port: 993 },
    smtp: { host: "smtp.office365.com", port: 587 },
    domains: ["outlook.com", "hotmail.com", "live.com"],
    authNote: "个人账号需要应用密码；企业账号可能已被管理员禁用基本身份验证。",
  },
  icloud: {
    label: "iCloud",
    imap: { host: "imap.mail.me.com", port: 993 },
    smtp: { host: "smtp.mail.me.com", port: 587 },
    domains: ["icloud.com", "me.com"],
    authNote: "在 Apple ID 页面生成 App 专用密码。",
  },
};

/** Best-guess provider for an address, so the form fills itself in. */
export function providerForAddress(address) {
  const domain = String(address).split("@")[1]?.toLowerCase();
  if (!domain) return null;
  for (const [id, p] of Object.entries(MAIL_PROVIDERS)) {
    if (p.domains.includes(domain)) return { id, ...p };
  }
  return null;
}

/**
 * Actually log in, and report what the account looks like.
 *
 * This is the whole point of "快捷登录": the credential is proven to work
 * before it is stored, and the quota and folder counts come back from the
 * server rather than being typed in from memory.
 */
export function validateMailboxConnection(value) {
  const host = typeof value?.host === "string" ? value.host.trim().toLowerCase() : "";
  const port = Number(value?.port);
  if (
    !host ||
    host.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
    host.includes("..")
  ) {
    throw new Error("请填写有效的 IMAP 服务器主机名");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("IMAP 端口必须为 1 到 65535 的整数");
  if (value.secure !== true) throw new Error("邮箱连接必须启用 TLS 加密");
  return { host, port, secure: true };
}

export class MailboxQueryError extends Error {}

export async function testMailbox({ address, password, host, port, secure = true }) {
  if (!address || !password) throw new Error("请填写邮箱地址与密码 / 授权码");
  const guess = providerForAddress(address);
  const connection = validateMailboxConnection({
    host: host || guess?.imap.host,
    port: port ?? guess?.imap.port ?? 993,
    secure,
  });
  const result = await queryMailbox({ ...connection, username: address, password, address });
  return {
    ok: true,
    address,
    provider: guess?.id ?? null,
    providerLabel: guess?.label ?? connection.host,
    imap: connection,
    smtp: guess?.smtp ?? null,
    messages: result.messages,
    unseen: result.unseen,
    ...(result.usedMb === undefined ? {} : { usedMb: result.usedMb }),
    ...(result.quotaMb === undefined ? {} : { quotaMb: result.quotaMb }),
    at: new Date().toISOString(),
  };
}

export async function queryMailbox(
  { host, port, secure = true, username, password, accessToken, address, baseline, signal },
  { createClient = (options) => new ImapFlow(options), timeoutMs = 25_000 } = {},
) {
  const connection = validateMailboxConnection({ host, port, secure });
  if (
    typeof username !== "string" ||
    !username ||
    (!accessToken && (typeof password !== "string" || !password))
  ) {
    throw new Error("请先保存邮箱用户名与密码 / 授权码");
  }
  if (signal?.aborted) throw new Error("邮箱检查已取消");
  const client = createClient({
    ...connection,
    auth: accessToken ? { user: username, accessToken } : { user: username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    logger: false,
    clientInfo: { name: "Zhiyu", vendor: "Zhiyu" },
    connectionTimeout: 12_000,
    socketTimeout: 20_000,
    greetingTimeout: 12_000,
    emitLogs: false,
  });
  // 所有异步阶段共用总超时；取消必须关闭底层套接字，不能仅忽略返回值。
  let stopped = false;
  let rejectStop;
  const stopPromise = new Promise((_, reject) => {
    rejectStop = reject;
  });
  const stop = (message) => {
    stopped = true;
    try {
      client.close();
    } catch {
      /* 套接字可能尚未建立。 */
    }
    rejectStop(new Error(message));
  };
  const abort = () => stop("邮箱检查已取消");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("邮箱检查超时，请检查网络和 IMAP 设置"), timeoutMs);
  const onError = (error) => rejectStop(error);
  client.on?.("error", onError);
  const operation = (async () => {
    await client.connect();
    if (stopped) throw new Error("邮箱检查已取消");
    await client.mailboxOpen("INBOX", { readOnly: true });
    const status = await client.status("INBOX", {
      messages: true,
      unseen: true,
      uidNext: true,
      uidValidity: true,
    });
    const messages = count(status.messages);
    const unseen = count(status.unseen);
    if (messages === null || unseen === null) throw new Error("IMAP 服务器未返回有效邮件统计");
    const uidValidity = positiveId(status.uidValidity);
    const uidNext = count(status.uidNext);
    let newMessages = null;
    if (
      uidValidity &&
      uidNext > 0 &&
      baseline?.uidValidity === uidValidity &&
      baseline.uidNext > 0 &&
      uidNext >= baseline.uidNext
    ) {
      if (uidNext === baseline.uidNext) newMessages = 0;
      else {
        // UID 可能不连续，必须搜索真实存在的邮件，不能把 UIDNEXT 的差当作数量。
        const uids = await client.search(
          { uid: `${baseline.uidNext}:${uidNext - 1}` },
          { uid: true },
        );
        if (!Array.isArray(uids)) throw new Error("IMAP 服务器未返回有效邮件统计");
        newMessages = new Set(
          uids.filter(
            (uid) => Number.isSafeInteger(uid) && uid >= baseline.uidNext && uid < uidNext,
          ),
        ).size;
      }
    }
    let quota = {};
    try {
      const value = await client.getQuota("INBOX");
      if (Number.isFinite(value?.storage?.usage) && value.storage.usage >= 0)
        quota.usedMb = Math.round(value.storage.usage / 1024);
      if (Number.isFinite(value?.storage?.limit) && value.storage.limit >= 0)
        quota.quotaMb = Math.round(value.storage.limit / 1024);
    } catch {
      // 部分服务器不支持 QUOTA，不影响邮件计数。
    }
    if (stopped) throw new Error("邮箱检查已取消");
    await client.logout();
    return {
      messages,
      unseen,
      uidValidity,
      uidNext: uidNext > 0 ? uidNext : null,
      newMessages,
      ...quota,
    };
  })();
  try {
    return await Promise.race([operation, stopPromise]);
  } catch (error) {
    if (stopped)
      throw new MailboxQueryError(
        signal?.aborted ? "邮箱检查已取消" : "邮箱检查超时，请检查网络和 IMAP 设置",
      );
    throw new MailboxQueryError(friendlyImap(error, providerForAddress(address)));
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    try {
      client.close();
    } catch {
      /* 所有退出路径都关闭连接。 */
    }
  }
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveId(value) {
  const text = String(value ?? "");
  return /^[1-9][0-9]{0,19}$/.test(text) ? text : null;
}

/** IMAP failures are terse and often misleading; say what actually happened. */
function friendlyImap(err, guess) {
  const msg = String(err?.responseText ?? err?.message ?? err);
  if (/Unsafe Login|unsafe/i.test(msg)) {
    return "服务器拒绝了这次登录（Unsafe Login）。163/126 需要在设置里开启 IMAP 并使用客户端授权码。";
  }
  // QQ answers with a paragraph of English covering six possible causes at
  // once; for a third-party client it is almost always the same two.
  if (
    /AUTHENTICATIONFAILED|Invalid credentials|LOGIN fail|Login fail|auth|Account is abnormal|service is not open/i.test(
      msg,
    )
  ) {
    return guess?.authNote
      ? `登录被拒绝。${guess.authNote}`
      : "登录被拒绝：地址或密码 / 授权码不正确。";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return "无法解析 IMAP 服务器地址";
  if (/ECONNREFUSED/i.test(msg)) return "连接被拒绝：IMAP 端口不对或服务未开启";
  if (/ETIMEDOUT|timeout/i.test(msg)) return "连接超时：网络不可达，或被防火墙拦截";
  if (/certificate|self.signed/i.test(msg)) return "TLS 证书校验失败";
  return "邮箱检查失败，请检查 IMAP 设置、网络及账号权限";
}
