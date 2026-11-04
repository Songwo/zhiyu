import { webVault } from "./web-vault";
import { useVault } from "./vault-state";

/** 为共用服务提供浏览器密钥库；实际加解密与批量提交仍只在当前标签页。 */
export function createWebVaultAdapter() {
  let session = 0;
  const listeners = new Set<() => void>();
  useVault.subscribe((state, previous) => {
    if (state.unlocked !== previous.unlocked) session++;
    if (!state.unlocked && previous.unlocked) for (const listener of listeners) listener();
  });
  return {
    get unlocked() {
      return useVault.getState().unlocked;
    },
    get session() {
      return session;
    },
    onLock(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: webVault.get,
    set: webVault.set,
    remove: webVault.remove,
    list: webVault.list,
    readAll: webVault.readAll,
    batch: webVault.batch,
  };
}
