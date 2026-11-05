import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const RETRY_DELAYS = [25, 50, 100, 200, 400];
const TRANSIENT_WINDOWS_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

/** 同文件按调用顺序提交；Windows 的短暂占用只重试 rename，不删除原文件或降级为原地覆盖。 */
export function createAtomicWriter({
  renameFile = rename,
  wait = delay,
  platform = process.platform,
} = {}) {
  const pending = new Map();
  async function commit(file, data, mode) {
    const temporary = `${file}.${randomBytes(16).toString("hex")}.tmp`;
    let created = false;
    try {
      const handle = await open(temporary, "wx", mode);
      created = true;
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      for (let attempt = 0; ; attempt++) {
        try {
          await renameFile(temporary, file);
          return;
        } catch (error) {
          if (
            platform !== "win32" ||
            !TRANSIENT_WINDOWS_ERRORS.has(error.code) ||
            attempt >= RETRY_DELAYS.length
          )
            throw error;
          await wait(RETRY_DELAYS[attempt]);
        }
      }
    } finally {
      if (created) await rm(temporary, { force: true }).catch(() => {});
    }
  }
  return (file, data, mode = 0o600) => {
    const previous = pending.get(file) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => commit(file, data, mode));
    pending.set(file, task);
    const release = () => {
      if (pending.get(file) === task) pending.delete(file);
    };
    void task.then(release, release);
    return task;
  };
}

export const writeAtomic = createAtomicWriter();
