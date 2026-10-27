import {
  accountId,
  credentialId,
  desktop,
  type DesktopBridge,
  type SshCredential,
} from "./desktop";
import { t } from "./i18n";
import { useVault } from "./vault-state";
import { vaultApi } from "./vault-api";
import { isWeb, webApi } from "./web";

/**
 * 网页版的「主进程桥」：与桌面版 preload 同名的频道，由 selfhost/bridge.mjs 在服务器上执行。
 *
 * 需要凭据的操作先在浏览器里解锁密钥库、取出凭据，再随请求发给服务器，服务器用完即丢。
 * 服务器推送的事件（SSH 输出、AI 助手进度、资料变更）共用一条 SSE 长连接。
 */
export type HostBridge = Pick<
  DesktopBridge,
  | "ssh"
  | "sftp"
  | "metrics"
  | "integrations"
  | "agent"
  | "profile"
  | "storage"
  | "domain"
  | "cert"
  | "info"
  | "usage"
  | "nodes"
  | "images"
  | "mail"
  | "mailboxes"
  | "mailClient"
>;

export async function webInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await webApi<{ data: T }>("rpc", { method: "POST", body: { channel, args } });
  return res.data;
}

const listeners = new Map<string, Set<(payload: never) => void>>();
let source: EventSource | null = null;

function connect() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/web/events");
  source.onmessage = (event) => {
    let message: { channel?: string; payload?: unknown };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    for (const handler of listeners.get(message.channel ?? "") ?? [])
      (handler as (payload: unknown) => void)(message.payload);
  };
}

/** 订阅服务器推送；最后一个订阅取消后断开长连接。 */
export function onWebEvent<T>(channel: string, handler: (payload: T) => void): () => void {
  let set = listeners.get(channel);
  if (!set) listeners.set(channel, (set = new Set()));
  set.add(handler as (payload: never) => void);
  connect();
  return () => {
    set.delete(handler as (payload: never) => void);
    if (![...listeners.values()].some((entry) => entry.size)) {
      source?.close();
      source = null;
    }
  };
}

/** 解锁浏览器里的密钥库并取出这台主机的 SSH 凭据。 */
async function sshCredential(serverId: string): Promise<SshCredential> {
  const vault = vaultApi();
  if (!vault || !(await useVault.getState().require(t("解锁后才能用保存的凭据连接主机。"))))
    throw new Error(t("密钥库未解锁"));
  const credential = await vault.get(credentialId(serverId));
  if (!credential) throw new Error(t("没有找到该主机的凭据，请先在密钥库中保存"));
  return credential;
}

/** 邮箱的登录名和授权码：同样在浏览器里解密后随请求发送，服务器不保存。 */
async function mailCredential(mailboxId: string) {
  const vault = vaultApi();
  if (!vault || !(await useVault.getState().require(t("查看和发送邮件需要解锁密钥库。"))))
    throw new Error(t("密钥库未解锁"));
  const account = await vault.get(accountId(mailboxId));
  if (!account?.username || !account.password)
    throw new Error(t("请先在邮箱详情保存用户名和密码 / 授权码"));
  return { username: account.username, password: account.password };
}

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 键入的字符攒一小会儿再发，避免每个按键都是一次请求。 */
const outgoing = new Map<string, { data: string; timer: ReturnType<typeof setTimeout> }>();
function queueWrite(sessionId: string, data: string) {
  const entry = outgoing.get(sessionId);
  if (entry) {
    entry.data += data;
    return;
  }
  outgoing.set(sessionId, {
    data,
    timer: setTimeout(() => {
      const pending = outgoing.get(sessionId);
      outgoing.delete(sessionId);
      if (pending) void webInvoke("ssh:write", sessionId, pending.data).catch(() => {});
    }, 12),
  });
}

function pickTextFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

function saveFromServer(ticket: string, name: string) {
  const a = document.createElement("a");
  a.href = `/api/web/download/${encodeURIComponent(ticket)}`;
  a.download = name;
  a.click();
}

const invoker =
  <A extends unknown[], R>(channel: string) =>
  (...args: A) =>
    webInvoke<R>(channel, ...args);

export const webBridge: HostBridge = {
  info: () => webInvoke("app:info"),
  ssh: {
    open: async (target, size) =>
      webInvoke("ssh:open", target, size, await sshCredential(target.id)),
    probe: async (target) => webInvoke("ssh:probe", target, await sshCredential(target.id)),
    test: (target, credential) => webInvoke("ssh:test", target, credential),
    resetHostKey: (target) => webInvoke("ssh:reset-host-key", target),
    close: (sessionId) => webInvoke("ssh:close", sessionId),
    write: queueWrite,
    resize: (sessionId, cols, rows) => void webInvoke("ssh:resize", sessionId, cols, rows),
    onData: (handler) => onWebEvent("ssh:data", handler),
    onExit: (handler) => onWebEvent("ssh:exit", handler),
  },
  sftp: {
    list: async (id, path) => webInvoke("sftp:list", id, path, await sshCredential(id)),
    download: async (id, path) => {
      const { ticket, name } = await webInvoke<{ ticket: string; name: string }>(
        "sftp:download",
        id,
        path,
        await sshCredential(id),
      );
      saveFromServer(ticket, name);
      return true;
    },
  },
  metrics: {
    list: invoker("metrics:list"),
    onUpdated: (handler) => onWebEvent("metrics:updated", handler),
    onError: (handler) => onWebEvent("metrics:error", handler),
  },
  integrations: {
    list: invoker("integrations:list"),
    save: invoker("integrations:save"),
    remove: invoker("integrations:remove"),
    inventory: (id, force = false) => webInvoke("integrations:inventory", id, force),
    bind: invoker("integrations:bind"),
    importZones: invoker("integrations:importZones"),
    syncZones: invoker("integrations:syncZones"),
    unbind: invoker("integrations:unbind"),
    dnsList: (id, zoneId, force = false) => webInvoke("integrations:dnsList", id, zoneId, force),
    dnsPreview: invoker("integrations:dnsPreview"),
    dnsApply: invoker("integrations:dnsApply"),
    probeHistory: invoker("integrations:probeHistory"),
    probeCheckHistory: invoker("integrations:probeCheckHistory"),
    probeEnroll: invoker("integrations:probeEnroll"),
    probeRevoke: invoker("integrations:probeRevoke"),
    probeSaveCheck: invoker("integrations:probeSaveCheck"),
    probeDeleteCheck: invoker("integrations:probeDeleteCheck"),
  } as HostBridge["integrations"],
  agent: {
    applyProposal: invoker("agent:apply-proposal"),
    discardProposal: invoker("agent:discard-proposal"),
    config: invoker("agent:config"),
    saveConfig: invoker("agent:save-config"),
    models: invoker("agent:models"),
    test: invoker("agent:test"),
    run: invoker("agent:run"),
    cancel: invoker("agent:cancel"),
    knowledge: invoker("agent:knowledge"),
    rebuild: invoker("agent:rebuild"),
    removeDocument: invoker("agent:remove-document"),
    importDocument: async () => {
      const file = await pickTextFile(".md,.txt,text/markdown,text/plain");
      if (!file) return null;
      if (file.size > 512000) throw new Error(t("知识文档不能超过 500 KB。"));
      return webInvoke("agent:add-document", file.name, await file.text());
    },
    onEvent: (handler) => onWebEvent("agent:event", handler),
  },
  profile: {
    get: invoker("profile:get"),
    save: invoker("profile:save"),
  },
  storage: {
    stats: invoker("storage:stats"),
    clear: async () => {
      throw new Error(t("网页版没有本机缓存需要清理"));
    },
  },
  usage: {
    onChanged: (handler) => onWebEvent("usage:changed", handler),
    list: invoker("usage:list"),
    add: invoker("usage:add"),
    update: invoker("usage:update"),
    subscriptionDetails: invoker("usage:subscription-details"),
    v2raynStatus: (force = false) => webInvoke("usage:v2rayn-status", force),
    chooseV2raynDirectory: invoker("usage:v2rayn-directory"),
    remove: invoker("usage:remove"),
    refresh: invoker("usage:refresh"),
    refreshAll: invoker("usage:refresh-all"),
    localStatus: invoker("usage:local-status"),
    configureLocal: invoker("usage:local-configure"),
    refreshLocal: invoker("usage:local-refresh"),
  },
  nodes: { check: invoker("nodes:check") },
  mail: {
    providers: invoker("mail:providers"),
    guess: invoker("mail:guess"),
    test: invoker("mail:test"),
    oauthProviders: async () => ({}),
    oauthSignIn: async () => {
      throw new Error(t("邮箱的 OAuth 登录需要桌面版弹出的授权窗口，网页版请改用授权码登录。"));
    },
  },
  mailboxes: {
    check: async (id) => webInvoke("mailboxes:check", id, await mailCredential(id)),
    validate: invoker("mailboxes:validate"),
  },
  mailClient: {
    folders: async (id) => webInvoke("mail-client:folders", id, await mailCredential(id)),
    messages: async (id, options) =>
      webInvoke("mail-client:messages", id, options, await mailCredential(id)),
    read: async (id, selection) =>
      webInvoke("mail-client:read", id, selection, await mailCredential(id)),
    seen: async (id, selection, seen) =>
      webInvoke("mail-client:seen", id, selection, seen, await mailCredential(id)),
    send: async (id, draft) => webInvoke("mail-client:send", id, draft, await mailCredential(id)),
    draft: async (id) => webInvoke("mail-client:draft", id, await mailCredential(id)),
    saveDraft: async (id, draft) =>
      webInvoke("mail-client:save-draft", id, draft, await mailCredential(id)),
    validateSmtp: invoker("mail-client:validate-smtp"),
    /** 与桌面版相同的限制：最多 5 个附件，合计不超过 8 MiB。 */
    pickAttachments: async () => {
      const files = await pickFiles();
      if (files.length > 5) throw new Error(t("最多添加 5 个附件"));
      if (files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024)
        throw new Error(t("附件总大小不能超过 8 MiB"));
      return Promise.all(
        files.map(async (file) => ({ name: file.name, base64: await fileBase64(file) })),
      );
    },
    download: async (id, selection, index) => {
      const { ticket, name } = await webInvoke<{ ticket: string; name: string }>(
        "mail-client:download",
        id,
        selection,
        index,
        await mailCredential(id),
      );
      saveFromServer(ticket, name);
      return true;
    },
  },
  images: {
    status: invoker("images:status"),
    configure: invoker("images:configure"),
    upload: invoker("images:upload"),
  },
  domain: { probe: invoker("domain:probe") },
  cert: { probe: invoker("cert:probe"), parsePem: invoker("cert:parse-pem") },
};

/** 桌面版交给系统浏览器打开，网页版与预览直接开新标签页。 */
export function openExternal(url: string): Promise<boolean> {
  const bridge = desktop();
  if (bridge) return bridge.openExternal(url);
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve(true);
}

/** 桌面版走 Electron 主进程，网页版走服务器；纯浏览器预览两者都没有。 */
export function hostBridge(): HostBridge | null {
  return desktop() ?? (isWeb() ? webBridge : null);
}

export interface HostSnapshot {
  supported: boolean;
  reason?: string;
  at?: number;
  scope?: { procHost: boolean; proc: string; container: string | null };
  info: {
    hostname: string | null;
    hostnameFromHost: boolean;
    os: string | null;
    osFromHost: boolean;
    kernel: string;
    arch: string;
    cpuModel: string | null;
    cores: number;
    container: string | null;
    node: string;
  };
  cpu?: { usage: number; iowait: number; steal: number } | null;
  memory?: {
    total: number;
    used: number;
    available: number;
    cached: number;
    swapTotal: number;
    swapUsed: number;
  } | null;
  load?: number[] | null;
  uptime?: number | null;
  disk?: { total: number; used: number; free: number } | null;
  diskIo?: { read: number | null; write: number | null } | null;
  network?: {
    rx: number | null;
    tx: number | null;
    totalRx: number;
    totalTx: number;
    interfaces: Array<{ name: string; rx: number; tx: number }>;
  };
  cgroup?: {
    version: number;
    memoryLimit: number | null;
    memoryUsed: number | null;
    cpuLimit: number | null;
    cpu: number | null;
  } | null;
  processes?: {
    count: number;
    byCpu: HostProcess[];
    byMemory: HostProcess[];
  } | null;
  history?: HostPoint[];
  service?: { pid: number; uptime: number; rss: number };
}
export interface HostProcess {
  pid: number;
  name: string;
  state: string;
  cpu: number | null;
  memory: number;
  memoryPercent: number | null;
}
export interface HostPoint {
  at: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  load1: number | null;
  rx: number | null;
  tx: number | null;
  diskRead: number | null;
  diskWrite: number | null;
  containerCpu: number | null;
  containerMemory: number | null;
}

export const hostStats = () => webInvoke<HostSnapshot>("host:stats");
