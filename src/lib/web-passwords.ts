import { BrowserPasswords } from "../../electron/services/browser-passwords.mjs";
import { desktop, type DesktopBridge } from "./desktop";
import { createWebVaultAdapter } from "./web-vault-adapter";
import { randomId } from "./random-id";
import { useAppStore } from "./store";
import { isWeb } from "./web";

type PasswordBridge = DesktopBridge["passwords"];
let runtime: { service: BrowserPasswords; vault: ReturnType<typeof createWebVaultAdapter> } | null =
  null;
export function webPasswordRuntime() {
  if (runtime) return runtime;
  const vault = createWebVaultAdapter();
  const passwords = new BrowserPasswords({
    vault,
    uuid: randomId,
    getAssets: () => useAppStore.getState().secrets,
  });
  return (runtime = { service: passwords, vault });
}
const listeners = new Set<Parameters<PasswordBridge["onChanged"]>[0]>();
const web: PasswordBridge = {
  previewImport: async () => {
    const current = webPasswordRuntime();
    if (!current.vault.unlocked) throw new Error("密钥库已锁定。");
    const session = current.vault.session;
    const file = await new Promise<File | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".csv,text/csv";
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
    if (!file) return null;
    if (file.size > 10 * 1024 * 1024) throw new Error("CSV 大小不能超过 10 MiB。");
    const csv = await file.text();
    if (!current.vault.unlocked || current.vault.session !== session)
      throw new Error("密钥库已锁定，操作已取消。");
    return current.service.preview(csv);
  },
  commitImport: async (ticket) => {
    const result = await webPasswordRuntime().service.commit(ticket);
    for (const handler of listeners) handler(result.assets);
    return result;
  },
  cancelImport: async (ticket) => {
    webPasswordRuntime().service.cancel(ticket);
  },
  exportCsv: async () => {
    const { csv, count } = await webPasswordRuntime().service.exportCsv();
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `Zhiyu-passwords-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { count };
  },
  onChanged: (handler) => {
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  },
};
export const passwordsApi = (): PasswordBridge | null =>
  desktop()?.passwords ?? (isWeb() ? web : null);
