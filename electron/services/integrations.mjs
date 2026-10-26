import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CloudflareClient, normalizeDnsInput } from "./cloudflare.mjs";
import { bindResource, syncBoundZones, unbindResource } from "./integration-assets.mjs";
import {
  probeEndpoint,
  probeRequest,
  probeHost,
  probeSample,
  probeCheck,
  probeCheckInput,
  probeCheckResult,
  remoteId,
} from "./probe-client.mjs";

const methods = [
  "list",
  "save",
  "remove",
  "inventory",
  "bind",
  "importZones",
  "syncZones",
  "unbind",
  "dnsList",
  "dnsPreview",
  "dnsApply",
  "probeHistory",
  "probeCheckHistory",
  "probeEnroll",
  "probeRevoke",
  "probeSaveCheck",
  "probeDeleteCheck",
];
export const INTEGRATION_METHODS = Object.freeze(methods);
const publicConnection = (c) => ({
  id: c.id,
  provider: c.provider,
  name: c.name,
  allowInsecure: c.allowInsecure === true,
  hasToken: Boolean(c.encryptedToken),
  ...(c.endpoint ? { endpoint: c.endpoint } : {}),
});
const text = (v, max, label) => {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    [...v].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error(`${label}无效。`);
  return v.trim();
};

/** 系统加密存储使监控不依赖资产密钥库的解锁状态；Token 永远留在主进程。 */
export class Integrations {
  #file;
  #storage;
  #fetch;
  #factory;
  #mutate;
  #now;
  #queue = Promise.resolve();
  #cache = new Map();
  #flights = new Map();
  #versions = new Map();
  #controllers = new Map();
  #tickets = new Map();
  constructor({
    file,
    secureStorage,
    fetchImpl = fetch,
    cloudflareFactory,
    mutateAssets,
    now = Date.now,
  }) {
    this.#file = file;
    this.#storage = secureStorage;
    this.#fetch = fetchImpl;
    this.#factory = cloudflareFactory ?? ((options) => new CloudflareClient(options));
    this.#mutate = mutateAssets;
    this.#now = now;
  }
  #secure() {
    if (
      !this.#storage.isEncryptionAvailable() ||
      this.#storage.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("操作系统加密存储不可用，不能保存或读取接入凭据。");
  }
  async #read() {
    try {
      const s = await stat(this.#file);
      if (!s.isFile() || s.size > 1024 * 1024) throw new Error("size");
      const data = JSON.parse(await readFile(this.#file, "utf8"));
      if (data.v !== 1 || !Array.isArray(data.connections) || data.connections.length > 30)
        throw new Error("format");
      for (const c of data.connections) {
        text(c.id, 100, "连接标识");
        text(c.name, 160, "连接名称");
        if (
          !["cloudflare", "probe"].includes(c.provider) ||
          typeof c.encryptedToken !== "string" ||
          c.encryptedToken.length > 16000
        )
          throw new Error("format");
        if (c.provider === "probe") probeEndpoint(c.endpoint, c.allowInsecure === true);
      }
      return data.connections;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("云服务与探针配置读取失败，请检查本地文件。");
    }
  }
  async #write(connections) {
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = this.#file + ".tmp";
    await writeFile(tmp, JSON.stringify({ v: 1, connections }), { mode: 0o600 });
    await rename(tmp, this.#file);
  }
  #enqueue(work) {
    const job = this.#queue.then(work);
    this.#queue = job.catch(() => {});
    return job;
  }
  #invalidate(id) {
    this.#versions.set(id, (this.#versions.get(id) ?? 0) + 1);
    this.#controllers.get(id)?.abort();
    this.#controllers.delete(id);
    for (const [key, c] of this.#cache) if (c.id === id) this.#cache.delete(key);
    for (const [key, p] of this.#tickets) if (p.connectionId === id) this.#tickets.delete(key);
  }
  async list() {
    await this.#queue;
    return (await this.#read()).map(publicConnection);
  }
  save(input) {
    return this.#enqueue(async () => {
      this.#secure();
      if (!input || !["cloudflare", "probe"].includes(input.provider))
        throw new Error("接入类型无效。");
      const connections = await this.#read();
      const previous = input.id ? connections.find((c) => c.id === input.id) : null;
      if (input.id && !previous) throw new Error("连接已不存在。");
      if (!previous && connections.length >= 30) throw new Error("最多保存 30 个接入连接。");
      if (previous && previous.provider !== input.provider)
        throw new Error("已有连接不能更换类型，请新建连接。");
      const connection = {
        id: previous?.id ?? randomUUID(),
        provider: input.provider,
        name: text(input.name, 160, "连接名称"),
        allowInsecure: input.provider === "probe" && input.allowInsecure === true,
      };
      if (input.provider === "probe")
        connection.endpoint = probeEndpoint(input.endpoint, connection.allowInsecure);
      if (input.token !== undefined && typeof input.token !== "string")
        throw new Error("Token 格式无效。");
      const entered = input.token?.trim();
      if (!entered && previous?.endpoint !== connection.endpoint)
        throw new Error("地址变更后需重新输入 Token，防止凭据发送到错误服务端。");
      if (entered) {
        if (entered.length < 16 || entered.length > 4096 || /\s/.test(entered))
          throw new Error("Token 需为 16–4096 个无空白字符。");
        connection.encryptedToken = this.#storage.encryptString(entered).toString("base64");
      } else connection.encryptedToken = previous?.encryptedToken;
      if (!connection.encryptedToken) throw new Error("请填写访问 Token。");
      await this.#write(
        previous
          ? connections.map((c) => (c.id === connection.id ? connection : c))
          : [...connections, connection],
      );
      this.#invalidate(connection.id);
      return publicConnection(connection);
    });
  }
  remove(id) {
    return this.#enqueue(async () => {
      const connections = await this.#read();
      if (!connections.some((c) => c.id === id)) throw new Error("连接已不存在。");
      await this.#write(connections.filter((c) => c.id !== id));
      this.#invalidate(id);
    });
  }
  async #access(id, provider) {
    return this.#enqueue(async () => {
      const connection = (await this.#read()).find((c) => c.id === id);
      if (!connection || (provider && connection.provider !== provider))
        throw new Error("连接不存在或类型不匹配。");
      this.#secure();
      let token;
      try {
        token = this.#storage.decryptString(Buffer.from(connection.encryptedToken, "base64"));
      } catch {
        throw new Error("当前系统无法解密连接凭据，请重新配置。");
      }
      if (typeof token !== "string" || token.length < 16 || token.length > 4096 || /\s/.test(token))
        throw new Error("保存的连接凭据无效，请重新配置。");
      let controller = this.#controllers.get(id);
      if (!controller) {
        controller = new AbortController();
        this.#controllers.set(id, controller);
      }
      const version = this.#versions.get(id) ?? 0;
      const assert = () => {
        if (version !== (this.#versions.get(id) ?? 0)) throw new Error("连接已变更，请重新加载。");
      };
      return { connection, token, version, assert, signal: controller.signal };
    });
  }
  #client(access) {
    return this.#factory({ token: access.token, fetchImpl: this.#fetch, signal: access.signal });
  }
  async #cached(access, key, ttl, force, loader) {
    access.assert();
    const cacheKey = JSON.stringify([access.connection.id, access.version, key]);
    const cached = this.#cache.get(cacheKey);
    if (!force && cached && this.#now() - cached.at < ttl)
      return { value: structuredClone(cached.value), cached: true };
    const active = this.#flights.get(cacheKey);
    if (active) return { value: structuredClone(await active), cached: false };
    const task = Promise.resolve()
      .then(loader)
      .then((value) => {
        access.assert();
        if (this.#cache.size >= 256) this.#cache.delete(this.#cache.keys().next().value);
        this.#cache.set(cacheKey, {
          id: access.connection.id,
          value: structuredClone(value),
          at: this.#now(),
        });
        return value;
      })
      .finally(() => this.#flights.delete(cacheKey));
    this.#flights.set(cacheKey, task);
    return { value: structuredClone(await task), cached: false };
  }
  async #probe(access, path, options = {}) {
    access.assert();
    const result = await probeRequest(access.connection, access.token, path, {
      ...options,
      fetchImpl: this.#fetch,
      signal: access.signal,
    });
    access.assert();
    return result;
  }
  async inventory(id, force = false) {
    const access = await this.#access(id);
    const result = await this.#cached(
      access,
      "inventory",
      access.connection.provider === "probe" ? 3000 : 60000,
      force === true,
      async () => {
        if (access.connection.provider === "cloudflare") return this.#client(access).inventory();
        const [hosts, checks] = await Promise.all([
          this.#probe(access, "/hosts"),
          this.#probe(access, "/checks"),
        ]);
        if (
          !Array.isArray(hosts) ||
          !Array.isArray(checks) ||
          hosts.length > 5000 ||
          checks.length > 5000
        )
          throw new Error("探针返回的资源列表无效或过大。");
        const resources = [
          ...hosts.map(probeHost).map((host) => ({
            key: "host:" + host.id,
            type: "host",
            remoteId: host.id,
            name: host.name,
            url: "",
            status: host.status,
            host,
          })),
          ...checks.map(probeCheck).map((check) => ({
            key: "check:" + check.id,
            type: "check",
            remoteId: check.id,
            name: check.name,
            url: check.type === "http" ? check.target : "",
            status: check.status,
            check,
          })),
        ];
        return {
          resources,
          warnings: [],
          fetchedAt: new Date(this.#now()).toISOString(),
          cached: false,
        };
      },
    );
    access.assert();
    return { ...result.value, cached: result.cached };
  }
  async bind(input) {
    const access = await this.#access(input?.connectionId);
    const inventory = await this.inventory(access.connection.id);
    const resource = inventory.resources.find((r) => r.key === input.resourceKey);
    if (!resource) throw new Error("远端资源已不存在，请刷新后重试。");
    // 和配置写入共用串行队列，资产队列内再读最新快照，防止并发编辑丢失。
    return this.#enqueue(async () => {
      access.assert();
      let asset;
      await this.#mutate((snapshot) => {
        access.assert();
        const result = bindResource(snapshot, access.connection, resource, input.assetId);
        asset = result.asset;
        return result.snapshot;
      });
      return asset;
    });
  }
  /** 批量导入（或更新）所选域名；每个 Cloudflare 域名对应一个本机域名资产。 */
  async importZones(input) {
    const access = await this.#access(input?.connectionId, "cloudflare");
    const keys = input.resourceKeys;
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.length > 1000 ||
      keys.some((key) => typeof key !== "string")
    )
      throw new Error("请选择要导入的域名。");
    const inventory = await this.inventory(access.connection.id, true);
    const wanted = new Set(keys);
    const zones = inventory.resources.filter((r) => r.type === "zone" && wanted.has(r.key));
    if (!zones.length) throw new Error("所选域名已不存在，请刷新后重试。");
    return this.#enqueue(async () => {
      access.assert();
      let created = 0;
      let updated = 0;
      const assets = [];
      await this.#mutate((snapshot) => {
        access.assert();
        let next = snapshot;
        for (const zone of zones) {
          const before = (next.domains ?? []).length;
          const result = bindResource(next, access.connection, zone);
          if (result.snapshot.domains.length > before) created += 1;
          else updated += 1;
          assets.push(result.asset);
          next = result.snapshot;
        }
        return next;
      });
      return { created, updated, assets };
    });
  }
  /** 把已导入的域名与 Cloudflare 的最新 NS、到期日对齐；不会新增资产。 */
  async syncZones(connectionId) {
    const access = await this.#access(connectionId, "cloudflare");
    const inventory = await this.inventory(access.connection.id, true);
    return this.#enqueue(async () => {
      access.assert();
      let updated = 0;
      await this.#mutate((snapshot) => {
        access.assert();
        const result = syncBoundZones(snapshot, access.connection, inventory.resources);
        updated = result.updated;
        return result.snapshot;
      });
      return { updated };
    });
  }
  unbind(input) {
    return this.#enqueue(() =>
      this.#mutate((snapshot) => unbindResource(snapshot, input)).then(() => undefined),
    );
  }
  async dnsList(id, zoneId, force = false) {
    remoteId(zoneId);
    const access = await this.#access(id, "cloudflare");
    const result = await this.#cached(access, "dns:" + zoneId, 60000, force === true, () =>
      this.#client(access).dnsList(zoneId),
    );
    access.assert();
    return result.value;
  }
  async dnsPreview(input) {
    if (!input || !["create", "update", "delete"].includes(input.action))
      throw new Error("DNS 操作无效。");
    remoteId(input.zoneId);
    const access = await this.#access(input.connectionId, "cloudflare");
    const after = input.action === "delete" ? null : normalizeDnsInput(input.record);
    if (input.action !== "create") remoteId(input.recordId);
    const before =
      input.action === "create"
        ? null
        : await this.#client(access).dnsGet(input.zoneId, input.recordId);
    access.assert();
    const ticket = randomUUID(),
      expires = this.#now() + 120000;
    for (const [key, p] of this.#tickets) if (p.expires < this.#now()) this.#tickets.delete(key);
    if (this.#tickets.size >= 100) throw new Error("待确认的 DNS 修改过多，请稍后再试。");
    this.#tickets.set(ticket, {
      connectionId: input.connectionId,
      version: access.version,
      zoneId: input.zoneId,
      action: input.action,
      recordId: input.recordId,
      before,
      after,
      expires,
    });
    return {
      ticket,
      action: input.action,
      zoneId: input.zoneId,
      before,
      after,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  async dnsApply(ticket) {
    const proposal = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!proposal || proposal.expires < this.#now())
      throw new Error("修改预览已过期或失效，请重新预览。");
    const access = await this.#access(proposal.connectionId, "cloudflare");
    if (access.version !== proposal.version) throw new Error("连接已变更，请重新预览。");
    const client = this.#client(access);
    if (proposal.before) {
      const current = await client.dnsGet(proposal.zoneId, proposal.recordId);
      if (!isDeepStrictEqual(current, proposal.before))
        throw new Error("DNS 记录已被其他操作变更，请刷新并重新预览。");
    }
    access.assert();
    await client.dnsWrite(proposal.zoneId, {
      action: proposal.action,
      recordId: proposal.recordId,
      record: proposal.after,
    });
    access.assert();
    this.#invalidate(proposal.connectionId);
  }
  async probeHistory(id, hostId, range) {
    if (!["1h", "24h", "7d"].includes(range)) throw new Error("历史时间范围无效。");
    const path = "/hosts/" + remoteId(hostId) + "/history?range=" + range;
    const access = await this.#access(id, "probe");
    const result = await this.#cached(access, path, 5000, false, async () => {
      const values = await this.#probe(access, path);
      if (!Array.isArray(values) || values.length > 10000)
        throw new Error("历史指标响应无效或过大。");
      return values.map(probeSample);
    });
    access.assert();
    return result.value;
  }
  async probeEnroll(id, name) {
    const access = await this.#access(id, "probe");
    const result = await this.#probe(access, "/hosts", {
      method: "POST",
      body: { name: text(name, 160, "主机名称") },
    });
    remoteId(result?.id);
    if (
      typeof result.secret !== "string" ||
      result.secret.length < 24 ||
      result.secret.length > 256 ||
      /\s/.test(result.secret)
    )
      throw new Error("服务端未返回有效的主机凭据。");
    this.#invalidate(id);
    return { id: result.id, secret: result.secret };
  }
  async probeCheckHistory(id, checkId, range) {
    if (!["1h", "24h", "7d"].includes(range)) throw new Error("历史时间范围无效。");
    const path = "/checks/" + remoteId(checkId) + "/history?range=" + range;
    const access = await this.#access(id, "probe");
    const result = await this.#cached(access, path, 5000, false, async () => {
      const values = await this.#probe(access, path);
      if (!Array.isArray(values) || values.length > 10000)
        throw new Error("服务检查历史响应无效或过大。");
      return values.map(probeCheckResult);
    });
    access.assert();
    return result.value;
  }
  async probeRevoke(id, hostId) {
    const access = await this.#access(id, "probe");
    await this.#probe(access, "/hosts/" + remoteId(hostId), { method: "DELETE" });
    this.#invalidate(id);
  }
  async probeSaveCheck(id, input) {
    const body = probeCheckInput(input),
      access = await this.#access(id, "probe");
    await this.#probe(access, "/checks", { method: "POST", body });
    this.#invalidate(id);
  }
  async probeDeleteCheck(id, checkId) {
    const access = await this.#access(id, "probe");
    await this.#probe(access, "/checks/" + remoteId(checkId), { method: "DELETE" });
    this.#invalidate(id);
  }
  stop() {
    for (const id of this.#controllers.keys()) this.#invalidate(id);
    this.#cache.clear();
    this.#tickets.clear();
  }
}
