/**
 * 网页版密钥库：在浏览器里用主密码派生密钥、加解密，服务器只保存密文。
 *
 * 文件格式与桌面版 electron/services/vault.mjs 完全相同（scrypt 派生、每条记录
 * 单独 AES-256-GCM），所以桌面版备份恢复到网页版后，用同一个主密码就能解锁。
 * 解锁后的密钥只在这个标签页的内存里，刷新或关闭页面即锁定。
 */
import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { AccountCredential, SshCredential } from "./desktop.ts";
import { webApi, WebConflictError } from "./web.ts";

type Sealed = { iv: string; tag: string; data: string };
type Kdf = { N: number; r: number; p: number };
interface VaultDoc {
  v: 1 | 2;
  salt: string;
  kdf?: Kdf;
  check: Sealed;
  records: Record<string, Sealed>;
}
type Secret = SshCredential & AccountCredential;

const CURRENT_KDF: Kdf = { N: 2 ** 17, r: 8, p: 1 };
const LEGACY_KDF: Kdf = { N: 2 ** 15, r: 8, p: 1 };
const CHECK = "sinan-vault";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let key: CryptoKey | null = null;
let keyContext = "";
let doc: VaultDoc | null = null;
let revision: string | null = null;
let loaded = false;

const toB64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function kdfOf(d: VaultDoc): Kdf {
  if (d.v === 1 && !d.kdf) return LEGACY_KDF;
  const k = d.kdf;
  if (
    !k ||
    d.v !== 2 ||
    k.N < 2 ** 14 ||
    k.N > 2 ** 20 ||
    k.r < 1 ||
    k.r > 32 ||
    k.p < 1 ||
    k.p > 16
  )
    throw new Error("主密码不正确或密钥库格式不受支持");
  return k;
}
async function deriveKey(master: string, salt: string, kdf: Kdf) {
  const raw = await scryptAsync(encoder.encode(master), fromB64(salt), {
    ...kdf,
    dkLen: 32,
    maxmem: 300 * 1024 * 1024,
  });
  const k = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return k;
}
async function seal(k: CryptoKey, plaintext: Uint8Array<ArrayBuffer>): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, k, plaintext),
  );
  return {
    iv: toB64(iv),
    tag: toB64(out.slice(out.length - 16)),
    data: toB64(out.slice(0, out.length - 16)),
  };
}
async function open(k: CryptoKey, rec: Sealed): Promise<Uint8Array<ArrayBuffer>> {
  const data = fromB64(rec.data),
    tag = fromB64(rec.tag);
  const joined = new Uint8Array(data.length + tag.length);
  joined.set(data);
  joined.set(tag, data.length);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(rec.iv), tagLength: 128 },
      k,
      joined,
    ),
  );
}
async function verified(k: CryptoKey, d: VaultDoc) {
  try {
    return decoder.decode(await open(k, d.check)) === CHECK;
  } catch {
    return false;
  }
}
function assertMaster(master: string, label: string) {
  if (typeof master !== "string" || master.length < 10) throw new Error(`${label}至少 10 位`);
  if (master.length > 256) throw new Error(`${label}最多 256 位`);
}

async function load() {
  const res = await webApi<{ revision: string | null; doc: VaultDoc | null }>("vault");
  doc = res.doc;
  revision = res.revision;
  loaded = true;
  // 其他设备改了主密码：旧密钥打不开新文件，立即锁定。
  if (
    key &&
    doc &&
    (keyContext !== `${doc.salt}:${JSON.stringify(kdfOf(doc))}` || !(await verified(key, doc)))
  )
    lock();
}
async function put(next: VaultDoc) {
  const res = await webApi<{ revision: string }>("vault", {
    method: "PUT",
    body: { revision, doc: next },
  });
  doc = next;
  revision = res.revision;
}
function requireKey() {
  if (!key) throw new Error("密钥库已锁定");
  return key;
}
/** 读-改-写；别的设备刚写过时重新读取再试一次。 */
async function mutate(change: (current: VaultDoc, k: CryptoKey) => Promise<VaultDoc>) {
  for (let attempt = 0; ; attempt++) {
    if (!loaded || attempt > 0) await load();
    if (!doc) throw new Error("密钥库尚未创建");
    try {
      return await put(await change(doc, requireKey()));
    } catch (error) {
      if (!(error instanceof WebConflictError) || attempt >= 2) throw error;
    }
  }
}
function lock() {
  key = null;
  keyContext = "";
  return { ok: true as const };
}

export const webVault = {
  async status() {
    if (!loaded) await load();
    return { exists: Boolean(doc), unlocked: key !== null };
  },
  async create(master: string) {
    assertMaster(master, "主密码");
    await load();
    if (doc) throw new Error("密钥库已存在，请直接解锁");
    const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    const k = await deriveKey(master, salt, CURRENT_KDF);
    await put({
      v: 2,
      salt,
      kdf: { ...CURRENT_KDF },
      check: await seal(k, encoder.encode(CHECK)),
      records: {},
    });
    key = k;
    keyContext = `${salt}:${JSON.stringify(CURRENT_KDF)}`;
    return { ok: true as const };
  },
  async unlock(master: string) {
    await load();
    if (!doc) throw new Error("密钥库尚未创建");
    if (typeof master !== "string" || !master) throw new Error("主密码不正确");
    const kdf = kdfOf(doc);
    const k = await deriveKey(master, doc.salt, kdf);
    if (!(await verified(k, doc))) throw new Error("主密码不正确");
    key = k;
    keyContext = `${doc.salt}:${JSON.stringify(kdf)}`;
    return { ok: true as const };
  },
  async lock() {
    return lock();
  },
  async changePassword(oldMaster: string, newMaster: string) {
    assertMaster(newMaster, "新主密码");
    await load();
    if (!doc) throw new Error("密钥库尚未创建");
    const oldKey = await deriveKey(oldMaster, doc.salt, kdfOf(doc));
    if (!(await verified(oldKey, doc))) throw new Error("主密码不正确");
    const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    const newKey = await deriveKey(newMaster, salt, CURRENT_KDF);
    const records: Record<string, Sealed> = {};
    for (const [id, rec] of Object.entries(doc.records))
      records[id] = await seal(newKey, await open(oldKey, rec));
    await put({
      v: 2,
      salt,
      kdf: { ...CURRENT_KDF },
      check: await seal(newKey, encoder.encode(CHECK)),
      records,
    });
    key = newKey;
    keyContext = `${salt}:${JSON.stringify(CURRENT_KDF)}`;
    return { ok: true as const, count: Object.keys(records).length };
  },
  async get(id: string): Promise<Secret | null> {
    const k = requireKey();
    if (!loaded) await load();
    const rec = doc?.records[id];
    if (!rec || !Object.hasOwn(doc!.records, id)) return null;
    return JSON.parse(decoder.decode(await open(k, rec))) as Secret;
  },
  async set(id: string, secret: SshCredential | AccountCredential) {
    await mutate(async (current, k) => ({
      ...current,
      records: { ...current.records, [id]: await seal(k, encoder.encode(JSON.stringify(secret))) },
    }));
    return { ok: true as const };
  },
  async remove(id: string) {
    await mutate(async (current) => {
      const records = { ...current.records };
      delete records[id];
      return { ...current, records };
    });
    return { ok: true as const };
  },
  async list() {
    if (!loaded) await load();
    return Object.keys(doc?.records ?? {});
  },
};
