/**
 * 网页版的「本机监控」：读取服务所在主机的 CPU、内存、磁盘、网络、负载与运行时长。
 *
 * 只读 Linux 的 /proc 与 cgroup 文件，不执行任何命令。在 Docker 里：
 * - 默认只能看到容器自己的 /proc：CPU、内存总量、负载与运行时长其实是宿主机的数字，
 *   但网络只有容器网卡、进程只有容器内进程；
 * - 把宿主机的 /proc 只读挂到 /host/proc（docker-compose.yml 已写好）后，网络和进程也换成整台机器的；
 * - 磁盘统计资料目录所在的文件系统，挂载卷时就是宿主机上那块盘。
 * 容器的内存与 CPU 上限另外从 cgroup 读出，和宿主机数字并排显示。
 */
import { existsSync } from "node:fs";
import { readFile, readdir, statfs } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const HISTORY_LIMIT = 720;
const SAMPLE_MS = 5000;

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const read = (file) => readFile(file, "utf8").catch(() => null);

/** 优先使用挂载进来的宿主机 /proc，否则用自己的。 */
export function resolveProcRoot(env = process.env) {
  if (env.ZHIYU_HOST_PROC) return { root: env.ZHIYU_HOST_PROC, host: true };
  if (existsSync("/host/proc/stat")) return { root: "/host/proc", host: true };
  return { root: "/proc", host: false };
}

export function parseCpuTimes(text) {
  const line = text?.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const idleAll = idle + iowait;
  const total = user + nice + system + idleAll + irq + softirq + steal;
  return { total, idle: idleAll, iowait, steal };
}

export function cpuPercent(prev, next) {
  if (!prev || !next) return null;
  const total = next.total - prev.total;
  if (total <= 0) return null;
  return {
    usage: round(((total - (next.idle - prev.idle)) / total) * 100),
    iowait: round(((next.iowait - prev.iowait) / total) * 100),
    steal: round(((next.steal - prev.steal) / total) * 100),
  };
}

export function parseMeminfo(text) {
  const map = {};
  for (const line of text?.split("\n") ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) map[m[1]] = Number(m[2]) * 1024;
  }
  if (!map.MemTotal) return null;
  const available = map.MemAvailable ?? (map.MemFree ?? 0) + (map.Cached ?? 0);
  return {
    total: map.MemTotal,
    used: map.MemTotal - available,
    available,
    cached: (map.Cached ?? 0) + (map.Buffers ?? 0),
    swapTotal: map.SwapTotal ?? 0,
    swapUsed: (map.SwapTotal ?? 0) - (map.SwapFree ?? 0),
  };
}

/** /proc/net/dev：忽略回环与容器网桥 / veth，避免同一份流量算两遍。 */
export function parseNetDev(text) {
  const out = {};
  for (const line of text?.split("\n").slice(2) ?? []) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (name === "lo" || /^(veth|docker|br-|cni|flannel|virbr)/.test(name)) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    out[name] = { rx: f[0], tx: f[8] };
  }
  return out;
}

/** /proc/diskstats：只算整块盘（不含分区、loop、ram），扇区按 512 字节。 */
export function parseDiskstats(text) {
  let read = 0;
  let write = 0;
  const devices = [];
  for (const line of text?.split("\n") ?? []) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (/^(loop|ram|sr|fd|dm-|md)/.test(name)) continue;
    if (/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)\d+$/.test(name)) continue;
    if (/^(nvme\d+n\d+|mmcblk\d+)p\d+$/.test(name)) continue;
    devices.push(name);
    read += Number(f[5]) * 512;
    write += Number(f[9]) * 512;
  }
  return { read, write, devices };
}

export function parseOsRelease(text) {
  const map = {};
  for (const line of text?.split("\n") ?? []) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) map[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return map.PRETTY_NAME || [map.NAME, map.VERSION].filter(Boolean).join(" ") || null;
}

/** cgroup v2 优先，v1 兜底；"max" 或巨大的数字表示没有限制。 */
async function cgroupLimits(cgroupRoot = "/sys/fs/cgroup") {
  const v2 = await read(join(cgroupRoot, "memory.max"));
  if (v2 !== null) {
    const memoryLimit = v2.trim() === "max" ? null : num(v2.trim());
    const memoryUsed = num((await read(join(cgroupRoot, "memory.current")))?.trim());
    const cpuMax = (await read(join(cgroupRoot, "cpu.max")))?.trim().split(/\s+/);
    const cpuLimit =
      cpuMax && cpuMax[0] !== "max" ? round(Number(cpuMax[0]) / Number(cpuMax[1] || 100000)) : null;
    const usage = /usage_usec\s+(\d+)/.exec((await read(join(cgroupRoot, "cpu.stat"))) ?? "");
    return {
      version: 2,
      memoryLimit,
      memoryUsed,
      cpuLimit,
      cpuUsageUs: usage ? Number(usage[1]) : null,
    };
  }
  const v1 = await read(join(cgroupRoot, "memory/memory.limit_in_bytes"));
  if (v1 !== null) {
    const limit = num(v1.trim());
    const quota = num((await read(join(cgroupRoot, "cpu/cpu.cfs_quota_us")))?.trim());
    const period = num((await read(join(cgroupRoot, "cpu/cpu.cfs_period_us")))?.trim());
    const usageNs = num((await read(join(cgroupRoot, "cpuacct/cpuacct.usage")))?.trim());
    return {
      version: 1,
      memoryLimit: limit && limit < 2 ** 60 ? limit : null,
      memoryUsed: num((await read(join(cgroupRoot, "memory/memory.usage_in_bytes")))?.trim()),
      cpuLimit: quota && quota > 0 && period ? round(quota / period) : null,
      cpuUsageUs: usageNs === null ? null : usageNs / 1000,
    };
  }
  return null;
}

/** 判断自己是否跑在容器里，以及大致是哪种。 */
export async function detectContainer(selfProc = "/proc") {
  if (existsSync("/.dockerenv")) return "docker";
  if (existsSync("/run/.containerenv")) return "podman";
  const cgroup = (await read(join(selfProc, "1/cgroup"))) ?? "";
  if (/docker|containerd/.test(cgroup)) return "docker";
  if (/kubepods/.test(cgroup)) return "kubernetes";
  if (/lxc/.test(cgroup)) return "lxc";
  return null;
}

async function processes(procRoot, prevTicks, elapsedTicks, memTotal) {
  const entries = await readdir(procRoot).catch(() => []);
  const pids = entries.filter((name) => /^\d+$/.test(name));
  const ticks = new Map();
  const list = [];
  await Promise.all(
    pids.map(async (pid) => {
      const stat = await read(join(procRoot, pid, "stat"));
      if (!stat) return;
      const close = stat.lastIndexOf(")");
      const name = stat.slice(stat.indexOf("(") + 1, close);
      const f = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/);
      const used = Number(f[11]) + Number(f[12]);
      const rss = Number(f[21]) * 4096;
      ticks.set(pid, used);
      const before = prevTicks?.get(pid);
      list.push({
        pid: Number(pid),
        name,
        state: f[0],
        memory: rss,
        memoryPercent: memTotal ? round((rss / memTotal) * 100) : null,
        cpu:
          before === undefined || !elapsedTicks
            ? null
            : round(((used - before) / elapsedTicks) * 100),
      });
    }),
  );
  return { count: pids.length, ticks, list };
}

const round = (n) => Math.round(n * 10) / 10;

export class HostStats {
  #proc;
  #dataDir;
  #history = [];
  #prev = null;
  #timer = null;
  #procTicks = null;
  #procAt = 0;
  #static = null;
  #last = null;
  #now;

  #platform;
  #cgroupRoot;
  #hostEtc;
  #container;

  /** 后几个参数只给测试用：在任何系统上用一份假的 /proc 跑完整流程。 */
  constructor({
    dataDir,
    env = process.env,
    now = Date.now,
    proc = resolveProcRoot(env),
    platform = process.platform,
    cgroupRoot = "/sys/fs/cgroup",
    hostEtc = "/host/etc",
    container,
  } = {}) {
    this.#platform = platform;
    this.#cgroupRoot = cgroupRoot;
    this.#hostEtc = hostEtc;
    this.#container = container;
    this.#proc = proc;
    this.#dataDir = dataDir;
    this.#now = now;
  }

  async #staticInfo() {
    if (this.#static) return this.#static;
    const root = this.#proc.root;
    const container = this.#container !== undefined ? this.#container : await detectContainer();
    const hostFile = (name) => join(this.#hostEtc, name);
    const osName =
      parseOsRelease(await read(hostFile("os-release"))) ??
      (container ? null : parseOsRelease(await read("/etc/os-release")));
    const hostname =
      (await read(hostFile("hostname")))?.trim() ||
      (container ? null : os.hostname()) ||
      os.hostname();
    const cpuinfo = (await read(join(root, "cpuinfo"))) ?? "";
    const model = /model name\s*:\s*(.+)/.exec(cpuinfo)?.[1]?.trim() ?? os.cpus()[0]?.model ?? null;
    const cores = (cpuinfo.match(/^processor\s*:/gm) ?? []).length || os.cpus().length;
    this.#static = {
      hostname,
      hostnameFromHost: existsSync(hostFile("hostname")) || !container,
      os: osName,
      osFromHost: existsSync(hostFile("os-release")) || !container,
      kernel: (await read(join(root, "sys/kernel/osrelease")))?.trim() ?? os.release(),
      arch: os.arch(),
      cpuModel: model,
      cores,
      container,
      node: process.versions.node,
      linux: this.#platform === "linux",
    };
    return this.#static;
  }

  /** 一次采样：返回当下的数字，并和上一次相减算出速率。 */
  async sample() {
    const root = this.#proc.root;
    const at = this.#now();
    const [statText, memText, loadText, uptimeText, netText, diskText] = await Promise.all([
      read(join(root, "stat")),
      read(join(root, "meminfo")),
      read(join(root, "loadavg")),
      read(join(root, "uptime")),
      // 宿主机的网卡在 1 号进程的网络命名空间里；读不到时退回自己的。
      this.#proc.host
        ? read(join(root, "1/net/dev")).then((t) => t ?? read(join(root, "net/dev")))
        : read(join(root, "net/dev")),
      read(join(root, "diskstats")),
    ]);
    const cpuTimes = parseCpuTimes(statText);
    const mem = parseMeminfo(memText);
    const nets = parseNetDev(netText);
    const disk = parseDiskstats(diskText);
    const cgroup = await cgroupLimits(this.#cgroupRoot);
    const net = Object.values(nets).reduce((a, n) => ({ rx: a.rx + n.rx, tx: a.tx + n.tx }), {
      rx: 0,
      tx: 0,
    });
    const prev = this.#prev;
    const seconds = prev ? (at - prev.at) / 1000 : 0;
    const rate = (a, b) => (prev && seconds > 0 ? Math.max(0, (a - b) / seconds) : null);
    const cpu = cpuPercent(prev?.cpuTimes, cpuTimes);
    const containerCpu =
      prev && cgroup?.cpuUsageUs != null && prev.cgroup?.cpuUsageUs != null && seconds > 0
        ? round(((cgroup.cpuUsageUs - prev.cgroup.cpuUsageUs) / (seconds * 1e6)) * 100)
        : null;
    let fs = null;
    try {
      const s = await statfs(this.#dataDir);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      fs = { total, used: total - s.bfree * s.bsize, free };
    } catch {
      // 非 Linux 或目录不可读时不显示磁盘。
    }
    const load = loadText?.trim().split(/\s+/).slice(0, 3).map(Number) ?? null;
    const point = {
      at,
      cpu: cpu?.usage ?? null,
      memory: mem ? round((mem.used / mem.total) * 100) : null,
      disk: fs ? round((fs.used / fs.total) * 100) : null,
      load1: load?.[0] ?? null,
      rx: rate(net.rx, prev?.net.rx ?? 0),
      tx: rate(net.tx, prev?.net.tx ?? 0),
      diskRead: rate(disk.read, prev?.disk.read ?? 0),
      diskWrite: rate(disk.write, prev?.disk.write ?? 0),
      containerCpu,
      containerMemory: cgroup?.memoryUsed ?? null,
    };
    this.#prev = { at, cpuTimes, net, disk, cgroup };
    if (prev) {
      this.#history.push(point);
      if (this.#history.length > HISTORY_LIMIT) this.#history.shift();
    }
    this.#last = {
      point,
      cpu,
      mem,
      load,
      uptime: num(uptimeText?.split(/\s+/)[0]),
      fs,
      nets,
      net,
      disk,
      cgroup,
    };
    return this.#last;
  }

  /** 后台每 5 秒采样一次，页面打开时就有最近一小时的曲线。 */
  start() {
    if (this.#timer || this.#platform !== "linux") return () => {};
    void this.sample().catch(() => {});
    this.#timer = setInterval(() => void this.sample().catch(() => {}), SAMPLE_MS);
    this.#timer.unref?.();
    return () => this.stop();
  }
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async snapshot({ withProcesses = true } = {}) {
    const info = await this.#staticInfo();
    if (!info.linux)
      return {
        supported: false,
        info,
        reason: "主机监控需要 Linux（读取 /proc）；当前服务运行在 " + this.#platform + "。",
      };
    // 后台采样刚刚跑过时直接用它，避免两次相减间隔太短、速率失真。
    const current =
      this.#last && this.#now() - this.#last.point.at < SAMPLE_MS
        ? this.#last
        : await this.sample();
    let procs = null;
    if (withProcesses) {
      const now = this.#now();
      const elapsed = this.#procTicks ? ((now - this.#procAt) / 1000) * 100 * info.cores : 0;
      const result = await processes(
        this.#proc.root,
        this.#procTicks,
        elapsed,
        current.mem?.total ?? 0,
      );
      this.#procTicks = result.ticks;
      this.#procAt = now;
      const top = (key) =>
        [...result.list]
          .sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1))
          .slice(0, 8)
          .map(({ pid, name, state, cpu, memory, memoryPercent }) => ({
            pid,
            name,
            state,
            cpu,
            memory,
            memoryPercent,
          }));
      procs = { count: result.count, byCpu: top("cpu"), byMemory: top("memory") };
    }
    return {
      supported: true,
      at: this.#now(),
      scope: {
        procHost: this.#proc.host,
        proc: this.#proc.root,
        container: info.container,
      },
      info,
      cpu: current.cpu,
      memory: current.mem,
      load: current.load,
      uptime: current.uptime,
      disk: current.fs,
      diskIo: current.point
        ? { read: current.point.diskRead, write: current.point.diskWrite }
        : null,
      network: {
        rx: current.point?.rx ?? null,
        tx: current.point?.tx ?? null,
        totalRx: current.net.rx,
        totalTx: current.net.tx,
        interfaces: Object.entries(current.nets).map(([name, v]) => ({ name, ...v })),
      },
      cgroup: current.cgroup
        ? {
            version: current.cgroup.version,
            memoryLimit: current.cgroup.memoryLimit,
            memoryUsed: current.cgroup.memoryUsed,
            cpuLimit: current.cgroup.cpuLimit,
            cpu: current.point?.containerCpu ?? null,
          }
        : null,
      processes: procs,
      history: this.#history.slice(),
      service: {
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        rss: process.memoryUsage().rss,
      },
    };
  }
}
