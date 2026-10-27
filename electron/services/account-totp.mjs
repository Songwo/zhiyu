import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";

// 纯 JavaScript 实现：桌面主进程与网页版浏览器（密钥库在浏览器里解密）共用同一份代码。
const HASHES = { SHA1: sha1, SHA256: sha256, SHA512: sha512 };

const PREFIX = "totp:";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULTS = { issuer: "", label: "", algorithm: "SHA1", digits: 6, period: 30 };
const ALGOS = new Set(["SHA1", "SHA256", "SHA512"]);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

class TotpError extends Error {}
const fail = (message) => new TotpError(message);

function base32(value) {
  if (typeof value !== "string" || value.length > 4096)
    throw fail("请输入 Base32 密钥或 otpauth://totp 导入链接。");
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(normalized))
    throw fail("验证码密钥不是有效的 Base32 编码，请检查复制内容。");
  const secret = normalized.replace(/=+$/, "");
  if (normalized.includes("=") && normalized.length % 8 !== 0)
    throw fail("验证码密钥的 Base32 补位无效。");
  const bytes = [];
  let bits = 0,
    buffer = 0;
  for (const character of secret) {
    buffer = (buffer << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (
    buffer !== 0 ||
    [1, 3, 6].includes(secret.length % 8) ||
    bytes.length < 10 ||
    bytes.length > 128
  )
    throw fail("验证码密钥长度或 Base32 编码无效，支持 10–128 字节密钥。");
  return { secret, bytes: Uint8Array.from(bytes) };
}

function normalizeSecret(value) {
  const decoded = base32(value);
  decoded.bytes.fill(0);
  return decoded.secret;
}

function parseSecret(value) {
  if (typeof value !== "string" || value.length > 4096)
    throw fail("请输入 Base32 密钥或 otpauth://totp 导入链接。");
  const input = value.trim();
  if (!/^otpauth:/i.test(input)) return { ...DEFAULTS, secret: normalizeSecret(input) };
  let uri;
  try {
    uri = new URL(input);
  } catch {
    throw fail("验证码导入链接无效。");
  }
  if (
    uri.protocol !== "otpauth:" ||
    uri.hostname !== "totp" ||
    uri.username ||
    uri.password ||
    uri.port ||
    uri.hash
  )
    throw fail("仅支持按时间变化的 otpauth://totp 验证码，不支持 HOTP 计数器链接。");
  const allowed = new Set(["secret", "issuer", "algorithm", "digits", "period"]);
  for (const key of uri.searchParams.keys()) {
    if (!allowed.has(key) || uri.searchParams.getAll(key).length !== 1)
      throw fail("验证码链接含不支持或重复的参数。");
  }
  let label;
  try {
    label = decodeURIComponent(uri.pathname.slice(1));
  } catch {
    throw fail("验证码名称编码无效。");
  }
  if (
    !label ||
    label.length > 300 ||
    Array.from(label).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw fail("验证码名称无效。");
  const explicitIssuer = uri.searchParams.get("issuer") || "";
  const colon = label.indexOf(":");
  const labelIssuer = colon >= 0 ? label.slice(0, colon).trim() : "";
  if (explicitIssuer && labelIssuer && explicitIssuer !== labelIssuer)
    throw fail("验证码链接中的服务商名称不一致，请检查原始链接。");
  const issuer = explicitIssuer || labelIssuer;
  if (
    issuer.length > 200 ||
    Array.from(issuer).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw fail("验证码服务商名称无效。");
  const algorithm = (uri.searchParams.get("algorithm") || "SHA1").toUpperCase();
  const digitsRaw = uri.searchParams.get("digits") || "6";
  const periodRaw = uri.searchParams.get("period") || "30";
  if (!ALGOS.has(algorithm)) throw fail("验证码算法仅支持 SHA1、SHA256 或 SHA512。");
  if (!["6", "8"].includes(digitsRaw)) throw fail("验证码位数仅支持 6 位或 8 位。");
  if (!/^\d+$/.test(periodRaw) || Number(periodRaw) < 15 || Number(periodRaw) > 120)
    throw fail("验证码更新间隔须为 15–120 秒。");
  const secret = normalizeSecret(uri.searchParams.get("secret"));
  return {
    secret,
    issuer,
    label: colon >= 0 ? label.slice(colon + 1).trim() || label : label,
    algorithm,
    digits: Number(digitsRaw),
    period: Number(periodRaw),
  };
}

function metadata(record) {
  if (!record) return { configured: false, ...DEFAULTS };
  return {
    configured: true,
    issuer: record.issuer,
    label: record.label,
    algorithm: record.algorithm,
    digits: record.digits,
    period: record.period,
  };
}

/** TOTP 种子仅在主进程密钥库中使用；界面只读取短期验证码及显示所需参数。 */
export class AccountTotp {
  #vault;
  #getAssets;
  #now;
  #queue = Promise.resolve();

  constructor({ vault, getAssets, now = Date.now }) {
    this.#vault = vault;
    this.#getAssets = getAssets;
    this.#now = now;
  }

  #assert(generation) {
    if (!this.#vault.unlocked || this.#vault.session !== generation)
      throw fail("密钥库已锁定，请解锁后查看验证码。");
  }

  #run(assetId, action, requireAsset = true) {
    const generation = this.#vault.session;
    const task = this.#queue.then(async () => {
      this.#assert(generation);
      if (
        typeof assetId !== "string" ||
        !assetId ||
        assetId.length > 200 ||
        Array.from(assetId).some((char) => char.charCodeAt(0) < 32)
      )
        throw fail("账号标识无效。");
      try {
        if (requireAsset) {
          const assets = await this.#getAssets();
          this.#assert(generation);
          const asset = (Array.isArray(assets) ? assets : assets?.secrets || []).find(
            (entry) => entry.id === assetId,
          );
          if (!asset || asset.kind !== "account")
            throw fail("请先选择一个已保存的账号，再设置验证码。");
        }
        return await action(generation);
      } catch (error) {
        this.#assert(generation);
        throw error instanceof TotpError
          ? error
          : fail("验证码读取或保存失败，请检查本地密钥库后重试。");
      }
    });
    this.#queue = task.catch(() => {});
    return task;
  }

  async #read(assetId, generation) {
    const record = await this.#vault.get(PREFIX + assetId);
    this.#assert(generation);
    if (
      record &&
      (!object(record) ||
        !ALGOS.has(record.algorithm) ||
        ![6, 8].includes(record.digits) ||
        !Number.isInteger(record.period) ||
        record.period < 15 ||
        record.period > 120 ||
        typeof record.issuer !== "string" ||
        typeof record.label !== "string")
    )
      throw fail("验证码配置无效，请重新导入原始密钥。");
    return record;
  }

  status(assetId) {
    return this.#run(assetId, async (generation) =>
      metadata(await this.#read(assetId, generation)),
    );
  }

  configure({ assetId, secret } = {}) {
    return this.#run(assetId, async (generation) => {
      const record = parseSecret(secret);
      await this.#vault.batch([{ id: PREFIX + assetId, secret: record }], {
        beforeCommit: () => this.#assert(generation),
      });
      this.#assert(generation);
      return metadata(record);
    });
  }

  code(assetId) {
    return this.#run(assetId, async (generation) => {
      const record = await this.#read(assetId, generation);
      if (!record) throw fail("此账号尚未配置二次验证码。");
      const stamp = this.#now();
      if (!Number.isFinite(stamp) || stamp < 0 || stamp > Number.MAX_SAFE_INTEGER)
        throw fail("系统时间无效，无法生成验证码。");
      const interval = record.period * 1000;
      const counter = Math.floor(stamp / interval);
      const message = new Uint8Array(8);
      new DataView(message.buffer).setBigUint64(0, BigInt(counter));
      const bytes = base32(record.secret).bytes;
      let digest;
      try {
        digest = hmac(HASHES[record.algorithm], bytes, message);
        const offset = digest[digest.length - 1] & 15;
        const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
        const number = (view.getUint32(offset) & 0x7fffffff) % 10 ** record.digits;
        const expiresAt = (counter + 1) * interval;
        return {
          code: String(number).padStart(record.digits, "0"),
          remaining: Math.ceil((expiresAt - stamp) / 1000),
          expiresAt,
          period: record.period,
        };
      } finally {
        bytes.fill(0);
        digest?.fill(0);
      }
    });
  }

  remove(assetId) {
    return this.#run(
      assetId,
      async (generation) => {
        await this.#vault.remove(PREFIX + assetId);
        this.#assert(generation);
      },
      false,
    );
  }
}
