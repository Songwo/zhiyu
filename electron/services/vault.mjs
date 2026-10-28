import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { linkSync, renameSync, statSync, unlinkSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const derive = promisify(scrypt);

const VERSION = 2;
const KEY_LEN = 32;
const IV_LEN = 12;
const MIN_MASTER_LENGTH = 10;
const MAX_MASTER_LENGTH = 256;
// v1 文件不含 kdf 字段，始终使用这些历史参数。
const LEGACY_KDF = { N: 2 ** 15, r: 8, p: 1 };
// 当前参数每次派生使用约 128 MiB；参数随文件保存，改密时才升级旧库。
const CURRENT_KDF = { N: 2 ** 17, r: 8, p: 1 };
const MAXMEM = 256 * 1024 * 1024;
// 同时限制 CPU 工作量，避免未鉴权的文件通过增大 p 长时间占满派生线程。
const MAX_KDF_WORK = CURRENT_KDF.N * CURRENT_KDF.r * CURRENT_KDF.p;
// Windows 可短暂拒绝文件替换；最多等待 2.55 秒，永久权限错误仍向调用方报告。
const RENAME_RETRY_DELAYS = [50, 100, 200, 400, 800, 1000];

/** 参数同时受内存与运算量限制，不接受越界后退回历史参数的降级。 */
function normalizeKdf(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isInteger(value.N) ||
    value.N < 2 ** 14 ||
    value.N > 2 ** 20 ||
    (value.N & (value.N - 1)) !== 0 ||
    !Number.isInteger(value.r) ||
    value.r < 1 ||
    value.r > 32 ||
    !Number.isInteger(value.p) ||
    value.p < 1 ||
    value.p > 16 ||
    128 * value.r * (value.N + value.p + 2) >= MAXMEM ||
    value.N * value.r * value.p > MAX_KDF_WORK
  )
    return null;
  return { N: value.N, r: value.r, p: value.p };
}
function kdfOf(doc) {
  if (doc?.v === 1 && !Object.hasOwn(doc, "kdf")) return LEGACY_KDF;
  const kdf = doc?.v === VERSION ? normalizeKdf(doc.kdf) : null;
  if (!kdf) throw new Error("主密码不正确或密钥库格式不受支持");
  return kdf;
}
const deriveKey = (master, salt, kdf) => derive(master, salt, KEY_LEN, { ...kdf, maxmem: MAXMEM });
const fileStamp = (info) => `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}:${info.size}`;
const keyContext = (doc) => {
  const kdf = kdfOf(doc);
  return `${doc.salt}:${kdf.N}:${kdf.r}:${kdf.p}`;
};

function assertMaster(master, label) {
  if (typeof master !== "string" || master.length < MIN_MASTER_LENGTH)
    throw new Error(`${label}至少 ${MIN_MASTER_LENGTH} 位`);
  if (master.length > MAX_MASTER_LENGTH) throw new Error(`${label}最多 ${MAX_MASTER_LENGTH} 位`);
}

/**
 * Credential store for SSH passwords, private keys and API secrets.
 *
 * The master password is never written anywhere — it derives a key that lives
 * in this process's memory until the app locks or quits. On disk there is only
 * AES-256-GCM ciphertext, one IV and one auth tag per record, so a stolen
 * `vault.enc` is inert without the password.
 */
export class Vault {
  #file;
  #key = null;
  #keyContext = null;
  #doc = null;
  // 文件身份与纳秒时间共同识别恢复操作，包括保留大小和修改时间的替换。
  #stamp = null;
  #queue = Promise.resolve();
  #generation = 0;
  #lockListeners = new Set();

  constructor(file) {
    this.#file = file;
  }

  get unlocked() {
    return this.#key !== null;
  }

  /** 锁库代次用于取消跨越锁定边界的上层异步操作。 */
  get session() {
    return this.#generation;
  }

  onLock(listener) {
    if (typeof listener !== "function") throw new TypeError("锁库监听器无效");
    this.#lockListeners.add(listener);
    return () => this.#lockListeners.delete(listener);
  }

  #assertGeneration(generation) {
    if (generation !== this.#generation) throw new Error("密钥库已锁定，操作已取消。");
  }

  #enqueue(action, { requireUnlocked = false, cancelOnLock = true } = {}) {
    if (requireUnlocked && !this.unlocked) return Promise.reject(new Error("密钥库已锁定"));
    const generation = this.#generation;
    const task = this.#queue.then(() => {
      if (cancelOnLock) this.#assertGeneration(generation);
      return action(generation);
    });
    this.#queue = task.catch(() => {});
    return task;
  }

  #replaceKey(key, doc) {
    if (this.#key && this.#key !== key) this.#key.fill(0);
    this.#key = key;
    this.#keyContext = key ? keyContext(doc) : null;
  }

  async #read() {
    let info;
    try {
      // 同步 stat：缓存命中时不让出事件循环，上层依赖"入队即读"的时序不受影响。
      info = statSync(this.#file, { bigint: true });
    } catch (error) {
      // 文件缺失或暂时不可访问时沿用内存副本；只有首次读取缺失才视为尚未创建。
      if (this.#doc) return { doc: this.#doc, stamp: this.#stamp, writable: false };
      if (error.code === "ENOENT") return { doc: null, stamp: null, writable: true };
      throw new Error("密钥库读取失败，请保留原文件并检查备份。");
    }
    if (!info.isFile()) {
      if (this.#doc) return { doc: this.#doc, stamp: this.#stamp, writable: false };
      throw new Error("密钥库读取失败，请保留原文件并检查备份。");
    }
    const stamp = fileStamp(info);
    if (this.#doc && this.#stamp === stamp) return { doc: this.#doc, stamp, writable: true };
    let doc;
    try {
      doc = JSON.parse(await readFile(this.#file, "utf8"));
    } catch {
      throw new Error("密钥库读取失败，请保留原文件并检查备份。");
    }
    // 异步读取期间可能恢复了另一个文件，不能把旧密文标记成新版本缓存。
    this.#assertUnchanged({ stamp, writable: true });
    if (this.#key) {
      let compatible = false;
      try {
        compatible =
          this.#keyContext === keyContext(doc) &&
          open(this.#key, doc.check).equals(Buffer.from("sinan-vault"));
      } catch {
        // 盐、参数或校验密文异常都不能沿用现有解密密钥。
      }
      if (!compatible) this.lock();
    }
    this.#doc = doc;
    this.#stamp = stamp;
    return { doc, stamp, writable: true };
  }

  #assertUnchanged(expected) {
    if (!expected.writable) throw new Error("密钥库保存失败，请恢复原文件后重试。");
    let stamp = null;
    try {
      const info = statSync(this.#file, { bigint: true });
      stamp = info.isFile() ? fileStamp(info) : "not-file";
    } catch (error) {
      if (error.code !== "ENOENT") stamp = "unreadable";
    }
    if (stamp !== expected.stamp) {
      // 取消本次及旧会话中的排队操作；重新解锁后以恢复的文件为准。
      this.lock();
      throw new Error("密钥库文件已变化，操作已取消，请重新解锁后重试。");
    }
  }

  async #write(doc, generation, expected, nextKey, beforeCommit) {
    const tmp = `${this.#file}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      this.#assertUnchanged(expected);
      await mkdir(dirname(this.#file), { recursive: true });
      this.#assertGeneration(generation);
      await writeFile(tmp, JSON.stringify(doc), { encoding: "utf8", mode: 0o600, flag: "wx" });
      for (let attempt = 0; ; attempt += 1) {
        this.#assertGeneration(generation);
        beforeCommit?.();
        this.#assertGeneration(generation);
        // 每次等待后重新验证独立快照，不能覆盖等待期间恢复的备份。
        this.#assertUnchanged(expected);
        try {
          if (expected.stamp === null) {
            // 首次创建使用不覆盖目标的原子硬链接，保留并发创建或恢复的文件。
            linkSync(tmp, this.#file);
            unlinkSync(tmp);
          } else renameSync(tmp, this.#file);
          break;
        } catch (error) {
          if (
            expected.stamp === null ||
            process.platform !== "win32" ||
            error.code !== "EPERM" ||
            attempt >= RENAME_RETRY_DELAYS.length
          )
            throw error;
          await delay(RENAME_RETRY_DELAYS[attempt]);
        }
      }
      // 成功替换到切换文档和密钥仍在同一个同步段，不允许锁库插入。
      this.#doc = doc;
      try {
        this.#stamp = fileStamp(statSync(this.#file, { bigint: true }));
      } catch {
        this.#stamp = null;
      }
      if (nextKey) this.#replaceKey(nextKey, doc);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      this.#assertGeneration(generation);
      beforeCommit?.();
      throw new Error("密钥库保存失败，请检查本地文件权限。", { cause: error });
    }
  }

  status() {
    return this.#enqueue(
      async () => {
        const snapshot = await this.#read();
        const { doc } = snapshot;
        return { exists: Boolean(doc), unlocked: this.unlocked };
      },
      { cancelOnLock: false },
    );
  }

  /**
   * 同步用：读取原始密文文档，不需要解锁，也不返回任何明文。
   * `stamp` 标识读取时的文件版本，传给 importDocument 防止覆盖同步期间的新写入。
   */
  exportDocument() {
    return this.#enqueue(
      async () => {
        const { doc, stamp } = await this.#read();
        return { doc: doc ? structuredClone(doc) : null, stamp, mtimeMs: this.#mtimeMs() };
      },
      { cancelOnLock: false },
    );
  }

  #mtimeMs() {
    try {
      return statSync(this.#file).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 同步用：用合并后的密文文档替换本机文件。文件在导出之后变过就放弃；
   * 主密码在另一端改过（盐、参数或校验块不同）时，当前解锁状态立即失效并锁库。
   */
  importDocument(doc, expectedStamp) {
    return this.#enqueue(
      async (generation) => {
        const snapshot = await this.#read();
        if (snapshot.stamp !== expectedStamp)
          throw new Error("密钥库在同步期间发生变化，已放弃本次写入。");
        const kdf = doc?.v === VERSION ? normalizeKdf(doc.kdf) : doc?.v === 1 ? LEGACY_KDF : null;
        if (
          !doc ||
          typeof doc.salt !== "string" ||
          !kdf ||
          !doc.check ||
          typeof doc.records !== "object"
        )
          throw new Error("同步得到的密钥库格式不正确，已放弃写入。");
        await this.#write(doc, generation, snapshot, null);
        if (this.#key) {
          let compatible = false;
          try {
            compatible =
              this.#keyContext === keyContext(doc) &&
              open(this.#key, doc.check).equals(Buffer.from("sinan-vault"));
          } catch {
            // 校验块或参数不匹配：说明主密码已经换了。
          }
          if (!compatible) this.lock();
        }
        return { ok: true };
      },
      { cancelOnLock: false },
    );
  }

  /** First run: pick a master password and seal an empty vault with it. */
  create(master) {
    return this.#enqueue(async (generation) => {
      assertMaster(master, "主密码");
      const snapshot = await this.#read();
      if (snapshot.doc) throw new Error("密钥库已存在，请直接解锁");
      this.#assertGeneration(generation);
      const salt = randomBytes(16);
      const key = await deriveKey(master, salt, CURRENT_KDF);
      try {
        this.#assertGeneration(generation);
        await this.#write(
          {
            v: VERSION,
            salt: salt.toString("base64"),
            kdf: { ...CURRENT_KDF },
            check: seal(key, Buffer.from("sinan-vault")),
            records: {},
          },
          generation,
          snapshot,
          key,
        );
        return { ok: true };
      } finally {
        if (this.#key !== key) key.fill(0);
      }
    });
  }

  async #verifiedKey(master, doc, generation) {
    if (typeof master !== "string" || !master) throw new Error("主密码不正确");
    const key = await deriveKey(master, Buffer.from(doc.salt, "base64"), kdfOf(doc));
    try {
      this.#assertGeneration(generation);
      let probe;
      try {
        probe = open(key, doc.check);
      } catch {
        throw new Error("主密码不正确");
      }
      const expected = Buffer.from("sinan-vault");
      if (probe.length !== expected.length || !timingSafeEqual(probe, expected))
        throw new Error("主密码不正确");
      return key;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  unlock(master) {
    return this.#enqueue(async (generation) => {
      const snapshot = await this.#read();
      const { doc } = snapshot;
      if (!doc) throw new Error("密钥库尚未创建");
      this.#assertGeneration(generation);
      const key = await this.#verifiedKey(master, doc, generation);
      try {
        this.#assertGeneration(generation);
        this.#assertUnchanged(snapshot);
        this.#replaceKey(key, doc);
        return { ok: true };
      } finally {
        if (this.#key !== key) key.fill(0);
      }
    });
  }

  lock() {
    this.#generation += 1;
    this.#replaceKey(null);
    for (const listener of this.#lockListeners) {
      try {
        listener();
      } catch {
        // 清理回调异常不能阻止其他模块清除敏感状态。
      }
    }
    return { ok: true };
  }

  /**
   * Re-key the whole vault.
   *
   * A new password means a new salt and therefore a new key, so every record
   * has to be decrypted with the old one and re-sealed with the new one. The
   * document is only written once, at the end — a crash halfway through must
   * not leave half the records unreadable by either password.
   */
  changePassword(oldMaster, newMaster) {
    return this.#enqueue(async (generation) => {
      assertMaster(newMaster, "新主密码");
      const snapshot = await this.#read();
      const { doc } = snapshot;
      if (!doc) throw new Error("密钥库尚未创建");
      this.#assertGeneration(generation);
      const oldKey = await this.#verifiedKey(oldMaster, doc, generation);
      let newKey;
      try {
        this.#assertGeneration(generation);
        const salt = randomBytes(16);
        newKey = await deriveKey(newMaster, salt, CURRENT_KDF);
        this.#assertGeneration(generation);
        const records = Object.create(null);
        for (const [id, rec] of Object.entries(doc.records ?? {}))
          records[id] = seal(newKey, open(oldKey, rec));
        await this.#write(
          {
            v: VERSION,
            salt: salt.toString("base64"),
            kdf: { ...CURRENT_KDF },
            check: seal(newKey, Buffer.from("sinan-vault")),
            records,
          },
          generation,
          snapshot,
          newKey,
        );
        return { ok: true, count: Object.keys(records).length };
      } finally {
        oldKey.fill(0);
        if (newKey && this.#key !== newKey) newKey.fill(0);
      }
    });
  }

  #require() {
    if (!this.#key) throw new Error("密钥库已锁定");
    return this.#key;
  }

  set(id, secret) {
    return this.#enqueue(
      async (generation) => {
        const snapshot = await this.#read();
        const { doc } = snapshot;
        this.#assertGeneration(generation);
        const key = this.#require();
        const records = {
          ...(doc?.records ?? {}),
          [id]: seal(key, Buffer.from(JSON.stringify(secret), "utf8")),
        };
        await this.#write({ ...doc, records }, generation, snapshot);
        return { ok: true };
      },
      { requireUnlocked: true },
    );
  }

  get(id) {
    return this.#enqueue(
      async (generation) => {
        const snapshot = await this.#read();
        const { doc } = snapshot;
        this.#assertGeneration(generation);
        const key = this.#require();
        if (!Object.hasOwn(doc?.records ?? {}, id)) return null;
        return JSON.parse(open(key, doc.records[id]).toString("utf8"));
      },
      { requireUnlocked: true },
    );
  }

  /** 全部记录先加密，再一次落盘；任一条失败时保留整个旧库。 */
  batch(entries, { beforeCommit } = {}) {
    return this.#enqueue(
      async (generation) => {
        if (!Array.isArray(entries) || entries.length > 10000) throw new Error("批量凭据数量无效");
        const snapshot = await this.#read();
        const { doc } = snapshot;
        this.#assertGeneration(generation);
        const key = this.#require();
        beforeCommit?.();
        this.#assertGeneration(generation);
        const records = { ...(doc?.records ?? {}) };
        const ids = new Set();
        for (const entry of entries) {
          if (
            !entry ||
            typeof entry.id !== "string" ||
            !entry.id ||
            entry.id.length > 512 ||
            ids.has(entry.id) ||
            !entry.secret ||
            typeof entry.secret !== "object" ||
            Array.isArray(entry.secret) ||
            (entry.merge !== undefined && typeof entry.merge !== "boolean")
          )
            throw new Error("批量凭据格式无效");
          ids.add(entry.id);
          let secret = entry.secret;
          if (entry.merge && Object.hasOwn(records, entry.id)) {
            // 在持久化队列中读取最新版本，避免身份同步覆盖同时保存的密码和备注。
            const current = JSON.parse(open(key, records[entry.id]).toString("utf8"));
            if (!current || typeof current !== "object" || Array.isArray(current))
              throw new Error("现有凭据不是可合并的对象");
            secret = { ...current, ...secret };
          }
          Object.defineProperty(records, entry.id, {
            value: seal(key, Buffer.from(JSON.stringify(secret), "utf8")),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        if (entries.length)
          await this.#write({ ...doc, records }, generation, snapshot, undefined, beforeCommit);
        return { ok: true, count: entries.length };
      },
      { requireUnlocked: true },
    );
  }

  /** 同一个锁库代次内读取快照，不向调用方暴露内部缓存。 */
  readAll(prefix = "") {
    return this.#enqueue(
      async (generation) => {
        if (typeof prefix !== "string") throw new Error("凭据前缀无效");
        const snapshot = await this.#read();
        const { doc } = snapshot;
        this.#assertGeneration(generation);
        const key = this.#require();
        const result = {};
        for (const [id, record] of Object.entries(doc?.records ?? {})) {
          if (!id.startsWith(prefix)) continue;
          Object.defineProperty(result, id, {
            value: JSON.parse(open(key, record).toString("utf8")),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return result;
      },
      { requireUnlocked: true },
    );
  }

  remove(id) {
    return this.#enqueue(
      async (generation) => {
        const snapshot = await this.#read();
        const { doc } = snapshot;
        this.#assertGeneration(generation);
        this.#require();
        if (Object.hasOwn(doc?.records ?? {}, id)) {
          const records = { ...doc.records };
          delete records[id];
          await this.#write({ ...doc, records }, generation, snapshot);
        }
        return { ok: true };
      },
      { requireUnlocked: true },
    );
  }

  /** 一次提交整组删除，失败或锁库时保留全部原记录。 */
  removeMany(ids, { beforeCommit } = {}) {
    return this.#enqueue(
      async (generation) => {
        if (
          !Array.isArray(ids) ||
          ids.length > 10000 ||
          ids.some((id) => typeof id !== "string" || !id || id.length > 512)
        )
          throw new Error("批量删除凭据标识无效");
        const snapshot = await this.#read();
        const { doc } = snapshot;
        this.#assertGeneration(generation);
        this.#require();
        beforeCommit?.();
        this.#assertGeneration(generation);
        const records = { ...(doc?.records ?? {}) };
        let count = 0;
        for (const id of new Set(ids)) {
          if (!Object.hasOwn(records, id)) continue;
          delete records[id];
          count += 1;
        }
        if (count)
          await this.#write({ ...doc, records }, generation, snapshot, undefined, beforeCommit);
        return { ok: true, count };
      },
      { requireUnlocked: true },
    );
  }

  list() {
    return this.#enqueue(
      async () => {
        const snapshot = await this.#read();
        const { doc } = snapshot;
        return Object.keys(doc?.records ?? {});
      },
      { cancelOnLock: false },
    );
  }
}

function seal(key, plaintext) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function open(key, rec) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(rec.iv, "base64"));
  decipher.setAuthTag(Buffer.from(rec.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(rec.data, "base64")), decipher.final()]);
}

export const vaultPath = (userData) => join(userData, "vault.enc");

// 加密备份沿用同一套 scrypt 参数边界与派生实现，不另起一套强度标准。
export { CURRENT_KDF, MAX_MASTER_LENGTH, MIN_MASTER_LENGTH, deriveKey, normalizeKdf };
