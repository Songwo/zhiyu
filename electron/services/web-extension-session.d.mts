export class WebExtensionSession {
  constructor(options: {
    vault: { readonly unlocked: boolean; onLock(listener: () => void): unknown };
    accounts: {
      listForOrigin(url: string): Promise<Array<{ id: string; title: string; username: string }>>;
      getForOrigin(id: string, url: string): Promise<{ username: string; password: string }>;
      saveCapture(input: { url: string; title: string; username: string; password: string },
        guard: () => void): Promise<{ id: string; status: string }>;
    };
    saveDocument(input: { url: string; title: string; text: string }, guard: () => void): Promise<{ id: string; status: string }>;
    onChange?: () => void;
    now?: () => number;
    random?: () => string;
  });
  status(): { running: boolean; port: number; pairedClients: number; pairingPending: boolean; pendingCount: number };
  beginPairing(): { code: string; expiresAt: number; port: number };
  revoke(): void;
  list(): Array<{ id: string; url: string; title: string; username: string; createdAt: number; hasCredential: true }>;
  take(id: string): { id: string; url: string; title: string; username: string; password: string };
  discard(id: string): void;
  stop(): void;
  call(path: string, input: { extensionId: string; token?: string; body: unknown }):
    Promise<{ status: number; data: Record<string, unknown> }>;
}
