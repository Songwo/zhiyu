import type { Secret } from "./types";

export interface IdentityProfile {
  subject: string;
  username: string;
  name: string;
  email: string | null;
  trustLevel: number | null;
  avatarUrl: string | null;
  profileUrl: string;
  active: boolean | null;
  silenced: boolean | null;
}
export interface IdentityPost {
  id: string;
  postId?: number;
  title: string;
  url: string;
  kind: "topic" | "reply";
  excerpt: string;
  createdAt: string | null;
}
export interface IdentityAccount {
  assetId: string;
  provider: "linuxdo";
  profile: IdentityProfile;
  connected: boolean;
  updatedAt: string;
  posts: {
    items: IdentityPost[];
    fetchedAt: string | null;
    status: "idle" | "ready" | "unavailable";
    message: string;
    nextOffset: number;
    hasMore: boolean;
  };
}
export interface IdentityConfig {
  clientId: string;
  redirectUri: string;
  hasClientSecret: boolean;
  configured: boolean;
}
export interface IdentitySession {
  id: string;
  status: "waiting" | "ready" | "error" | "cancelled";
  preview?: IdentityProfile;
  error?: string;
}
export interface IdentityBridge {
  config(): Promise<IdentityConfig>;
  configure(config: {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    allowServerStorage?: boolean;
  }): Promise<IdentityConfig>;
  start(options?: {
    allowServerStorage?: boolean;
  }): Promise<{
    id: string;
    expiresAt: number;
    authorizationUrl?: string;
    redirectUri?: string;
    manualCallback?: boolean;
  }>;
  finish?(id: string, callback: string): Promise<IdentitySession>;
  status(id: string): Promise<IdentitySession>;
  cancel(id: string): Promise<void>;
  commit(options: {
    sessionId: string;
    folderId?: string;
  }): Promise<{ account: IdentityAccount; asset: Secret }>;
  get(assetId: string): Promise<IdentityAccount | null>;
  refresh(assetId: string): Promise<IdentityAccount>;
  loadPosts(
    assetId: string,
    options?: { force?: boolean; more?: boolean },
  ): Promise<IdentityAccount>;
  disconnect(assetId: string): Promise<IdentityAccount>;
  savePosts(options: { assetId: string; postIds: string[]; force?: boolean }): Promise<{
    documentId: string | null;
    imported: number;
    errors: Array<{ id: string; message: string }>;
  }>;
}
