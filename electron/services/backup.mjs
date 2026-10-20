import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  CURRENT_KDF,
  MAX_MASTER_LENGTH,
  MIN_MASTER_LENGTH,
  deriveKey,
  normalizeKdf,
} from "./vault.mjs";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const BACKUP_EXTENSION = "zhiyu-backup";
export const BACKUP_LIMITS = { bytes: 512 * 1024 * 1024, files: 20000 };
export const PENDING_DIRECTORY = ".restore-pending";
export const SNAPSHOT_DIRECTORY = "restore-snapshots";

const MAGIC = Buffer.from("ZHIYUBAK", "ascii");
const FORMAT = "zhiyu-backup";
const FORMAT_VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_HEADER = 4096;
const CHECK = Buffer.from("zhiyu-backup-check");
const ASSET_COLLECTIONS = [
  "servers",
  "services",
  "domains",
  "certs",
  "mailboxes",
  "aiAssets",
  "secrets",
  "phoneNumbers",
];
// 本机缓存与本机备份计划：既不打包，恢复时也保留当前文件。
const MACHINE_LOCAL = new Set(["local-usage.json", "backup-schedule.json"]);
// 只收应用自己的小写数据文件；Chromium 的 Preferences、Local State、缓存目录天然被排除。
const ROOT_FILE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:json|enc)$/;
const DOCUMENT_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export class BackupError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
const corrupt = () => new BackupError("备份文件已损坏或被篡改，无法读取。", "CORRUPT");
const wrongPassword = () => new BackupError("备份密码不正确。", "PASSWORD");

/** 备份路径同时是恢复写入路径，只允许根目录数据文件与 documents 下的文件。 */
export function isBackupPath(path) {
  if (typeof path !== "string" || !path || path.length > 300 || path.includes("\\")) return false;
  const parts = path.split("/");
  if (parts.length === 1) {
    const [name] = parts;
    return ROOT_FILE.test(name) && !name.includes(".backup") && !MACHINE_LOCAL.has(name);
  }
  return (
    parts[0] === "documents" &&
    parts.length <= 4 &&
    parts.slice(1).every((part) => DOCUMENT_PART.test(part) && part !== "." && part !== "..") &&
    !parts.at(-1).endsWith(".tmp")
  );
}

export function assertBackupPassword(password) {
  if (typeof password !== "string" || password.length < MIN_MASTER_LENGTH)
    throw new BackupError(`备份密码至少 ${MIN_MASTER_LENGTH} 位`, "PASSWORD_RULE");
  if (password.length > MAX_MASTER_LENGTH)
    throw new BackupError(`备份密码最多 ${MAX_MASTER_LENGTH} 位`, "PASSWORD_RULE");
}

/** 列出资料目录中会被备份（以及恢复时会被替换）的文件，按路径排序。 */
export async function collectFiles(root) {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries)
    if (entry.isFile() && isBackupPath(entry.name)) files.push(entry.name);
  async function walk(directory, prefix, depth) {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const child of children) {
      const path = `${prefix}/${child.name}`;
      // 符号链接既不是 isFile 也不是 isDirectory，不会把资料目录之外的文件带进备份。
      if (child.isDirectory() && depth < 3)
        await walk(join(directory, child.name), path, depth + 1);
      else if (child.isFile() && isBackupPath(path)) files.push(path);
    }
  }
  await walk(join(root, "documents"), "documents", 1);
  return files.sort();
}

const absolute = (root, path) => join(root, ...path.split("/"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function sealCheck(key) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(CHECK), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function openCheck(key, check) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(check.iv, "base64"));
    decipher.setAuthTag(Buffer.from(check.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(check.data, "base64")),
      decipher.final(),
    ]);
    return plain.equals(CHECK);
  } catch {
    return false;
  }
}

// —— 系统加密（Windows DPAPI / 钥匙串）保存的凭据 ——
// 这些密文绑定当前系统用户，换机器后无法解密；可选地以明文放进加密备份，恢复时再交给本机重新加密。
function jsonField(field) {
  return {
    read(bytes) {
      const json = JSON.parse(bytes.toString("utf8"));
      return typeof json?.[field] === "string" && json[field]
        ? [{ id: field, cipher: Buffer.from(json[field], "base64") }]
        : [];
    },
    write(bytes, values, storage) {
      const json = JSON.parse(bytes.toString("utf8"));
      if (values.has(field))
        json[field] = storage.encryptString(values.get(field)).toString("base64");
      return Buffer.from(JSON.stringify(json), "utf8");
    },
  };
}

export const SECURE_SOURCES = [
  { file: "agent-config.json", ...jsonField("encryptedKey") },
  { file: "image-bed.json", ...jsonField("encryptedKey") },
  {
    file: "integrations.json",
    read(bytes) {
      const json = JSON.parse(bytes.toString("utf8"));
      return (Array.isArray(json?.connections) ? json.connections : [])
        .filter((c) => typeof c?.id === "string" && typeof c.encryptedToken === "string")
        .map((c) => ({ id: c.id, cipher: Buffer.from(c.encryptedToken, "base64") }));
    },
    write(bytes, values, storage) {
      const json = JSON.parse(bytes.toString("utf8"));
      for (const connection of json.connections ?? [])
        if (values.has(connection.id))
          connection.encryptedToken = storage
            .encryptString(values.get(connection.id))
            .toString("base64");
      return Buffer.from(JSON.stringify(json), "utf8");
    },
  },
  {
    // 整个文件都是系统加密密文。
    file: "main-identity.enc",
    read: (bytes) => (bytes.length ? [{ id: "file", cipher: bytes }] : []),
    write: (bytes, values, storage) =>
      values.has("file") ? storage.encryptString(values.get("file")) : bytes,
  },
];
const SECURE_FILES = new Set(SECURE_SOURCES.map((source) => source.file));

/** Linux 无钥匙串时会退化为固定密钥，不能当作安全存储。 */
export function secureStorageUsable(storage) {
  try {
    return Boolean(
      storage?.isEncryptionAvailable?.() && storage.getSelectedStorageBackend?.() !== "basic_text",
    );
  } catch {
    return false;
  }
}

function extractSecure(contents, storage) {
  const entries = [];
  const failed = new Set();
  const usable = secureStorageUsable(storage);
  for (const source of SECURE_SOURCES) {
    const bytes = contents.get(source.file);
    if (!bytes) continue;
    let items;
    try {
      items = source.read(bytes);
    } catch {
      failed.add(source.file);
      continue;
    }
    for (const item of items) {
      try {
        if (!usable) throw new Error("unavailable");
        const value = storage.decryptString(item.cipher);
        if (typeof value !== "string") throw new Error("invalid");
        entries.push({ file: source.file, id: item.id, value });
      } catch {
        failed.add(source.file);
      }
    }
  }
  return { entries, failed: [...failed] };
}

function summarize(contents) {
  const assets = {};
  let assetTotal = 0;
  try {
    const raw = JSON.parse(contents.get("assets.json")?.toString("utf8") ?? "null");
    const state = raw?.state ?? raw;
    for (const key of ASSET_COLLECTIONS)
      if (Array.isArray(state?.[key])) {
        assets[key] = state[key].length;
        assetTotal += state[key].length;
      }
  } catch {
    // 资产文件损坏也照原样备份，只是预览不给数量。
  }
  let vaultRecords = null;
  try {
    const vault = JSON.parse(contents.get("vault.enc")?.toString("utf8") ?? "null");
    if (vault?.records && typeof vault.records === "object")
      vaultRecords = Object.keys(vault.records).length;
  } catch {
    vaultRecords = null;
  }
  const documents = [...contents.keys()].filter(
    (path) => path.startsWith("documents/") && path.endsWith(".json"),
  ).length;
  return { assets, assetTotal, documents, vaultRecords };
}

function preview(manifest) {
  return {
    formatVersion: manifest.formatVersion,
    appVersion: manifest.appVersion,
    createdAt: manifest.createdAt,
    platform: manifest.platform,
    kind: manifest.kind,
    summary: manifest.summary,
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    secure: {
      included: manifest.secure.included,
      count: manifest.secure.entries.length,
      files: [...new Set(manifest.secure.entries.map((entry) => entry.file))],
      failed: manifest.secure.failed,
    },
  };
}

/**
 * 读取资料目录并生成单个加密备份。
 *
 * 文件格式：MAGIC | u32 头长度 | 头 JSON | AES-256-GCM 密文 | 16 字节标签。
 * 头里只有 scrypt 参数、盐、IV 与密码校验块，并作为 AAD 参与认证；
 * 版本、时间、文件清单和凭据都在密文里，没有密码连预览也看不到。
 */
export async function createBackup({
  root,
  password,
  appVersion = "",
  platform = process.platform,
  kind = "manual",
  now = new Date(),
  secureStorage = null,
}) {
  assertBackupPassword(password);
  const paths = await collectFiles(root);
  if (paths.length > BACKUP_LIMITS.files)
    throw new BackupError("资料文件过多，无法备份。", "LIMIT");
  const contents = new Map();
  let total = 0;
  for (const path of paths) {
    let bytes;
    try {
      bytes = await readFile(absolute(root, path));
    } catch (error) {
      // 打包期间被删除的文件（例如文档刚被移除）不算失败。
      if (error.code === "ENOENT") continue;
      throw new BackupError(`无法读取 ${path}，请稍后重试。`, "READ");
    }
    total += bytes.length;
    if (total > BACKUP_LIMITS.bytes) throw new BackupError("资料超过 512 MiB，无法打包。", "LIMIT");
    contents.set(path, bytes);
  }
  const secure = secureStorage
    ? { included: true, ...extractSecure(contents, secureStorage) }
    : { included: false, entries: [], failed: [] };
  const manifest = {
    app: "zhiyu",
    formatVersion: FORMAT_VERSION,
    appVersion: String(appVersion),
    createdAt: now.toISOString(),
    platform: String(platform),
    kind: kind === "auto" ? "auto" : "manual",
    files: [...contents].map(([path, bytes]) => ({
      path,
      size: bytes.length,
      sha256: sha256(bytes),
    })),
    summary: summarize(contents),
    secure,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const payload = Buffer.concat([u32(manifestBytes.length), manifestBytes, ...contents.values()]);
  const compressed = await gzipAsync(payload);
  payload.fill(0);
  manifestBytes.fill(0);

  const salt = randomBytes(16);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKey(password, salt, CURRENT_KDF);
  try {
    const header = Buffer.from(
      JSON.stringify({
        format: FORMAT,
        v: FORMAT_VERSION,
        kdf: { ...CURRENT_KDF },
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        check: sealCheck(key),
      }),
      "utf8",
    );
    const prefix = Buffer.concat([MAGIC, u32(header.length), header]);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(prefix);
    const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
    return { data: Buffer.concat([prefix, body, cipher.getAuthTag()]), preview: preview(manifest) };
  } finally {
    key.fill(0);
    compressed.fill(0);
  }
}

function parseHeader(data) {
  if (!Buffer.isBuffer(data) || data.length < MAGIC.length + 4 + TAG_LEN)
    throw new BackupError("这不是知屿备份文件。", "FORMAT");
  if (!data.subarray(0, MAGIC.length).equals(MAGIC))
    throw new BackupError("这不是知屿备份文件。", "FORMAT");
  const length = data.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  if (length < 2 || length > MAX_HEADER || start + length + TAG_LEN > data.length) throw corrupt();
  let header;
  try {
    header = JSON.parse(data.subarray(start, start + length).toString("utf8"));
  } catch {
    throw corrupt();
  }
  if (header?.format !== FORMAT || typeof header.v !== "number") throw corrupt();
  if (header.v > FORMAT_VERSION)
    throw new BackupError("备份由更新版本的知屿创建，请先升级后再恢复。", "VERSION");
  const kdf = normalizeKdf(header.kdf);
  const salt = Buffer.from(String(header.salt ?? ""), "base64");
  const iv = Buffer.from(String(header.iv ?? ""), "base64");
  const check = header.check;
  if (
    header.v !== FORMAT_VERSION ||
    !kdf ||
    salt.length !== 16 ||
    iv.length !== IV_LEN ||
    !check ||
    typeof check.iv !== "string" ||
    typeof check.tag !== "string" ||
    typeof check.data !== "string"
  )
    throw corrupt();
  return { kdf, salt, iv, check, end: start + length };
}

function parseManifest(payload) {
  if (payload.length < 4) throw corrupt();
  const length = payload.readUInt32BE(0);
  if (4 + length > payload.length) throw corrupt();
  let manifest;
  try {
    manifest = JSON.parse(payload.subarray(4, 4 + length).toString("utf8"));
  } catch {
    throw corrupt();
  }
  if (
    manifest?.app !== "zhiyu" ||
    manifest.formatVersion !== FORMAT_VERSION ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > BACKUP_LIMITS.files ||
    typeof manifest.createdAt !== "string" ||
    !manifest.secure ||
    !Array.isArray(manifest.secure.entries) ||
    !Array.isArray(manifest.secure.failed)
  )
    throw corrupt();
  const files = new Map();
  let offset = 4 + length;
  for (const file of manifest.files) {
    if (
      !isBackupPath(file?.path) ||
      files.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw corrupt();
    const bytes = payload.subarray(offset, offset + file.size);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw corrupt();
    files.set(file.path, bytes);
    offset += file.size;
  }
  if (offset !== payload.length) throw corrupt();
  for (const entry of manifest.secure.entries)
    if (
      !SECURE_FILES.has(entry?.file) ||
      typeof entry.id !== "string" ||
      typeof entry.value !== "string"
    )
      throw corrupt();
  return { manifest, files };
}

/** 解密并完整校验备份；密码错误与内容被篡改给出不同的错误。 */
export async function openBackup(data, password) {
  const { kdf, salt, iv, check, end } = parseHeader(data);
  if (typeof password !== "string" || !password || password.length > MAX_MASTER_LENGTH)
    throw wrongPassword();
  const key = await deriveKey(password, salt, kdf);
  let compressed;
  try {
    if (!openCheck(key, check)) throw wrongPassword();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(data.subarray(0, end));
    decipher.setAuthTag(data.subarray(data.length - TAG_LEN));
    try {
      compressed = Buffer.concat([
        decipher.update(data.subarray(end, data.length - TAG_LEN)),
        decipher.final(),
      ]);
    } catch {
      throw corrupt();
    }
  } finally {
    key.fill(0);
  }
  let payload;
  try {
    payload = await gunzipAsync(compressed, {
      maxOutputLength: BACKUP_LIMITS.bytes + 16 * 1024 * 1024,
    });
  } catch {
    throw corrupt();
  } finally {
    compressed.fill(0);
  }
  const { manifest, files } = parseManifest(payload);
  return { manifest, files, preview: preview(manifest) };
}

export async function readBackupFile(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new BackupError("无法读取所选备份文件。", "READ");
  }
  if (!info.isFile() || info.size > BACKUP_LIMITS.bytes + 1024 * 1024)
    throw new BackupError("所选文件不是有效的知屿备份。", "FORMAT");
  return readFile(path);
}

/** 先写临时文件再替换，避免中断时留下半个备份。 */
export async function writeBackupFile(target, data) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 把备份内容写入资料目录下的暂存区，下次启动时再整体替换。
 *
 * 运行中的服务都持有内存缓存和文件句柄，直接覆盖会被旧缓存写回；
 * 因此这里只准备文件，`ready.json` 最后写入，作为可以替换的唯一信号。
 */
export async function stageRestore({ root, backup, secureStorage = null, now = new Date() }) {
  const pending = join(root, PENDING_DIRECTORY);
  await rm(pending, { recursive: true, force: true });
  const files = new Map(backup.files);
  const entries = backup.manifest.secure.entries;
  let secureRestored = 0;
  let secureSkipped = false;
  if (entries.length) {
    if (!secureStorageUsable(secureStorage)) secureSkipped = true;
    else
      for (const source of SECURE_SOURCES) {
        const bytes = files.get(source.file);
        const values = new Map(
          entries.filter((entry) => entry.file === source.file).map((e) => [e.id, e.value]),
        );
        if (!bytes || !values.size) continue;
        files.set(source.file, Buffer.from(source.write(bytes, values, secureStorage)));
        secureRestored += values.size;
      }
  }
  try {
    await mkdir(join(pending, "files"), { recursive: true });
    for (const [path, bytes] of files) {
      const target = absolute(join(pending, "files"), path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    }
    const ready = {
      v: 1,
      stamp: backupStamp(now),
      files: [...files.keys()],
      backupCreatedAt: backup.manifest.createdAt,
    };
    await writeFile(join(pending, "ready.json.tmp"), JSON.stringify(ready), { mode: 0o600 });
    await rename(join(pending, "ready.json.tmp"), join(pending, "ready.json"));
  } catch (error) {
    await rm(pending, { recursive: true, force: true }).catch(() => {});
    throw new BackupError(`准备恢复文件失败：${error.message}`, "STAGE");
  }
  return { files: files.size, secureRestored, secureSkipped };
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * 启动早期、任何服务读取资料之前调用：把当前资料移入快照目录，再换入暂存的备份。
 *
 * 两个阶段都可以在中断后重放：第一阶段完成后写下标记，第二阶段只移动仍在暂存区的文件。
 */
export async function applyPendingRestore(root, { keepSnapshots = 5 } = {}) {
  const pending = join(root, PENDING_DIRECTORY);
  if (!(await exists(pending))) return null;
  let ready;
  try {
    ready = JSON.parse(await readFile(join(pending, "ready.json"), "utf8"));
    if (
      ready?.v !== 1 ||
      typeof ready.stamp !== "string" ||
      !/^\d{8}-\d{6}$/.test(ready.stamp) ||
      !Array.isArray(ready.files) ||
      !ready.files.every(isBackupPath)
    )
      throw new Error("invalid");
  } catch {
    // 暂存未完成（例如准备时退出），当前资料保持原样。
    await rm(pending, { recursive: true, force: true });
    return { status: "discarded" };
  }
  const snapshot = join(root, SNAPSHOT_DIRECTORY, ready.stamp);
  const marker = join(pending, "moved-out");
  if (!(await exists(marker))) {
    await mkdir(snapshot, { recursive: true });
    // 中断后重放时快照里已有的文件是真正的原资料，绝不覆盖；根目录同名文件留给第二阶段替换。
    for (const path of await collectFiles(root)) {
      if (path.startsWith("documents/") || (await exists(join(snapshot, path)))) continue;
      await rename(absolute(root, path), join(snapshot, path));
    }
    if ((await exists(join(root, "documents"))) && !(await exists(join(snapshot, "documents"))))
      await rename(join(root, "documents"), join(snapshot, "documents"));
    await writeFile(marker, "");
  }
  for (const path of ready.files) {
    const source = absolute(join(pending, "files"), path);
    if (!(await exists(source))) continue;
    const target = absolute(root, path);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }
  await rm(pending, { recursive: true, force: true });
  await pruneDirectories(join(root, SNAPSHOT_DIRECTORY), keepSnapshots);
  return {
    status: "applied",
    snapshot: `${SNAPSHOT_DIRECTORY}/${ready.stamp}`,
    files: ready.files.length,
    backupCreatedAt: typeof ready.backupCreatedAt === "string" ? ready.backupCreatedAt : null,
  };
}

async function pruneDirectories(directory, keep) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const stamps = entries
    .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of stamps.slice(keep))
    await rm(join(directory, name), { recursive: true, force: true }).catch(() => {});
}

const AUTO_NAME = /^zhiyu-auto-\d{8}-\d{6}\.zhiyu-backup$/;
export const autoBackupName = (date = new Date()) =>
  `zhiyu-auto-${backupStamp(date)}.${BACKUP_EXTENSION}`;

/** 只清理自动备份自己命名的文件，用户放在同一目录的其他文件一律不动。 */
export async function pruneAutoBackups(directory, keep) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && AUTO_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removed = names.slice(keep);
  for (const name of removed) await rm(join(directory, name), { force: true });
  return removed;
}
