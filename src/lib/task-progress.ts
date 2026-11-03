export interface TaskProgressItem {
  id: string;
  label: string;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: number;
  endedAt?: number;
  detail?: string;
}
