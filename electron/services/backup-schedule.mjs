import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  assertBackupPassword,
  autoBackupName,
  pruneAutoBackups,
  secureStorageUsable,
  writeBackupFile,
} from "./backup.mjs";

export const BACKUP_INTERVALS = [24, 72, 168];
const HOUR = 60 * 60 * 1000;
// 失败后至少隔一小时再试，避免目标目录不可用时每次检查都重新派生密钥。
const RETRY_AFTER = HOUR;
const DEFAULTS = {
  enabled: false,
  directory: null,
  intervalHours: 24,
  keep: 7,
  encryptedPassword: null,
  lastRunAt: null,
  lastAttemptAt: null,
  lastFile: null,
  lastError: null,
};

function validKeep(value) {
  return Number.isInteger(value) && value >= 1 && value <= 30;
}

/**
 * 按周期把加密备份写到用户选择的文件夹，并只保留最近 N 份。
 *
 * 无人值守运行需要备份密码，它用系统安全存储加密后保存在本机，
 * 不进入备份本身；换机器恢复后需要重新设置自动备份密码。
 */
export class BackupScheduler {
  #file;
  #storage;
  #run;
  #now;
  #queue = Promise.resolve();
  #timer = null;
  #starter = null;

  constructor({ file, secureStorage, run, now = Date.now }) {
    this.#file = file;
    this.#storage = secureStorage;
    this.#run = run;
    this.#now = now;
  }

  #enqueue(work) {
    const task = this.#queue.then(work);
    this.#queue = task.catch(() => {});
    return task;
  }

  async #read() {
    try {
      const saved = JSON.parse(await readFile(this.#file, "utf8"));
      return {
        ...DEFAULTS,
        enabled: saved.enabled === true,
        directory:
          typeof saved.directory === "string" && isAbsolute(saved.directory)
            ? saved.directory
            : null,
        intervalHours: BACKUP_INTERVALS.includes(saved.intervalHours) ? saved.intervalHours : 24,
        keep: validKeep(saved.keep) ? saved.keep : 7,
        encryptedPassword:
          typeof saved.encryptedPassword === "string" ? saved.encryptedPassword : null,
        lastRunAt: Number.isFinite(saved.lastRunAt) ? saved.lastRunAt : null,
        lastAttemptAt: Number.isFinite(saved.lastAttemptAt) ? saved.lastAttemptAt : null,
        lastFile: typeof saved.lastFile === "string" ? saved.lastFile : null,
        lastError: typeof saved.lastError === "string" ? saved.lastError : null,
      };
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return { ...DEFAULTS };
      throw new Error("自动备份设置读取失败，请检查本地文件。");
    }
  }

  async #write(config) {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
    await rename(temporary, this.#file);
  }

  #password(config) {
    if (!config.encryptedPassword) throw new Error("请先设置自动备份密码。");
    if (!secureStorageUsable(this.#storage))
      throw new Error("系统加密存储不可用，无法读取自动备份密码。");
    try {
      return this.#storage.decryptString(Buffer.from(config.encryptedPassword, "base64"));
    } catch {
      throw new Error("无法读取自动备份密码（可能是资料从其他电脑恢复而来），请重新设置。");
    }
  }

  #due(config) {
    if (!config.enabled || !config.directory || !config.encryptedPassword) return false;
    const now = this.#now();
    if (config.lastAttemptAt && now - config.lastAttemptAt < RETRY_AFTER) return false;
    return !config.lastRunAt || now - config.lastRunAt >= config.intervalHours * HOUR;
  }

  #dto(config) {
    let passwordReadable = false;
    if (config.encryptedPassword && secureStorageUsable(this.#storage))
      try {
        this.#storage.decryptString(Buffer.from(config.encryptedPassword, "base64"));
        passwordReadable = true;
      } catch {
        passwordReadable = false;
      }
    return {
      enabled: config.enabled,
      directory: config.directory,
      intervalHours: config.intervalHours,
      keep: config.keep,
      hasPassword: Boolean(config.encryptedPassword),
      passwordReadable,
      lastRunAt: config.lastRunAt,
      lastFile: config.lastFile,
      lastError: config.lastError,
      nextRunAt:
        config.enabled && config.lastRunAt ? config.lastRunAt + config.intervalHours * HOUR : null,
    };
  }

  status() {
    return this.#enqueue(async () => this.#dto(await this.#read()));
  }

  /** 目录只能由主进程的选择对话框传入，渲染进程不能指定写入位置。 */
  setDirectory(directory) {
    return this.#enqueue(async () => {
      if (typeof directory !== "string" || !isAbsolute(directory))
        throw new Error("备份文件夹无效。");
      const config = { ...(await this.#read()), directory, lastError: null };
      await this.#write(config);
      return this.#dto(config);
    });
  }

  configure(input) {
    return this.#enqueue(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("自动备份设置无效。");
      const config = await this.#read();
      if (input.intervalHours !== undefined) {
        if (!BACKUP_INTERVALS.includes(input.intervalHours)) throw new Error("备份周期无效。");
        config.intervalHours = input.intervalHours;
      }
      if (input.keep !== undefined) {
        if (!validKeep(input.keep)) throw new Error("保留份数需为 1–30。");
        config.keep = input.keep;
      }
      if (input.password !== undefined) {
        assertBackupPassword(input.password);
        if (!secureStorageUsable(this.#storage))
          throw new Error("系统加密存储不可用，无法保存自动备份密码。");
        config.encryptedPassword = this.#storage.encryptString(input.password).toString("base64");
        config.lastError = null;
      }
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== "boolean") throw new Error("自动备份设置无效。");
        if (input.enabled && !config.directory) throw new Error("请先选择备份文件夹。");
        if (input.enabled && !config.encryptedPassword) throw new Error("请先设置自动备份密码。");
        config.enabled = input.enabled;
      }
      await this.#write(config);
      return this.#dto(config);
    });
  }

  async #execute(config) {
    const attemptAt = this.#now();
    try {
      if (!config.directory) throw new Error("请先选择备份文件夹。");
      const data = await this.#run(this.#password(config));
      const name = autoBackupName(new Date(attemptAt));
      await writeBackupFile(join(config.directory, name), data);
      await pruneAutoBackups(config.directory, config.keep);
      const next = {
        ...config,
        lastRunAt: attemptAt,
        lastAttemptAt: null,
        lastFile: name,
        lastError: null,
      };
      await this.#write(next);
      return this.#dto(next);
    } catch (error) {
      const next = {
        ...config,
        lastAttemptAt: attemptAt,
        lastError: String(error?.message ?? error),
      };
      await this.#write(next).catch(() => {});
      throw error;
    }
  }

  runNow() {
    return this.#enqueue(async () => this.#execute(await this.#read()));
  }

  /** 定时检查：到期才运行，失败只记录在状态里，不抛给计时器。 */
  tick() {
    return this.#enqueue(async () => {
      const config = await this.#read();
      if (!this.#due(config)) return false;
      await this.#execute(config).catch(() => {});
      return true;
    });
  }

  start({ every = 10 * 60 * 1000, firstDelay = 2 * 60 * 1000 } = {}) {
    this.stop();
    this.#starter = setTimeout(() => void this.tick(), firstDelay);
    this.#starter.unref?.();
    this.#timer = setInterval(() => void this.tick(), every);
    this.#timer.unref?.();
  }

  stop() {
    clearTimeout(this.#starter);
    clearInterval(this.#timer);
    this.#starter = null;
    this.#timer = null;
  }
}
