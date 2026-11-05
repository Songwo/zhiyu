import { join } from "node:path";
import { BackupScheduler } from "../electron/services/backup-schedule.mjs";
import { S3Backups } from "../electron/services/backup-s3.mjs";

/** Web 自动备份的配置留在 server，工作区备份不携带云凭据和备份密码。 */
export function createWebBackups({
  serverDir,
  secureStorage,
  produceBackup,
  fetchImpl,
  sessionActive,
}) {
  const directory = join(serverDir, "auto-backups");
  const remote = new S3Backups({
    file: join(serverDir, "backup-s3.json"),
    secureStorage,
    fetchImpl,
  });
  const schedule = new BackupScheduler({
    file: join(serverDir, "backup-schedule.json"),
    secureStorage,
    run: produceBackup,
    upload: (data, file, keep) => remote.upload(data, file, keep),
  });
  const ready = schedule
    .status()
    .then((status) => (status.directory ? undefined : schedule.setDirectory(directory)));
  let stopped = false;
  const consent = (input) => {
    if (input?.allowServerStorage !== true)
      throw new Error("请先同意服务器加密保管备份密码与 S3 凭据；敏感资产建议使用桌面端。");
  };
  const handlers = {
    "backup:auto-status": () => schedule.status(),
    "backup:auto-configure": ([input], guard) => {
      if (input?.password !== undefined || input?.enabled === true) consent(input);
      return schedule.configure(input, guard);
    },
    "backup:auto-directory": () => schedule.status(),
    "backup:auto-run": () => schedule.runNow(),
    "backup:s3-status": () => remote.status(),
    "backup:s3-configure": ([input], guard) => {
      if (
        input?.enabled !== false ||
        Object.keys(input ?? {}).some((key) => !["enabled", "allowServerStorage"].includes(key))
      )
        consent(input);
      return remote.configure(
        Object.fromEntries(
          Object.entries(input ?? {}).filter(([key]) => key !== "allowServerStorage"),
        ),
        guard,
      );
    },
    "backup:s3-test": (_, guard) => remote.test(guard),
    "backup:s3-disconnect": (_, guard) => remote.disconnect(guard),
  };
  return {
    channels: Object.keys(handlers),
    async call(channel, args, context) {
      const guard = () => {
        if (stopped || !sessionActive(context?.sessionKey))
          throw new Error("网页登录已过期，请重新登录。");
      };
      guard();
      await ready;
      guard();
      return handlers[channel](args ?? [], guard);
    },
    start() {
      void ready
        .then(() => {
          if (!stopped) schedule.start();
        })
        .catch(() => {});
    },
    stop() {
      stopped = true;
      schedule.stop();
      remote.stop();
    },
  };
}
