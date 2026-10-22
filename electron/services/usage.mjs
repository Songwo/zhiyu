import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_SUBSCRIPTION_BYTES, parseSubscriptionNodes } from "./subscription-parser.mjs";

const TYPES = new Set(["3x-ui", "subscription", "openai-api", "anthropic-api"]);
const numeric = (x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
export function subscriptionUsage(header) {
  if (!header) throw new Error("机场未提供 subscription-userinfo 用量头，无法采集真实流量");
  const fields = Object.fromEntries(header.split(";").map((x) => x.trim().split("=")));
  const read = (k) =>
    fields[k] !== undefined && fields[k].trim() !== "" ? numeric(Number(fields[k])) : null;
  const upload = read("upload"),
    download = read("download");
  if (upload === null || download === null) throw new Error("机场用量头缺少有效的上传或下载字节数");
  const expire = read("expire");
  return [
    {
      key: "traffic",
      label: "机场订阅",
      kind: "traffic",
      upload,
      download,
      total: read("total"),
      expiresAt: expire && expire < 8640000000000 ? new Date(expire * 1000).toISOString() : null,
    },
  ];
}
export function panelUsage(inbounds, filter = {}) {
  if (!Array.isArray(inbounds)) throw new Error("3x-ui 返回的入站列表无效");
  const rows = [];
  for (const inbound of inbounds) {
    if (filter.inboundId && String(inbound.id) !== String(filter.inboundId)) continue;
    const clients = filter.clientEmail
      ? (inbound.clientStats ?? []).filter((c) => c.email === filter.clientEmail)
      : null;
    for (const item of clients ?? [inbound]) {
      const upload = numeric(item.up),
        download = numeric(item.down);
      if (upload === null || download === null) continue;
      const expiry = numeric(item.expiryTime);
      rows.push({
        key: `inbound:${inbound.id}:${clients ? item.email : "all"}`,
        label: clients ? item.email : inbound.remark || `入站 ${inbound.id}`,
        kind: "traffic",
        upload,
        download,
        total: numeric(item.total),
        expiresAt: expiry && expiry < 8640000000000000 ? new Date(expiry).toISOString() : null,
      });
    }
  }
  if (!rows.length) throw new Error("未找到匹配的入站或客户端流量，请检查入站 ID 和客户端 Email");
  return rows;
}
function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入有效的服务地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("服务地址只支持 HTTP / HTTPS，账号密码请单独填写");
  return url;
}
function normalizedSubscriptionUrl(value) {
  const url = endpoint(value);
  url.hash = "";
  return url.href;
}
async function request(fetchImpl, url, options = {}, json = true, context = "AI API 用量") {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(`${context}连接失败或超时，请检查服务地址、证书和网络`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    let hint = "";
    if ([401, 403].includes(response.status)) {
      if (context === "3x-ui 登录")
        hint =
          "：登录请求被拒绝。请核对面板根地址（含自定义路径，不含 /panel/ 页面后缀），以及反向代理、WAF 和 IP 访问限制；若启用了两步验证，当前自动采集尚不支持验证码登录";
      else if (context === "3x-ui 读取入站流量")
        hint =
          "：登录后的会话未被接口接受，或请求被代理拦截。请核对面板版本的 API 鉴权方式和反向代理规则";
      else if (context.startsWith("3x-ui"))
        hint = "：面板页面请求被拒绝，请检查访问地址和反向代理规则";
      else if (context === "机场订阅")
        hint = "：订阅地址失效、无权限或被机场访问规则拦截，请核对订阅地址";
      else hint = "：凭据无效或无用量查询权限；AI API 用量通常需要组织 Admin Key";
    }
    if (response.headers.get("cf-mitigated") === "challenge")
      hint += "；响应标记为 Cloudflare challenge，当前请求遇到了浏览器验证";
    throw new Error(context + " HTTP " + response.status + hint);
  }
  let body = "",
    size = 0;
  const subscription = json === "subscription";
  const limit = subscription ? MAX_SUBSCRIPTION_BYTES : 8 * 1024 * 1024;
  const sizeMessage = subscription ? "订阅响应超过 2 MiB，未保存不完整数据" : "用量响应超过 8 MiB";
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error(sizeMessage);
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } catch (error) {
      if (subscription && error.message !== sizeMessage)
        throw new Error("机场订阅读取失败或超时，请检查网络后重试");
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  if (json === "text" || subscription) return { data: body, response };
  try {
    return { data: JSON.parse(body), response };
  } catch {
    throw new Error("用量接口未返回有效 JSON");
  }
}
async function collectSubscription(config, fetchImpl) {
  const { data, response } = await request(
    fetchImpl,
    endpoint(config.url),
    {},
    "subscription",
    "机场订阅",
  );
  let rows = [],
    trafficMessage;
  try {
    rows = subscriptionUsage(response.headers.get("subscription-userinfo"));
  } catch {
    trafficMessage = "机场未提供有效的 subscription-userinfo 用量头，当前流量未知";
  }
  let parsed;
  try {
    parsed = parseSubscriptionNodes(data);
  } catch {
    parsed = {
      format: "unknown",
      nodes: [],
      truncated: false,
      nodesMessage: "订阅节点格式无法识别",
    };
  }
  if (!rows.length && !parsed.nodes.length)
    throw new Error("机场未提供有效用量，订阅正文中也未识别到可用节点");
  return {
    rows,
    subscription: {
      fetchedAt: new Date().toISOString(),
      format: parsed.format,
      trafficAvailable: rows.length > 0,
      ...(trafficMessage ? { trafficMessage } : {}),
      ...(parsed.nodesMessage || !parsed.nodes.length
        ? { nodesMessage: parsed.nodesMessage || "订阅正文中未识别到可用节点" }
        : {}),
      nodeCount: parsed.nodes.length,
      truncated: parsed.truncated,
      nodes: parsed.nodes,
    },
  };
}
export async function collectUsage(config, fetchImpl = fetch, now = Date.now()) {
  if (config.type === "subscription") return (await collectSubscription(config, fetchImpl)).rows;
  if (config.type === "3x-ui") {
    const base = endpoint(config.url);
    base.pathname = base.pathname.replace(/\/?$/, "/");
    base.search = "";
    base.hash = "";
    const cookies = new Map();
    const remember = (response) => {
      const headers = response.headers.getSetCookie?.() ?? [
        response.headers.get("set-cookie") ?? "",
      ];
      for (const header of headers) {
        const pair = header.split(";")[0];
        const split = pair.indexOf("=");
        if (split > 0) cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
    };
    const cookieHeader = () => [...cookies].map(([key, value]) => key + "=" + value).join("; ");
    const page = await request(
      fetchImpl,
      base,
      { headers: { "X-Requested-With": "XMLHttpRequest" } },
      "text",
      "3x-ui 初始化登录",
    );
    remember(page.response);
    const meta =
      String(page.data).match(/<meta\b[^>]*\bname\s*=\s*["']csrf-token["'][^>]*>/i)?.[0] ?? "";
    const csrf = meta.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    const loginHeaders = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Origin: base.origin,
      Referer: base.href,
    };
    if (cookieHeader()) loginHeaders.Cookie = cookieHeader();
    if (csrf) loginHeaders["X-CSRF-Token"] = csrf;
    const login = await request(
      fetchImpl,
      new URL("login", base),
      {
        method: "POST",
        headers: loginHeaders,
        body: new URLSearchParams({ username: config.username, password: config.password }),
      },
      true,
      "3x-ui 登录",
    );
    if (login.data.success !== true)
      throw new Error("3x-ui 登录失败，请检查账号密码或面板二步验证设置");
    remember(login.response);
    if (!cookieHeader()) throw new Error("3x-ui 未返回会话 Cookie");
    const result = await request(
      fetchImpl,
      new URL("panel/api/inbounds/list", base),
      {
        headers: {
          Cookie: cookieHeader(),
          "X-Requested-With": "XMLHttpRequest",
          Referer: base.href,
        },
      },
      true,
      "3x-ui 读取入站流量",
    );
    if (result.data.success !== true) throw new Error("3x-ui 入站用量读取失败");
    return panelUsage(result.data.obj, config);
  }
  const openai = config.type === "openai-api";
  if (!openai && config.type !== "anthropic-api") throw new Error("不支持的用量来源");
  const start = Math.floor((now - 30 * 86400000) / 86400000) * 86400;
  const url = new URL(
    openai
      ? "https://api.openai.com/v1/organization/usage/completions"
      : "https://api.anthropic.com/v1/organizations/usage_report/messages",
  );
  url.searchParams.set(
    openai ? "start_time" : "starting_at",
    openai ? String(start) : new Date(start * 1000).toISOString(),
  );
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "31");
  const headers = openai
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" };
  const rows = [],
    pages = new Set();
  for (let i = 0; i < 40; i++) {
    const { data } = await request(fetchImpl, url, { headers });
    if (!Array.isArray(data.data)) throw new Error("API 用量响应缺少时间桶");
    for (const bucket of data.data) {
      const bucketStart = openai
        ? new Date(bucket.start_time * 1000).toISOString()
        : new Date(bucket.starting_at).toISOString();
      let input = 0,
        output = 0,
        cached = 0,
        cacheWrite = 0;
      for (const row of bucket.results ?? []) {
        const a = numeric(openai ? row.input_tokens : row.uncached_input_tokens),
          b = numeric(row.output_tokens);
        if (a === null || b === null)
          throw new Error("API 未返回完整的输入 / 输出 Token，未写入不完整统计");
        const c = numeric(openai ? row.input_cached_tokens : row.cache_read_input_tokens) ?? 0;
        const w = openai
          ? 0
          : (numeric(row.cache_creation?.ephemeral_5m_input_tokens) ?? 0) +
            (numeric(row.cache_creation?.ephemeral_1h_input_tokens) ?? 0);
        input += a + (openai ? 0 : c + w);
        output += b;
        cached += c;
        cacheWrite += w;
      }
      rows.push({
        key: bucketStart,
        label: "组织 API · 全部 Key / 模型",
        kind: "tokens",
        bucketStart,
        input,
        output,
        cached,
        cacheWrite,
      });
    }
    if (!data.has_more) return rows;
    if (!data.next_page || pages.has(data.next_page))
      throw new Error("API 分页异常，未保存不完整统计");
    pages.add(data.next_page);
    url.searchParams.set("page", data.next_page);
  }
  throw new Error("API 用量分页超过上限");
}

export const AUTOMATIC_USAGE_TTL_MS = 300_000;

export function usageNeedsRefresh(source, now = Date.now()) {
  const attempts = [source?.checkedAt, source?.attemptedAt]
    .map((value) => Date.parse(value ?? ""))
    .filter((value) => Number.isFinite(value) && value <= now);
  return !attempts.length || now - Math.max(...attempts) >= AUTOMATIC_USAGE_TTL_MS;
}

function fileVersion(info) {
  return `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
}

function sourceConfig(input, previous = {}) {
  const type = input.type ?? previous.type;
  if (!TYPES.has(type)) throw new Error("用量来源类型无效");
  const config = { type };
  if (["3x-ui", "subscription"].includes(type)) {
    const value =
      typeof input.url === "string" && input.url.trim() ? input.url.trim() : previous.url;
    config.url = type === "subscription" ? normalizedSubscriptionUrl(value) : endpoint(value).href;
  }
  if (type === "3x-ui") {
    const username = input.username ? String(input.username) : previous.username;
    const password = input.password ? String(input.password) : previous.password;
    if (!username || !password) throw new Error("请填写面板用户名和密码");
    Object.assign(config, {
      username,
      password,
      inboundId: String(input.inboundId ?? previous.inboundId ?? ""),
      clientEmail: String(input.clientEmail ?? previous.clientEmail ?? ""),
    });
  }
  if (type.endsWith("-api")) {
    config.apiKey = String(input.apiKey ?? "").trim() || previous.apiKey;
    if (!config.apiKey) throw new Error("请填写组织 Admin Key");
  }
  return config;
}

function emptySubscription(sourceId) {
  return {
    sourceId,
    fetchedAt: null,
    format: "unknown",
    trafficAvailable: false,
    trafficMessage: "尚未刷新订阅，当前流量未知",
    nodesMessage: "刷新订阅后显示节点",
    nodeCount: 0,
    truncated: false,
    nodes: [],
  };
}

function appendRecords(state, source, rows, checkedAt) {
  source.checkedAt = checkedAt;
  source.error = "";
  for (const row of rows) {
    const old = [...state.records]
      .reverse()
      .find(
        (record) =>
          record.sourceId === source.id &&
          record.key === row.key &&
          (record.revision ?? 0) === (source.revision ?? 0),
      );
    const reset =
      row.kind === "traffic" && old && (row.upload < old.upload || row.download < old.download);
    const record = {
      ...row,
      sourceId: source.id,
      sourceName: source.name,
      revision: source.revision ?? 0,
      checkedAt,
      ...(row.kind === "traffic"
        ? {
            counterReset: Boolean(reset),
            deltaUpload: old && !reset ? row.upload - old.upload : null,
            deltaDownload: old && !reset ? row.download - old.download : null,
          }
        : {}),
    };
    if (row.kind === "tokens")
      // API 返回同组织按日的完整快照；轮换凭据仍替换旧值，不能按 revision 重复累计。
      state.records = state.records.filter(
        (entry) => !(entry.sourceId === source.id && entry.key === row.key),
      );
    if (row.kind === "quota" && old?.sampleAt === row.sampleAt) continue;
    state.records.push(record);
  }
}

export class UsageStore {
  #file;
  #vault;
  #fetch;
  #queue = Promise.resolve();
  #active = new Map();
  #generations = new Map();
  #cache = null;
  constructor(file, vault, fetchImpl = fetch) {
    this.#file = file;
    this.#vault = vault;
    this.#fetch = fetchImpl;
  }
  async #read() {
    try {
      const version = fileVersion(await stat(this.#file));
      if (this.#cache?.version === version) return this.#cache.state;
      const state = JSON.parse(await readFile(this.#file, "utf8"));
      const after = fileVersion(await stat(this.#file));
      // 读文件期间若发生替换，不把新文件元信息与旧正文组合成错误缓存。
      this.#cache = after === version ? { version, state } : null;
      return state;
    } catch (e) {
      this.#cache = null;
      if (e.code === "ENOENT") return { sources: [], records: [] };
      throw e;
    }
  }
  #write(fn, { beforeCommit, persist, rollback } = {}) {
    const task = this.#queue.then(async () => {
      // 写事务使用副本，落盘失败不得污染此前读到的有效缓存。
      const state = structuredClone(await this.#read());
      const result = await fn(state);
      let persisted = false;
      try {
        beforeCommit?.();
        await mkdir(dirname(this.#file), { recursive: true });
        await writeFile(this.#file + ".tmp", JSON.stringify(state));
        beforeCommit?.();
        if (persist) {
          await persist();
          persisted = true;
        }
        beforeCommit?.();
        // 校验到提交之间不让锁库、编辑或删除插入异步回调。
        renameSync(this.#file + ".tmp", this.#file);
        this.#cache = null;
        return structuredClone(result);
      } catch (error) {
        if (persisted && rollback) await rollback().catch(() => {});
        throw error;
      }
    });
    this.#queue = task.catch(() => {});
    return task;
  }
  async list() {
    await this.#queue;
    const { sources, records } = await this.#read();
    return structuredClone({ sources, records });
  }
  #assertSession(session) {
    if (this.#vault.unlocked === false || this.#vault.session !== session)
      throw new Error("密钥库已锁定或会话已变化，操作已取消");
  }
  #invalidate(id) {
    this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1);
    this.#active.delete(id);
  }
  async #duplicateSubscription(state, url, excludedId) {
    for (const source of state.sources) {
      if (source.type !== "subscription" || source.id === excludedId) continue;
      const config = await this.#vault.get(source.id);
      if (config?.url && normalizedSubscriptionUrl(config.url) === url) return source;
    }
    return null;
  }
  async add(input) {
    if (!TYPES.has(input?.type) || !String(input.name ?? "").trim())
      throw new Error("请填写来源名称和类型");
    const config = sourceConfig(input);
    const id = "usage-" + randomUUID();
    const session = this.#vault.session;
    let added = false;
    return this.#write(
      async (state) => {
        this.#assertSession(session);
        if (input.type === "subscription") {
          const existing = await this.#duplicateSubscription(state, config.url);
          if (existing) return existing;
        }
        const source = {
          id,
          name: String(input.name).trim().slice(0, 100),
          type: input.type,
          nodeId: typeof input.nodeId === "string" ? input.nodeId : "",
          createdAt: new Date().toISOString(),
          revision: 0,
        };
        state.sources.push(source);
        added = true;
        return source;
      },
      {
        beforeCommit: () => this.#assertSession(session),
        persist: async () => {
          if (added) await this.#vault.set(id, config);
        },
        rollback: async () => {
          if (added) {
            this.#assertSession(session);
            await this.#vault.remove(id);
          }
        },
      },
    );
  }
  async update(id, input) {
    if (!/^usage-[\w-]+$/.test(id)) throw new Error("来源标识无效");
    const session = this.#vault.session;
    let previous, config;
    return this.#write(
      async (state) => {
        this.#assertSession(session);
        const source = state.sources.find((entry) => entry.id === id);
        if (!source) throw new Error("用量来源不存在");
        if (!input || (input.type !== undefined && input.type !== source.type))
          throw new Error("不能更改用量来源类型");
        const name = String(input.name ?? source.name)
          .trim()
          .slice(0, 100);
        if (!name) throw new Error("请填写来源名称");
        previous = await this.#vault.get(id);
        if (!previous) throw new Error("用量来源凭据不存在");
        config = sourceConfig({ ...input, type: source.type }, previous);
        if (
          source.type === "subscription" &&
          config.url !== normalizedSubscriptionUrl(previous.url) &&
          (await this.#duplicateSubscription(state, config.url, id))
        )
          throw new Error("该订阅已存在，请编辑已有机场，避免重复统计");
        this.#invalidate(id);
        const changed = JSON.stringify(config) !== JSON.stringify(sourceConfig(previous));
        source.name = name;
        if (typeof input.nodeId === "string") source.nodeId = input.nodeId;
        for (const record of state.records) if (record.sourceId === id) record.sourceName = name;
        if (changed) {
          source.revision = (source.revision ?? 0) + 1;
          delete source.checkedAt;
          delete source.attemptedAt;
          source.error = "";
          delete source.subscription;
          if (state.subscriptions) delete state.subscriptions[id];
        }
        return source;
      },
      {
        beforeCommit: () => this.#assertSession(session),
        persist: () => this.#vault.set(id, config),
        rollback: async () => {
          this.#assertSession(session);
          await this.#vault.set(id, previous);
        },
      },
    );
  }
  async subscriptionDetails(id) {
    if (!/^usage-[\w-]+$/.test(id)) throw new Error("来源标识无效");
    await this.#queue;
    const state = await this.#read();
    const source = state.sources.find((entry) => entry.id === id);
    if (!source) throw new Error("用量来源不存在");
    if (source.type !== "subscription") throw new Error("该来源不是机场订阅");
    return structuredClone(state.subscriptions?.[id] ?? emptySubscription(id));
  }
  async remove(id) {
    if (!/^usage-[\w-]+$/.test(id)) throw new Error("来源标识无效");
    const session = this.#vault.session;
    let previous;
    return this.#write(
      async (state) => {
        this.#assertSession(session);
        previous = await this.#vault.get(id);
        this.#invalidate(id);
        state.sources = state.sources.filter((s) => s.id !== id);
        if (state.subscriptions) delete state.subscriptions[id];
      },
      {
        beforeCommit: () => this.#assertSession(session),
        persist: () => this.#vault.remove(id),
        rollback: async () => {
          if (previous) {
            this.#assertSession(session);
            await this.#vault.set(id, previous);
          }
        },
      },
    );
  }
  async record(id, rows, meta = {}) {
    const checkedAt = new Date().toISOString();
    return this.#write((state) => {
      let source = state.sources.find((s) => s.id === id);
      if (!source && meta.type === "oauth") {
        source = { id, name: meta.name, type: "oauth" };
        state.sources.push(source);
      }
      if (!source) return;
      appendRecords(state, source, rows, checkedAt);
    });
  }
  /**
   * 记录采集失败。订阅账号第一次就失败时还没有来源，按 `meta` 建出来，
   * 否则失败会被静默丢弃，用量页只剩一张没有任何说明的空图表。
   * @param {string} id
   * @param {string} message
   * @param {{ type?: string, name?: string }} [meta]
   */
  async markFailure(id, message, meta = {}) {
    return this.#write((state) => {
      let source = state.sources.find((s) => s.id === id);
      if (!source && meta.type === "oauth" && id.startsWith("oauth:")) {
        source = { id, name: meta.name || id.slice(6), type: "oauth" };
        state.sources.push(source);
      }
      if (source) {
        source.error = message;
        source.attemptedAt = new Date().toISOString();
      }
    });
  }
  async recordAccount(account) {
    if (
      !account.usage ||
      account.usage.status === "stale" ||
      account.usageRefresh?.status === "error"
    )
      return;
    await this.record(
      "oauth:" + account.id,
      (account.usage.windows ?? []).map((window, index) => ({
        key: `${window.label}:${window.model ?? ""}:${index}`,
        kind: "quota",
        label: window.label,
        usedPercent: window.usedPercent ?? null,
        unit: window.unit ?? "percent",
        used: window.used ?? null,
        limit: window.limit ?? null,
        resetsAt: window.resetsAt,
        sampleAt: account.usage.checkedAt,
        scope: account.usage.scope ?? account.provider,
      })),
      { type: "oauth", name: `${account.provider} · ${account.email || account.accountId}` },
    );
  }
  refresh(id, { force = true } = {}) {
    if (!/^usage-[\w-]+$/.test(id)) throw new Error("来源标识无效");
    const active = this.#active.get(id);
    if (active && active.session === this.#vault.session) {
      // 人工刷新可升级正在检查缓存的自动任务，但共用已进行的网络请求。
      if (force) active.force = true;
      return active.promise;
    }
    const job = {
      force,
      promise: null,
      session: this.#vault.session,
      generation: this.#generations.get(id) ?? 0,
    };
    const assertCurrent = () => {
      this.#assertSession(job.session);
      if ((this.#generations.get(id) ?? 0) !== job.generation)
        throw new Error("用量来源已更新或删除，旧刷新结果已丢弃");
    };
    const work = (async () => {
      const current = await this.list();
      assertCurrent();
      const source = current.sources.find((item) => item.id === id);
      if (!source) throw new Error("用量来源不存在");
      if (!job.force && !usageNeedsRefresh(source)) return current;
      const config = await this.#vault.get(id);
      assertCurrent();
      if (!config) throw new Error("用量来源凭据不存在");
      try {
        const result =
          config.type === "subscription"
            ? await collectSubscription(config, this.#fetch)
            : { rows: await collectUsage(config, this.#fetch) };
        await this.#write(
          (state) => {
            assertCurrent();
            const latest = state.sources.find((entry) => entry.id === id);
            if (!latest || (latest.revision ?? 0) !== (source.revision ?? 0))
              throw new Error("用量来源已更新或删除，旧刷新结果已丢弃");
            appendRecords(state, latest, result.rows, new Date().toISOString());
            if (result.subscription) {
              state.subscriptions ??= {};
              state.subscriptions[id] = { sourceId: id, ...result.subscription };
              const { nodes: _nodes, ...summary } = result.subscription;
              latest.subscription = summary;
            }
          },
          { beforeCommit: assertCurrent },
        );
      } catch (error) {
        assertCurrent();
        await this.#write(
          (state) => {
            assertCurrent();
            const latest = state.sources.find((entry) => entry.id === id);
            if (latest && (latest.revision ?? 0) === (source.revision ?? 0)) {
              latest.error = error.message;
              latest.attemptedAt = new Date().toISOString();
            }
          },
          { beforeCommit: assertCurrent },
        );
        throw error;
      }
      return this.list();
    })().finally(() => {
      if (this.#active.get(id) === job) this.#active.delete(id);
    });
    job.promise = work;
    this.#active.set(id, job);
    return work;
  }
}
