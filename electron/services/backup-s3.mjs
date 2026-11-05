import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AwsClient } from "aws4fetch";
import { secureStorageUsable } from "./backup.mjs";

const id = () => randomBytes(16).toString("hex");
const PROVIDERS = new Set(["s3", "r2", "oss", "minio"]);
const safeText = (value, limit) =>
  typeof value === "string" &&
  value.length <= limit &&
  ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const keyPath = (parts) =>
  parts
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join("/");
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function normalizeS3Backup(input) {
  if (!input || !PROVIDERS.has(input.provider)) throw new Error("请选择 S3 存储类型。");
  if (!safeText(input.endpoint, 2048)) throw new Error("S3 Endpoint 不正确。");
  let endpoint;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new Error("S3 Endpoint 需要完整的 HTTPS 地址。");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["https:", "http:"].includes(endpoint.protocol)
  )
    throw new Error("S3 Endpoint 不能包含账号、密码、查询参数或片段。");
  if (endpoint.protocol !== "https:" && input.allowInsecure !== true)
    throw new Error("S3 需要 HTTPS；仅在了解风险的可信内网才允许 HTTP。");
  if (
    !safeText(input.bucket, 63) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) ||
    input.bucket.includes("..") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(input.bucket)
  )
    throw new Error("Bucket 需要符合 S3 命名规则（3–63 位小写字母、数字、点或短横线）。");
  if (!safeText(input.region, 50) || !/^[a-z0-9-]+$/.test(input.region))
    throw new Error("请填写有效的签名区域。");
  const prefix =
    typeof input.prefix === "string" ? input.prefix.replace(/^\/+|\/+$/g, "") : "zhiyu-backups";
  if (!safeText(prefix, 180) || prefix.split("/").some((p) => !p || p === "." || p === ".."))
    throw new Error("备份前缀不正确。");
  if (
    input.pathStyle === false &&
    (endpoint.port || endpoint.hostname === "localhost" || /^\d+\./.test(endpoint.hostname))
  )
    throw new Error("IP 或带端口的 Endpoint 请使用路径寻址。");
  return {
    provider: input.provider,
    endpoint: endpoint.href.replace(/\/$/, ""),
    bucket: input.bucket,
    region: input.region,
    prefix,
    pathStyle: input.pathStyle !== false,
    allowInsecure: endpoint.protocol === "http:",
  };
}

/** 仅上传已加密的备份，连接凭据不返回界面，也不进入备份本身。 */
export class S3Backups {
  #file;
  #storage;
  #fetch;
  #now;
  #queue = Promise.resolve();
  #controller = null;
  #stopped = false;
  constructor({ file, secureStorage, fetchImpl = fetch, now = Date.now }) {
    this.#file = file;
    this.#storage = secureStorage;
    this.#fetch = fetchImpl;
    this.#now = now;
  }
  #serial(work) {
    const job = this.#queue.then(() => {
      if (this.#stopped) throw new Error("云端备份已停止。");
      return work();
    });
    this.#queue = job.catch(() => {});
    return job;
  }
  async #read() {
    try {
      return JSON.parse(await readFile(this.#file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { enabled: false, workspaceId: id(), history: [] };
      throw new Error("云端备份设置读取失败，请检查配置文件。");
    }
  }
  async #write(value, beforeCommit = () => {}) {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${id()}.tmp`;
    try {
      beforeCommit();
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      beforeCommit();
      await rename(temporary, this.#file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  #credentials(config) {
    if (!secureStorageUsable(this.#storage)) throw new Error("加密存储不可用，无法读取 S3 凭据。");
    try {
      return JSON.parse(this.#storage.decryptString(Buffer.from(config.credentials, "base64")));
    } catch {
      throw new Error("S3 凭据无法在本机读取，请重新绑定。");
    }
  }
  #fingerprint(c) {
    return digest(JSON.stringify([c.target, c.credentials]));
  }
  #namespace(c) {
    return `${c.target.prefix}/${c.workspaceId}/`;
  }
  #dto(c) {
    return {
      enabled: c.enabled === true,
      target: c.target ?? null,
      hasCredentials: Boolean(c.credentials),
      testedAt: c.testedAt ?? null,
      bound: Boolean(c.testedAt && c.testedHash === this.#fingerprint(c)),
      history: (c.history ?? []).slice(0, 30),
      lastError: c.lastError ?? null,
    };
  }
  status() {
    return this.#serial(async () => this.#dto(await this.#read()));
  }
  configure(input, beforeCommit = () => {}) {
    if (input?.enabled === false) this.#controller?.abort();
    return this.#serial(async () => {
      beforeCommit();
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("S3 设置不正确。");
      const before = await this.#read();
      if (Object.keys(input).every((key) => key === "enabled")) {
        if (typeof input.enabled !== "boolean") throw new Error("云端备份开关不正确。");
        if (input.enabled && !this.#dto(before).bound) throw new Error("请先测试并绑定 S3 存储。");
        before.enabled = input.enabled;
        await this.#write(before, beforeCommit);
        return this.#dto(before);
      }
      const target = normalizeS3Backup(input);
      if (!secureStorageUsable(this.#storage))
        throw new Error("加密存储不可用，不能保存 S3 凭据。");
      const previous =
        before.credentials && before.target?.endpoint === target.endpoint
          ? this.#credentials(before)
          : {};
      const entered = (key) =>
        input[key] === undefined || input[key] === "" ? previous[key] : input[key];
      const credentials = {
        accessKeyId: entered("accessKeyId"),
        secretAccessKey: entered("secretAccessKey"),
        sessionToken: input.clearSessionToken === true ? "" : entered("sessionToken") || "",
      };
      if (
        !safeText(credentials.accessKeyId, 256) ||
        !credentials.accessKeyId ||
        !safeText(credentials.secretAccessKey, 512) ||
        !credentials.secretAccessKey ||
        !safeText(credentials.sessionToken, 8192)
      )
        throw new Error(
          "请填写有效的 Access Key ID 与 Secret Access Key；更换 Endpoint 需要重新输入凭据。",
        );
      const next = {
        ...before,
        enabled: false,
        target,
        credentials: this.#storage.encryptString(JSON.stringify(credentials)).toString("base64"),
        testedAt: null,
        testedHash: null,
        lastError: null,
      };
      await this.#write(next, beforeCommit);
      return this.#dto(next);
    });
  }
  async #request(c, method, key, data, signal) {
    const target = c.target,
      base = new URL(target.endpoint + "/");
    if (!target.pathStyle) base.hostname = `${target.bucket}.${base.hostname}`;
    base.pathname =
      base.pathname.replace(/\/$/, "") +
      "/" +
      keyPath([...(target.pathStyle ? [target.bucket] : []), ...key.split("/")]);
    const credentials = this.#credentials(c);
    const headers = { "x-amz-content-sha256": digest(data ?? Buffer.alloc(0)) };
    if (data) {
      headers["content-type"] = "application/octet-stream";
      // Electron net.fetch 拒绝手动 Content-Length；由网络层按 Buffer 长度生成。
    }
    if (target.provider === "oss") {
      headers["x-oss-s3-compat"] = "true";
      headers["x-oss-content-sha256"] = "UNSIGNED-PAYLOAD";
    }
    const aws = new AwsClient({ ...credentials, region: target.region, service: "s3", retries: 0 });
    const signed = await aws.sign(base, { method, headers, ...(data ? { body: data } : {}) });
    const res = await this.#fetch(signed.url, {
      method,
      headers: Object.fromEntries(signed.headers),
      ...(data ? { body: data } : {}),
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(
        `S3 ${method} 失败（HTTP ${res.status}），请检查 Endpoint、权限、区域和网络。`,
      );
    }
    await res.body?.cancel().catch(() => {});
    return res;
  }
  test(beforeCommit = () => {}) {
    return this.#serial(async () => {
      beforeCommit();
      const c = await this.#read();
      if (!c.target || !c.credentials) throw new Error("请先保存 S3 连接。");
      const controller = new AbortController();
      this.#controller = controller;
      const key = this.#namespace(c) + `.probe-${id()}`,
        data = Buffer.from("zhiyu-storage-probe-v1");
      let uploaded = false;
      try {
        await this.#request(c, "PUT", key, data, controller.signal);
        uploaded = true;
        const head = await this.#request(c, "HEAD", key, null, controller.signal);
        if (Number(head.headers.get("content-length")) !== data.length)
          throw new Error("S3 探测文件大小校验失败。");
        await this.#request(c, "DELETE", key, null, controller.signal);
        uploaded = false;
        c.testedAt = this.#now();
        c.testedHash = this.#fingerprint(c);
        c.lastError = null;
        await this.#write(c, beforeCommit);
        return this.#dto(c);
      } catch (error) {
        if (uploaded)
          await this.#request(c, "DELETE", key, null, controller.signal).catch(() => {});
        c.testedAt = null;
        c.testedHash = null;
        c.lastError = this.#message(error);
        await this.#write(c, beforeCommit);
        throw new Error(c.lastError);
      } finally {
        this.#controller = null;
      }
    });
  }
  #message(error) {
    return String(error?.message ?? "").startsWith("S3 ")
      ? error.message
      : "S3 连接失败或超时，请检查网络、权限和存储设置。";
  }
  upload(data, file, keep) {
    return this.#serial(async () => {
      const c = await this.#read();
      if (!c.enabled) return { skipped: true };
      if (!this.#dto(c).bound) throw new Error("S3 连接未完成测试，请重新绑定。");
      if (
        !Buffer.isBuffer(data) ||
        data.subarray(0, 8).toString("ascii") !== "ZHIYUBAK" ||
        !/^[A-Za-z0-9._-]{1,150}\.zhiyu-backup$/.test(file) ||
        !Number.isInteger(keep) ||
        keep < 1 ||
        keep > 30
      )
        throw new Error("只允许上传知屿加密备份。");
      const controller = new AbortController();
      this.#controller = controller;
      const key = this.#namespace(c) + id() + "-" + file,
        hash = digest(data);
      const record = {
        id: id(),
        at: this.#now(),
        file,
        bytes: data.length,
        sha256: hash,
        state: "uploading",
        key,
        targetHash: digest(JSON.stringify(c.target)),
      };
      try {
        await this.#request(c, "PUT", key, data, controller.signal);
        const head = await this.#request(c, "HEAD", key, null, controller.signal);
        if (Number(head.headers.get("content-length")) !== data.length)
          throw new Error("S3 上传后大小校验失败。");
        record.state = "uploaded";
        c.lastError = null;
        c.history = [record, ...(c.history ?? [])];
        const owned = c.history.filter(
          (r) => r.state === "uploaded" && r.targetHash === record.targetHash,
        );
        for (const old of owned.slice(keep)) {
          if (
            old.key?.startsWith(this.#namespace(c)) &&
            /^[a-f0-9]{32}-[A-Za-z0-9._-]+\.zhiyu-backup$/.test(
              old.key.slice(this.#namespace(c).length),
            )
          ) {
            try {
              await this.#request(c, "DELETE", old.key, null, controller.signal);
              old.state = "pruned";
            } catch {
              c.lastError = "S3 新备份已上传，但旧备份清理失败，请检查删除权限。";
            }
          }
        }
        c.history = c.history.slice(0, 60);
        await this.#write(c);
        return { uploaded: true, key, warning: c.lastError };
      } catch (error) {
        record.state = "failed";
        record.error = this.#message(error);
        c.lastError = record.error;
        c.history = [record, ...(c.history ?? [])].slice(0, 60);
        await this.#write(c);
        throw new Error(record.error);
      } finally {
        this.#controller = null;
      }
    });
  }
  stop() {
    this.#stopped = true;
    this.#controller?.abort();
  }
  disconnect(beforeCommit = () => {}) {
    this.#controller?.abort();
    return this.#serial(async () => {
      beforeCommit();
      const c = await this.#read();
      c.enabled = false;
      c.credentials = null;
      c.target = null;
      c.testedAt = null;
      c.testedHash = null;
      c.lastError = null;
      await this.#write(c, beforeCommit);
      return this.#dto(c);
    });
  }
}
