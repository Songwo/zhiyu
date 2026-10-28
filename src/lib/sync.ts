/** 桌面端与网页版同步（ZSP，见 docs/SYNC.md）的界面类型。 */
export interface SyncScope {
  assets: boolean;
  documents: boolean;
  vault: boolean;
}
export interface SyncLogEntry {
  at: string;
  kind: string;
  text: string;
}
export interface SyncResult {
  ok: boolean;
  at: string;
  pulled?: number;
  pushed?: number;
  merged?: number;
  deleted?: number;
  warnings?: string[];
  error?: string;
}
export type SyncAttentionKind = "rollback" | "vault-conflict" | "revoked";
export interface SyncStatus {
  paired: boolean;
  running: boolean;
  server?: { url: string; fingerprint: string };
  device?: { id: string; name: string };
  scope: SyncScope;
  lastSyncAt?: string | null;
  lastResult?: SyncResult | null;
  attention?: { kind: SyncAttentionKind; message: string } | null;
  error?: string;
  log?: SyncLogEntry[];
}

/** 桌面端：preload 暴露的方法。 */
export interface SyncBridge {
  status(): Promise<SyncStatus>;
  pair(input: { url: string; code: string; name?: string }): Promise<SyncStatus>;
  unpair(): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  setScope(scope: Partial<SyncScope>): Promise<SyncStatus>;
  acceptServerState(): Promise<SyncStatus>;
  resolveVault(choice: "local" | "remote"): Promise<SyncStatus>;
  onChanged(handler: () => void): () => void;
}

/** 网页版：服务器端的设备管理。 */
export interface SyncDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}
export interface SyncEvent {
  at: string;
  kind: string;
  device?: string;
  path?: string;
  count?: number;
}
export interface WebSyncInfo {
  fingerprint: string;
  devices: SyncDevice[];
  pairing: { expiresAt: number } | null;
  events: SyncEvent[];
}
export interface WebPairing {
  code: string;
  expiresAt: number;
  fingerprint: string;
}
