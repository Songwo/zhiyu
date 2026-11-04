import type { IdentityAccount, IdentityProfile, IdentitySession } from "./identities";

export interface MainIdentity {
  provider: "linuxdo";
  profile: IdentityProfile;
  connected: boolean;
  updatedAt: string;
  syncAvatar: boolean;
  syncName: boolean;
  avatarDataUrl: string;
  avatarMessage?: string;
}

export interface MainIdentityBridge {
  get(): Promise<MainIdentity | null>;
  availability(): Promise<{ configured: boolean; message: string }>;
  start(): Promise<{ id: string; expiresAt: number; authorizationUrl?: string }>;
  status(id: string): Promise<IdentitySession & { avatarDataUrl?: string }>;
  cancel(id: string): Promise<void>;
  bind(options: {
    sessionId: string;
    syncAvatar: boolean;
    syncName: boolean;
    replaceSubject?: string;
  }): Promise<MainIdentity>;
  preferences(options: { syncAvatar: boolean; syncName: boolean }): Promise<MainIdentity>;
  refresh(): Promise<MainIdentity>;
  disconnect(): Promise<void>;
  loadPosts(options?: { force?: boolean; more?: boolean }): Promise<IdentityAccount>;
  savePosts(options: { postIds: string[]; force?: boolean }): Promise<{
    documentId: string | null;
    imported: number;
    errors: Array<{ id: string; message: string }>;
  }>;
}
