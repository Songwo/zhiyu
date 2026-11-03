import type { TaskProgressItem } from "./task-progress";
export interface AnalysisRule {
  id: string;
  label: string;
  description: string;
  color: string;
}
export interface AnalysisConfig {
  enabled: boolean;
  model: string;
  mode: "highlight" | "underline" | "sidebar" | "off";
  threshold: number;
  fontSize: number;
  lineHeight: number;
  width: "comfortable" | "wide";
  rules: AnalysisRule[];
  hasApiKey?: boolean;
  apiKeyReadable?: boolean;
}
export interface AnalysisResult {
  id: string;
  choice: string;
  confidence: number;
}
export interface AnalysisEvent {
  id: string;
  items: TaskProgressItem[];
  results: AnalysisResult[];
}
export interface DocumentAnalysisBridge {
  config(): Promise<AnalysisConfig>;
  saveConfig(
    input: AnalysisConfig & { apiKey?: string; clearApiKey?: boolean },
  ): Promise<AnalysisConfig>;
  models(): Promise<unknown>;
  run(input: {
    id: string;
    blocks: Array<{ id: string; text: string }>;
    allowDocumentContent: boolean;
  }): Promise<{ items: TaskProgressItem[]; results: AnalysisResult[]; cancelled?: boolean }>;
  cancel(id: string): Promise<boolean>;
  onEvent(handler: (event: AnalysisEvent) => void): () => void;
}
