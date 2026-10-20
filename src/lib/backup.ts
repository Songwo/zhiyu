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
}

export interface BackupBridge {
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
