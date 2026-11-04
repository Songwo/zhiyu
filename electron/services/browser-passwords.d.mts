import type { AccountCredential, DesktopBridge } from "../../src/lib/desktop";
import type { Secret } from "../../src/lib/types";

export class BrowserPasswords {
  constructor(options: {
    vault: {
      readonly unlocked: boolean;
      readonly session: number;
      onLock(listener: () => void): unknown;
      readAll(prefix: string): Promise<Record<string, AccountCredential>>;
      batch(items: Array<{ id: string; secret: unknown }>, options?: { beforeCommit?: () => void }): Promise<unknown>;
    };
    getAssets?: () => Secret[];
    now?: () => number;
    uuid?: () => string;
    ticket?: () => string;
  });
  preview(csv: string): Promise<NonNullable<Awaited<ReturnType<DesktopBridge["passwords"]["previewImport"]>>>>;
  commit(ticket: string): ReturnType<DesktopBridge["passwords"]["commitImport"]>;
  cancel(ticket: string): { ok: true };
  exportCsv(): Promise<{ csv: string; count: number }>;
  managedAssets(): Promise<Secret[]>;
  listForOrigin(url: string): Promise<Array<{ id: string; title: string; username: string }>>;
  getForOrigin(id: string, url: string): Promise<{ username: string; password: string }>;
  saveCapture(input: { url: string; title: string; username: string; password: string },
    assertCurrent?: () => void): Promise<{ id: string; status: string; assets: Secret[] }>;
  clear(): void;
}
