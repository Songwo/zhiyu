import { WebExtensionSession } from "../../electron/services/web-extension-session.mjs";
import { browserDocument } from "../../electron/services/browser-documents.mjs";
import { desktop, type DesktopBridge } from "./desktop";
import { webPasswordRuntime } from "./web-passwords";
import { isWeb, webApi } from "./web";
import { useAppStore } from "./store";
import { useVault } from "./vault-state";
import type { DocumentAsset, DocumentSummary } from "./documents";

let runtime: WebExtensionSession | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
function service() {
  if (runtime) return runtime;
  const { service: passwords, vault } = webPasswordRuntime();
  runtime = new WebExtensionSession({
    vault,
    onChange: notify,
    accounts: {
      listForOrigin: (url) => passwords.listForOrigin(url),
      getForOrigin: (id, url) => passwords.getForOrigin(id, url),
      saveCapture: async (input, guard) => {
        const result = await passwords.saveCapture(input, guard);
        guard();
        useAppStore.setState((state) => ({
          secrets: [
            ...state.secrets,
            ...result.assets.filter((asset) => !state.secrets.some((item) => item.id === asset.id)),
          ],
        }));
        return result;
      },
    },
    saveDocument: async (input, guard) => {
      const doc = browserDocument(input);
      const list = await webApi<DocumentSummary[]>("documents");
      guard();
      const exists = list.some((item) => item.id === doc.id);
      await webApi<DocumentAsset>(`documents/${encodeURIComponent(doc.id)}`, {
        method: "PUT",
        body: doc,
      });
      guard();
      return { id: doc.id, status: exists ? "existing" : "created" };
    },
  });
  return runtime;
}
const web: DesktopBridge["extension"] = {
  status: async () => service().status(),
  beginPairing: async () => {
    if (!window.isSecureContext) throw new Error("插件连接需要 HTTPS 网页或本机测试地址。");
    return service().beginPairing();
  },
  revoke: async () => {
    service().revoke();
  },
  list: async () => service().list(),
  take: async (id) => service().take(id),
  discard: async (id) => {
    service().discard(id);
  },
  onChanged: (handler) => {
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  },
};
export const extensionApi = () => desktop()?.extension ?? (isWeb() ? web : null);

/** 扩展内容脚本只连接同一顶层窗口；数据不经过 Web 服务器。 */
export function startWebExtensionBroker() {
  if (!isWeb() || window !== window.top) return;
  document.documentElement.dataset.zhiyuWebWorkspace = "true";
  const current = service();
  const onMessage = async (event: MessageEvent) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.kind !== "zhiyu:extension-web-request"
    )
      return;
    const { requestId, path, extensionId, token, body } = event.data;
    if (
      typeof requestId !== "string" ||
      !/^[a-f0-9]{32}$/.test(requestId) ||
      typeof path !== "string" ||
      typeof extensionId !== "string" ||
      (token !== undefined && (typeof token !== "string" || token.length > 64))
    )
      return;
    const response = await current.call(path, { extensionId, token, body });
    window.postMessage(
      { kind: "zhiyu:extension-web-response", requestId, ...response },
      location.origin,
    );
  };
  window.addEventListener("message", onMessage);
  const off = useVault.subscribe((state, previous) => {
    if (!state.unlocked && previous.unlocked && useAppStore.getState().composerPreset?._captureId)
      useAppStore.getState().closeComposer();
  });
  return () => {
    window.removeEventListener("message", onMessage);
    off();
    current.stop();
    runtime = null;
    delete document.documentElement.dataset.zhiyuWebWorkspace;
  };
}

export function captureBridge(): Pick<
  DesktopBridge,
  "capture" | "extension" | "onVaultChanged"
> | null {
  const native = desktop();
  if (native) return native;
  if (!isWeb()) return null;
  return {
    extension: web,
    capture: {
      list: async () => [],
      discard: async () => undefined,
      onChanged: (handler) => web.onChanged(handler),
    },
    onVaultChanged: (handler) =>
      useVault.subscribe((state, previous) => {
        if (state.unlocked !== previous.unlocked) handler();
      }),
  };
}
