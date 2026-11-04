import { DocumentAccountImports } from "../../electron/services/document-account-imports.mjs";
import { parseDocumentAccounts } from "../../electron/services/document-accounts.mjs";
import type { DocumentAccountsBridge } from "./document-accounts";
import { desktop } from "./desktop";
import { useDocuments, type DocumentAsset } from "./documents";
import { randomId } from "./random-id";
import { useAppStore } from "./store";
import type { Secret } from "./types";
import { useVault } from "./vault-state";
import { webVault } from "./web-vault";
import { isWeb, webApi } from "./web";

let importer: DocumentAccountImports | null = null;
function webImporter() {
  if (importer) return importer;
  let session = 0;
  const onLock = new Set<() => void>();
  useVault.subscribe((state, previous) => {
    if (state.unlocked !== previous.unlocked) session++;
    if (!state.unlocked && previous.unlocked) for (const listener of onLock) listener();
  });
  importer = new DocumentAccountImports({
    uuid: randomId,
    parse: parseDocumentAccounts,
    vault: {
      get unlocked() {
        return useVault.getState().unlocked;
      },
      get session() {
        return session;
      },
      onLock(listener: () => void) {
        onLock.add(listener);
        return () => onLock.delete(listener);
      },
      readAll: webVault.readAll,
      batch: webVault.batch,
    },
    documents: {
      get: (id: string) => webApi<DocumentAsset>(`documents/${encodeURIComponent(id)}`),
      save: (
        doc: DocumentAsset,
        options: { expectedRevision?: string; assertCurrent?: () => void },
      ) => {
        options?.assertCurrent?.();
        return webApi<DocumentAsset>(`documents/${encodeURIComponent(doc.id)}`, {
          method: "PUT",
          body: { ...doc, expectedRevision: options?.expectedRevision },
        });
      },
    },
    getAssets: () => useAppStore.getState().secrets,
    publishAssets: (assets: Secret[]) => {
      useAppStore.setState((state) => ({
        secrets: [
          ...state.secrets,
          ...assets.filter((asset) => !state.secrets.some((item) => item.id === asset.id)),
        ],
      }));
    },
  });
  return importer;
}
const web: DocumentAccountsBridge = {
  preview: (id) => webImporter().preview(id),
  cancel: (ticket) => webImporter().cancel(ticket),
  commit: async (input) => {
    const { document, ...result } = await webImporter().commit(input);
    if (document) useDocuments.getState().acceptChange({ document });
    return result;
  },
};

/** 账号候选在浏览器内解析；凭据只写入浏览器加密密钥库。 */
export const documentAccountsApi = (): DocumentAccountsBridge | null =>
  desktop()?.documentAccounts ?? (isWeb() ? web : null);
