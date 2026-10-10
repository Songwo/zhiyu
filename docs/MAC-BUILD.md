# macOS 测试版与本机构建

## 公开测试版下载

macOS 测试包采用独立的 **Pre-release（公开测试版）**，标签以 `mac-test-` 开头。当前可下载的是 [macOS 1.7.1 测试版](https://github.com/Songwo/zhiyu/releases/tag/mac-test-1.7.1.1)，开发中的 1.7.2 尚未发布。每个测试版页面会说明实际应用版本、验证范围和构建来源。

| Mac 芯片                                      | 选择的 ZIP                    |
| --------------------------------------------- | ----------------------------- |
| Apple Silicon（M1、M2、M3、M4、M5 等 M 系列） | 文件名含 `mac-arm64-unsigned` |
| Intel                                         | 文件名含 `mac-x64-unsigned`   |

解压对应 ZIP 后，将 `Zhiyu.app` 放入「应用程序」。发布页同时提供 `SHA256SUMS.txt` 和 `BUILD-VERIFICATION.json`，用于核对下载文件的 SHA-256、源码提交、应用版本与 CPU 架构。两个架构的测试包分别构建，请按芯片选择。

这些程序未使用 Apple Developer 证书签名，也未完成 Apple 公证。若系统阻止打开，可参考 [Apple 关于打开来自未知开发者应用的说明](https://support.apple.com/zh-cn/102445)，确认来源后再决定是否打开。

维护者目前没有 Mac 实机。[社区用户曾反馈](https://github.com/Songwo/zhiyu/issues/2#issuecomment-6072196096)，**1.6.0 的 arm64 包在 MacBook Air M5 上使用正常**，并提供了界面截图。这是该设备与该版本的使用反馈，不能代表后续版本、Intel 设备、所有 macOS 版本或全部功能均已通过实机验证。公开测试版不会替代 Windows 正式版，也不会成为 Windows 自动更新目标。

如遇问题，欢迎在 [Issue #2](https://github.com/Songwo/zhiyu/issues/2) 补充 macOS 版本、芯片类型、应用版本、复现步骤和错误表现；分享截图或日志前，请隐藏账号、密码、令牌等个人信息。

## 在本机构建

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

GitHub Actions 的「macOS 打包检查」分别在 Apple Silicon 和 Intel runner 上生成 `.app` 并校验二进制架构，上传的 ZIP 是未签名测试产物。「macOS 公开测试版发布」在选定成功构建后，核对来源正式标签的提交、Actions 附件摘要、ZIP 完整性、应用版本与架构，再将原始 ZIP 发布为独立 Pre-release。发布过程中不重新打包程序，也不执行 Apple Developer ID 签名与公证；不能把这些测试 ZIP 描述为已签名正式安装包。
