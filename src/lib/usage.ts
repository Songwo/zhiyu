export interface UsageSource {
  id: string;
  name: string;
  type: string;
  nodeId?: string;
  checkedAt?: string;
  attemptedAt?: string;
  error?: string;
  revision?: number;
  subscription?: Omit<SubscriptionDetails, "sourceId" | "nodes">;
}
export interface SubscriptionNode {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
}
export interface SubscriptionDetails {
  sourceId: string;
  fetchedAt: string | null;
  format: "uri" | "base64" | "clash" | "sing-box" | "unknown";
  trafficAvailable: boolean;
  trafficMessage?: string;
  nodesMessage?: string;
  nodeCount: number;
  truncated: boolean;
  nodes: SubscriptionNode[];
}
export interface V2raynNodeStat extends SubscriptionNode {
  subscriptionName?: string;
  savedUploadKb: number | null;
  savedDownloadKb: number | null;
  todayUploadKb: number | null;
  todayDownloadKb: number | null;
  statDate: string | null;
}
export interface V2raynUsageState {
  available: boolean;
  stale?: boolean;
  statisticsEnabled: boolean | null;
  checkedAt: string | null;
  savedAt: string | null;
  message?: string;
  nodes: V2raynNodeStat[];
  live: {
    available: boolean;
    checkedAt: string | null;
    upload: number | null;
    download: number | null;
    observedUpload: number | null;
    observedDownload: number | null;
    nodeId?: string;
    reset?: boolean;
    message?: string;
  };
}
export interface UsageRecord {
  sourceId: string;
  sourceName: string;
  key: string;
  kind: "traffic" | "tokens" | "quota";
  label: string;
  checkedAt: string;
  bucketStart?: string;
  upload?: number;
  download?: number;
  total?: number | null;
  expiresAt?: string | null;
  deltaUpload?: number | null;
  deltaDownload?: number | null;
  counterReset?: boolean;
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  usedPercent?: number | null;
  used?: number | null;
  limit?: number | null;
  unit?: string;
  resetsAt?: string | null;
  scope?: string;
  sampleAt?: string;
  origin?: "local";
  model?: string;
  revision?: number;
}
export interface UsageState {
  sources: UsageSource[];
  records: UsageRecord[];
}
export interface UsageBridge {
  onChanged?(
    handler: (change: { recordsChanged: boolean; localStatus?: LocalUsageStatus }) => void,
  ): () => void;
  list(): Promise<UsageState>;
  add(input: Record<string, string>): Promise<UsageSource>;
  update(id: string, input: Record<string, string>): Promise<UsageSource>;
  subscriptionDetails(id: string): Promise<SubscriptionDetails>;
  v2raynStatus?(force?: boolean): Promise<V2raynUsageState>;
  chooseV2raynDirectory?(): Promise<V2raynUsageState | null>;
  remove(id: string): Promise<void>;
  refresh(id: string): Promise<UsageState>;
  refreshAll(): Promise<{ failures: string[] }>;
  localStatus(): Promise<LocalUsageStatus>;
  configureLocal(input: { enabled: boolean }): Promise<LocalUsageStatus>;
  refreshLocal(): Promise<LocalUsageStatus>;
}
export interface LocalUsageStatus {
  enabled: boolean;
  paused?: boolean;
  intervalMs: number;
  lastScannedAt: string | null;
  sources: {
    id: string;
    name: string;
    available: boolean;
    files: number;
    records: number;
    status?: "not-found" | "discovering" | "importing" | "ready" | "no-usage" | "error";
    progress?: { discoveryComplete: boolean; pendingFiles: number; processedFiles: number };
    warnings?: string[];
    firstUsageAt?: string;
    lastUsageAt?: string;
    error?: string;
  }[];
  error?: string;
}
export function usageBytes(value: number | null | undefined) {
  if (value == null) return "未提供";
  if (value === 0) return "0 B";
  const index = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 2 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`;
}
