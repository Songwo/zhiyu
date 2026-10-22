import type { AssetKind } from "./types";

export interface ModelConfig {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  /** 已保存的 API Key 在当前环境能否解密（数据迁移后可能失效）。 */
  apiKeyReadable: boolean;
  topK: number;
  maxSteps: number;
  maxTokens: number;
  embeddingEnabled: boolean;
  embeddingBaseUrl: string;
  embeddingModel: string;
}
export interface Source {
  id: string;
  citation: string;
  title: string;
  kind?: AssetKind;
  assetId?: string;
  documentId?: string;
  focus?: "account";
  excerpt: string;
}
export interface AgentEvent {
  id: string;
  type: "phase" | "delta" | "tool" | "source" | "done" | "error";
  text?: string;
  name?: string;
  model?: string;
  step?: number;
  source?: Source;
}
export interface KnowledgeStatus {
  assets: number;
  chunks: number;
  documents: Array<{ id: string; name: string; characters: number; addedAt: string }>;
}
export interface WorkspaceProposal {
  id: string;
  status?: "applied" | "dismissed";
  type:
    | "document-edit"
    | "document-rename"
    | "document-create"
    | "account-edit"
    | "asset-update"
    | "asset-link"
    | "document-binding";
  title: string;
  documentId?: string;
  assetId?: string;
  before: string;
  after: string;
  reason: string;
  expiresAt: number;
}
/** 回答下方的「下一步」：继续提问，或打开页面 / 资产。主进程已校验目标存在。 */
export type NextStep =
  | { label: string; kind: "ask"; question: string }
  | { label: string; kind: "open"; view: import("./types").ViewId }
  | { label: string; kind: "open"; asset: { kind: AssetKind; id: string } };
export interface WorkspaceAccessRequest {
  permissions: Array<"documentContent" | "workspaceChanges">;
  reason: string;
}
export interface AgentBridge {
  applyProposal(id: string): Promise<{
    before?: import("./types").Snapshot;
    snapshot?: import("./types").Snapshot;
    document?: import("./documents").DocumentAsset;
  }>;
  discardProposal(id: string): Promise<boolean>;
  config(): Promise<ModelConfig>;
  saveConfig(
    config: ModelConfig & { apiKey?: string; clearApiKey?: boolean },
  ): Promise<ModelConfig>;
  models(): Promise<string[]>;
  test(): Promise<{ model: string; latencyMs: number; text: string }>;
  knowledge(): Promise<KnowledgeStatus>;
  rebuild(): Promise<KnowledgeStatus>;
  importDocument(): Promise<KnowledgeStatus | null>;
  removeDocument(id: string): Promise<KnowledgeStatus>;
  run(request: {
    id: string;
    question: string;
    allowMailboxChecks?: boolean;
    allowDocumentContent?: boolean;
    allowWorkspaceChanges?: boolean;
    history: Array<{ role: "user" | "assistant"; content: string; documentContent?: boolean }>;
  }): Promise<{
    model: string;
    sources: number;
    steps: number;
    text: string;
    sourceItems: Source[];
    tools: string[];
    proposals?: WorkspaceProposal[];
    accessRequests?: WorkspaceAccessRequest[];
    nextSteps?: NextStep[];
  }>;
  cancel(id: string): Promise<boolean>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
}
