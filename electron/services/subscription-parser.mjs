import { createHash } from "node:crypto";
import { load, JSON_SCHEMA } from "js-yaml";

export const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
export const MAX_SUBSCRIPTION_NODES = 1000;

const protocols = new Set([
  "ss",
  "ssr",
  "vmess",
  "vless",
  "trojan",
  "hysteria",
  "hysteria2",
  "tuic",
  "socks5",
  "http",
  "wireguard",
]);
const aliases = { shadowsocks: "ss", shadowsocksr: "ssr", hy2: "hysteria2", socks: "socks5" };
const emptyMessage = "订阅未提供可识别的节点列表，支持 URI、Base64、Clash 和 sing-box 格式。";
const protocolOf = (value) => {
  if (typeof value !== "string") return null;
  const protocol = value.toLowerCase();
  const normalized = aliases[protocol] ?? protocol;
  return protocols.has(normalized) ? normalized : null;
};

function decodeBase64(value) {
  const text = value.replace(/\s/g, "");
  if (!text || !/^[A-Za-z\d+/_-]+={0,2}$/.test(text) || text.length % 4 === 1) return null;
  const decoded = Buffer.from(text, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }
}
function decodeName(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function publicNode(protocol, host, port, name, index) {
  if (!protocol || typeof host !== "string") return null;
  host = host.trim().replace(/^\[|\]$/g, "");
  if (!host || host.length > 255 || /[\s/\\@?#]/.test(host)) return null;
  // 不对 YAML 数组/对象做隐式转换，避免别名图在 Array.toString 中指数级展开。
  if (typeof port !== "number" && typeof port !== "string") return null;
  if (typeof port === "string" && !/^\d+$/.test(port)) return null;
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const address = new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);
    host = address.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  const label =
    typeof name === "string"
      ? name
        .replace(/\p{Cc}/gu, "")
          .trim()
          .slice(0, 160)
      : "";
  // 名称是普通展示文本，不能将被误填为名称的完整分享链接带入明文缓存。
  name =
    label && !/[a-z][\w+-]*:\/\//i.test(label)
      ? label
      : `${protocol.toUpperCase()} · ${host}:${port}`;
  // 同地址可能有多个不同认证配置；用序号区分，既不合并也不把认证内容用于公开标识。
  const id = createHash("sha256")
    .update(JSON.stringify([protocol, host, port, name, index]))
    .digest("hex")
    .slice(0, 24);
  return { id, name, protocol, host, port };
}

function parseUri(line, index) {
  const match = /^([a-z][\w+-]*):\/\/(.*)$/i.exec(line);
  if (!match) return null;
  const protocol = protocolOf(match[1]);
  // 普通网页链接不能被误认作成功导入的代理订阅。
  if (!protocol || protocol === "http") return null;
  let body = match[2];
  try {
    if (protocol === "vmess" && !body.includes("@")) {
      const config = JSON.parse(decodeBase64(body.split("#")[0]) ?? "null");
      return publicNode(protocol, config?.add, config?.port, config?.ps, index);
    }
    if (protocol === "ssr") {
      const decoded = decodeBase64(body);
      const fields =
        decoded && /^(.*):(\d+):[^:]+:[^:]+:[^:/?]+:[^/?]+(?:\/\?(.*))?$/.exec(decoded);
      if (!fields) return null;
      const remarks = new URLSearchParams(fields[3] ?? "").get("remarks");
      return publicNode(
        protocol,
        fields[1],
        fields[2],
        remarks ? decodeBase64(remarks) : "",
        index,
      );
    }
    if (protocol === "ss" && !body.split("#")[0].includes("@")) {
      const hash = body.indexOf("#");
      const payload = hash < 0 ? body : body.slice(0, hash);
      const decoded = decodeBase64(payload);
      if (!decoded) return null;
      body = decoded + (hash < 0 ? "" : body.slice(hash));
    }
    const url = new URL(`${match[1]}://${body}`);
    return publicNode(protocol, url.hostname, url.port, decodeName(url.hash.slice(1)), index);
  } catch {
    return null;
  }
}

/** 只提取显示所需字段；解析出的认证参数与正文不进入返回值、日志或磁盘。 */
export function parseSubscriptionNodes(text) {
  if (typeof text !== "string")
    return { format: "unknown", nodes: [], truncated: false, nodesMessage: emptyMessage };
  if (Buffer.byteLength(text, "utf8") > MAX_SUBSCRIPTION_BYTES)
    throw new Error("订阅正文超过 2 MiB，请使用精简的订阅格式。");
  let body = text.replace(/^\uFEFF/, "").trim();
  let encoded = false;
  const decoded = decodeBase64(body);
  if (decoded && decoded !== body) {
    body = decoded.trim();
    encoded = true;
  }
  const nodes = [];
  let format = "unknown";
  let truncated = false;
  const append = (node) => {
    if (!node) return;
    if (nodes.length >= MAX_SUBSCRIPTION_NODES) truncated = true;
    else nodes.push(node);
  };
  if (/^[a-z][\w+-]*:\/\//im.test(body)) {
    format = "uri";
    for (const [index, line] of body.split(/\r?\n/).entries()) {
      append(parseUri(line.trim(), index));
      if (truncated) break;
    }
  } else if (!/^\s*</.test(body)) {
    try {
      // JSON_SCHEMA 不执行 YAML 自定义类型；不递归遍历结果，别名/循环引用也不会扩展节点。
      const document = /^[{[]/.test(body) ? JSON.parse(body) : load(body, { schema: JSON_SCHEMA });
      const entries = Array.isArray(document?.proxies)
        ? document.proxies
        : Array.isArray(document?.outbounds)
          ? document.outbounds
          : [];
      format = Array.isArray(document?.proxies)
        ? "clash"
        : Array.isArray(document?.outbounds)
          ? "sing-box"
          : "unknown";
      for (const [index, node] of entries.entries()) {
        if (node && typeof node === "object" && !Array.isArray(node)) {
          append(
            publicNode(
              protocolOf(node.type),
              node.server,
              node.port ?? node.server_port,
              node.name ?? node.tag,
              index,
            ),
          );
        }
        if (truncated) break;
      }
    } catch {
      // 解析异常可能附带正文，其中含密码；只返回固定提示。
      format = "unknown";
    }
  }
  return {
    format: encoded && nodes.length ? "base64" : format,
    nodes,
    truncated,
    ...(!nodes.length
      ? { nodesMessage: emptyMessage }
      : truncated
        ? { nodesMessage: "节点过多，最多展示前 1000 个。" }
        : {}),
  };
}
