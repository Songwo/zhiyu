/** 加密备份与恢复的桌面桥接类型；实现在 electron/services/backup.mjs。 */
export interface BackupPreview {
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  platform: string;
  kind: "manual" | "auto";
  summary: {
    assets: Record<string, number>;
    assetTotal: number;
    documents: number;
    vaultRecords: number | null;
  };
  fileCount: number;
  totalBytes: number;
  secure: { included: boolean; count: number; files: string[]; failed: string[] };
}

export interface RestoreOutcome {
  status: "applied" | "failed" | "discarded";
  snapshot?: string;
  files?: number;
  backupCreatedAt?: string | null;
  message?: string;
}

export interface AutoBackupStatus {
  enabled: boolean;
  directory: string | null;
  intervalHours: 24 | 72 | 168;
  keep: number;
  hasPassword: boolean;
  passwordReadable: boolean;
  lastRunAt: number | null;
  lastFile: string | null;
  lastError: string | null;
  nextRunAt: number | null;
  lastLocalRunAt?: number | null;
  history?: Array<{
    at: number;
    file: string | null;
    local: boolean;
    remote: "uploaded" | "disabled" | "failed" | "not-started";
    warning?: string | null;
    error?: string;
  }>;
}

export interface S3BackupTarget {
  provider: "s3" | "r2" | "oss" | "minio";
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  pathStyle: boolean;
  allowInsecure: boolean;
}
export interface S3BackupStatus {
  enabled: boolean;
  target: S3BackupTarget | null;
  hasCredentials: boolean;
  bound: boolean;
  testedAt: number | null;
  lastError: string | null;
  history: Array<{
    id: string;
    at: number;
    file: string;
    bytes: number;
    sha256: string;
    state: "uploading" | "uploaded" | "failed" | "pruned";
    key: string;
    error?: string;
  }>;
}
export type S3BackupInput = Partial<S3BackupTarget> & {
  enabled?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  clearSessionToken?: boolean;
  allowServerStorage?: boolean;
};

export interface BackupBridge {
  s3Status(): Promise<S3BackupStatus>;
  s3Configure(input: S3BackupInput): Promise<S3BackupStatus>;
  s3Test(): Promise<S3BackupStatus>;
  s3Disconnect(): Promise<S3BackupStatus>;
  info(): Promise<{ lastRestore: RestoreOutcome | null; secureAvailable: boolean }>;
  create(input: {
    password: string;
    includeSecure: boolean;
  }): Promise<null | { file: string; preview: BackupPreview }>;
  pick(): Promise<null | { ticket: string; file: string; size: number }>;
  inspect(ticket: string, password: string): Promise<BackupPreview>;
  cancel(ticket: string): Promise<void>;
  restore(
    ticket: string,
    password: string,
  ): Promise<{ files: number; secureRestored: number; secureSkipped: boolean }>;
  autoStatus(): Promise<AutoBackupStatus>;
  autoConfigure(input: {
    enabled?: boolean;
    intervalHours?: number;
    keep?: number;
    password?: string;
    allowServerStorage?: boolean;
  }): Promise<AutoBackupStatus>;
  autoDirectory(): Promise<AutoBackupStatus | null>;
  autoRun(): Promise<AutoBackupStatus>;
}

/** 系统保护凭据所在文件 → 界面名称（中文原文，经 t() 翻译）。 */
export const SECURE_FILE_LABELS: Record<string, string> = {
  "agent-config.json": "模型 API Key",
  "integrations.json": "云服务与探针连接",
  "image-bed.json": "图床 Key",
  "main-identity.enc": "Linux.do 主身份",
};

export const ASSET_KIND_LABELS: Record<string, string> = {
  servers: "服务器",
  services: "服务",
  domains: "域名",
  certs: "证书",
  mailboxes: "邮箱",
  aiAssets: "AI 资产",
  secrets: "账号与密钥",
  phoneNumbers: "手机号",
};
