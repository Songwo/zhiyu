// 网页版在浏览器里复用这份验证码实现（src/lib/web-totp.ts），这里给出它的类型。
import type { TotpBridge } from "../../src/lib/totp";

export interface TotpVault {
  readonly unlocked: boolean;
  readonly session: number;
  get(id: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  batch(
    items: Array<{ id: string; secret: unknown }>,
    options?: { beforeCommit?: () => void },
  ): Promise<unknown>;
}

export class AccountTotp implements TotpBridge {
  constructor(options: {
    vault: TotpVault;
    getAssets: () => unknown;
    now?: () => number;
  });
  status: TotpBridge["status"];
  configure: TotpBridge["configure"];
  code: TotpBridge["code"];
  remove: TotpBridge["remove"];
}
