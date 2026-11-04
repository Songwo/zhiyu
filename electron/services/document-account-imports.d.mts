import type {
  DocumentAccountsBridge,
  DocumentAccountCandidate,
} from "../../src/lib/document-accounts";
import type { DocumentAsset } from "../../src/lib/documents";
import type { AccountCredential } from "../../src/lib/desktop";
import type { Secret } from "../../src/lib/types";

/** 与已有 TOTP 适配相同，浏览器用加密密钥库实现服务依赖。 */
export class DocumentAccountImports {
  constructor(options: {
    vault: {
      readonly unlocked: boolean;
      readonly session: number;
      onLock(listener: () => void): () => unknown;
      readAll(prefix: string): Promise<Record<string, AccountCredential>>;
      batch(
        items: Array<{ id: string; secret: unknown }>,
        options?: { beforeCommit?: () => void },
      ): Promise<unknown>;
    };
    documents: {
      get(id: string): Promise<DocumentAsset>;
      save(
        doc: DocumentAsset,
        options: { expectedRevision?: string; assertCurrent?: () => void },
      ): Promise<DocumentAsset>;
    };
    getAssets(): Secret[] | { secrets: Secret[] };
    publishAssets(assets: Secret[]): unknown;
    parse(source: string): { candidates: DocumentAccountCandidate[]; warnings: string[] };
    now?: () => number;
    uuid?: () => string;
  });
  preview: DocumentAccountsBridge["preview"];
  cancel: DocumentAccountsBridge["cancel"];
  commit(
    input: Parameters<DocumentAccountsBridge["commit"]>[0],
  ): Promise<Awaited<ReturnType<DocumentAccountsBridge["commit"]>> & { document?: DocumentAsset }>;
  stop(): void;
}
