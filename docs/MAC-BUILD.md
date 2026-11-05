# macOS 安装与本机构建

自 **1.17.7** 起，每次正式 Release 必须同时提供 Apple Silicon 与 Intel 的应用包，不再要求用户自行编译或下载 Actions 临时附件。

| 芯片                    | DMG                          | ZIP                          |
| ----------------------- | ---------------------------- | ---------------------------- |
| Apple Silicon（M 系列） | `Zhiyu-<版本>-mac-arm64.dmg` | `Zhiyu-<版本>-mac-arm64.zip` |
| Intel                   | `Zhiyu-<版本>-mac-x64.dmg`   | `Zhiyu-<版本>-mac-x64.zip`   |

从[正式下载页](https://github.com/Songwo/zhiyu/releases/latest)下载对应芯片的包。DMG 打开后将知屿拖入应用程序；ZIP 解压后同样拖入应用程序。升级前先保存编辑内容并退出旧版，保留原资料目录。应用内更新检查仅提醒并打开发布页，不会自动退出、替换或重启 Mac 程序。

当前 Mac 包**未进行 Apple Developer ID 签名及公证**。如系统拦截，请按 macOS「隐私与安全性」界面的说明核对来源后允许打开；不要全局关闭系统保护。发布流程检查应用版本、Mach-O 芯片架构、资源、执行权限、ZIP 完整性及 DMG 内应用，并在两个架构均成功后才公开 Release。这些检查不等于所有 Mac 设备及系统版本的实机验收。

历史 `mac-test-*` Pre-release 保留作历史记录，不作为当前下载目标。问题请附版本、芯片、macOS 版本与具体步骤，隐藏账号、密码和令牌。

## 本机构建

知屿使用 Electron，可在 macOS 本机开发和打包。项目持续集成使用 Node.js 22，最低需要 22.13；本机用量索引使用内置 SQLite。建议先使用相同版本与随附 npm，避免把 Node.js 26 / npm 12 的安装策略差异误判成代码错误。

```sh
npm ci
node node_modules/electron/install.js
npm run typecheck
node --test scripts/package-stage.test.mjs
npm run desktop:pack -- --mac --arm64
```

Intel Mac 将最后一条的 `--arm64` 换成 `--x64`，并在对应架构的机器和 Node.js 环境运行。产物在 `release/v<版本>/mac-arm64/Zhiyu.app` 或 `release/v<版本>/mac/Zhiyu.app`。需要 DMG 时使用 `npm run desktop:dist -- --mac --arm64`（Intel 使用 `--x64`）。

Electron 下载受网络影响时，可只为此次安装设置可信镜像，例如：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

这仅调整 Electron 运行时下载地址。不要使用全局 `allow-remote=all` 绕过 npm 的远程依赖保护，也不要删除锁文件或用 `--force` 掩盖依赖不一致。

打包器现在先解析暂存目录的真实路径，并只用该目录作为 npm 子进程的 `cwd`，不再额外传入 `--prefix`。这解决了 macOS 的 `/var` → `/private/var` 路径别名导致刚生成的锁文件被 `npm ci` 判断为不同步的问题；打包前还会检查主进程依赖的版本与仓库锁定版本一致。

GitHub Actions「全平台正式版」在 Apple Silicon 和 Intel runner 上分别生成 DMG、ZIP，并挂载 DMG 校验内容。Windows 与两个 Mac 架构通过后，汇总真实附件摘要，生成包含四个 Mac 文件的 `latest-mac.yml`，核对 GitHub 上传摘要后才公开 Release。旧的独立 Mac 检查工作流可用于开发诊断，不能替代正式发布闸门。
