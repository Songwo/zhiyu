import { isIP } from "node:net";

export function probeEndpoint(value, allowInsecure = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("探针服务端地址无效。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.length > 2048
  )
    throw new Error("探针地址必须为不含凭据和查询参数的 HTTP(S) 地址。");
  if (url.protocol === "http:") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const internal =
      host === "localhost" ||
      host === "::1" ||
      (isIP(host) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ||
      (isIP(host) === 6 && /^f[cd]/i.test(host));
    if (!allowInsecure || !internal)
      throw new Error("HTTP 明文仅允许显式启用的本机或内网地址；公网请使用 HTTPS。");
  }
  return url.href.replace(/\/+$/, "");
}

export function remoteId(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    /[/\\?#]/.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error("远端资源标识无效。");
  return encodeURIComponent(value);
}
const str = (value, max = 256) => (typeof value === "string" ? value.slice(0, max) : "");
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
export function probeSample(value) {
  if (!value || typeof value !== "object" || !timestamp(value.at))
    throw new Error("探针返回的采样时间无效。");
  const result = { at: timestamp(value.at) };
  for (const key of [
    "cpu",
    "memory",
    "swap",
    "disk",
    "memoryTotal",
    "diskTotal",
    "networkRx",
    "networkTx",
    "rxRate",
    "txRate",
    "uptime",
    "load1",
    "load5",
    "load15",
    "tcp",
    "udp",
    "processes",
    "temperature",
    "gpu",
  ]) {
    const n = value[key];
    result[key] =
      typeof n === "number" &&
      Number.isFinite(n) &&
      n >= (key === "temperature" ? -100 : 0) &&
      (key !== "temperature" || n <= 250) &&
      (!["cpu", "memory", "swap", "disk", "gpu"].includes(key) || n <= 100)
        ? n
        : null;
  }
  return result;
}
export function probeHost(value) {
  remoteId(value?.id);
  return {
    id: value.id,
    name: str(value.name),
    hostname: str(value.hostname),
    os: str(value.os),
    arch: str(value.arch),
    status: ["online", "offline", "pending"].includes(value.status) ? value.status : "pending",
    lastSeen: timestamp(value.lastSeen),
    latest: value.latest ? probeSample(value.latest) : null,
  };
}
export function probeCheckResult(value) {
  const at = timestamp(value?.at);
  if (!at || !["up", "down"].includes(value.status)) throw new Error("服务检查历史格式无效。");
  return {
    at,
    status: value.status,
    latencyMs: Number.isFinite(value.latencyMs) && value.latencyMs >= 0 ? value.latencyMs : null,
    message: str(value.message, 512),
  };
}
export function probeCheckInput(value) {
  if (!value || !["http", "tcp"].includes(value.type)) throw new Error("检查类型无效。");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 160)
    throw new Error("请填写 160 字以内的检查名称。");
  if (typeof value.target !== "string" || !value.target.trim() || value.target.length > 2048)
    throw new Error("检查目标无效。");
  if (
    !Number.isInteger(value.intervalSeconds) ||
    value.intervalSeconds < 10 ||
    value.intervalSeconds > 3600 ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 100 ||
    value.timeoutMs > 30000
  )
    throw new Error("检查间隔需为 10–3600 秒，超时为 100–30000 毫秒。");
  if (value.timeoutMs > value.intervalSeconds * 1000) throw new Error("检查超时不能大于检查间隔。");
  if (value.type === "http") {
    let u;
    try {
      u = new URL(value.target);
    } catch {
      throw new Error("HTTP 检查地址无效。");
    }
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hash)
      throw new Error("HTTP 检查不支持凭据或片段。");
  } else if (!/^(\[[^\]]+\]|[^:\s/]+):\d{1,5}$/.test(value.target))
    throw new Error("TCP 目标需为主机:端口。");
  if (value.id !== undefined) remoteId(value.id);
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    name: value.name.trim(),
    type: value.type,
    target: value.target.trim(),
    intervalSeconds: value.intervalSeconds,
    timeoutMs: value.timeoutMs,
  };
}
export function probeCheck(value) {
  remoteId(value?.id);
  const input = probeCheckInput(value);
  return {
    ...input,
    id: value.id,
    status: ["up", "down", "pending"].includes(value.status) ? value.status : "pending",
    lastCheckedAt: timestamp(value.lastCheckedAt),
    latencyMs: Number.isFinite(value.latencyMs) && value.latencyMs >= 0 ? value.latencyMs : null,
    message: str(value.message, 512),
    uptime24h:
      Number.isFinite(value.uptime24h) && value.uptime24h >= 0 && value.uptime24h <= 100
        ? value.uptime24h
        : null,
  };
}

export async function probeRequest(
  connection,
  token,
  path,
  { method = "GET", body, fetchImpl = fetch, signal } = {},
) {
  let response;
  try {
    response = await fetchImpl(connection.endpoint + "/api/v1" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("探针连接失败或超时，请检查服务端地址、证书和网络。");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401 || response.status === 403
        ? "探针访问凭据无效或无权限。"
        : `探针服务请求失败（HTTP ${response.status}）。`,
    );
  }
  if (response.status === 204) return null;
  let text = "",
    bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("探针响应为空。");
  try {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("探针响应过大。");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    throw new Error("探针响应读取失败、超时或数据过大。");
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (text.includes(token)) throw new Error("探针响应包含连接凭据，已拒绝显示。");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("探针响应不是有效 JSON。");
  }
  // 解码后再检查，避免 Unicode 转义绕过原始字符串比较。
  const pending = [data];
  let visited = 0;
  while (pending.length) {
    if (++visited > 100000) throw new Error("探针响应结构过于复杂。");
    const value = pending.pop();
    if (typeof value === "string" && value.includes(token))
      throw new Error("探针响应包含连接凭据，已拒绝显示。");
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) pending.push(key, child);
  }
  return data;
}
