import type { TaskProgressItem } from "./task-progress";
export interface ResearchQuota {
  configured: boolean;
  freeRemaining: number;
  freeUsed: number;
  freeReserved?: number;
  freeLimit: number;
  paidRemaining: number;
  paidTotal: number;
  paidUsed: number;
  price: string;
  purchaseUnits: number;
  paymentConfigured: boolean;
  purchaseGuardConfigured: boolean;
  exaStatus: string;
  balanceKnown: boolean;
  pendingJobId: string | null;
}
export interface ResearchResult {
  title: string;
  url: string;
  publishedDate: string;
  highlights: string[];
}
export interface ResearchJob {
  id: string;
  query: string;
  state:
    | "queued"
    | "searching"
    | "complete"
    | "awaiting_payment"
    | "failed"
    | "cancelled"
    | "interrupted";
  free: boolean;
  price: string;
  purchaseUnits: number;
  items: TaskProgressItem[];
  paymentUrl: string | null;
  results?: ResearchResult[];
}
export interface ResearchEntry {
  id: string;
  jobId: string;
  kind: "search" | "purchase";
  query: string | null;
  state: string;
  source: "free" | "purchased" | "purchase";
  consumed: number;
  units: number | null;
  amount: string | null;
  createdAt: number;
  paidAt: number | null;
  tradeNo: string | null;
}
export interface ResearchRecords {
  entries: ResearchEntry[];
  nextOffset: number | null;
}
export interface ResearchBridge {
  quota(): Promise<ResearchQuota>;
  start(input: { requestId: string; query: string }): Promise<ResearchJob>;
  status(id: string): Promise<ResearchJob>;
  records(offset?: number): Promise<ResearchRecords>;
  cancel(id: string): Promise<boolean>;
  checkout(id: string): Promise<ResearchJob>;
}
