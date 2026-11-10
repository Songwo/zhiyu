import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nodemailer from "nodemailer";
import { MailClient, validateSmtp, validateDraft } from "./mail-client.mjs";

const draft = () => ({
  to: "recipient@example.test",
  cc: "",
  bcc: "hidden@example.test",
  subject: "项目进度",
  text: "本周交付安排",
  attachments: [],
});
function fixture(overrides = {}) {
  const saved = new Map();
  const vault = {
    unlocked: true,
    get: async (id) =>
      id.startsWith("account:")
        ? { username: "owner@example.test", password: "private-password" }
        : (saved.get(id) ?? null),
    set: async (id, value) => saved.set(id, value),
  };
  const account = {
    id: "mail-1",
    kind: "mailbox",
    address: "owner@example.test",
    imap: { host: "imap.example.test", port: 993, secure: true },
    smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
  };
  const calls = [];
  class FakeImap extends EventEmitter {
    async connect() {
      calls.push("connect");
    }
    close() {
      calls.push("close");
    }
    async logout() {}
    async list() {
      return [
        { path: "INBOX", name: "Inbox", flags: new Set() },
        { path: "noselect", flags: new Set(["\\Noselect"]) },
      ];
    }
    async mailboxOpen(folder, options) {
      calls.push({ folder, options });
      return { exists: 65, uidValidity: 123n };
    }
    async search(query) {
      calls.push({ search: query });
      return [1, 10, 80];
    }
    async *fetch(range, fields, options) {
      calls.push({ range, fields, options });
      yield {
        uid: 10,
        size: 100,
        flags: new Set(),
        envelope: {
          subject: "测试邮件",
          from: [{ name: "发件人", address: "sender@example.test" }],
          date: new Date("2026-09-09T00:00:00Z"),
        },
      };
    }
    async fetchOne(uid, fields) {
      return fields.source
        ? {
            uid,
            size: 100,
            source: Buffer.from(
              "From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Hello\r\nMessage-ID: <hello@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from MIME",
            ),
            envelope: { subject: "Hello" },
            flags: new Set(),
          }
        : { size: 100 };
    }
    async messageFlagsAdd(uid, flags, options) {
      calls.push({ add: uid, flags, options });
    }
    async messageFlagsRemove(uid, flags, options) {
      calls.push({ remove: uid, flags, options });
    }
  }
  let client;
  const service = new MailClient({
    vault,
    getSnapshot: async () => ({ mailboxes: [account] }),
    createImap: (options) => {
      calls.push({ imapOptions: options });
      client = new FakeImap();
      Object.assign(client, overrides.imap);
      return client;
    },
    createSmtp: (options) => {
      calls.push({ smtpOptions: options });
      return {
        sendMail: async (value) => {
          calls.push({ sent: value });
          return { messageId: "<sent@example.test>", accepted: [value.to], rejected: [] };
        },
        close() {},
        ...overrides.smtp,
      };
    },
  });
  return { service, vault, saved, account, calls, client: () => client };
}
const selected = { folder: "INBOX", uid: 10, uidValidity: "123" };

test("SMTP 只允许 TLS 或强制 STARTTLS，拒绝非法主机和端口", () => {
  assert.deepEqual(validateSmtp({ host: "SMTP.Example.test", port: 587, security: "starttls" }), {
    host: "smtp.example.test",
    port: 587,
    security: "starttls",
  });
  for (const value of [
    { host: "bad\r\nhost", port: 465, security: "tls" },
    { host: "smtp.test", port: 0, security: "tls" },
    { host: "smtp.test", port: 25, security: "plain" },
  ])
    assert.throws(() => validateSmtp(value));
});
test("发信输入拒绝邮件头注入、无效地址及附件路径，保留未完成草稿", () => {
  assert.throws(() =>
    validateDraft({ ...draft(), subject: "hello\r\nBcc: other@test.com" }, { sending: true }),
  );
  assert.throws(() => validateDraft({ ...draft(), to: "wrong" }, { sending: true }));
  assert.throws(() =>
    validateDraft({ ...draft(), attachments: [{ name: "../secret", base64: "YQ==" }] }),
  );
  assert.throws(() =>
    validateDraft({
      ...draft(),
      attachments: Array.from({ length: 6 }, () => ({ name: "a", base64: "YQ==" })),
    }),
  );
  assert.equal(validateDraft({ ...draft(), to: "unfinished" }).to, "unfinished");
  assert.equal(
    validateDraft({ ...draft(), to: "a@example.test；b@example.test" }, { sending: true }).to,
    "a@example.test, b@example.test",
  );
});
test("文件夹排除不可选择项；分页从最新邮件开始，每页最多 30 封", async () => {
  const f = fixture();
  assert.equal((await f.service.folders("mail-1")).length, 1);
  const value = await f.service.messages("mail-1", {
    folder: "INBOX",
    page: 1,
    query: "",
    unseen: false,
  });
  assert.equal(value.total, 65);
  assert.equal(value.uidValidity, "123");
  assert.ok(f.calls.some((call) => call.range === "6:35"));
  assert.equal(value.items[0].seen, false);
  const config = f.calls.find((call) => call.imapOptions).imapOptions;
  assert.equal(config.tls.rejectUnauthorized, true);
  assert.equal(config.logger, false);
});
test("搜索主题和发件人，未读筛选使用 UID；空页不发 FETCH", async () => {
  const f = fixture();
  const result = await f.service.messages("mail-1", {
    folder: "INBOX",
    page: 0,
    query: "project",
    unseen: true,
  });
  assert.equal(result.total, 3);
  assert.deepEqual(f.calls.find((call) => typeof call === "object" && call.search).search, {
    or: [{ subject: "project" }, { from: "project" }],
    seen: false,
  });
  assert.ok(f.calls.some((call) => call.range === "80,10,1" && call.options.uid === true));
  f.calls.length = 0;
  await f.service.messages("mail-1", { folder: "INBOX", page: 20 });
  assert.equal(
    f.calls.some((call) => call.range),
    false,
  );
});
test("正文由 MIME 解析为纯文本，不自动标已读", async () => {
  const f = fixture();
  const result = await f.service.read("mail-1", selected);
  assert.equal(result.text, "Hello from MIME");
  assert.equal(result.messageId, "<hello@example.test>");
  assert.equal(result.html, undefined);
  assert.equal(
    f.calls.some((call) => call.add),
    false,
  );
  assert.ok(f.calls.some((call) => call.options?.readOnly));
});
test("HTML 邮件保留安全排版及纯文本，附件单独获取且不暴露路径", async () => {
  const mime = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
    from: "sender@example.test",
    to: "owner@example.test",
    subject: "html",
    html: '<p>Visible body</p><img src="https://tracking.example.test/pixel">',
    attachments: [{ filename: "report.txt", content: "attachment content" }],
  });
  const f = fixture({
    imap: {
      fetchOne: async (_uid, fields) =>
        fields.source
          ? { uid: 10, source: mime.message, envelope: {}, flags: new Set() }
          : { size: mime.message.length },
    },
  });
  const read = await f.service.read("mail-1", selected);
  assert.match(read.text, /Visible body/);
  assert.match(read.html, /<p>Visible body<\/p>/);
  assert.match(read.html, /data-mail-remote-src="https:\/\/tracking\.example\.test\/pixel"/);
  assert.doesNotMatch(read.html, /\ssrc=/);
  assert.equal(read.attachments[0].name, "report.txt");
  assert.equal(read.attachments[0].content, undefined);
  const attachment = await f.service.attachment("mail-1", selected, 0);
  assert.equal(attachment.content.toString(), "attachment content");
});

test("真实 MIME 的 CID 图片内联，危险 HTML 不跨越邮件读取 IPC", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const mime = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
    from: "sender@example.test",
    to: "owner@example.test",
    subject: "inline",
    text: "图片报告",
    html: '<h2>图片报告</h2><img src="cid:report@example.test"><script>private script</script><a href="file:///private">不安全链接</a>',
    attachments: [{ filename: "report.png", content: png, cid: "report@example.test" }],
  });
  const f = fixture({
    imap: {
      fetchOne: async (_uid, fields) =>
        fields.source
          ? { uid: 10, source: mime.message, envelope: {}, flags: new Set() }
          : { size: mime.message.length },
    },
  });
  const read = await f.service.read("mail-1", selected);
  assert.equal(read.text, "图片报告");
  assert.match(read.html, /<h2>图片报告<\/h2>/);
  assert.match(read.html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(read.html, /private|script|file:/);
  assert.equal(read.attachments[0].name, "report.png");
  assert.equal(read.attachments[0].content, undefined);
});
test("UIDVALIDITY 变化与大邮件阻止读取正文", async () => {
  const f = fixture();
  await assert.rejects(f.service.read("mail-1", { ...selected, uidValidity: "999" }), /刷新/);
  const large = fixture({ imap: { fetchOne: async () => ({ size: 13 * 1024 * 1024 }) } });
  await assert.rejects(large.service.read("mail-1", selected), /12 MiB/);
});
test("显式标记已读和未读使用 UID", async () => {
  const f = fixture();
  await f.service.seen("mail-1", selected, true);
  await f.service.seen("mail-1", selected, false);
  assert.ok(f.calls.some((call) => call.add === 10 && call.options.uid));
  assert.ok(f.calls.some((call) => call.remove === 10 && call.options.uid));
});
test("锁库和演示邮箱不建立连接", async () => {
  const f = fixture();
  f.vault.unlocked = false;
  await assert.rejects(f.service.folders("mail-1"), /锁定/);
  f.vault.unlocked = true;
  f.account.demo = true;
  await assert.rejects(f.service.folders("mail-1"), /真实邮箱/);
  assert.equal(f.calls.length, 0);
});
test("锁库取消尚未结束的读取并关闭连接", async () => {
  const f = fixture({ imap: { connect: () => new Promise(() => {}) } });
  const reading = f.service.read("mail-1", selected);
  await new Promise((resolve) => setImmediate(resolve));
  f.service.stop();
  await assert.rejects(reading, /取消/);
  assert.ok(f.calls.includes("close"));
});
test("服务器错误不会泄露上游正文或凭据", async () => {
  const f = fixture({
    imap: {
      connect: async () => {
        throw new Error("private-password private message body");
      },
    },
  });
  await assert.rejects(
    f.service.folders("mail-1"),
    (error) => !error.message.includes("private") && error.message.includes("邮件操作失败"),
  );
});
test("草稿只交给加密库，不写入资产快照", async () => {
  const f = fixture();
  await f.service.saveDraft("mail-1", draft());
  assert.deepEqual(await f.service.draft("mail-1"), draft());
  assert.ok(f.saved.has("mail-draft:mail-1"));
  assert.equal(f.account.text, undefined);
});
test("真实发信参数使用保存的发件人、强制 TLS 和内存附件", async () => {
  const f = fixture();
  const result = await f.service.send("mail-1", {
    ...draft(),
    from: "attacker@example.test",
    attachments: [{ name: "a.txt", base64: "YQ==" }],
  });
  assert.equal(result.accepted.length, 1);
  const smtp = f.calls.find((call) => call.smtpOptions).smtpOptions;
  assert.equal(smtp.requireTLS, true);
  assert.equal(smtp.tls.rejectUnauthorized, true);
  assert.equal(smtp.disableUrlAccess, true);
  assert.equal(smtp.disableFileAccess, true);
  const sent = f.calls.find((call) => call.sent).sent;
  assert.equal(sent.from, "owner@example.test");
  assert.equal(sent.bcc, "hidden@example.test");
  assert.equal(sent.attachments[0].content.toString(), "a");
  assert.equal(sent.html, undefined);
});
test("同一邮箱发信进行中拒绝重复提交，部分拒绝如实返回", async () => {
  let complete;
  const f = fixture({
    smtp: {
      sendMail: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  });
  const first = f.service.send("mail-1", draft());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.service.send("mail-1", draft()), /重复提交/);
  complete({ accepted: ["a@example.test"], rejected: ["b@example.test"] });
  assert.deepEqual((await first).rejected, ["b@example.test"]);
});
test("SMTP 结果不明不谎报成功也不自动重发", async () => {
  let count = 0;
  const f = fixture({
    smtp: {
      sendMail: async () => {
        count++;
        throw new Error("private-password");
      },
    },
  });
  await assert.rejects(f.service.send("mail-1", draft()), /结果未确认/);
  assert.equal(count, 1);
});

test("锁库取消无响应的 SMTP 请求，不依赖传输层完成回调", async () => {
  let closed = 0;
  const f = fixture({
    smtp: {
      sendMail: () => new Promise(() => {}),
      close: () => {
        closed++;
      },
    },
  });
  const sending = f.service.send("mail-1", draft());
  await new Promise((resolve) => setImmediate(resolve));
  f.service.stop();
  await assert.rejects(sending, /结果未确认/);
  assert.ok(closed > 0);
});

// —— 0.9.0 会话级缓存 ——
test("正文与附件共享会话缓存：同一封邮件不重复连接解析", async () => {
  const f = fixture();
  const first = await f.service.read("mail-1", selected);
  assert.equal(first.text, "Hello from MIME");
  const second = await f.service.read("mail-1", selected);
  assert.deepEqual(second, first);
  assert.equal(f.service.cacheStats().messages, 1);
  // 附件走同一份已解析缓存：即使该邮件没有附件，也不应重新连接 IMAP。
  await assert.rejects(f.service.attachment("mail-1", selected, 0), /附件不存在/);
  assert.equal(f.calls.filter((c) => c === "connect").length, 1);
});
test("标记已读后清除该邮箱的会话缓存", async () => {
  const f = fixture();
  await f.service.read("mail-1", selected);
  await f.service.seen("mail-1", selected, true);
  await f.service.read("mail-1", selected);
  // 读取 + 标记 + 缓存清除后的再次读取都各自连接。
  assert.equal(f.calls.filter((c) => c === "connect").length, 3);
});
test("锁库后缓存命中路径不返回邮件内容", async () => {
  const f = fixture();
  await f.service.read("mail-1", selected);
  assert.equal(f.service.cacheStats().messages, 1);
  f.vault.unlocked = false;
  await assert.rejects(f.service.read("mail-1", selected), /密钥库已锁定/);
  f.vault.unlocked = true;
});
test("文件夹与列表分页在短 TTL 内直接复用", async () => {
  const f = fixture();
  await f.service.folders("mail-1");
  await f.service.folders("mail-1");
  await f.service.messages("mail-1", { folder: "INBOX" });
  await f.service.messages("mail-1", { folder: "INBOX" });
  assert.equal(f.calls.filter((c) => c === "connect").length, 2);
});

test("延迟创建 SMTP 传输期间锁库，完成加载后不得发送且关闭传输", async () => {
  const f = fixture();
  let ready, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let sent = 0,
    closed = 0;
  const service = new MailClient({
    vault: f.vault,
    getSnapshot: async () => ({ mailboxes: [f.account] }),
    createSmtp: () => {
      entered();
      return new Promise((resolve) => {
        ready = resolve;
      });
    },
  });
  const result = service.send("mail-1", draft());
  await started;
  service.stop();
  ready({
    sendMail: async () => {
      sent++;
    },
    close: () => {
      closed++;
    },
  });
  await assert.rejects(result, /结果未确认/);
  assert.equal(sent, 0);
  assert.equal(closed, 1);
});

test("先请求附件形成的解析缓存仍可随后构建正文，不重复连接", async () => {
  const f = fixture();
  await assert.rejects(f.service.attachment("mail-1", selected, 0), /附件不存在/);
  const message = await f.service.read("mail-1", selected);
  assert.equal(message.text, "Hello from MIME");
  assert.equal(f.calls.filter((call) => call === "connect").length, 1);
});

test("首次直接获取 MIME 附件，再读正文，复用同一解析缓存", async () => {
  const source = Buffer.from(
    [
      "From: sender@example.test",
      "To: owner@example.test",
      "Subject: Attachment",
      'Content-Type: multipart/mixed; boundary="fixture"',
      "",
      "--fixture",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body before attachment",
      "--fixture",
      "Content-Type: text/plain",
      'Content-Disposition: attachment; filename="a.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      "YQ==",
      "--fixture--",
      "",
    ].join("\r\n"),
  );
  const f = fixture({
    imap: {
      fetchOne: async (uid, fields) =>
        fields.source
          ? {
              uid,
              size: source.length,
              source,
              envelope: { subject: "Attachment" },
              flags: new Set(),
            }
          : { size: source.length },
    },
  });
  const attachment = await f.service.attachment("mail-1", selected, 0);
  assert.equal(attachment.name, "a.txt");
  assert.equal(attachment.content.toString(), "a");
  const message = await f.service.read("mail-1", selected);
  assert.equal(message.text, "Body before attachment");
  assert.equal(message.attachments[0].name, "a.txt");
  assert.equal(f.calls.filter((call) => call === "connect").length, 1);
});

test("锁库后延迟返回的邮件解析不得重新填充正文缓存", async () => {
  let releaseSource, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    imap: {
      fetchOne: async (uid, fields) => {
        if (!fields.source) return { size: 100 };
        entered();
        return new Promise((resolve) => {
          releaseSource = () =>
            resolve({
              uid,
              size: 100,
              source: Buffer.from(
                "From: sender@example.test\r\nContent-Type: text/plain\r\n\r\nPrivate delayed body",
              ),
              envelope: { subject: "Delayed" },
              flags: new Set(),
            });
        });
      },
    },
  });
  const reading = f.service.read("mail-1", selected);
  const rejected = assert.rejects(reading, /取消|锁定/);
  await started;
  f.service.stop();
  f.vault.unlocked = false;
  await rejected;
  releaseSource();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.service.cacheStats().messages, 0);
});
