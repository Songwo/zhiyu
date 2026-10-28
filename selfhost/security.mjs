/**
 * 网页版的安全部件：访问来源白名单、登录两步验证（TOTP）、登录限流与登录记录。
 * 都是不依赖服务器上下文的小部件，方便单独测试；接线在 server.mjs。
 */
import { BlockList, isIP } from "node:net";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ———— 访问来源白名单 ————

/** 家里、公司内网、回环和 Tailscale / WireGuard 常用的 CGNAT 网段。 */
export const PRIVATE_NETS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

/** `::ffff:1.2.3.4` 这种 IPv4 映射地址按 IPv4 比较。 */
export function normalizeIp(address) {
  const text = String(address ?? "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  return mapped ? mapped[1] : text;
}

/**
 * 解析 ZHIYU_ALLOWED_NETS：逗号分隔的 IP、CIDR 或关键字 `private`。
 * 写错的条目直接报错（拒绝启动），不能因为手误把服务开放给所有人。
 */
export function parseAllowedNets(value) {
  const entries = String(value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const list = new BlockList();
  for (const entry of entries.flatMap((item) =>
    item.toLowerCase() === "private" ? PRIVATE_NETS : [item],
  )) {
    const [address, prefix] = entry.split("/");
    const family = isIP(address);
    if (!family) throw new Error(`ZHIYU_ALLOWED_NETS 里的「${entry}」不是有效的 IP 或网段`);
    const max = family === 4 ? 32 : 128;
    if (prefix === undefined) list.addAddress(address, family === 4 ? "ipv4" : "ipv6");
    else {
      const bits = Number(prefix);
      if (!/^\d+$/.test(prefix) || bits > max)
        throw new Error(`ZHIYU_ALLOWED_NETS 里的「${entry}」前缀长度无效`);
      list.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
    }
  }
  return {
    empty: entries.length === 0,
    entries,
    allows(address) {
      if (entries.length === 0) return true;
      const ip = normalizeIp(address);
      const family = isIP(ip);
      return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6");
    },
  };
}

// ———— TOTP（RFC 6238，SHA-1、6 位、30 秒） ————

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  const clean = String(text)
    .toUpperCase()
    .replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error("密钥格式不正确");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => randomBytes(20);

export const TOTP_PERIOD = 30;
export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}
/**
 * 验证验证码：允许前后各一个时间窗（手机时钟略有偏差），
 * 且同一个或更早的时间窗不能再用一次（`lastStep` 之后才算新），防止被看到的验证码重放。
 * @returns {{ ok: boolean, step?: number }}
 */
export function verifyTotp(secret, code, now = Date.now(), lastStep = 0) {
  const text = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(text)) return { ok: false };
  const current = Math.floor(now / 1000 / TOTP_PERIOD);
  let matched;
  for (const step of [current - 1, current, current + 1]) {
    // 每个时间窗都比较，不因提前命中而缩短耗时。
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(text)) && step > lastStep) matched ??= step;
  }
  return matched === undefined ? { ok: false } : { ok: true, step: matched };
}
export function otpauthUri({ secret, account, issuer = "知屿 Zhiyu" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}

// ———— 恢复码 ————

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = [...randomBytes(10)].map((byte) => CROCKFORD[byte & 31]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
export const normalizeRecovery = (code) =>
  String(code ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
export const hashRecovery = (code, salt) =>
  createHash("sha256").update(salt).update(normalizeRecovery(code)).digest("hex");

// ———— 登录限流 ————

const WINDOW = 15 * 60_000;
export class LoginGuard {
  #now;
  #byIp = new Map();
  #all = [];
  #attempts = [];
  constructor({ now = Date.now, perIp = 8, globalFree = 10, perMinute = 40 } = {}) {
    this.#now = now;
    this.perIp = perIp;
    this.globalFree = globalFree;
    this.perMinute = perMinute;
  }
  #prune() {
    const at = this.#now();
    this.#all = this.#all.filter((time) => at - time < WINDOW);
    this.#attempts = this.#attempts.filter((time) => at - time < 60_000);
    for (const [ip, list] of this.#byIp) {
      const kept = list.filter((time) => at - time < WINDOW);
      if (kept.length) this.#byIp.set(ip, kept);
      else this.#byIp.delete(ip);
    }
  }
  /** 登录前检查：某个来源失败太多、或全站登录请求过密都先拒绝，不进入昂贵的密码哈希。 */
  check(ip) {
    this.#prune();
    if ((this.#byIp.get(ip)?.length ?? 0) >= this.perIp) return { blocked: true, reason: "ip" };
    if (this.#attempts.length >= this.perMinute) return { blocked: true, reason: "rate" };
    this.#attempts.push(this.#now());
    return { blocked: false };
  }
  /** 全站最近的失败次数超过免费额度后，每次尝试都要多等一会儿（上限 5 秒），拖慢分布式猜密码。 */
  delayMs() {
    this.#prune();
    return Math.min(5000, Math.max(0, this.#all.length - this.globalFree) * 400);
  }
  fail(ip) {
    const at = this.#now();
    this.#all.push(at);
    this.#byIp.set(ip, [...(this.#byIp.get(ip) ?? []), at]);
    return this.#byIp.get(ip).length;
  }
  success(ip) {
    this.#byIp.delete(ip);
  }
  get recentFailures() {
    this.#prune();
    return this.#all.length;
  }
}

// ———— 登录记录 ————

export const MAX_LOG = 100;
export const KNOWN_IP_DAYS = 60;
/** 最近的登录与安全事件，用来在设置里查看，以及判断「这是不是一个新的来源」。 */
export function appendLog(list, entry, now = Date.now()) {
  return [{ at: new Date(now).toISOString(), ...entry }, ...(list ?? [])].slice(0, MAX_LOG);
}
export function isKnownIp(list, ip, now = Date.now()) {
  return (list ?? []).some(
    (entry) =>
      entry.kind === "login" &&
      entry.ip === ip &&
      now - Date.parse(entry.at) < KNOWN_IP_DAYS * 86_400_000,
  );
}
/** 只保留浏览器名称的大概信息，不把完整 User-Agent 长期存下来。 */
export function shortAgent(value) {
  const text = String(value ?? "");
  // Edge、Opera 的 User-Agent 里也带 Chrome / Safari，要按优先级匹配。
  const browser = ["Edg", "OPR", "Firefox", "Chrome", "Safari"].find((name) =>
    text.includes(`${name}/`),
  );
  const system = /(Windows|Mac OS X|Android|iPhone|iPad|Linux)/.exec(text)?.[1];
  return [browser === "Edg" ? "Edge" : browser === "OPR" ? "Opera" : browser, system]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 60);
}
