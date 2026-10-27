import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostStats,
  cpuPercent,
  parseCpuTimes,
  parseDiskstats,
  parseMeminfo,
  parseNetDev,
  parseOsRelease,
} from "../selfhost/host-stats.mjs";

const NET = (rx, tx) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0
  eth0: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0
docker0: 5000 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0
vethab12: 7000 1 0 0 0 0 0 0 7000 1 0 0 0 0 0 0
`;

async function fakeProc(root, tick) {
  const busy = 1000 + tick * 300;
  const idle = 9000 + tick * 700;
  await mkdir(join(root, "proc/1/net"), { recursive: true });
  await mkdir(join(root, "proc/net"), { recursive: true });
  await mkdir(join(root, "proc/42"), { recursive: true });
  await mkdir(join(root, "proc/sys/kernel"), { recursive: true });
  await mkdir(join(root, "cgroup"), { recursive: true });
  await mkdir(join(root, "etc"), { recursive: true });
  const files = {
    "proc/stat": `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\n`,
    "proc/meminfo":
      "MemTotal:        4000000 kB\nMemFree:          500000 kB\nMemAvailable:    1000000 kB\nBuffers:          100000 kB\nCached:           900000 kB\nSwapTotal:       1000000 kB\nSwapFree:         750000 kB\n",
    "proc/loadavg": "0.50 0.40 0.30 1/200 4242\n",
    "proc/uptime": "93784.12 100000.00\n",
    "proc/1/net/dev": NET(1_000_000 + tick * 5_000_000, 2_000_000 + tick * 1_000_000),
    "proc/net/dev": NET(10, 10),
    "proc/diskstats": `   8       0 sda 100 0 ${2000 + tick * 20480} 0 100 0 ${4000 + tick * 40960} 0 0 0 0 0 0 0 0
   8       1 sda1 100 0 999999 0 100 0 999999 0 0 0 0 0 0 0 0
   7       0 loop0 1 0 999999 0 1 0 999999 0 0 0 0 0 0 0 0\n`,
    "proc/cpuinfo":
      "processor\t: 0\nmodel name\t: Test CPU @ 3.0GHz\n\nprocessor\t: 1\nmodel name\t: Test CPU @ 3.0GHz\n",
    "proc/sys/kernel/osrelease": "6.1.0-test\n",
    "proc/1/stat": `1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 ${10 + tick * 10} 0 0 0 20 0 1 0 1 100 1000 0`,
    "proc/42/stat": `42 (node server) R 1 42 42 0 -1 4194560 0 0 0 0 ${100 + tick * 100} 50 0 0 20 0 1 0 1 100 25000 0`,
    "cgroup/memory.max": "2147483648\n",
    "cgroup/memory.current": "104857600\n",
    "cgroup/cpu.max": "150000 100000\n",
    "cgroup/cpu.stat": `usage_usec ${1_000_000 + tick * 2_500_000}\nuser_usec 1\n`,
    "etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian"\n',
    "etc/hostname": "vps-tokyo\n",
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
}

test("主机监控：/proc 解析", () => {
  const a = parseCpuTimes("cpu  100 0 100 800 0 0 0 0\n");
  const b = parseCpuTimes("cpu  150 0 150 900 0 0 0 0\n");
  assert.deepEqual(cpuPercent(a, b), { usage: 50, iowait: 0, steal: 0 });
  assert.equal(cpuPercent(null, b), null);
  const mem = parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 250 kB\n");
  assert.equal(mem.total, 1024000);
  assert.equal(mem.used, 768000);
  assert.deepEqual(Object.keys(parseNetDev(NET(1, 2))), ["eth0"]);
  const disk = parseDiskstats(
    "8 0 sda 1 0 10 0 1 0 20 0 0 0 0\n8 1 sda1 1 0 99 0 1 0 99 0 0 0 0\n259 0 nvme0n1 1 0 2 0 1 0 4 0 0 0 0\n259 1 nvme0n1p1 1 0 9 0 1 0 9 0 0 0 0\n",
  );
  assert.deepEqual(disk.devices, ["sda", "nvme0n1"]);
  assert.equal(disk.read, 12 * 512);
  assert.equal(parseOsRelease('NAME="Alpine"\nVERSION="3.20"\n'), "Alpine 3.20");
});

test("主机监控：两次采样算出速率，容器视角与宿主机视角分得清", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000_000;
  const stats = new HostStats({
    dataDir: root,
    now: () => now,
    proc: { root: join(root, "proc"), host: true },
    platform: "linux",
    cgroupRoot: join(root, "cgroup"),
    hostEtc: join(root, "etc"),
    container: "docker",
  });
  await fakeProc(root, 0);
  await stats.snapshot();
  await fakeProc(root, 1);
  now += 5000;
  const snap = await stats.snapshot();
  assert.equal(snap.supported, true);
  assert.deepEqual(snap.scope, { procHost: true, proc: join(root, "proc"), container: "docker" });
  assert.equal(snap.info.hostname, "vps-tokyo");
  assert.equal(snap.info.os, "Debian GNU/Linux 12 (bookworm)");
  assert.equal(snap.info.cores, 2);
  assert.equal(snap.info.kernel, "6.1.0-test");
  assert.equal(snap.cpu.usage, 30);
  assert.equal(snap.memory.total, 4000000 * 1024);
  assert.equal(snap.memory.swapUsed, 250000 * 1024);
  assert.deepEqual(snap.load, [0.5, 0.4, 0.3]);
  assert.equal(snap.uptime, 93784.12);
  // 宿主机网卡读自 1 号进程的网络命名空间，跳过 lo / docker0 / veth。
  assert.equal(snap.network.rx, 1_000_000);
  assert.equal(snap.network.tx, 200_000);
  assert.deepEqual(
    snap.network.interfaces.map((nic) => nic.name),
    ["eth0"],
  );
  assert.equal(snap.diskIo.read, (20480 * 512) / 5);
  assert.equal(snap.cgroup.memoryLimit, 2147483648);
  assert.equal(snap.cgroup.cpuLimit, 1.5);
  assert.equal(snap.cgroup.cpu, 50);
  assert.equal(snap.history.length, 1);
  assert.equal(snap.processes.count, 2);
  assert.equal(snap.processes.byCpu[0].name, "node server");
  assert.equal(snap.processes.byMemory[0].memory, 25000 * 4096);
  assert.ok(snap.disk.total > 0);
});

test("主机监控：非 Linux 时说明原因，不报错", async () => {
  const stats = new HostStats({ dataDir: tmpdir(), platform: "win32" });
  const snap = await stats.snapshot();
  assert.equal(snap.supported, false);
  assert.match(snap.reason, /Linux/);
  assert.equal(typeof stats.start(), "function");
});
