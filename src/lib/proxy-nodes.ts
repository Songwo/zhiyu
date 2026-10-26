import type { ProxyNode, ProxyProtocol, Server } from "./types";
import { randomId } from "./random-id.ts";
const uid = (prefix: string) => prefix + "-" + randomId();

/**
 * Parses proxy connection strings (VLESS, VMess, Trojan, Shadowsocks, Hysteria2)
 * into a structured ProxyNode object.
 */
export function parseProxyUri(rawInput: string): Partial<ProxyNode> | null {
  const uri = rawInput.trim();
  if (!uri) return null;

  try {
    // 1. VMess (vmess://<base64-json>)
    if (uri.startsWith("vmess://")) {
      const b64 = uri.slice(8);
      const jsonStr = decodeBase64Safe(b64);
      if (!jsonStr) return null;
      const v = JSON.parse(jsonStr);
      return {
        id: uid("nod"),
        name: v.ps || "VMess Node",
        protocol: "vmess",
        host: v.add || "",
        port: Number(v.port) || 443,
        uuid: v.id || "",
        network: (v.net || "tcp").toLowerCase(),
        security: (v.tls || "none").toLowerCase(),
        sni: v.sni || v.host || "",
        path: v.path || "",
        rawUri: uri,
      };
    }

    // 2. VLESS (vless://uuid@host:port?query#name)
    if (uri.startsWith("vless://")) {
      const url = new URL(uri);
      const params = url.searchParams;
      return {
        id: uid("nod"),
        name:
          decodeURIComponent(url.hash.replace(/^#/, "")) || `${url.hostname}:${url.port || 443}`,
        protocol: "vless",
        host: url.hostname,
        port: Number(url.port) || 443,
        uuid: decodeURIComponent(url.username),
        network: (params.get("type") as ProxyNode["network"]) || "tcp",
        security: (params.get("security") as ProxyNode["security"]) || "none",
        sni: params.get("sni") || undefined,
        path: params.get("path") || undefined,
        pbk: params.get("pbk") || undefined,
        sid: params.get("sid") || undefined,
        flow: params.get("flow") || undefined,
        rawUri: uri,
      };
    }

    // 3. Trojan (trojan://password@host:port?query#name)
    if (uri.startsWith("trojan://")) {
      const url = new URL(uri);
      const params = url.searchParams;
      return {
        id: uid("nod"),
        name: decodeURIComponent(url.hash.replace(/^#/, "")) || `Trojan-${url.hostname}`,
        protocol: "trojan",
        host: url.hostname,
        port: Number(url.port) || 443,
        password: decodeURIComponent(url.username),
        security: "tls",
        sni: params.get("sni") || params.get("peer") || url.hostname,
        network: (params.get("type") as ProxyNode["network"]) || "tcp",
        rawUri: uri,
      };
    }

    // 4. Shadowsocks (ss://base64@host:port#name or ss://method:pass@host:port#name)
    if (uri.startsWith("ss://")) {
      const rest = uri.slice(5);
      const hashIndex = rest.indexOf("#");
      const name =
        hashIndex !== -1 ? decodeURIComponent(rest.slice(hashIndex + 1)) : "Shadowsocks Node";
      const mainPart = hashIndex !== -1 ? rest.slice(0, hashIndex) : rest;

      let userInfo = "";
      let host = "";
      let port = 8388;

      if (mainPart.includes("@")) {
        const [userPart, hostPart] = mainPart.split("@");
        const decodedUser = decodeBase64Safe(userPart) || userPart;
        userInfo = decodedUser;
        const target = new URL("ss://" + hostPart);
        host = target.hostname;
        port = Number(target.port) || 8388;
      } else {
        const decoded = decodeBase64Safe(mainPart);
        if (decoded && decoded.includes("@")) {
          const [userPart, hostPart] = decoded.split("@");
          userInfo = userPart;
          const target = new URL("ss://" + hostPart);
          host = target.hostname;
          port = Number(target.port) || 8388;
        }
      }

      return {
        id: uid("nod"),
        name,
        protocol: "ss",
        host,
        port,
        password: userInfo,
        rawUri: uri,
      };
    }

    // 5. Hysteria2 (hysteria2://password@host:port?sni=...#name or hy2://)
    if (uri.startsWith("hysteria2://") || uri.startsWith("hy2://")) {
      const cleanUri = uri.startsWith("hy2://") ? `hysteria2://${uri.slice(6)}` : uri;
      const url = new URL(cleanUri);
      const params = url.searchParams;
      return {
        id: uid("nod"),
        name: decodeURIComponent(url.hash.replace(/^#/, "")) || `Hy2-${url.hostname}`,
        protocol: "hysteria2",
        host: url.hostname,
        port: Number(url.port) || 443,
        password: decodeURIComponent(url.username + (url.password ? `:${url.password}` : "")),
        sni: params.get("sni") || undefined,
        security: "tls",
        rawUri: uri,
      };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Formats a ProxyNode into a standard client import URI.
 */
export function formatProxyUri(node: ProxyNode): string {
  if (node.rawUri) return node.rawUri;

  const host = node.host.includes(":") && !node.host.startsWith("[") ? `[${node.host}]` : node.host;
  const enc = encodeURIComponent;
  const hash = `#${enc(node.name || "Node")}`;

  switch (node.protocol) {
    case "vless": {
      const params = new URLSearchParams();
      params.set("encryption", "none");
      if (node.security) params.set("security", node.security);
      if (node.network) params.set("type", node.network);
      if (node.sni) params.set("sni", node.sni);
      if (node.flow) params.set("flow", node.flow);
      if (node.path) params.set("path", node.path);
      if (node.pbk) params.set("pbk", node.pbk);
      if (node.sid) params.set("sid", node.sid);
      return `vless://${node.uuid || ""}@${host}:${node.port}?${params.toString()}${hash}`;
    }
    case "trojan": {
      const params = new URLSearchParams();
      if (node.sni) params.set("sni", node.sni);
      if (node.network) params.set("type", node.network);
      return `trojan://${enc(node.password || "")}@${host}:${node.port}?${params.toString()}${hash}`;
    }
    case "hysteria2": {
      const params = new URLSearchParams();
      if (node.sni) params.set("sni", node.sni);
      return `hysteria2://${enc(node.password || "")}@${host}:${node.port}?${params.toString()}${hash}`;
    }
    case "ss": {
      const auth = encodeBase64(node.password || "");
      return `ss://${auth}@${host}:${node.port}${hash}`;
    }
    case "vmess": {
      const vmessConfig = {
        v: "2",
        ps: node.name,
        add: node.host,
        port: node.port,
        id: node.uuid || "",
        aid: "0",
        net: node.network || "tcp",
        type: "none",
        host: node.sni || "",
        path: node.path || "",
        tls: node.security === "tls" ? "tls" : "",
        sni: node.sni || "",
      };
      return `vmess://${encodeBase64(JSON.stringify(vmessConfig))}`;
    }
  }
}

/**
 * Protocol badge styling info according to IoToken industrial aesthetic.
 */
export function getProtocolBadge(protocol: ProxyProtocol): {
  label: string;
  badgeClass: string;
} {
  switch (protocol) {
    case "vless":
      return {
        label: "VLESS",
        badgeClass:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-mono font-semibold",
      };
    case "vmess":
      return {
        label: "VMESS",
        badgeClass: "border-sky-500/30 bg-sky-500/10 text-sky-400 font-mono font-semibold",
      };
    case "trojan":
      return {
        label: "TROJAN",
        badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-400 font-mono font-semibold",
      };
    case "hysteria2":
      return {
        label: "HYSTERIA 2",
        badgeClass: "border-purple-500/30 bg-purple-500/10 text-purple-400 font-mono font-semibold",
      };
    case "ss":
      return {
        label: "SHADOWSOCKS",
        badgeClass: "border-slate-500/30 bg-slate-500/10 text-slate-300 font-mono font-semibold",
      };
  }
}

function decodeBase64Safe(str: string): string | null {
  try {
    const clean = str.replace(/-/g, "+").replace(/_/g, "/");
    const padded = clean.padEnd(clean.length + ((4 - (clean.length % 4)) % 4), "=");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

export interface NodeWithServer {
  node: ProxyNode;
  server: Server;
}

export function getAllProxyNodes(servers: Server[]): NodeWithServer[] {
  const result: NodeWithServer[] = [];
  for (const server of servers) {
    if (server.nodes) {
      for (const node of server.nodes) {
        result.push({ node, server });
      }
    }
  }
  return result;
}

export function exportNodesSubscription(nodes: ProxyNode[]): string {
  const uris = nodes.map((n) => formatProxyUri(n)).join("\n");
  try {
    return btoa(unescape(encodeURIComponent(uris)));
  } catch {
    return btoa(uris);
  }
}

function encodeBase64(value: string) {
  return btoa(
    Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(""),
  );
}
export function validateProxyNode(node: Partial<ProxyNode>) {
  if (!["vless", "vmess", "trojan", "ss", "hysteria2"].includes(node.protocol ?? ""))
    throw new Error("不支持的节点协议");
  if (!node.host?.trim() || /[\s/\\@?#]/.test(node.host))
    throw new Error("请填写有效的节点主机名或 IP");
  if (!Number.isInteger(node.port) || node.port! < 1 || node.port! > 65535)
    throw new Error("端口必须为 1–65535 的整数");
  if (
    ["vless", "vmess"].includes(node.protocol!) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.uuid ?? "")
  )
    throw new Error("请填写服务端提供的有效 UUID");
  if (["trojan", "ss", "hysteria2"].includes(node.protocol!) && !node.password)
    throw new Error("请填写节点密码");
  if (node.protocol === "ss" && !/^[^:]+:.+/.test(node.password ?? ""))
    throw new Error("Shadowsocks 需要 加密方法:密码");
  if (node.protocol === "vless" && node.security === "reality" && (!node.pbk || !node.sni))
    throw new Error("Reality 节点需要填写公钥和 SNI");
}
