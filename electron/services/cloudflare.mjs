import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const API = "https://api.cloudflare.com/client/v4";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_ROWS = 10_000;
const MAX_ACCOUNTS = 100;
const MAX_RETRY_DELAY = 10_000;
const WRITABLE_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "MX", "NS"]);
const PROXY_TYPES = new Set(["A", "AAAA", "CNAME"]);
const DATA_FIELDS = new Set([
  "priority",
  "weight",
  "port",
  "target",
  "service",
  "proto",
  "name",
  "flags",
  "tag",
  "value",
  "algorithm",
  "certificate",
  "digest",
  "digest_type",
  "key_tag",
  "protocol",
  "public_key",
  "type",
  "usage",
  "selector",
  "matching_type",
  "fingerprint",
  "order",
  "preference",
  "regexp",
  "replacement",
]);

class CloudflareError extends Error {
  constructor(message, code = "request") {
    super(message);
    this.name = "CloudflareError";
    this.code = code;
  }
}

function invalid(message = "Cloudflare 返回的数据格式不正确") {
  return new CloudflareError(message, "invalid");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, max = 512) {
  return typeof value === "string"
    ? [...value]
        .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
        .join("")
        .slice(0, max)
    : "";
}

function hasControls(value, allowTextBreaks = false) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (code < 32 && !(allowTextBreaks && (code === 9 || code === 10))) || code === 127;
  });
}

function identifier(value, label = "资源") {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/i.test(value))
    throw invalid(`${label}标识格式不正确`);
  return value;
}

function hostname(value, { wildcard = false, underscore = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    /[\s/:@?#\\]/.test(value) ||
    hasControls(value)
  )
    throw invalid("DNS 域名格式不正确，请填写完整域名");
  let host = value.toLowerCase().replace(/\.$/, "");
  const star = wildcard && host.startsWith("*.");
  if (star) host = host.slice(2);
  host = domainToASCII(host);
  const label = underscore
    ? /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/
    : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (
    !host ||
    host.length + (star ? 2 : 0) > 253 ||
    !host.includes(".") ||
    isIP(host) ||
    !host.split(".").every((part) => label.test(part))
  )
    throw invalid("DNS 域名格式不正确，请填写完整域名");
  return `${star ? "*." : ""}${host}`;
}

/** 只接受编辑器实际支持的记录，不把未知字段发送给服务商。 */
export function normalizeDnsInput(input) {
  if (!object(input)) throw invalid("请填写 DNS 记录");
  if (!WRITABLE_TYPES.has(input.type))
    throw invalid("暂不支持编辑此 DNS 类型，请在 Cloudflare 控制台编辑");
  if (input.data !== undefined)
    throw invalid("暂不支持编辑高级 DNS 数据，请在 Cloudflare 控制台编辑");
  const type = input.type;
  const name = hostname(typeof input.name === "string" ? input.name.trim() : input.name, {
    wildcard: true,
    underscore: true,
  });
  if (
    typeof input.content !== "string" ||
    input.content.length === 0 ||
    Buffer.byteLength(input.content) > 2048 ||
    hasControls(input.content, true)
  )
    throw invalid("DNS 记录内容格式不正确或过长");
  let content = type === "TXT" ? input.content : input.content.trim();
  if (type === "A" && isIP(content) !== 4) throw invalid("A 记录需要有效的 IPv4 地址");
  if (type === "AAAA" && (isIP(content) !== 6 || content.includes("%")))
    throw invalid("AAAA 记录需要有效的 IPv6 地址");
  if (["CNAME", "MX", "NS"].includes(type))
    content = hostname(content, { underscore: type === "CNAME" });
  if (!Number.isInteger(input.ttl) || (input.ttl !== 1 && (input.ttl < 60 || input.ttl > 86400)))
    throw invalid("TTL 请选择自动（1）或 60–86400 秒");
  if (input.proxied !== undefined && typeof input.proxied !== "boolean")
    throw invalid("DNS 代理状态必须为布尔值");
  if (input.proxied && !PROXY_TYPES.has(type)) throw invalid("只有 A、AAAA、CNAME 记录支持代理");
  if (input.proxied && input.ttl !== 1) throw invalid("开启 Cloudflare 代理的记录需要使用自动 TTL");
  const out = { type, name, content, ttl: input.ttl };
  if (PROXY_TYPES.has(type) && input.proxied !== undefined) out.proxied = input.proxied;
  if (type === "MX") {
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 65535)
      throw invalid("MX 优先级须为 0–65535 的整数");
    out.priority = input.priority;
  } else if (input.priority !== undefined) throw invalid("只有 MX 记录使用此优先级字段");
  if (input.comment !== undefined) {
    if (
      typeof input.comment !== "string" ||
      input.comment.length > 500 ||
      hasControls(input.comment)
    )
      throw invalid("DNS 备注过长或包含非法字符");
    out.comment = input.comment;
  }
  return out;
}

function dnsRecord(value) {
  if (
    !object(value) ||
    typeof value.type !== "string" ||
    !/^[A-Z][A-Z0-9]{0,15}$/.test(value.type) ||
    typeof value.name !== "string" ||
    typeof value.content !== "string" ||
    value.content.length > 16_384 ||
    !Number.isInteger(value.ttl) ||
    value.ttl < 1 ||
    value.ttl > 86400
  )
    throw invalid("Cloudflare 返回的 DNS 字段格式不正确");
  const out = {
    id: identifier(value.id, "DNS 记录"),
    type: value.type,
    name: hostname(value.name, { wildcard: true, underscore: true }),
    content: text(value.content, 16_384),
    ttl: value.ttl,
  };
  if (typeof value.proxied === "boolean") out.proxied = value.proxied;
  if (Number.isInteger(value.priority) && value.priority >= 0 && value.priority <= 65535)
    out.priority = value.priority;
  if (typeof value.comment === "string") out.comment = text(value.comment, 500);
  if (typeof value.modified_on === "string" && Number.isFinite(Date.parse(value.modified_on)))
    out.modifiedOn = new Date(value.modified_on).toISOString();
  if (object(value.data)) {
    out.data = {};
    for (const [key, val] of Object.entries(value.data))
      if (
        DATA_FIELDS.has(key) &&
        (typeof val === "string" || (typeof val === "number" && Number.isFinite(val)))
      )
        out.data[key] = typeof val === "string" ? text(val, 4096) : val;
  }
  return out;
}

function resource(type, value, accountId) {
  if (!object(value)) throw invalid();
  let remoteId = text(value.id, 200);
  if (!remoteId || /[\s/\\?#]/.test(remoteId)) throw invalid();
  let name = text(value.name || value.id);
  let status = "unknown";
  let url = "";
  if (type === "zone") {
    remoteId = identifier(value.id);
    name = hostname(value.name);
    url = `https://${name}/`;
    status = ["initializing", "pending", "active", "moved", "deactivated"].includes(value.status)
      ? value.status
      : "unknown";
  } else if (type === "pages" && typeof value.subdomain === "string") {
    const host = hostname(value.subdomain);
    if (host.endsWith(".pages.dev")) url = `https://${host}/`;
  } else if (type === "tunnel")
    status = ["inactive", "degraded", "healthy", "down"].includes(value.status)
      ? value.status
      : "unknown";
  return {
    key: `${type}:${accountId || ""}:${remoteId}`,
    type,
    remoteId,
    ...(accountId ? { accountId } : {}),
    name,
    url,
    status,
  };
}

/** 无凭据持久化；所有请求锁定官方 API，错误只包含本机生成的信息。 */
export class CloudflareClient {
  #token;
  #fetch;
  #signal;
  #timeout;

  constructor({ token, fetchImpl = fetch, signal, timeoutMs = 15_000 } = {}) {
    if (
      typeof token !== "string" ||
      !token.trim() ||
      token.length > 4096 ||
      /\s/.test(token) ||
      hasControls(token)
    )
      throw invalid("Cloudflare API Token 格式不正确");
    if (
      typeof fetchImpl !== "function" ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    )
      throw invalid("Cloudflare 客户端配置不正确");
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#signal = signal;
    this.#timeout = timeoutMs;
  }

  #cancelled() {
    if (this.#signal?.aborted) throw new CloudflareError("Cloudflare 请求已取消", "cancelled");
  }

  #redact(value) {
    if (typeof value === "string") return value.split(this.#token).join("[已隐藏]");
    if (Array.isArray(value)) return value.map((item) => this.#redact(item));
    if (object(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.#redact(item)]),
      );
    return value;
  }

  async #request(path, { method = "GET", body } = {}) {
    this.#cancelled();
    const controller = new AbortController();
    let timer;
    let onCancel;
    const interrupted = new Promise((_, reject) => {
      const stop = (error) => {
        controller.abort();
        reject(error);
      };
      timer = setTimeout(
        () => stop(new CloudflareError("Cloudflare 请求超时，请稍后重试", "timeout")),
        this.#timeout,
      );
      onCancel = () => stop(new CloudflareError("Cloudflare 请求已取消", "cancelled"));
      this.#signal?.addEventListener("abort", onCancel, { once: true });
    });
    const operation = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (controller.signal.aborted)
          throw new CloudflareError("Cloudflare 请求已取消", "cancelled");
        const response = await this.#fetch(`${API}${path}`, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new CloudflareError("Cloudflare 返回了重定向，已阻止携带凭据跳转", "redirect");
        }
        if (response.status === 429) {
          const raw = response.headers.get("retry-after");
          const seconds = raw === null || raw.trim() === "" ? NaN : Number(raw);
          const retryMs =
            Number.isFinite(seconds) && seconds >= 0
              ? seconds * 1000
              : raw && Number.isFinite(Date.parse(raw))
                ? Math.max(0, Date.parse(raw) - Date.now())
                : 500 * 2 ** attempt;
          await response.body?.cancel();
          if (attempt === 2 || retryMs > MAX_RETRY_DELAY)
            throw new CloudflareError("Cloudflare 请求过于频繁，请稍后重试", "rate-limit");
          await delay(retryMs, undefined, { signal: controller.signal });
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401)
            throw new CloudflareError("Cloudflare 认证失败，请检查 API Token", "auth");
          if (response.status === 403)
            throw new CloudflareError(
              "Cloudflare 权限不足，请检查 API Token 的资源范围与权限",
              "permission",
            );
          if (response.status === 404)
            throw new CloudflareError("Cloudflare 资源不存在或当前 Token 无权访问", "not-found");
          throw new CloudflareError(`Cloudflare 请求失败（HTTP ${response.status}）`);
        }
        if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
          await response.body?.cancel();
          throw invalid("Cloudflare 返回的数据过大，请缩小资源范围");
        }
        const reader = response.body?.getReader();
        if (!reader) throw invalid();
        const chunks = [];
        let size = 0;
        const abortReader = () => {
          void reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener("abort", abortReader, { once: true });
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
              await reader.cancel();
              throw invalid("Cloudflare 返回的数据过大，请缩小资源范围");
            }
            chunks.push(value);
          }
        } finally {
          controller.signal.removeEventListener("abort", abortReader);
          reader.releaseLock();
        }
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw invalid();
        }
        if (!object(data)) throw invalid();
        if (data.success === false) {
          const codes = Array.isArray(data.errors) ? data.errors.map((error) => error?.code) : [];
          if (codes.some((code) => [10000, 9103, 9106, 9109, 1001].includes(code)))
            throw new CloudflareError("Cloudflare 认证或授权失败，请检查 API Token", "auth");
          throw new CloudflareError("Cloudflare 拒绝了此次请求，请检查权限和记录内容");
        }
        if (data.success !== true || !("result" in data)) throw invalid();
        return data;
      }
      throw new CloudflareError("Cloudflare 请求过于频繁，请稍后重试", "rate-limit");
    };
    try {
      return await Promise.race([operation(), interrupted]);
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      throw new CloudflareError("无法连接 Cloudflare，请检查网络后重试", "network");
    } finally {
      clearTimeout(timer);
      this.#signal?.removeEventListener("abort", onCancel);
    }
  }

  async #list(path, { single = false } = {}) {
    const rows = [];
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await this.#request(
        single ? path : `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`,
      );
      if (!Array.isArray(data.result)) throw invalid();
      for (const row of data.result) {
        if (!object(row) || typeof row.id !== "string" || !row.id) throw invalid();
        if (seen.has(row.id)) throw invalid("Cloudflare 分页包含重复资源，请刷新后重试");
        seen.add(row.id);
        rows.push(row);
      }
      if (rows.length > MAX_ROWS)
        throw invalid("Cloudflare 资源超过读取上限，请缩小 Token 的资源范围");
      if (single) return rows;
      const info = data.result_info;
      if (info !== undefined && !object(info)) throw invalid();
      if (info?.page !== undefined && info.page !== page)
        throw invalid("Cloudflare 返回了异常分页，请刷新后重试");
      if (info?.total_pages !== undefined) {
        if (!Number.isInteger(info.total_pages) || info.total_pages < 0) throw invalid();
        if (info.total_pages > MAX_PAGES)
          throw invalid("Cloudflare 分页超过读取上限，请缩小 Token 的资源范围");
        if (page >= info.total_pages) return rows;
        if (data.result.length === 0) throw invalid("Cloudflare 分页提前结束，请刷新后重试");
      } else if (info?.total_count !== undefined) {
        if (!Number.isInteger(info.total_count) || info.total_count < 0) throw invalid();
        if (info.total_count > MAX_ROWS)
          throw invalid("Cloudflare 资源超过读取上限，请缩小 Token 的资源范围");
        if (rows.length >= info.total_count) return rows;
        if (data.result.length === 0) throw invalid("Cloudflare 分页提前结束，请刷新后重试");
      } else if (
        data.result.length <
        (Number.isInteger(info?.per_page) && info.per_page > 0 ? info.per_page : 50)
      )
        return rows;
    }
    throw invalid("Cloudflare 分页超过读取上限，请缩小 Token 的资源范围");
  }

  async inventory() {
    this.#cancelled();
    const resources = [];
    const warnings = [];
    const accountIds = new Set();
    let successfulLists = 0;
    const capture = async (label, task) => {
      try {
        const data = await task();
        successfulLists += 1;
        return data;
      } catch (error) {
        if (error.code === "cancelled" || this.#signal?.aborted) {
          this.#cancelled();
          throw error;
        }
        warnings.push(
          `${label}：${error instanceof CloudflareError ? error.message : "返回的数据格式不正确"}`,
        );
        return null;
      }
    };
    const [accounts, zones] = await Promise.all([
      capture("账户列表", async () =>
        (await this.#list("/accounts")).map((row) => identifier(row.id, "账户")),
      ),
      capture("域名列表", async () =>
        (await this.#list("/zones")).map((row) =>
          resource("zone", row, row.account?.id ? identifier(row.account.id, "账户") : undefined),
        ),
      ),
    ]);
    for (const id of accounts || []) accountIds.add(id);
    for (const zone of zones || []) {
      resources.push(zone);
      if (zone.accountId) accountIds.add(zone.accountId);
    }
    if (accountIds.size > MAX_ACCOUNTS)
      throw invalid("Cloudflare 账户超过读取上限，请缩小 Token 的资源范围");
    for (const accountId of accountIds) {
      const results = await Promise.all([
        capture("Workers 列表", async () =>
          (await this.#list(`/accounts/${accountId}/workers/scripts`, { single: true })).map(
            (row) => resource("worker", row, accountId),
          ),
        ),
        capture("Pages 列表", async () =>
          (await this.#list(`/accounts/${accountId}/pages/projects`)).map((row) =>
            resource("pages", row, accountId),
          ),
        ),
        capture("Tunnel 列表", async () =>
          (await this.#list(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`)).map((row) =>
            resource("tunnel", row, accountId),
          ),
        ),
      ]);
      for (const list of results) if (list) resources.push(...list);
      if (resources.length > MAX_ROWS)
        throw invalid("Cloudflare 资源超过读取上限，请缩小 Token 的资源范围");
    }
    this.#cancelled();
    if (!successfulLists)
      throw new CloudflareError(warnings.join("；") || "无法读取 Cloudflare 资源");
    return this.#redact({
      resources,
      warnings,
      fetchedAt: new Date().toISOString(),
      cached: false,
    });
  }

  async dnsList(zoneId) {
    return this.#redact(
      (await this.#list(`/zones/${identifier(zoneId, "域名")}/dns_records`)).map(dnsRecord),
    );
  }

  async dnsGet(zoneId, recordId) {
    const data = await this.#request(
      `/zones/${identifier(zoneId, "域名")}/dns_records/${identifier(recordId, "DNS 记录")}`,
    );
    const record = dnsRecord(data.result);
    if (record.id !== recordId) throw invalid("Cloudflare 返回了不匹配的 DNS 记录");
    return this.#redact(record);
  }

  async dnsWrite(zoneId, input) {
    const base = `/zones/${identifier(zoneId, "域名")}/dns_records`;
    if (!object(input) || !["create", "update", "delete"].includes(input.action))
      throw invalid("DNS 操作不正确");
    const id = input.action === "create" ? undefined : identifier(input.recordId, "DNS 记录");
    const body = input.action === "delete" ? undefined : normalizeDnsInput(input.record);
    const data = await this.#request(id ? `${base}/${id}` : base, {
      method: { create: "POST", update: "PATCH", delete: "DELETE" }[input.action],
      body,
    });
    if (input.action === "delete") {
      if (data.result?.id !== id)
        throw invalid("Cloudflare 未确认删除指定 DNS 记录，请刷新列表核对");
      return;
    }
    const record = dnsRecord(data.result);
    if (id && record.id !== id) throw invalid("Cloudflare 返回了不匹配的 DNS 记录，请刷新列表核对");
    return this.#redact(record);
  }
}
