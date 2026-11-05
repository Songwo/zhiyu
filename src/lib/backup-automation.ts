import { desktop } from "./desktop";
import { isWeb } from "./web";
import { webInvoke } from "./web-bridge";
import type { BackupBridge } from "./backup";

type Automation = Pick<
  BackupBridge,
  | "autoStatus"
  | "autoConfigure"
  | "autoDirectory"
  | "autoRun"
  | "s3Status"
  | "s3Configure"
  | "s3Test"
  | "s3Disconnect"
>;
const web: Automation = {
  autoStatus: () => webInvoke("backup:auto-status"),
  autoConfigure: (input) => webInvoke("backup:auto-configure", input),
  autoDirectory: () => webInvoke("backup:auto-directory"),
  autoRun: () => webInvoke("backup:auto-run"),
  s3Status: () => webInvoke("backup:s3-status"),
  s3Configure: (input) => webInvoke("backup:s3-configure", input),
  s3Test: () => webInvoke("backup:s3-test"),
  s3Disconnect: () => webInvoke("backup:s3-disconnect"),
};
export const backupAutomation = (): Automation | null =>
  desktop()?.backup ?? (isWeb() ? web : null);
