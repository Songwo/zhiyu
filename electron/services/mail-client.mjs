import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { convert as htmlToText } from "html-to-text";
import { validateMailboxConnection } from "./mail.mjs";
import { sanitizeMailHtml } from "./mail-content.mjs";

const MAX_MESSAGE = 12 * 1024 * 1024;
const MAX_ATTACHMENTS = 8 * 1024 * 1024;
// 会话级缓存参数：文件夹与分页短 TTL，解析邮件按字节预算 LRU。
const FOLDERS_TTL_MS = 60_000;
const PAGES_TTL_MS = 30_000;
const MESSAGE_CACHE_MAX = 10;
const MESSAGE_CACHE_BYTES = 32 * 1024 * 1024;
const PAGES_CACHE_MAX = 40;
class MailClientError extends Error {}
const fail = (message) => {
  throw new MailClientError(message);
};
const control = (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127;
const hasControl = (value) => Array.from(value).some(control);
const clean = (value, max = 500) =>
  Array.from(String(value ?? "").slice(0, max))
    .map((character) => (control(character) ? " " : character))
    .join("");
const address = (value) =>
  typeof value === "string" &&
  value.length <= 254 &&
  !hasControl(value) &&
  !/[<>(),;:\\"]/.test(value) &&
  !value.includes("[") &&
  !value.includes("]") &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function validateSmtp(value) {
  let endpoint;
  try {
    endpoint = validateMailboxConnection({ ...value, secure: true });
  } catch {
    fail("请填写有效的 SMTP 主机名和端口");
  }
  if (!["tls", "starttls"].includes(value?.security)) fail("SMTP 必须使用 TLS 或 STARTTLS");
  return { host: endpoint.host, port: endpoint.port, security: value.security };
}

export function validateDraft(input, { sending = false } = {}) {
  if (!input || typeof input !== "object") fail("邮件内容无效");
  const result = {};
  for (const key of ["to", "cc", "bcc"]) {
    if (typeof input[key] !== "string" || input[key].length > 4000 || hasControl(input[key]))
      fail("收件人格式无效");
    result[key] = input[key].trim();
    const values = result[key]
      .split(/[;,，；]/)
      .map((v) => v.trim())
      .filter(Boolean);
    if (sending && values.some((v) => !address(v)))
      fail("请填写有效的收件人邮箱地址，多个地址用逗号分隔");
    if (sending) result[key] = values.join(", ");
    if (values.length > 20) fail("每种收件人最多填写 20 个地址");
  }
  if (sending && !result.to) fail("请填写收件人");
  if (typeof input.subject !== "string" || input.subject.length > 200 || hasControl(input.subject))
    fail("主题最多 200 个字符且不能换行");
  if (typeof input.text !== "string" || input.text.length > 256000 || input.text.includes("\0"))
    fail("邮件正文最多 256000 个字符");
  result.subject = input.subject;
  result.text = input.text;
  if (sending && !result.subject.trim()) fail("请填写邮件主题");
  if (
    input.inReplyTo &&
    (typeof input.inReplyTo !== "string" || !/^<[^<>\s]{1,500}>$/.test(input.inReplyTo))
  )
    fail("回复标识无效");
  if (input.inReplyTo) result.inReplyTo = input.inReplyTo;
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 5) fail("最多添加 5 个附件");
  let total = 0;
  result.attachments = attachments.map((item) => {
    if (
      typeof item?.name !== "string" ||
      !item.name ||
      item.name.length > 180 ||
      hasControl(item.name) ||
      /[\\/]/.test(item.name)
    )
      fail("附件文件名无效");
    if (
      typeof item.base64 !== "string" ||
      item.base64.length > MAX_ATTACHMENTS * 1.4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.base64)
    )
      fail("附件内容无效");
    total += Buffer.byteLength(item.base64, "base64");
    if (total > MAX_ATTACHMENTS) fail("附件总大小不能超过 8 MiB");
    return { name: item.name, base64: item.base64 };
  });
  return result;
}

function selection(input, requireUid = false) {
  const folder = input?.folder;
  if (typeof folder !== "string" || !folder || folder.length > 512 || hasControl(folder))
    fail("邮件文件夹无效");
  if (requireUid && (!Number.isSafeInteger(input.uid) || input.uid < 1 || input.uid > 4294967295))
    fail("邮件标识无效");
  if (requireUid && !/^[1-9][0-9]{0,19}$/.test(String(input.uidValidity ?? "")))
    fail("邮件列表已失效，请刷新");
  return folder;
}

function contacts(items) {
  return (items ?? [])
    .slice(0, 60)
    .map((item) => ({ name: clean(item.name, 200), address: clean(item.address, 254) }));
}
function summary(item) {
  return {
    uid: item.uid,
    subject: clean(item.envelope?.subject, 1000),
    from: contacts(item.envelope?.from),
    to: contacts(item.envelope?.to),
    date:
      item.envelope?.date instanceof Date && Number.isFinite(item.envelope.date.getTime())
        ? item.envelope.date.toISOString()
        : null,
    seen: item.flags?.has("\\Seen") ?? false,
    size: item.size ?? 0,
  };
}

export class MailClient {
  #vault;
  #snapshot;
  #imap;
  #smtp;
  #controllers = new Set();
  #generation = 0;
  #sending = new Set();
  /**
   * 会话级缓存（0.9.0）：文件夹列表与分页结果短 TTL 复用，已解析邮件
   * LRU 复用（正文读取与附件下载共享，避免重复拉取与解析同一封邮件）。
   * 密文级磁盘缓存按 docs/archive/plans/v0.9.0 的评审结论顺延；锁库即全部清除。
   */
  #foldersCache = new Map();
  #pagesCache = new Map();
  #messagesCache = new Map();
  #messagesCacheBytes = 0;
  constructor({
    vault,
    getSnapshot,
    createImap = (options) => new ImapFlow(options),
    createSmtp = (options) => nodemailer.createTransport(options),
  }) {
    this.#vault = vault;
    this.#snapshot = getSnapshot;
    this.#imap = createImap;
    this.#smtp = createSmtp;
  }
  stop() {
    this.#generation += 1;
    for (const controller of this.#controllers) controller.abort();
    this.clearCaches();
  }
  /** 清空全部邮件缓存；锁库、断开或退出时调用，缓存不跨锁定保留。 */
  clearCaches() {
    this.#foldersCache.clear();
    this.#pagesCache.clear();
    this.#messagesCache.clear();
    this.#messagesCacheBytes = 0;
  }
  cacheStats() {
    return {
      folders: this.#foldersCache.size,
      pages: this.#pagesCache.size,
      messages: this.#messagesCache.size,
      bytes: this.#messagesCacheBytes,
    };
  }
  #assertCacheReadable() {
    // 缓存命中路径绕过了 #run，必须自己守住锁定边界：锁库后不返回任何邮件内容。
    if (!this.#vault.unlocked) fail("密钥库已锁定，邮件操作已取消");
  }
  #cachedMessage(id, input) {
    this.#assertCacheReadable();
    const key = `${id}|${input.folder}|${input.uid}|${input.uidValidity}`;
    if (!this.#messagesCache.has(key)) return { key, entry: null };
    const entry = this.#messagesCache.get(key);
    this.#messagesCache.delete(key);
    this.#messagesCache.set(key, entry);
    return { key, entry };
  }
  #storeMessage(key, { item, parsed }, message) {
    const bytes =
      (item?.source?.length ?? 0) +
      (parsed.text?.length ?? 0) +
      (parsed.html?.length ?? 0) +
      parsed.attachments.reduce((sum, file) => sum + (file.content?.length ?? 0), 0);
    // 超大邮件不值得占用缓存预算；按字节 LRU 驱逐到预算内。
    if (bytes > MESSAGE_CACHE_BYTES) return;
    this.#messagesCache.set(key, { item, parsed, message, bytes });
    this.#messagesCacheBytes += bytes;
    while (this.#messagesCacheBytes > MESSAGE_CACHE_BYTES || this.#messagesCache.size > MESSAGE_CACHE_MAX) {
      const oldest = this.#messagesCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.#messagesCache.get(oldest);
      this.#messagesCache.delete(oldest);
      this.#messagesCacheBytes -= evicted.bytes;
    }
  }
  #dropMailboxCaches(id) {
    for (const key of this.#pagesCache.keys())
      if (key.startsWith(`${id}|`)) this.#pagesCache.delete(key);
    for (const key of this.#messagesCache.keys())
      if (key.startsWith(`${id}|`)) {
        const evicted = this.#messagesCache.get(key);
        this.#messagesCache.delete(key);
        this.#messagesCacheBytes -= evicted.bytes;
      }
  }
  async #run(id, operation) {
    const generation = this.#generation;
    const assertActive = () => {
      if (!this.#vault.unlocked || generation !== this.#generation)
        fail("密钥库已锁定，邮件操作已取消");
    };
    assertActive();
    const snapshot = await this.#snapshot();
    const account = snapshot?.mailboxes?.find((item) => item.id === id);
    if (!account || account.demo || account.kind !== "mailbox") fail("请选择已保存的真实邮箱账号");
    const credential = await this.#vault.get(`account:${id}`);
    assertActive();
    if (!credential?.username || !credential?.password)
      fail("请先在邮箱详情保存用户名和密码 / 授权码");
    const controller = new AbortController();
    this.#controllers.add(controller);
    const monitor = setInterval(() => {
      if (!this.#vault.unlocked) controller.abort();
    }, 150);
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const result = await operation(account, credential, controller.signal, assertActive);
      assertActive();
      if (controller.signal.aborted) fail("邮件操作已取消或超时；发送中的邮件请先核对已发送记录");
      return result;
    } catch (error) {
      if (error instanceof MailClientError) throw error;
      if (controller.signal.aborted) fail("邮件操作已取消或超时；发送中的邮件请先核对已发送记录");
      // 不返回上游原始错误，避免凭据、正文或收件人被写进错误日志。
      fail("邮件操作失败，请检查连接设置、授权码、网络和服务商权限");
    } finally {
      clearInterval(monitor);
      clearTimeout(timeout);
      this.#controllers.delete(controller);
    }
  }
  async #withImap(id, work) {
    return this.#run(id, async (account, auth, signal, assertActive) => {
      if (!account.imap) fail("请先保存 IMAP 连接设置");
      const client = this.#imap({
        ...validateMailboxConnection(account.imap),
        auth: { user: auth.username, pass: auth.password },
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
        logger: false,
        emitLogs: false,
        connectionTimeout: 12000,
        greetingTimeout: 12000,
        socketTimeout: 20000,
        clientInfo: { name: "Zhiyu", vendor: "Zhiyu" },
      });
      let rejectAbort;
      const interrupted = new Promise((_, reject) => {
        rejectAbort = reject;
      });
      const abort = () => {
        client.close();
        rejectAbort(new MailClientError("邮件操作已取消或超时"));
      };
      client.on("error", rejectAbort);
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await Promise.race([
          (async () => {
            await client.connect();
            assertActive();
            if (signal.aborted) fail("邮件操作已取消");
            const result = await work(client, assertActive);
            await client.logout();
            return result;
          })(),
          interrupted,
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
        client.close();
      }
    });
  }
  folders(id) {
    const cached = this.#foldersCache.get(id);
    if (cached && Date.now() - cached.at < FOLDERS_TTL_MS) {
      this.#assertCacheReadable();
      return cached.value;
    }
    return this.#withImap(id, async (client) => {
      const value = (await client.list())
        .filter((item) => !item.flags?.has("\\Noselect"))
        .slice(0, 200)
        .map((item) => ({
          path: item.path,
          name: clean(item.name),
          specialUse: item.specialUse ?? null,
        }));
      this.#foldersCache.set(id, { value, at: Date.now() });
      return value;
    });
  }
  messages(id, input) {
    const folder = selection(input);
    const page = input.page ?? 0;
    if (!Number.isSafeInteger(page) || page < 0 || page > 10000) fail("页码无效");
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query.length > 100 || hasControl(query)) fail("搜索词无效");
    const pageKey = `${id}|${folder}|${page}|${query}|${input.unseen === true}`;
    const cached = this.#pagesCache.get(pageKey);
    if (cached && Date.now() - cached.at < PAGES_TTL_MS) {
      this.#assertCacheReadable();
      return cached.value;
    }
    return this.#withImap(id, async (client) => {
      const box = await client.mailboxOpen(folder, { readOnly: true });
      let range,
        useUid = false,
        total = box.exists;
      if (query || input.unseen === true) {
        const uids = await client.search(
          {
            ...(query ? { or: [{ subject: query }, { from: query }] } : {}),
            ...(input.unseen === true ? { seen: false } : {}),
          },
          { uid: true },
        );
        if (!Array.isArray(uids)) fail("服务器未返回邮件列表");
        total = uids.length;
        range = uids
          .sort((a, b) => b - a)
          .slice(page * 30, (page + 1) * 30)
          .join(",");
        useUid = true;
      } else {
        const end = total - page * 30;
        range = end > 0 ? `${Math.max(1, end - 29)}:${end}` : "";
      }
      const items = [];
      if (range)
        for await (const item of client.fetch(
          range,
          { uid: true, envelope: true, flags: true, size: true },
          { uid: useUid },
        ))
          items.push(summary(item));
      const value = {
        items: items.sort((a, b) => b.uid - a.uid),
        total,
        page,
        uidValidity: String(box.uidValidity),
        folder,
      };
      this.#pagesCache.set(pageKey, { value, at: Date.now() });
      while (this.#pagesCache.size > PAGES_CACHE_MAX)
        this.#pagesCache.delete(this.#pagesCache.keys().next().value);
      return value;
    });
  }
  async #parsed(client, input) {
    const folder = selection(input, true);
    const box = await client.mailboxOpen(folder, { readOnly: true });
    if (String(box.uidValidity) !== String(input.uidValidity))
      fail("邮箱状态已变化，请刷新邮件列表");
    const metadata = await client.fetchOne(input.uid, { size: true }, { uid: true });
    if (!metadata) fail("邮件已不存在，请刷新列表");
    if (!Number.isFinite(metadata.size) || metadata.size > MAX_MESSAGE)
      fail("邮件超过 12 MiB，请在服务商网页查看");
    const item = await client.fetchOne(
      input.uid,
      {
        uid: true,
        source: { start: 0, maxLength: MAX_MESSAGE + 1 },
        envelope: true,
        flags: true,
        size: true,
      },
      { uid: true },
    );
    if (!item?.source || item.source.length > MAX_MESSAGE) fail("邮件正文过大或已不存在");
    const parsed = await simpleParser(item.source, {
      skipImageLinks: true,
      skipTextToHtml: true,
      maxHtmlLengthToParse: 1024 * 1024,
    });
    return { item, parsed };
  }
  #buildMessage({ item, parsed }) {
    if (!parsed.text && parsed.html?.length > 1024 * 1024)
      fail("HTML 正文过大，请在服务商网页查看");
    const text =
      parsed.text ||
      (parsed.html
        ? htmlToText(parsed.html, {
            wordwrap: false,
            selectors: [{ selector: "img", format: "skip" }],
          })
        : "");
    return {
      ...summary(item),
      text: text.slice(0, 500000),
      html: sanitizeMailHtml(parsed.html, parsed.attachments),
      cc: contacts(parsed.cc?.value),
      replyTo: contacts(parsed.replyTo?.value ?? parsed.from?.value),
      messageId: /^<[^<>\s]{1,500}>$/.test(parsed.messageId ?? "") ? parsed.messageId : null,
      attachments: parsed.attachments.map((file, index) => ({
        index,
        name: clean(file.filename || `attachment-${index + 1}`, 180),
        size: file.size,
        contentType: clean(file.contentType, 100),
      })),
    };
  }
  async read(id, input) {
    selection(input, true);
    const { key, entry } = this.#cachedMessage(id, input);
    if (entry) {
      // 命中缓存：不建立 IMAP 连接，直接返回（或基于已解析内容构建正文）。
      if (!entry.message) entry.message = this.#buildMessage(entry);
      return entry.message;
    }
    return this.#withImap(id, async (client) => {
      const parsed = await this.#parsed(client, input);
      const message = this.#buildMessage(parsed);
      this.#storeMessage(key, parsed, message);
      return message;
    });
  }
  async attachment(id, input, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 1000) fail("附件标识无效");
    selection(input, true);
    const pick = (parsed) => {
      const file = parsed.attachments[index];
      if (!file || file.size > MAX_ATTACHMENTS) fail("附件不存在或超过 8 MiB");
      return {
        name: clean(file.filename || `attachment-${index + 1}`, 180).replace(/[\\/:*?"<>|]/g, "_"),
        content: file.content,
      };
    };
    const { key, entry } = this.#cachedMessage(id, input);
    if (entry) return pick(entry.parsed);
    return this.#withImap(id, async (client) => {
      const parsed = await this.#parsed(client, input);
      this.#storeMessage(key, parsed, null);
      return pick(parsed);
    });
  }
  seen(id, input, seen) {
    selection(input, true);
    if (typeof seen !== "boolean") fail("已读状态无效");
    return this.#withImap(id, async (client, assertActive) => {
      const box = await client.mailboxOpen(input.folder);
      if (String(box.uidValidity) !== String(input.uidValidity))
        fail("邮箱状态已变化，请刷新邮件列表");
      assertActive();
      if (seen) await client.messageFlagsAdd(input.uid, ["\\Seen"], { uid: true });
      else await client.messageFlagsRemove(input.uid, ["\\Seen"], { uid: true });
      // 已读状态会改变列表与摘要，清掉该邮箱的会话缓存保证一致。
      this.#dropMailboxCaches(id);
      return true;
    });
  }
  draft(id) {
    return this.#run(id, () => this.#vault.get(`mail-draft:${id}`));
  }
  saveDraft(id, value) {
    const draft = validateDraft(value);
    return this.#run(id, () => this.#vault.set(`mail-draft:${id}`, draft));
  }
  async send(id, input) {
    const draft = validateDraft(input, { sending: true });
    if (this.#sending.has(id)) fail("该邮箱正在发送邮件，请勿重复提交");
    this.#sending.add(id);
    try {
      return await this.#run(id, async (account, auth, signal, assertActive) => {
        if (!address(account.address)) fail("发件人邮箱地址无效");
        if (!account.smtp) fail("请先保存 SMTP 发信设置");
        const smtp = validateSmtp(account.smtp);
        const transport = this.#smtp({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.security === "tls",
          requireTLS: smtp.security === "starttls",
          tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
          auth: { user: auth.username, pass: auth.password },
          connectionTimeout: 12000,
          greetingTimeout: 12000,
          socketTimeout: 25000,
          disableFileAccess: true,
          disableUrlAccess: true,
          logger: false,
          debug: false,
        });
        let rejectAbort;
        const interrupted = new Promise((_, reject) => {
          rejectAbort = reject;
        });
        const abort = () => {
          rejectAbort(new MailClientError("发信已取消，结果未确认"));
          transport.close();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          assertActive();
          if (signal.aborted) fail("发信已取消");
          const info = await Promise.race([
            transport.sendMail({
              from: account.address,
              to: draft.to,
              cc: draft.cc || undefined,
              bcc: draft.bcc || undefined,
              subject: draft.subject,
              text: draft.text,
              inReplyTo: draft.inReplyTo,
              attachments: draft.attachments.map((item) => ({
                filename: item.name,
                content: Buffer.from(item.base64, "base64"),
              })),
              disableFileAccess: true,
              disableUrlAccess: true,
            }),
            interrupted,
          ]);
          return {
            messageId: clean(info.messageId),
            accepted: (info.accepted ?? []).map((v) => clean(v, 254)),
            rejected: (info.rejected ?? []).map((v) => clean(v, 254)),
          };
        } catch {
          fail("发信失败或结果未确认，请先核对已发送记录，避免重复发送");
        } finally {
          signal.removeEventListener("abort", abort);
          transport.close();
        }
      });
    } finally {
      this.#sending.delete(id);
    }
  }
}
