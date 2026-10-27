import { AccountTotp } from "../../electron/services/account-totp.mjs";
import { desktop, type AccountCredential } from "./desktop";
import { useAppStore } from "./store";
import type { TotpBridge } from "./totp";
import { useVault } from "./vault-state";
import { webVault } from "./web-vault";
import { isWeb } from "./web";

/**
 * 网页版的二次验证码：与桌面主进程同一份生成代码，种子存在浏览器加密的密钥库里，
 * 验证码在浏览器里算出来，种子从不发给服务器。
 */
const vault = {
  get unlocked() {
    return useVault.getState().unlocked;
  },
  session: 1,
  get: (id: string) => webVault.get(id),
  remove: (id: string) => webVault.remove(id),
  async batch(
    items: Array<{ id: string; secret: unknown }>,
    { beforeCommit }: { beforeCommit?: () => void } = {},
  ) {
    beforeCommit?.();
    for (const item of items) await webVault.set(item.id, item.secret as AccountCredential);
  },
};

let web: TotpBridge | null = null;

export function totpApi(): TotpBridge | null {
  const bridge = desktop()?.totp;
  if (bridge) return bridge;
  if (!isWeb()) return null;
  web ??= new AccountTotp({
    vault,
    getAssets: () => useAppStore.getState().secrets,
  });
  return web;
}
