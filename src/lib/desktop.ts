import type { Snapshot } from "./types";
import { t } from "./i18n.ts";

export type CredentialKind = "password" | "key" | "agent";

export interface SshCredential {
  kind: CredentialKind;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

/**
 * A login kept in the vault: mailbox password, registrar account, AI provider
 * sign-in, or the body of a secret. One shape for every asset kind, because the
 * thing you actually want at 2am is always "账号是什么、密码是什么".
 */
export interface AccountCredential {
  url?: string;
  username?: string;
  password?: string;
  /** Recovery codes, API keys, 2FA backup — anything that needs more than a line. */
  note?: string;
  /** Present when the account was linked with OAuth rather than a password. */
  oauth?: {
    provider: string;
    refreshToken: string | null;
    expiresAt: string | null;
    scope: string;
  };
  updatedAt: string;
}

export interface SshTarget {
  id: string;
  host: string;
  port: number;
  username: string;
}

export interface HostProbe {
  ok: true;
  os?: string;
  hostname?: string;
  kernel?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  uptimeSeconds?: number;
  memTotalKb?: number;
  diskTotalKb?: number;
  loadavg?: string;
  at: string;
}

export interface DomainProbe {
  ok: true;
  domain: string;
  registrar?: string;
  expiresAt?: string;
  createdAt?: string;
  nameservers: string[];
  dns: string;
  statuses: string[];
  autoRenew?: boolean;
  at: string;
}

export interface CertProbe {
  ok: true;
  cn: string;
  issuer: string;
  validFrom: string;
  expiresAt: string;
  sans: string[];
  serial?: string;
  protocol?: string;
  trusted: boolean;
  untrustedReason?: string;
  at: string;
}

export interface MailProvider {
  label: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  domains: string[];
  authNote: string;
}

export interface OAuthProvider {
  label: string;
  usesSecret: boolean;
  scopes: string[];
  consoleUrl: string;
  setupNote: string;
}

export interface OAuthResult {
  ok: true;
  provider: string;
  providerLabel: string;
  address: string;
  name: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string;
  at: string;
}

export interface MailLogin {
  ok: true;
  address: string;
  provider: string | null;
  providerLabel: string;
  imap: import("./mailbox").MailboxConnection;
  smtp: { host: string; port: number } | null;
  messages: number;
  unseen: number;
  usedMb?: number;
  quotaMb?: number;
  at: string;
}

export interface AppInfo {
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  userData: string;
  packaged: boolean;
}

export interface UpdateCheck {
  state:
    | "idle"
    | "checking"
    | "current"
    | "outdated"
    | "downloading"
    | "downloaded"
    | "installing"
    | "unavailable"
    | "error";
  progress?: number;
  transferred?: number;
  total?: number;
  current: string;
  latest?: string;
  page: string;
  reason?: string;
}

export interface PersistedFile extends Snapshot {
  activity?: unknown[];
}

export interface DesktopBridge {
  integrations: import("./integrations").IntegrationsBridge;
  documentAccounts: import("./document-accounts").DocumentAccountsBridge;
  identities: import("./identities").IdentityBridge;
  mainIdentity: import("./main-identity").MainIdentityBridge;
  totp: import("./totp").TotpBridge;
  passwords: {
    previewImport(): Promise<null | {
      ticket: string;
      total: number;
      added: number;
      duplicates: number;
      conflicts: number;
      invalid: number;
      rows: Array<{ title: string; url: string; username: string; status: string }>;
    }>;
    commitImport(
      ticket: string,
    ): Promise<{ imported: number; skipped: number; assets: import("./types").Secret[] }>;
    cancelImport(ticket: string): Promise<void>;
    exportCsv(): Promise<null | { count: number }>;
    onChanged(handler: (assets: import("./types").Secret[]) => void): () => void;
  };
  images: import("./image-bed").ImageBedBridge;
  nodes: {
    check(
      node: import("./types").ProxyNode,
    ): Promise<{ checkedAt: string; latencyMs: number | null; error: string }>;
  };
  usage: import("./usage").UsageBridge;
  documents: import("./documents").DocumentsBridge;
  extension: {
    status(): Promise<{
      running: boolean;
      port: number;
      pairedClients: number;
      pairingPending: boolean;
      pendingCount: number;
      error?: string;
    }>;
    beginPairing(): Promise<{ code: string; expiresAt: number; port: number }>;
    revoke(): Promise<void>;
    list(): Promise<
      Array<{
        id: string;
        url: string;
        title: string;
        username: string;
        hasCredential: boolean;
        createdAt: number;
      }>
    >;
    take(id: string): Promise<{
      id: string;
      url: string;
      title: string;
      username: string;
      password: string;
    }>;
    discard(id: string): Promise<void>;
    onChanged(handler: () => void): () => void;
  };
  capture: {
    list(): Promise<Array<{ id: string; url: string; title: string }>>;
    discard(id: string): Promise<void>;
    onChanged(handler: () => void): () => void;
  };
  mailboxes: import("./mailbox").MailboxesBridge;
  mailClient: import("./mailbox").MailClientBridge;
  mailPush: import("./mail-push").MailPushBridge;
  storage: {
    stats(): Promise<{
      files: Record<string, number>;
      cache: { dirs: Record<string, number>; total: number };
      mail: { folders: number; pages: number; messages: number; bytes: number };
    }>;
    clear(scope: "mail" | "chromium"): Promise<string>;
  };
  aiAccounts: import("./ai-accounts").AiAccountBridge;
  profile: {
    get(): Promise<import("./profile").Profile>;
    save(value: {
      name: string;
      password?: string;
      avatarDataUrl?: string;
    }): Promise<import("./profile").Profile>;
  };
  agent: import("./agent-client").AgentBridge;
  display: {
    get(): Promise<{ zoomPercent: import("../../electron/services/display.mjs").ZoomPercent }>;
    set(
      zoomPercent: import("../../electron/services/display.mjs").ZoomPercent,
    ): Promise<{ zoomPercent: import("../../electron/services/display.mjs").ZoomPercent }>;
    onChanged(
      handler: (state: {
        zoomPercent: import("../../electron/services/display.mjs").ZoomPercent;
      }) => void,
    ): () => void;
    onError(handler: (event: { message: string }) => void): () => void;
  };
  preferences: {
    get(): Promise<DesktopPreferences>;
    set(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  };
  onAttention(
    handler: (event: { kind: import("./types").AssetKind | "phone"; id: string }) => void,
  ): () => void;
  onVaultChanged(handler: () => void): () => void;
  metrics: {
    list(id: string, since: number): Promise<MetricSample[]>;
    onUpdated(handler: (event: { id: string }) => void): () => void;
    onError(handler: (event: { id: string; error: string }) => void): () => void;
  };
  sftp: {
    list(
      id: string,
      path: string,
    ): Promise<{ path: string; entries: SftpEntry[]; truncated: boolean }>;
    download(id: string, path: string): Promise<boolean>;
  };
  isDesktop: true;
  info(): Promise<AppInfo>;
  checkUpdate(): Promise<UpdateCheck>;
  updates: {
    status(): Promise<UpdateCheck>;
    download(): Promise<UpdateCheck>;
    install(): Promise<UpdateCheck>;
    onStatus(handler: (state: UpdateCheck) => void): () => void;
  };
  openDataDir(): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  pickJson(): Promise<unknown | null>;
  store: {
    onChanged?(handler: (change: import("./snapshot-merge").SnapshotChange) => void): () => void;
    addDemo(): Promise<Snapshot>;
    load(): Promise<PersistedFile | null>;
    save(snapshot: PersistedFile): Promise<boolean>;
    loadConversations(): Promise<unknown | null>;
    saveConversations(value: unknown): Promise<boolean>;
  };
  vault: {
    status(): Promise<{ exists: boolean; unlocked: boolean }>;
    create(master: string): Promise<{ ok: true }>;
    unlock(master: string): Promise<{ ok: true }>;
    lock(): Promise<{ ok: true }>;
    changePassword(oldMaster: string, newMaster: string): Promise<{ ok: true; count: number }>;
    set(id: string, secret: SshCredential | AccountCredential): Promise<{ ok: true }>;
    get(id: string): Promise<(SshCredential & AccountCredential) | null>;
    remove(id: string): Promise<{ ok: true }>;
    list(): Promise<string[]>;
  };
  ssh: {
    open(target: SshTarget, size: { cols: number; rows: number }): Promise<{ sessionId: string }>;
    probe(target: SshTarget): Promise<HostProbe>;
    test(target: SshTarget, credential: SshCredential): Promise<{ ok: true; message: string }>;
    /** Forget the pinned host key fingerprint so the next connection re-pins it. */
    resetHostKey(target: { host: string; port?: number }): Promise<{ ok: true }>;
    close(sessionId: string): Promise<boolean>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    onData(handler: (e: { sessionId: string; chunk: string }) => void): () => void;
    onExit(handler: (e: { sessionId: string }) => void): () => void;
  };
  win: {
    state(): Promise<{ maximized: boolean; platform: NodeJS.Platform }>;
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    onMaximized(handler: (e: { maximized: boolean }) => void): () => void;
  };
  mail: {
    providers(): Promise<Record<string, MailProvider>>;
    guess(address: string): Promise<(MailProvider & { id: string }) | null>;
    test(options: {
      address: string;
      password: string;
      host?: string;
      port?: number;
      secure?: boolean;
    }): Promise<MailLogin>;
    oauthProviders(): Promise<Record<string, OAuthProvider>>;
    oauthSignIn(options: {
      provider: string;
      clientId: string;
      clientSecret?: string;
    }): Promise<OAuthResult>;
  };
  domain: { probe(name: string): Promise<DomainProbe> };
  cert: {
    probe(host: string, port?: number, servername?: string): Promise<CertProbe>;
    parsePem(pem: string): Promise<{
      cn: string;
      issuer: string;
      validFrom: string;
      expiresAt: string;
      sans: string[];
      serial: string;
    }>;
  };
}

export interface DesktopPreferences {
  serverMonitorMinutes: number;
  closeToTray: boolean;
  notifications: boolean;
  locale: "zh" | "en";
  notificationSupported?: boolean;
  trayAvailable?: boolean;
}
export interface MetricSample {
  at: string;
  cpu?: number;
  memory?: number;
  disk?: number;
}
export interface SftpEntry {
  name: string;
  size: number;
  modified: number;
  directory: boolean;
  symlink: boolean;
}

declare global {
  interface Window {
    sinan?: DesktopBridge;
  }
}

/**
 * The desktop bridge, or `null` in a browser.
 *
 * Every caller has to handle `null`: the same UI runs as a web preview where
 * there is no main process to talk to, and the simulated data path stands in.
 */
export function desktop(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.sinan ?? null;
}

export const isDesktop = () => desktop() !== null;

/** Vault key for a server's SSH credential — must match the main process. */
export const credentialId = (serverId: string) => `ssh:${serverId}`;

/** Vault key for an OAuth client registration. One per provider. */
export const oauthClientId = (provider: string) => `oauth-client:${provider}`;

/** Vault key for an asset's account login. Namespaced apart from SSH keys. */
export const accountId = (assetId: string) => `account:${assetId}`;

/** "47 天" / "3 小时" — the shape the cards already print. */
export function formatUptime(seconds?: number): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return t("{0} 天", days);
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return t("{0} 小时", hours);
  return t("{0} 分钟", Math.max(1, Math.floor(seconds / 60)));
}
