export type AiProvider = "openai" | "claude" | "grok" | "gemini";
export const AI_PROVIDER_NAMES: Record<AiProvider, string> = {
  openai: "OpenAI / ChatGPT",
  claude: "Anthropic / Claude",
  grok: "xAI / Grok",
  gemini: "Google / Gemini",
};
export interface AiUsageWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: string;
  model?: string;
  windowSeconds?: number;
  stale?: boolean;
}
export interface AiUsage {
  checkedAt: string;
  windows: AiUsageWindow[];
  source?: "openai-wham" | "anthropic-oauth" | "xai-cli-billing" | "google-code-assist";
  scope?: "codex" | "claude" | "grok-cli" | "code-assist";
  status?: "available" | "unavailable" | "stale";
  scopeNote?: string;
  webUsageAvailable?: boolean;
  unavailableReason?: string;
}
export interface AiAccount {
  id: string;
  provider: AiProvider;
  accountId: string;
  email: string;
  plan: string;
  tokenExpiresAt: string;
  subscriptionExpiresAt: string | null;
  refreshable: boolean;
  usage: AiUsage | null;
  usageRefresh?: {
    status: "ok" | "error";
    attemptedAt: string;
    errorCode?: string;
    message?: string;
  };
}
export interface AiAccountBridge {
  list(): Promise<AiAccount[]>;
  start(
    provider: AiProvider,
    options?: { allowServerStorage?: boolean },
  ): Promise<{
    id: string;
    mode: "loopback" | "code";
    redirectUri?: string;
    manualCallback?: boolean;
    authorizationUrl?: string;
  }>;
  status(id: string): Promise<{ status: string; error: string; accountId?: string }>;
  finish(id: string, code: string): Promise<AiAccount>;
  cancel(id: string): Promise<boolean>;
  refresh(id: string): Promise<AiAccount>;
  remove(id: string): Promise<boolean>;
}
