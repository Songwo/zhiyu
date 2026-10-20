export type Status = "online" | "warning" | "offline";

export type ViewId =
  | "phones"
  | "docs"
  | "relations"
  | "renewals"
  | "usage"
  | "overview"
  | "nodes"
  | "servers"
  | "services"
  | "domains"
  | "mail"
  | "ai"
  | "vault"
  | "certs"
  | "tags"
  | "agent"
  | "terminal";

export type AssetKind = "server" | "domain" | "mail" | "ai" | "secret" | "cert" | "service";

export type BillingCurrency = "CNY" | "USD";
/** 一次性费用（如买断、永久号码）不计入月度和年度支出。 */
export type BillingCycle = "month" | "year" | "once";

/** 用户填写的续费金额。旧记录没有这个字段，视为未填写。 */
export interface Billing {
  amount: number;
  currency: BillingCurrency;
  cycle: BillingCycle;
}

export interface ServiceAsset extends Taggable {
  integration?: import("./integrations").IntegrationRef;
  id: string;
  name: string;
  category: "worker" | "blog" | "mail" | "custom";
  url: string;
  provider: string;
  status: Status;
  notes: string;
  /** 订阅或托管到期日 YYYY-MM-DD。 */
  expiresAt?: string;
  billing?: Billing;
}

/** How the desktop app authenticates to a host. The secret itself is in the vault. */
export type AuthKind = "password" | "key" | "agent";

/** Free-form grouping labels. Every asset kind carries them, so one tag can
 *  span a project's host, its domain and its certificate. */
export interface Taggable {
  imageDataUrl?: string;
  demo?: boolean;
  tags: string[];
}

/** What a live probe filled in, and whether the last one worked. */
export interface ProbeMeta {
  probedAt?: string;
  probeError?: string;
}

export type ProxyProtocol = "vless" | "vmess" | "trojan" | "ss" | "hysteria2";

export interface ProxyNode {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  uuid?: string;
  password?: string;
  network?: "tcp" | "ws" | "grpc" | "h2";
  security?: "none" | "tls" | "reality";
  sni?: string;
  path?: string;
  pbk?: string;
  sid?: string;
  flow?: string;
  latencyMs?: number;
  checkedAt?: string;
  checkError?: string;
  rawUri?: string;
}

export interface BoundSecretItem {
  id: string;
  key: string;
  value: string;
  vaultSecretId?: string;
}

export interface Server extends ProbeMeta, Taggable {
  integration?: import("./integrations").IntegrationRef;
  sshConfigured?: boolean;
  id: string;
  name: string;
  label: string;
  host: string;
  port: number;
  username: string;
  os: string;
  region: string;
  tags: string[];
  status: Status;
  cpu: number;
  memory: number;
  disk: number;
  uptime: string;
  lastSeen: string;
  notes: string;
  authKind?: AuthKind;
  kernel?: string;
  loadavg?: string;
  memTotalKb?: number;
  diskTotalKb?: number;
  docs?: string;
  nodes?: ProxyNode[];
  customSecrets?: BoundSecretItem[];
  /** VPS 到期日 YYYY-MM-DD。 */
  expiresAt?: string;
  billing?: Billing;
}

export interface Domain extends ProbeMeta, Taggable {
  integration?: import("./integrations").IntegrationRef;
  id: string;
  name: string;
  registrar: string;
  expiresAt: string;
  dns: string;
  nameservers: string[];
  autoRenew: boolean;
  status: Status;
  notes: string;
  statuses?: string[];
  createdAt?: string;
  billing?: Billing;
}

export interface Mailbox extends Taggable {
  senderAvatars?: { address: string; imageDataUrl: string }[];
  folderId?: string;
  smtp?: import("./mailbox").SmtpConnection;
  imap?: import("./mailbox").MailboxConnection;
  mailStatus?: import("./mailbox").MailboxStatus;
  id: string;
  address: string;
  domain: string;
  kind: "mailbox" | "alias" | "forward";
  usedMb: number;
  quotaMb: number;
  forwardTo?: string;
  status: Status;
  notes: string;
}

export interface AiAsset extends Taggable {
  oauthAccountId?: string;
  oauthProvider?: import("./ai-accounts").AiProvider;
  oauthDisconnected?: boolean;
  accountEmail?: string;
  usageCheckedAt?: string;
  usageAvailable?: boolean;
  usageSummary?: string;
  usageStale?: boolean;
  usageScope?: string;
  monthlyUsdKnown?: boolean;
  subscriptionExpiresAt?: string | null;
  id: string;
  name: string;
  provider: string;
  plan: string;
  keyHint: string;
  monthlyUsd: number;
  usagePct: number;
  renewsAt: string;
  status: Status;
  notes: string;
}

export interface Secret extends Taggable {
  id: string;
  name: string;
  identityProvider?: "linuxdo";
  /** 密钥分组归属（0.10.0）；空或指向已删除分组时视为未分组。 */
  folderId?: string;
  kind: "api" | "ssh" | "password" | "token" | "account";
  hint: string;
  value: string;
  lastRotated: string;
  status: Status;
  notes: string;
}

export interface Certificate extends ProbeMeta, Taggable {
  id: string;
  cn: string;
  issuer: string;
  expiresAt: string;
  sans: string[];
  status: Status;
  notes: string;
  /** What to open a TLS connection to. Defaults to `cn` with any wildcard stripped. */
  host?: string;
  port?: number;
  trusted?: boolean;
  untrustedReason?: string;
  protocol?: string;
}

export interface ActivityItem {
  id: string;
  at: string;
  text: string;
  kind: AssetKind | "system";
}

export type AnyAsset =
  | { kind: "service"; data: ServiceAsset }
  | { kind: "server"; data: Server }
  | { kind: "domain"; data: Domain }
  | { kind: "mail"; data: Mailbox }
  | { kind: "ai"; data: AiAsset }
  | { kind: "secret"; data: Secret }
  | { kind: "cert"; data: Certificate };

export interface PhoneNumber {
  id: string;
  number: string;
  label: string;
  provider: string;
  expiresAt: string;
  notes: string;
  subscriptionIds: string[];
  createdAt: string;
  updatedAt: string;
  billing?: Billing;
}

export interface Snapshot {
  services?: ServiceAsset[];
  phoneNumbers?: PhoneNumber[];
  mailFolders?: import("./mail-folders").MailFolder[];
  secretFolders?: import("./secret-folders").SecretFolder[];
  links?: import("./operations").AssetLink[];
  servers: Server[];
  domains: Domain[];
  mailboxes: Mailbox[];
  aiAssets: AiAsset[];
  secrets: Secret[];
  certs: Certificate[];
}
