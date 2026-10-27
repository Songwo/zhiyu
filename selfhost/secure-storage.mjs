/**
 * 网页版的「系统加密存储」：桌面版用操作系统钥匙串（Electron safeStorage）加密
 * Cloudflare Token、模型 API Key 等，服务器上没有钥匙串，改用 server 目录里的随机密钥
 * 做 AES-256-GCM。密钥文件只有服务进程能读，不进入资料备份；换服务器后需要重新填写这些凭据。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const MAGIC = Buffer.from("zy1");

export function createServerSecureStorage(keyFile) {
  let key;
  try {
    key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!key || key.length !== 32) {
    key = randomBytes(32);
    const tmp = `${keyFile}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, key.toString("base64"), { mode: 0o600 });
    renameSync(tmp, keyFile);
  }
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "zhiyu_server_key",
    encryptString(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]);
    },
    decryptString(buffer) {
      const bytes = Buffer.from(buffer);
      if (bytes.length < 31 || !bytes.subarray(0, 3).equals(MAGIC))
        throw new Error("这项凭据不是在这台服务器上保存的，请重新填写。");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(3, 15));
      decipher.setAuthTag(bytes.subarray(15, 31));
      return Buffer.concat([decipher.update(bytes.subarray(31)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}
