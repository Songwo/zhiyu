import { open, stat, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DB_BYTES = 128 * 1024 * 1024;
const MAX_NODES = 5000;
const PROTOCOLS = {
  1: "vmess",
  3: "shadowsocks",
  4: "socks",
  5: "vless",
  6: "trojan",
  7: "hysteria2",
  8: "tuic",
  9: "wireguard",
  10: "http",
  11: "anytls",
};
const unavailableLive = (message) => ({
  available: false,
  checkedAt: null,
  upload: null,
  download: null,
  observedUpload: null,
  observedDownload: null,
  ...(message ? { message } : {}),
});
const emptyState = () => ({
  available: false,
  statisticsEnabled: null,
  checkedAt: null,
  savedAt: null,
  nodes: [],
  live: unavailableLive(),
});
const safeText = (value) =>
  typeof value === "string"
    ? [...value.slice(0, 512)]
        .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
        .join("")
    : "";
const normalizeHost = (value) => {
  const normalized = safeText(value)
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (isIP(normalized) === 6)
    return new URL(`http://[${normalized}]`).hostname.replace(/^\[|\]$/g, "");
  return normalized;
};
const numberOrNull = (value) => {
  if (typeof value !== "number" && typeof value !== "bigint") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
function localDay(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function ticksDay(value) {
  if (value == null) return null;
  try {
    // DateNow 保存的是本地日历的 .NET ticks，不能经过 Number 再转 BigInt。
    const millis = (BigInt(value) - 621355968000000000n) / 10000n;
    const date = new Date(Number(millis));
    return date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}
async function fingerprint(file) {
  try {
    const info = await stat(file, { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}
async function readJson(file, limit = MAX_FILE_BYTES) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("文件过大或格式不受支持");
    const buffer = Buffer.alloc(Math.min(limit + 1, info.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit || bytesRead > info.size) throw new Error("读取期间文件发生变化");
    return JSON.parse(
      buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    );
  } finally {
    await handle.close();
  }
}
export async function discoverV2raynDirectories({
  platform = process.platform,
  readFile: loadScript = readFile,
  execFile: execute = execFileAsync,
} = {}) {
  if (platform !== "win32") return [];
  try {
    const scriptPath = fileURLToPath(new URL("./v2rayn-discover.ps1", import.meta.url));
    // Electron 能读取 ASAR 内的固定脚本；外部 PowerShell 无法直接打开该虚拟路径。
    const script = (await loadScript(scriptPath, "utf8")).replace(/^\uFEFF/, "");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const { stdout } = await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 6000, maxBuffer: 128 * 1024, encoding: "utf8" },
    );
    const parsed = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    return Array.isArray(parsed) ? parsed : typeof parsed === "string" ? [parsed] : [];
  } catch {
    return [];
  }
}
function metricsEndpoint(listen) {
  if (typeof listen !== "string") return null;
  const match = /^(\[[^\]]+\]|[\d.]+):(\d{1,5})$/.exec(listen);
  if (!match) return null;
  const host = match[1].replace(/^\[|\]$/g, "");
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  if (!(host === "::1" || (isIP(host) === 4 && host.startsWith("127.")))) return null;
  return { host, port };
}
function readMetrics(endpoint, timeoutMs, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    // node:http 直接访问字面量回环地址，不读取系统代理，不跟随重定向。
    const req = request(
      {
        hostname: endpoint.host,
        port: endpoint.port,
        path: "/debug/vars",
        method: "GET",
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200 || Number(res.headers["content-length"]) > maxBytes) {
          res.destroy();
          reject(new Error("实时接口响应不受支持"));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error("实时接口响应过大"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("实时接口格式不受支持"));
          }
        });
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error("实时接口读取超时")), timeoutMs);
    req.on("close", () => clearTimeout(timeout));
    req.on("error", reject);
    req.end();
  });
}
function proxyIdentity(core) {
  const outbounds = Array.isArray(core.outbounds) ? core.outbounds : [];
  const proxies = outbounds.filter(
    (outbound) => !["freedom", "blackhole", "dns", "loopback"].includes(outbound.protocol),
  );
  if (proxies.length !== 1 || proxies[0].tag !== "proxy" || core.routing?.balancers?.length)
    return null;
  const proxy = proxies[0];
  const settings = proxy.settings;
  let target = settings;
  if (Array.isArray(settings?.vnext))
    target = settings.vnext.length === 1 ? settings.vnext[0] : null;
  if (Array.isArray(settings?.servers))
    target = settings.servers.length === 1 ? settings.servers[0] : null;
  if (!target || typeof target.address !== "string" || !Number.isInteger(target.port)) return null;
  return {
    host: normalizeHost(target.address),
    port: target.port,
    protocol: proxy.protocol === "socks" ? "socks" : safeText(proxy.protocol),
  };
}

/** v2rayN 只读本机统计；持久化内容只有用户选中的客户端目录。 */
export class V2raynUsage {
  constructor({
    configFile,
    discoverDirectories: discover = discoverV2raynDirectories,
    now = Date.now,
    requestTimeoutMs = 1500,
    maxResponseBytes = MAX_FILE_BYTES,
    openDatabase = (path) => new DatabaseSync(path, { readOnly: true }),
  } = {}) {
    this.configFile = configFile;
    this.discover = discover;
    this.now = now;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxResponseBytes = Math.min(maxResponseBytes, MAX_FILE_BYTES);
    this.openDatabase = openDatabase;
    this.state = emptyState();
    this.lastChecked = -Infinity;
    this.lastDiscovered = -Infinity;
    this.inFlight = null;
    this.directory = null;
    this.initialized = false;
    this.snapshot = null;
    this.dbSignature = null;
    this.liveBaseline = null;
  }
  async selectDirectory(directory) {
    if (typeof directory !== "string" || !isAbsolute(directory))
      throw new Error("请选择有效的 v2rayN 目录");
    const selected = resolve(directory);
    const info = await stat(join(selected, "guiConfigs", "guiNDB.db")).catch(() => null);
    if (!info?.isFile() || info.size > MAX_DB_BYTES)
      throw new Error("该目录中未找到可读取的 v2rayN 数据库");
    if (this.inFlight) await this.inFlight;
    if (this.configFile) {
      await mkdir(dirname(this.configFile), { recursive: true });
      const temporary = `${this.configFile}.tmp`;
      await writeFile(temporary, JSON.stringify({ directory: selected }), { mode: 0o600 });
      await rename(temporary, this.configFile);
    }
    this.initialized = true;
    this.selectedDirectory = selected;
    this.useDirectory(selected);
    return this.status({ force: true });
  }
  useDirectory(directory) {
    if (directory === this.directory) return;
    this.directory = directory;
    this.snapshot = null;
    this.dbSignature = null;
    this.liveBaseline = null;
    this.state = emptyState();
    this.lastChecked = -Infinity;
  }
  async locate(force) {
    if (!this.initialized) {
      this.initialized = true;
      if (this.configFile) {
        try {
          const saved = await readJson(this.configFile, 16384);
          if (typeof saved.directory === "string" && isAbsolute(saved.directory))
            this.selectedDirectory = resolve(saved.directory);
        } catch {
          /* 缺失或损坏的本机路径设置不阻止自动探测。 */
        }
      }
    }
    if (this.selectedDirectory) {
      this.useDirectory(this.selectedDirectory);
      return;
    }
    if (!force && this.now() - this.lastDiscovered < 60000) return;
    this.lastDiscovered = this.now();
    const candidates = await Promise.resolve()
      .then(() => this.discover())
      .catch(() => []);
    for (const directory of Array.isArray(candidates) ? candidates.slice(0, 32) : []) {
      if (typeof directory !== "string" || !isAbsolute(directory)) continue;
      const info = await stat(join(directory, "guiConfigs", "guiNDB.db")).catch(() => null);
      if (info?.isFile() && info.size <= MAX_DB_BYTES) {
        this.useDirectory(resolve(directory));
        return;
      }
    }
  }
  async status({ force = false } = {}) {
    if (this.inFlight) return this.inFlight;
    if (!force && this.now() - this.lastChecked < 5000) return this.state;
    this.inFlight = this.readStatus(force).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  async savedSnapshot() {
    const file = join(this.directory, "guiConfigs", "guiNDB.db");
    const signature = (await Promise.all([fingerprint(file), fingerprint(`${file}-wal`)])).join(
      "|",
    );
    if (this.snapshot && signature === this.dbSignature) return this.snapshot;
    const info = await stat(file);
    if (info.size > MAX_DB_BYTES || !info.isFile()) throw new Error("数据库过大或格式不受支持");
    let db;
    try {
      db = this.openDatabase(file);
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100;");
      // ProfileItem.Id 在旧版是认证字段，只允许 IndexId 与安全的展示列。
      const query =
        db.prepare(`SELECT p.IndexId, p.Subid, p.Remarks, p.Address, p.Port, p.ConfigType, p.CoreType,
        s.Remarks AS SubscriptionName, s.Enabled AS SubscriptionEnabled,
        st.TotalUp, st.TotalDown, st.TodayUp, st.TodayDown, st.DateNow
        FROM ProfileItem p LEFT JOIN SubItem s ON p.Subid=s.Id
        LEFT JOIN ServerStatItem st ON p.IndexId=st.IndexId ORDER BY p.IndexId LIMIT ${MAX_NODES + 1}`);
      query.setReadBigInts(true);
      const rows = query.all();
      const nodes = rows.slice(0, MAX_NODES).map((row) => ({
        id: safeText(row.IndexId),
        name: safeText(row.Remarks) || safeText(row.Address),
        host: safeText(row.Address),
        port: numberOrNull(row.Port) ?? 0,
        protocol: PROTOCOLS[Number(row.ConfigType)] || "unknown",
        ...(safeText(row.SubscriptionName)
          ? { subscriptionName: safeText(row.SubscriptionName) }
          : {}),
        savedUploadKb: numberOrNull(row.TotalUp),
        savedDownloadKb: numberOrNull(row.TotalDown),
        todayUploadKb: numberOrNull(row.TodayUp),
        todayDownloadKb: numberOrNull(row.TodayDown),
        statDate: ticksDay(row.DateNow),
      }));
      const latestInfo = await stat(file);
      const walInfo = await stat(`${file}-wal`).catch(() => null);
      const after = (await Promise.all([fingerprint(file), fingerprint(`${file}-wal`)])).join("|");
      this.snapshot = {
        nodes,
        savedAt: new Date(Math.max(latestInfo.mtimeMs, walInfo?.mtimeMs || 0)).toISOString(),
        truncated: rows.length > MAX_NODES,
      };
      // 写入恰好穿过读取窗口时保留本次只读快照，但下次必须重读。
      this.dbSignature = signature === after ? signature : null;
      return this.snapshot;
    } finally {
      db?.close();
    }
  }
  async liveStatus(gui, nodes, checkedAt) {
    try {
      const file = join(this.directory, "binConfigs", "config.json");
      const before = await fingerprint(file);
      const core = await readJson(file);
      const endpoint = metricsEndpoint(core.metrics?.listen);
      if (
        !endpoint ||
        core.policy?.system?.statsOutboundUplink !== true ||
        core.policy?.system?.statsOutboundDownlink !== true
      )
        throw new Error("unavailable");
      const payload = await readMetrics(endpoint, this.requestTimeoutMs, this.maxResponseBytes);
      const upload = numberOrNull(payload?.stats?.outbound?.proxy?.uplink);
      const download = numberOrNull(payload?.stats?.outbound?.proxy?.downlink);
      if (upload === null || download === null) throw new Error("unavailable");
      const after = await fingerprint(file);
      const latestGui = await readJson(join(this.directory, "guiConfigs", "guiNConfig.json"));
      if (before !== after || gui.IndexId !== latestGui.IndexId) throw new Error("changed");
      const target = proxyIdentity(core);
      const current = nodes.find((node) => node.id === gui.IndexId);
      const matched =
        current &&
        target &&
        normalizeHost(current.host) === target.host &&
        current.port === target.port &&
        current.protocol === target.protocol;
      const nodeId = matched ? current.id : undefined;
      const key = `${this.directory}|${before}|${gui.IndexId || ""}|${endpoint.host}:${endpoint.port}|${nodeId || "unmatched"}`;
      const prior = this.liveBaseline;
      const reset =
        !!prior &&
        (prior.key !== key || upload < prior.lastUpload || download < prior.lastDownload);
      if (!prior || reset)
        this.liveBaseline = { key, upload, download, lastUpload: upload, lastDownload: download };
      const baseline = this.liveBaseline;
      baseline.lastUpload = upload;
      baseline.lastDownload = download;
      return {
        available: true,
        checkedAt,
        upload,
        download,
        observedUpload: upload - baseline.upload,
        observedDownload: download - baseline.download,
        ...(nodeId
          ? { nodeId }
          : { message: "当前核心未匹配到唯一节点，实时流量不归属到机场节点" }),
        ...(reset ? { reset: true } : {}),
      };
    } catch {
      this.liveBaseline = null;
      return { ...unavailableLive("未发现可读取的本机实时接口，已保存统计仍可查看"), checkedAt };
    }
  }
  async readStatus(force) {
    const startedAt = this.now();
    const checkedAt = new Date(startedAt).toISOString();
    try {
      await this.locate(force);
    } catch {
      /* 探测失败由下方统一给出不含路径的提示。 */
    }
    if (!this.directory) {
      this.state = {
        ...emptyState(),
        checkedAt,
        message: "未找到 v2rayN，可选择客户端目录读取本机节点统计",
      };
      this.lastChecked = startedAt;
      return this.state;
    }
    let gui = null;
    try {
      gui = await readJson(join(this.directory, "guiConfigs", "guiNConfig.json"));
    } catch {
      /* 配置不可读时不猜测当前节点。 */
    }
    let snapshot,
      stale = false;
    try {
      snapshot = await this.savedSnapshot();
    } catch {
      snapshot = this.snapshot;
      stale = true;
    }
    const day = localDay(this.now());
    const nodes = (snapshot?.nodes || []).map((node) =>
      node.statDate === day ? { ...node } : { ...node, todayUploadKb: null, todayDownloadKb: null },
    );
    const statisticsEnabled =
      typeof gui?.GuiItem?.EnableStatistics === "boolean" ? gui.GuiItem.EnableStatistics : null;
    const live = gui
      ? await this.liveStatus(gui, stale ? [] : nodes, checkedAt)
      : { ...unavailableLive("客户端配置暂时不可读，无法确认实时流量归属"), checkedAt };
    if (!gui) this.liveBaseline = null;
    let message;
    if (stale)
      message = snapshot
        ? "客户端统计暂时不可读，显示上次成功快照，数据可能已过期"
        : "客户端统计暂时不可读，请确认所选目录和客户端统计功能";
    else if (snapshot?.truncated) message = "客户端节点较多，仅展示前 5000 个节点";
    else if (statisticsEnabled === false)
      message = "v2rayN 未开启流量统计，仅显示客户端此前保存的数据";
    this.state = {
      available: !!snapshot,
      statisticsEnabled,
      checkedAt,
      savedAt: snapshot?.savedAt || null,
      nodes,
      live,
      ...(stale ? { stale: true } : {}),
      ...(message ? { message } : {}),
    };
    this.lastChecked = startedAt;
    return this.state;
  }
}
