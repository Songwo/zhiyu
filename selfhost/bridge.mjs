/**
 * 网页版的「主进程」：把桌面版主进程里能在服务器上做的事，按同样的频道名开放给浏览器。
 *
 * 浏览器通过 POST /api/web/rpc 调用（{channel, args}），服务器推送的事件（SSH 输出、
 * AI 助手进度、资料变更）走 GET /api/web/events 的 SSE 长连接。频道表是白名单，
 * 页面不能调用这里没有列出的方法。
 *
 * 和桌面版的不同：
 * - 密钥库只在浏览器里解密，需要凭据的操作（SSH、SFTP、主机探测）由浏览器解锁后随请求带上，
 *   服务器用完即丢，不落盘；
 * - Cloudflare Token、模型 API Key 用 server 目录里的密钥加密保存（见 secure-storage.mjs）。
 */
import { X509Certificate, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { AgentService } from "../electron/services/agent-service.mjs";
import { Integrations, INTEGRATION_METHODS } from "../electron/services/integrations.mjs";
import { MetricsStore } from "../electron/services/metrics.mjs";
import { probeCertificate, probeDomain } from "../electron/services/net-probe.mjs";
import { SshManager } from "../electron/services/ssh.mjs";
import { validateImageDataUrl } from "../electron/services/image-data.mjs";
import { WorkspaceActions } from "../electron/services/workspace-actions.mjs";
import { UsageStore } from "../electron/services/usage.mjs";
import { LocalUsageMonitor } from "../electron/services/local-usage.mjs";
import { V2raynUsage } from "../electron/services/v2rayn-usage.mjs";
import { checkNode } from "../electron/services/node-check.mjs";
import { ImageBed } from "../electron/services/image-bed.mjs";
import { MailClient, validateSmtp } from "../electron/services/mail-client.mjs";
import { MailboxService } from "../electron/services/mailbox-service.mjs";
import {
  MAIL_PROVIDERS,
  providerForAddress,
  testMailbox,
  validateMailboxConnection,
} from "../electron/services/mail.mjs";

export class BridgeError extends Error {}

const STORAGE_FILES = [
  "assets.json",
  "vault.enc",
  "metrics.json",
  "rag-index.json",
  "knowledge.json",
  "profile.json",
  "agent-config.json",
  "integrations.json",
];

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(path);
    else total += (await stat(path).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** 浏览器带来的 SSH 凭据只接受密码或私钥正文：服务器上的私钥文件与 ssh-agent 不属于用户。 */
function sshCredential(value) {
  if (!value || typeof value !== "object")
    throw new BridgeError("没有找到该主机的凭据，请先在密钥库中保存");
  if (value.kind === "password" && typeof value.password === "string")
    return { kind: "password", password: value.password };
  if (value.kind === "key" && typeof value.privateKey === "string" && value.privateKey.trim())
    return {
      kind: "key",
      privateKey: value.privateKey,
      ...(typeof value.passphrase === "string" && value.passphrase
        ? { passphrase: value.passphrase }
        : {}),
    };
  if (value.kind === "key")
    throw new BridgeError("网页版需要把私钥内容保存在凭据里，不能读取服务器上的私钥文件");
  throw new BridgeError("网页版不能使用 ssh-agent，请改用密码或私钥");
}

/**
 * 用量来源（机场订阅、API 用量接口）的凭据：服务器要在浏览器关着时定时刷新，
 * 所以不能放进浏览器解密的密钥库，改为逐条用服务器密钥加密，存在 server 目录。
 */
export function createServerCredentialStore(file, secureStorage) {
  let queue = Promise.resolve();
  const readAll = async () => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new BridgeError("用量来源凭据读取失败");
    }
  };
  const writeAll = (mutate) => {
    const task = queue.then(async () => {
      const next = mutate(await readAll());
      const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, file);
    });
    queue = task.catch(() => {});
    return task;
  };
  return {
    unlocked: true,
    session: 1,
    async get(id) {
      const sealed = (await readAll())[id];
      if (typeof sealed !== "string") return null;
      try {
        return JSON.parse(secureStorage.decryptString(Buffer.from(sealed, "base64")));
      } catch {
        return null;
      }
    },
    set: (id, value) =>
      writeAll((all) => ({
        ...all,
        [id]: secureStorage.encryptString(JSON.stringify(value)).toString("base64"),
      })),
    remove: (id) =>
      writeAll((all) => {
        delete all[id];
        return all;
      }),
  };
}

export function compareVersions(a, b) {
  const pa = String(a)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

const size = (value) => ({
  cols: Math.min(500, Math.max(20, Number(value?.cols) || 100)),
  rows: Math.min(200, Math.max(5, Number(value?.rows) || 30)),
});

export function createWebBridge({
  workspace,
  serverDir,
  documents,
  getSnapshot,
  mutateAssets,
  emit,
  secureStorage,
  fetchImpl = fetch,
  hostStats,
  version,
  root,
}) {
  const hostKeysFile = join(serverDir, "ssh-known-hosts.json");
  const downloadsDir = join(serverDir, "downloads");
  const profileFile = join(workspace, "profile.json");
  const downloads = new Map();
  let hostKeyQueue = Promise.resolve();
  const readHostKeys = async () =>
    JSON.parse(await readFile(hostKeysFile, "utf8").catch(() => "{}"));
  const writeHostKeys = (mutate) => {
    const task = hostKeyQueue.then(async () => {
      const next = mutate(await readHostKeys());
      const tmp = `${hostKeysFile}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, hostKeysFile);
    });
    hostKeyQueue = task.catch(() => {});
    return task;
  };
  const hostKey = (host, port) => `${String(host).toLowerCase()}:${port || 22}`;
  const ssh = new SshManager(emit, {
    get: async (host, port) => (await readHostKeys())[hostKey(host, port)] ?? null,
    set: (host, port, fingerprint) =>
      writeHostKeys((all) => ({ ...all, [hostKey(host, port)]: fingerprint })),
    remove: (host, port) =>
      writeHostKeys((all) => {
        delete all[hostKey(host, port)];
        return all;
      }),
  });
  const metrics = new MetricsStore(join(workspace, "metrics.json"));
  // 邮箱：登录名和授权码只在浏览器的密钥库里，每次操作随请求带来，操作结束就从内存删掉。
  const mailCredentials = new Map();
  const drafts = createServerCredentialStore(join(serverDir, "mail-drafts.json"), secureStorage);
  const mailVault = {
    unlocked: true,
    session: 1,
    get: async (id) =>
      id.startsWith("mail-draft:") ? drafts.get(id) : (mailCredentials.get(id)?.value ?? null),
    set: (id, value) => {
      if (!id.startsWith("mail-draft:")) throw new BridgeError("网页版不在服务器上保存邮箱凭据");
      return drafts.set(id, value);
    },
    remove: (id) => drafts.remove(id),
  };
  const withMailbox = async (id, credential, work) => {
    if (
      typeof id !== "string" ||
      typeof credential?.username !== "string" ||
      typeof credential?.password !== "string"
    )
      throw new BridgeError("请先在邮箱详情保存用户名和密码 / 授权码");
    const key = `account:${id}`;
    const entry = mailCredentials.get(key) ?? { users: 0 };
    entry.users += 1;
    entry.value = { username: credential.username, password: credential.password };
    mailCredentials.set(key, entry);
    try {
      return await work();
    } finally {
      if (--entry.users <= 0) mailCredentials.delete(key);
    }
  };
  const mailClient = new MailClient({ vault: mailVault, getSnapshot });
  const mailboxes = new MailboxService({
    directory: workspace,
    vault: mailVault,
    getSnapshot,
  });
  const images = new ImageBed({
    file: join(workspace, "image-bed.json"),
    secureStorage,
    fetchImpl,
    // 桌面版用 Electron 解码校验；服务器上只确认是能识别的图片格式且内容非空。
    decode: (value) => {
      const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(
        String(value),
      );
      return Boolean(match && Buffer.from(match[2], "base64").length > 16);
    },
  });
  const usage = new UsageStore(
    join(workspace, "usage-history.json"),
    createServerCredentialStore(join(serverDir, "usage-credentials.json"), secureStorage),
    fetchImpl,
  );
  // 「本机」在网页版指服务所在的机器：读的是服务用户主目录下的 AI 客户端日志。
  const localUsage = new LocalUsageMonitor({ file: join(workspace, "local-usage.json") });
  const v2rayn = new V2raynUsage({ configFile: join(workspace, "v2rayn-usage.json") });
  const localStatus = async () => ({ ...(await localUsage.status()), paused: false });
  const refreshLocalUsage = async () => {
    const before = localUsage.recordsRevision;
    const status = await localUsage.refresh();
    emit("usage:changed", {
      recordsChanged: before !== localUsage.recordsRevision,
      localStatus: { ...status, paused: false },
    });
    return status;
  };
  let usageRefresh = null;
  const refreshUsage = (force) =>
    (usageRefresh ??= (async () => {
      const failures = [];
      try {
        for (const source of (await usage.list()).sources.filter((s) => s.type !== "oauth")) {
          try {
            await usage.refresh(source.id, { force });
          } catch (error) {
            failures.push(source.name + "：" + error.message);
          }
        }
        emit("usage:changed", { recordsChanged: true });
        return { failures };
      } finally {
        usageRefresh = null;
      }
    })());
  const timers = [];
  const integrations = new Integrations({
    file: join(workspace, "integrations.json"),
    secureStorage,
    fetchImpl,
    mutateAssets,
  });
  const workspaceActions = new WorkspaceActions({
    getSnapshot,
    documents: {
      get: (id) => documents().get(id),
      save: (doc, options) => documents().save(doc, options),
      remove: (id) => documents().remove(id),
      list: () => documents().list(),
      listMetadata: () => documents().listMetadata(),
    },
    mutateAssets,
  });
  const agent = new AgentService({
    directory: workspace,
    secureStorage,
    getSnapshot,
    workspaceActions,
    workspaceDocuments: {
      list: () => documents().listMetadata(),
      get: (id) => documents().get(id),
    },
    checkMailbox: async () => {
      throw new Error("网页版的服务器不保存邮箱密码，不能代为检查邮箱。");
    },
    emit: (event) => emit("agent:event", event),
    fetchImpl,
  });

  function savedServer(id) {
    const server = getSnapshot()?.servers?.find((x) => x.id === id);
    if (!server) throw new BridgeError("这台主机已经不存在");
    if (server.demo) throw new BridgeError("演示主机不允许进行真实连接。");
    return { id: server.id, host: server.host, port: server.port, username: server.username };
  }

  async function profile() {
    let saved = {};
    try {
      saved = JSON.parse(await readFile(profileFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new BridgeError("个人资料读取失败");
    }
    let avatarDataUrl = "";
    try {
      avatarDataUrl = validateImageDataUrl(saved.avatarDataUrl);
    } catch {
      // 损坏的旧头像不影响其他资料。
    }
    const vaultExists = Boolean(await stat(join(workspace, "vault.enc")).catch(() => null));
    return {
      name: typeof saved.name === "string" ? saved.name : "",
      avatarDataUrl,
      ready: true,
      vaultExists,
    };
  }

  const handlers = {
    "app:info": async () => ({
      platform: process.platform,
      arch: process.arch,
      version,
      node: process.versions.node,
      userData: root,
      packaged: true,
      portable: false,
      web: true,
    }),

    "host:stats": () => hostStats.snapshot(),
    /** 网页版不自更新（镜像由 docker compose pull 升级），这里只告诉用户有没有新版本。 */
    "app:check-update": async () => {
      const page = "https://github.com/Songwo/zhiyu/releases/latest";
      try {
        const res = await fetchImpl("https://api.github.com/repos/Songwo/zhiyu/releases/latest", {
          headers: { accept: "application/vnd.github+json", "user-agent": "zhiyu-web" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
        const latest = String((await res.json()).tag_name ?? "").replace(/^v/, "");
        const newer = compareVersions(latest, version) > 0;
        return { state: newer ? "outdated" : "current", current: version, latest, page };
      } catch (error) {
        return {
          state: "error",
          current: version,
          page,
          reason: `检查更新失败：${error.message}（服务器需要能访问 api.github.com）`,
        };
      }
    },

    "profile:get": profile,
    "profile:save": async (value) => {
      const name = typeof value?.name === "string" ? value.name.trim() : "";
      if (!name || name.length > 40) throw new BridgeError("姓名需要 1 至 40 个字符。");
      const current = await profile();
      const avatar =
        value.avatarDataUrl === undefined
          ? current.avatarDataUrl
          : validateImageDataUrl(value.avatarDataUrl);
      const tmp = `${profileFile}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify({ name, avatarDataUrl: avatar }), "utf8");
      await rename(tmp, profileFile);
      return profile();
    },

    "storage:stats": async () => {
      const files = {};
      for (const name of STORAGE_FILES)
        files[name] = (await stat(join(workspace, name)).catch(() => ({ size: 0 }))).size;
      files["documents/"] = await dirSize(join(workspace, "documents"));
      return {
        files,
        cache: { dirs: {}, total: 0 },
        mail: { folders: 0, pages: 0, messages: 0, bytes: 0 },
      };
    },

    "ssh:open": (target, dims, credential) =>
      ssh.openShell(savedServer(target?.id), sshCredential(credential), size(dims)),
    "ssh:probe": async (target, credential) => {
      const probe = await ssh.probe(savedServer(target?.id), sshCredential(credential));
      try {
        await metrics.record(target.id, probe);
        emit("metrics:updated", { id: target.id });
      } catch (error) {
        emit("metrics:error", { id: target.id, error: String(error.message) });
      }
      return probe;
    },
    "ssh:test": (target, credential) =>
      ssh.test(
        {
          host: String(target?.host ?? ""),
          port: Number(target?.port) || 22,
          username: String(target?.username ?? ""),
        },
        sshCredential(credential),
      ),
    "ssh:reset-host-key": async (target) => {
      if (!target || typeof target.host !== "string" || !target.host.trim())
        throw new BridgeError("主机地址不正确。");
      await ssh.resetHostKey({ host: target.host, port: Number(target.port) || 22 });
      return { ok: true };
    },
    "ssh:close": (sessionId) => {
      ssh.close(String(sessionId));
      return true;
    },
    "ssh:write": (sessionId, data) => {
      if (typeof data === "string" && data.length <= 64 * 1024) ssh.write(String(sessionId), data);
      return true;
    },
    "ssh:resize": (sessionId, cols, rows) => {
      const dims = size({ cols, rows });
      ssh.resize(String(sessionId), dims.cols, dims.rows);
      return true;
    },

    "metrics:list": (id, since) =>
      metrics.list(String(id), Number.isFinite(since) ? Number(since) : 0),
    "sftp:list": (id, path, credential) =>
      ssh.sftp.list(savedServer(id), sshCredential(credential), path),
    /** 先下到服务器的临时目录，浏览器再用一次性链接取走，取完即删。 */
    "sftp:download": async (id, path, credential) => {
      await mkdir(downloadsDir, { recursive: true, mode: 0o700 });
      const ticket = randomBytes(18).toString("base64url");
      const file = join(downloadsDir, ticket);
      await ssh.sftp.download(savedServer(id), sshCredential(credential), path, file);
      const name = posix.basename(String(path)) || "download";
      downloads.set(ticket, { file, name, expires: Date.now() + 10 * 60_000 });
      setTimeout(() => void takeDownload(ticket, true), 10 * 60_000).unref?.();
      return { ticket, name };
    },

    "usage:list": async () => {
      const [remote, local] = await Promise.all([usage.list(), localUsage.list()]);
      const recordedLocal = new Set(local.records.map((row) => row.sourceId));
      return {
        sources: [
          ...remote.sources,
          ...local.sources.filter((source) => recordedLocal.has(source.id)),
        ],
        records: [...remote.records, ...local.records],
      };
    },
    "usage:subscription-details": (id) => usage.subscriptionDetails(id),
    "usage:refresh-all": () => refreshUsage(true),
    "usage:local-status": localStatus,
    "usage:local-configure": async (input) => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "enabled") ||
        typeof input.enabled !== "boolean"
      )
        throw new BridgeError("监控设置只接受开启或关闭，不接受日志路径。");
      await localUsage.configure({ enabled: input.enabled });
      if (input.enabled) await refreshLocalUsage();
      else emit("usage:changed", { recordsChanged: false, localStatus: await localStatus() });
      return localStatus();
    },
    "usage:local-refresh": async () => {
      await refreshLocalUsage();
      return localStatus();
    },
    "usage:v2rayn-status": (force) => v2rayn.status({ force: force === true }),
    "usage:v2rayn-directory": async () => {
      throw new BridgeError("v2rayN 是 Windows 客户端，请在装有 v2rayN 的电脑上用桌面版读取流量。");
    },
    "nodes:check": (node) => checkNode(node),

    "mail:providers": async () => MAIL_PROVIDERS,
    "mail:guess": async (address) => providerForAddress(address),
    "mail:test": (options) => testMailbox(options),
    "mailboxes:validate": (connection) => validateMailboxConnection(connection),
    "mailboxes:check": (id, credential) => withMailbox(id, credential, () => mailboxes.check(id)),
    "mail-client:folders": (id, credential) =>
      withMailbox(id, credential, () => mailClient.folders(id)),
    "mail-client:messages": (id, options, credential) =>
      withMailbox(id, credential, () => mailClient.messages(id, options)),
    "mail-client:read": (id, selection, credential) =>
      withMailbox(id, credential, () => mailClient.read(id, selection)),
    "mail-client:seen": (id, selection, seen, credential) =>
      withMailbox(id, credential, () => mailClient.seen(id, selection, seen)),
    "mail-client:send": (id, draft, credential) =>
      withMailbox(id, credential, () => mailClient.send(id, draft)),
    "mail-client:draft": (id, credential) =>
      withMailbox(id, credential, () => mailClient.draft(id)),
    "mail-client:save-draft": (id, draft, credential) =>
      withMailbox(id, credential, () => mailClient.saveDraft(id, draft)),
    "mail-client:validate-smtp": (value) => validateSmtp(value),
    "mail-client:download": (id, selection, index, credential) =>
      withMailbox(id, credential, async () => {
        const file = await mailClient.attachment(id, selection, index);
        await mkdir(downloadsDir, { recursive: true, mode: 0o700 });
        const ticket = randomBytes(18).toString("base64url");
        await writeFile(join(downloadsDir, ticket), file.content, { mode: 0o600 });
        downloads.set(ticket, {
          file: join(downloadsDir, ticket),
          name: file.name,
          expires: Date.now() + 10 * 60_000,
        });
        setTimeout(() => void takeDownload(ticket, true), 10 * 60_000).unref?.();
        return { ticket, name: file.name };
      }),
    "images:status": () => images.status(),
    "images:configure": (input) => images.configure(input),
    "images:upload": (input) => images.upload(input),

    "domain:probe": (name) => probeDomain(String(name ?? "")),
    "cert:probe": (host, port, servername) =>
      probeCertificate(String(host ?? ""), Number(port) || 443, servername),
    "cert:parse-pem": async (pem) => {
      const cert = new X509Certificate(String(pem ?? ""));
      const field = (dn, key) => new RegExp(`${key}=([^,\\r\\n]+)`).exec(dn)?.[1]?.trim();
      return {
        cn: field(cert.subject, "CN") ?? "",
        issuer: field(cert.issuer, "O") ?? field(cert.issuer, "CN") ?? "",
        validFrom: new Date(cert.validFrom).toISOString(),
        expiresAt: new Date(cert.validTo).toISOString(),
        sans: (cert.subjectAltName ?? "")
          .split(",")
          .map((s) => s.trim().replace(/^DNS:/, ""))
          .filter(Boolean),
        serial: cert.serialNumber,
      };
    },

    "agent:config": () => agent.config(),
    "agent:save-config": (config) => agent.saveConfig(config),
    "agent:models": () => agent.models(),
    "agent:test": () => agent.test(),
    "agent:run": (request) => agent.run(request),
    "agent:cancel": (id) => agent.cancel(id),
    "agent:knowledge": () => agent.knowledge(),
    "agent:rebuild": () => agent.rebuild(),
    "agent:remove-document": (id) => agent.removeDocument(id),
    /** 桌面版弹系统文件框；网页版由浏览器读好文件内容再交给服务器。 */
    "agent:add-document": (name, text) => {
      if (typeof name !== "string" || !/\.(md|txt)$/i.test(name) || name.length > 200)
        throw new BridgeError("只能导入 .md 或 .txt 文件。");
      if (typeof text !== "string" || Buffer.byteLength(text) > 512000)
        throw new BridgeError("知识文档不能超过 500 KB。");
      return agent.addDocument(basename(name), text);
    },
    "agent:apply-proposal": async (id) => {
      if (typeof id !== "string" || id.length > 100) throw new BridgeError("修改建议标识无效。");
      const result = await workspaceActions.apply(id);
      if (result.document) emit("documents:changed", { document: result.document });
      return result;
    },
    "agent:discard-proposal": (id) => {
      if (typeof id !== "string" || id.length > 100) throw new BridgeError("修改建议标识无效。");
      return workspaceActions.discard(id);
    },
  };
  for (const method of ["add", "update", "remove", "refresh"])
    handlers["usage:" + method] = async (...args) => {
      try {
        return await usage[method](...args);
      } finally {
        emit("usage:changed", { recordsChanged: true });
      }
    };
  for (const method of INTEGRATION_METHODS)
    handlers["integrations:" + method] = (...args) => integrations[method](...args);

  async function takeDownload(ticket, discard = false) {
    const entry = downloads.get(ticket);
    downloads.delete(ticket);
    if (!entry) return null;
    if (discard || entry.expires < Date.now()) {
      await rm(entry.file, { force: true });
      return null;
    }
    return entry;
  }

  return {
    channels: Object.keys(handlers),
    async call(channel, args) {
      const fn = Object.hasOwn(handlers, channel) ? handlers[channel] : null;
      if (!fn) throw new BridgeError("网页版不支持这个操作");
      return fn(...(Array.isArray(args) ? args : []));
    },
    takeDownload,
    /** 与桌面版相同的节奏：本机日志 1 分钟扫一次，用量来源 5 分钟刷新一次。 */
    startSchedules() {
      void refreshLocalUsage().catch(() => {});
      timers.push(setInterval(() => void refreshLocalUsage().catch(() => {}), 60_000));
      timers.push(setInterval(() => void refreshUsage(false).catch(() => {}), 300_000));
      for (const timer of timers) timer.unref?.();
    },
    async clearDownloads() {
      await rm(downloadsDir, { recursive: true, force: true });
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
      mailClient.stop();
      mailboxes.stop();
      ssh.closeAll();
      integrations.stop?.();
    },
  };
}
