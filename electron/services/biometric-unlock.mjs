import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class BiometricUnlock {
  #vault;
  #storage;
  #system;
  #platform;
  #file;
  #epoch = 0;
  #pending = null;

  constructor({ vault, storage, system, directory, platform = process.platform }) {
    this.#vault = vault;
    this.#storage = storage;
    this.#system = system;
    this.#platform = platform;
    this.#file = join(directory, "touch-id-key.enc");
  }

  #available() {
    if (this.#platform !== "darwin") return false;
    try {
      return this.#system.canPromptTouchID() && this.#storage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async #read() {
    try {
      const value = JSON.parse(await readFile(this.#file, "utf8"));
      if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint))
        throw new Error("Touch ID 本机解锁材料格式错误，请重新开启。");
      if (typeof value.ciphertext !== "string" || !value.ciphertext)
        throw new Error("Touch ID 本机解锁材料格式错误，请重新开启。");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async status() {
    if (this.#platform !== "darwin") return { available: false, enabled: false };
    const entry = await this.#read();
    const available = this.#available();
    if (!entry) return { available, enabled: false };
    const fingerprint = await this.#vault.fingerprint();
    if (entry.fingerprint !== fingerprint) {
      await rm(this.#file, { force: true });
      return { available, enabled: false };
    }
    return { available, enabled: true };
  }

  #run(task) {
    if (this.#pending) throw new Error("Touch ID 操作仍在进行，请稍后重试。");
    const pending = Promise.resolve().then(task);
    this.#pending = pending;
    pending
      .finally(() => {
        if (this.#pending === pending) this.#pending = null;
      })
      .catch(() => {});
    return pending;
  }

  enable() {
    return this.#run(async () => {
      if (!this.#available()) throw new Error("这台 Mac 无法使用 Touch ID。");
      if (!this.#vault.unlocked) throw new Error("请先用主密码解锁密钥库。");
      const epoch = this.#epoch;
      const session = this.#vault.session;
      const fingerprint = await this.#vault.fingerprint();
      await this.#system.promptTouchID("开启知屿密钥库的 Touch ID 解锁");
      if (epoch !== this.#epoch || session !== this.#vault.session || !this.#vault.unlocked)
        throw new Error("密钥库状态已变化，请重新开启 Touch ID。");
      const key = this.#vault.exportUnlockKey();
      const temporary = `${this.#file}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        const ciphertext = this.#storage.encryptString(key.toString("base64")).toString("base64");
        await writeFile(temporary, JSON.stringify({ version: 1, fingerprint, ciphertext }), {
          mode: 0o600,
          flag: "wx",
        });
        if (epoch !== this.#epoch || session !== this.#vault.session || !this.#vault.unlocked)
          throw new Error("密钥库状态已变化，请重新开启 Touch ID。");
        await rename(temporary, this.#file);
        if (epoch !== this.#epoch || session !== this.#vault.session || !this.#vault.unlocked) {
          await rm(this.#file, { force: true });
          throw new Error("密钥库状态已变化，请重新开启 Touch ID。");
        }
        return { enabled: true };
      } finally {
        key.fill(0);
        await rm(temporary, { force: true });
      }
    });
  }

  unlock() {
    return this.#run(async () => {
      if (!this.#available()) throw new Error("这台 Mac 无法使用 Touch ID。");
      if (this.#vault.unlocked) return { ok: true };
      const epoch = this.#epoch;
      const session = this.#vault.session;
      const entry = await this.#read();
      if (!entry) throw new Error("请先在设置中开启 Touch ID 解锁。");
      const fingerprint = await this.#vault.fingerprint();
      if (entry.fingerprint !== fingerprint) {
        await rm(this.#file, { force: true });
        throw new Error("密钥库已更换，请用主密码解锁后重新开启 Touch ID。");
      }
      await this.#system.promptTouchID("解锁知屿密钥库");
      if (epoch !== this.#epoch || session !== this.#vault.session || this.#vault.unlocked)
        throw new Error("密钥库状态已变化，请重新解锁。");
      let key;
      try {
        try {
          key = Buffer.from(
            this.#storage.decryptString(Buffer.from(entry.ciphertext, "base64")),
            "base64",
          );
        } catch {
          await rm(this.#file, { force: true });
          throw new Error("本机解锁材料已失效，请使用主密码重新开启 Touch ID。");
        }
        const result = await this.#vault.unlockWithKey(key);
        if (epoch !== this.#epoch || session !== this.#vault.session) {
          this.#vault.lock();
          throw new Error("密钥库状态已变化，请重新解锁。");
        }
        return result;
      } catch (error) {
        if (/解锁材料|密钥库已更换/.test(error.message)) await rm(this.#file, { force: true });
        throw error;
      } finally {
        key?.fill(0);
      }
    });
  }

  async disable() {
    this.#epoch += 1;
    await this.#pending?.catch(() => {});
    await rm(this.#file, { force: true });
    return { enabled: false };
  }
}
