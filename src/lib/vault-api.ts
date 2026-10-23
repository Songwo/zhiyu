import { desktop, type DesktopBridge } from "./desktop";
import { isWeb } from "./web";
import { webVault } from "./web-vault";

export type VaultApi = DesktopBridge["vault"];

/** 桌面版走主进程的密钥库；自托管网页版在浏览器里加解密，服务器只存密文。 */
export function vaultApi(): VaultApi | null {
  return desktop()?.vault ?? (isWeb() ? webVault : null);
}
