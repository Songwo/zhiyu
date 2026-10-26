export type IntegrationProvider = "cloudflare" | "probe";
export type IntegrationResourceType = "zone" | "worker" | "pages" | "tunnel" | "host" | "check";
export interface IntegrationRef {
  provider: IntegrationProvider;
  connectionId: string;
  resourceType: IntegrationResourceType;
  remoteId: string;
  accountId?: string;
}
export interface IntegrationConnection {
  id: string;
  provider: IntegrationProvider;
  name: string;
  endpoint?: string;
  allowInsecure: boolean;
  hasToken: boolean;
}
export interface IntegrationConnectionInput {
  id?: string;
  provider: IntegrationProvider;
  name: string;
  endpoint?: string;
  token?: string;
  allowInsecure?: boolean;
}
export interface ProbeSample {
  at: string;
  cpu?: number | null;
  memory?: number | null;
  swap?: number | null;
  disk?: number | null;
  memoryTotal?: number | null;
  diskTotal?: number | null;
  networkRx?: number | null;
  networkTx?: number | null;
  rxRate?: number | null;
  txRate?: number | null;
  uptime?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  tcp?: number | null;
  udp?: number | null;
  processes?: number | null;
  temperature?: number | null;
  gpu?: number | null;
}
export interface ProbeHost {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  status: "online" | "offline" | "pending";
  lastSeen: string | null;
  latest: ProbeSample | null;
}
export interface ProbeCheckInput {
  id?: string;
  name: string;
  type: "http" | "tcp";
  target: string;
  intervalSeconds: number;
  timeoutMs: number;
}
export interface ProbeCheck extends ProbeCheckInput {
  id: string;
  status: "up" | "down" | "pending";
  lastCheckedAt: string | null;
  latencyMs: number | null;
  message: string;
  uptime24h: number | null;
}
export interface ProbeCheckResult {
  at: string;
  status: "up" | "down";
  latencyMs: number | null;
  message: string;
}
/** Cloudflare 域名（Zone）的附加信息；到期日只在域名于 Cloudflare 注册时才有。 */
export interface ZoneInfo {
  nameServers: string[];
  createdOn?: string;
  paused: boolean;
  registrar?: string;
  expiresAt?: string;
  autoRenew?: boolean;
  registrationStatus?: string;
}
export interface IntegrationResource {
  key: string;
  type: IntegrationResourceType;
  remoteId: string;
  accountId?: string;
  name: string;
  url: string;
  status: string;
  host?: ProbeHost;
  check?: ProbeCheck;
  zone?: ZoneInfo;
}
export interface IntegrationInventory {
  resources: IntegrationResource[];
  warnings: string[];
  fetchedAt: string;
  cached: boolean;
}
export interface DnsInput {
  type: "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS" | "SRV" | "CAA";
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  comment?: string;
  data?: Record<string, string | number>;
}
export interface DnsRecord extends Omit<DnsInput, "type"> {
  id: string;
  type: string;
  modifiedOn?: string;
}
export interface DnsProposal {
  ticket: string;
  action: "create" | "update" | "delete";
  zoneId: string;
  before: DnsRecord | null;
  after: DnsInput | null;
  expiresAt: string;
}
export interface IntegrationsBridge {
  list(): Promise<IntegrationConnection[]>;
  save(input: IntegrationConnectionInput): Promise<IntegrationConnection>;
  remove(id: string): Promise<void>;
  inventory(id: string, force?: boolean): Promise<IntegrationInventory>;
  bind(input: {
    connectionId: string;
    resourceKey: string;
    assetId?: string;
  }): Promise<{ kind: "domain" | "service" | "server"; id: string }>;
  importZones(input: {
    connectionId: string;
    resourceKeys: string[];
  }): Promise<{ created: number; updated: number; assets: { kind: "domain"; id: string }[] }>;
  syncZones(connectionId: string): Promise<{ updated: number }>;
  unbind(input: { kind: "domain" | "service" | "server"; id: string }): Promise<void>;
  dnsList(connectionId: string, zoneId: string, force?: boolean): Promise<DnsRecord[]>;
  dnsPreview(input: {
    connectionId: string;
    zoneId: string;
    action: "create" | "update" | "delete";
    recordId?: string;
    record?: DnsInput;
  }): Promise<DnsProposal>;
  dnsApply(ticket: string): Promise<void>;
  probeHistory(
    connectionId: string,
    hostId: string,
    range: "1h" | "24h" | "7d",
  ): Promise<ProbeSample[]>;
  probeCheckHistory(
    connectionId: string,
    checkId: string,
    range: "1h" | "24h" | "7d",
  ): Promise<ProbeCheckResult[]>;
  probeEnroll(connectionId: string, name: string): Promise<{ id: string; secret: string }>;
  probeRevoke(connectionId: string, hostId: string): Promise<void>;
  probeSaveCheck(connectionId: string, input: ProbeCheckInput): Promise<void>;
  probeDeleteCheck(connectionId: string, id: string): Promise<void>;
}
