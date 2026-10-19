import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

const PAGE = "https://github.com/Songwo/zhiyu/releases/latest";
const MANUAL_UPDATE = "便携版请在发布页下载新的便携压缩包，解压覆盖程序文件，保留 data 文件夹。";

/** 安装前再次核对已下载文件，拒绝被替换或截断的安装包。 */
export async function verifyInstaller(file, expected) {
  if (!file || !expected || !/^[A-Za-z0-9+/]{86}==$/.test(expected.sha512 ?? ""))
    throw new Error("更新包缺少有效校验信息，请重新下载。");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size)
    throw new Error("更新包大小不符，请重新下载。");
  const hash = createHash("sha512");
  for await (const part of createReadStream(file)) hash.update(part);
  if (hash.digest("base64") !== expected.sha512) throw new Error("更新包校验失败，请重新下载。");
}

/** 引擎只由主进程注入；渲染进程不能指定下载地址、文件路径或安装命令。 */
export class DesktopUpdater {
  constructor({
    engine,
    current,
    supported,
    manual = false,
    publish = () => {},
    prepare = async () => {},
  }) {
    this.engine = engine;
    this.supported = supported;
    this.manual = manual;
    this.publish = publish;
    this.prepare = prepare;
    this.state = { state: "idle", current, page: PAGE, ...(manual ? { manual: true } : {}) };
    this.job = null;
    this.downloaded = null;
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.allowPrerelease = false;
    engine.allowDowngrade = false;
    engine.disableWebInstaller = true;
    engine.on("download-progress", (progress) => {
      if (this.state.state !== "downloading") return;
      this.update({
        progress: Math.max(0, Math.min(100, progress.percent)),
        transferred: progress.transferred,
        total: progress.total,
      });
    });
    engine.on("error", () => {
      // 异步安装错误也必须回到可重试状态，不能永远停在安装中。
      this.update({ state: "error", reason: "更新失败，请检查网络或安装权限后重试。" });
    });
  }

  status() {
    return { ...this.state };
  }
  update(patch) {
    this.state = { ...this.state, ...patch };
    this.publish(this.status());
    return this.status();
  }
  run(action) {
    if (this.job) return this.job;
    this.job = action()
      .catch((error) => {
        this.update({ state: "error", reason: error.message || "更新失败，请稍后重试。" });
        return this.status();
      })
      .finally(() => {
        this.job = null;
      });
    return this.job;
  }
  check() {
    if (["downloaded", "installing"].includes(this.state.state))
      return Promise.resolve(this.status());
    return this.run(async () => {
      if (!this.supported)
        return this.update({
          state: "unavailable",
          reason: "应用内更新仅支持 Windows 正式安装版。",
        });
      this.update({ state: "checking", reason: undefined, progress: undefined });
      const result = await this.engine.checkForUpdates();
      if (!result) throw new Error("暂时无法检查更新，请稍后重试。");
      const info = result.updateInfo;
      this.available = result.isUpdateAvailable === true;
      this.info = info;
      return this.update({ state: this.available ? "outdated" : "current", latest: info.version });
    });
  }
  download() {
    return this.run(async () => {
      if (this.manual) throw new Error(MANUAL_UPDATE);
      if (!this.supported || !this.available) throw new Error("请先检查可用的新版本。");
      if (this.state.state === "installing") return this.status();
      this.downloaded = null;
      this.update({ state: "downloading", progress: 0, reason: undefined });
      const files = await this.engine.downloadUpdate();
      const expected = this.info.files?.find((file) => /\.exe(?:\?|$)/i.test(file.url));
      const file = files.find((path) => /\.exe$/i.test(path));
      await verifyInstaller(file, expected);
      this.downloaded = { file, expected };
      return this.update({ state: "downloaded", progress: 100 });
    });
  }
  install() {
    if (this.state.state === "installing") return Promise.resolve(this.status());
    return this.run(async () => {
      if (this.manual) throw new Error(MANUAL_UPDATE);
      if (!this.supported || !this.downloaded || this.state.state !== "downloaded")
        throw new Error("请先完整下载并校验更新包。");
      await verifyInstaller(this.downloaded.file, this.downloaded.expected);
      await this.prepare();
      this.update({ state: "installing", reason: undefined });
      // 先让 IPC 返回，让界面显示安装状态；只在明确点击后启动安装器。
      setTimeout(() => {
        try {
          this.engine.quitAndInstall(true, true);
        } catch {
          this.update({ state: "error", reason: "更新失败，请检查网络或安装权限后重试。" });
        }
      }, 300);
      return this.status();
    });
  }
}
