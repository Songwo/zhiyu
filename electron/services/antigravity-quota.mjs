import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function parseAntigravityQuota(stdout) {
  const windows = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const [pool, period, quota, reset] = line
      .trim()
      .split("\t")
      .map((value) => value.trim());
    const match = /^(\d+(?:\.\d+)?)%$/.exec(quota ?? "");
    const seconds = /^Five Hour Limit Remaining$/i.test(period)
      ? 18000
      : /^Weekly Limit Remaining$/i.test(period)
        ? 604800
        : null;
    if (!pool || !seconds || !match || Number(match[1]) > 100) continue;
    const timestamp = Date.parse(reset);
    const model = pool.slice(0, 100);
    const label = `${model}/${seconds === 18000 ? "five_hour" : "seven_day"}`;
    windows.set(label, {
      label,
      model,
      usedPercent: Math.round((100 - Number(match[1])) * 100) / 100,
      resetsAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      windowSeconds: seconds,
    });
  }
  return [...windows.values()].slice(0, 64);
}

/** 只在用户主动读取时调用，独立于知屿里已授权的 Google 账号。 */
export async function readAntigravityQuota() {
  const cwd = await mkdtemp(join(tmpdir(), "zhiyu-agy-"));
  try {
    const { stdout } = await run(
      process.platform === "win32" ? "agy.exe" : "agy",
      ["-p", "/usage", "--print-timeout", "20s"],
      { cwd, timeout: 25000, windowsHide: true, maxBuffer: 256 * 1024 },
    ).catch((error) => {
      throw new Error(
        error.code === "ENOENT"
          ? "找不到 Antigravity CLI。安装后请重新启动知屿。"
          : "读取 Antigravity CLI 额度失败，请检查本机 CLI 的登录状态。",
      );
    });
    const windows = parseAntigravityQuota(stdout);
    if (!windows.length)
      throw new Error("Antigravity CLI 未返回可识别的额度，请确认 CLI 已登录且支持额度查询。");
    return { checkedAt: new Date().toISOString(), windows };
  } finally {
    // Windows 上 CLI 子进程可能短暂持有工作目录，清理失败不覆盖读取结果。
    await rm(cwd, { force: true, recursive: true, maxRetries: 3 }).catch(() => {});
  }
}
