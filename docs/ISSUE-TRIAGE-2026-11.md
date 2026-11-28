# 用户反馈处理记录（2026-11-10）

## #5：Web SSH 指纹恢复入口

已在 1.17.6 发布修复。当前版本保留终端错误入口、服务器编辑入口、完整主机地址与端口确认、重置后不自动重连；本轮重新运行真实 Web 构建与隔离 SSH 服务回归。

## #6：邮箱 OAuth2

已确认现有授权只核验身份。下一小版本先明确身份验证标题、权限边界和成功提示，桌面与 Web 共用实现。

完整邮件 OAuth2 仍未实现，issue 保持开启。验收需覆盖独立邮件权限同意、Google/Microsoft 正确邮件权限、加密令牌保存、刷新并发与失效、撤销/断开、IMAP/SMTP 或 API 收发，以及锁库行为；不得把身份授权令牌当作邮件授权，也不得静默扩大已有授权。真实供应商账号授权和收发成功不能由本地测试替代。

## #7：生物认证

1.17.12 已加入 Mac Touch ID 快捷解锁：用户主动开启，主进程验证，钥匙串加密保存本机派生密钥，主密码恢复入口保留。自动化测试覆盖取消、锁屏与关闭并发、改密失效和非 Mac 隐藏入口；恢复备份后清除本机材料。没有带 Touch ID 的 Mac 实机验收记录，issue 保持开启，待硬件上验证后关闭。Web 不展示入口。

## 发布范围

本记录不表示新版本已发布。下次正式发布只列实际实现并验证的改动，继续执行 Windows 与 Mac arm64/x64 四包的统一发布门禁，同步 Web 镜像、README、Pages 和下载验收。

## 本机验收：macOS 通知授权被拦截（2026-11-28，待处理）

用户要求先记录，后续再处理；本轮未修改通知代码、应用签名或系统权限。

- 环境：macOS 26.5.1、Apple Silicon、Electron 44.1.1；使用独立验收资料目录运行开发客户端。
- 现象：当天到期资产已开启提醒，提醒候选计算正常，但等待一分钟后没有系统通知，也未出现授权弹窗；系统通知设置中未找到该开发客户端入口。
- 已核实：Electron 会调用系统授权接口，但系统日志记录 `requestAuthorization not allowed: com.github.Electron`、`addRequest not allowed: com.github.Electron`；发送失败事件返回 `UNErrorDomain` 错误 1。请求在用户选择允许或拒绝之前已被系统拦截，不能解释为用户拒绝了授权。
- 签名异常：开发客户端只有链接器生成的临时签名，签名标识为 `Electron`，应用声明标识为 `com.github.Electron`，`Info.plist=not bound`；`codesign --verify --strict` 校验失败。LaunchServices 已有该应用注册记录。已安装的 `/Applications/Zhiyu.app` 也观察到同类签名结构问题。
- 判断与边界：当前明确阻断点是应用身份／签名未满足系统通知授权条件；[Electron 44.1.1 官方说明](https://github.com/electron/electron/blob/v44.1.1/docs/tutorial/notifications.md#macos)要求 macOS 通知使用经过代码签名的应用。尚未完成正确签名副本的对照实验，不能声称重新签名后已经恢复。
- 关联缺陷：`electron/main.mjs` 仅检查 `Notification.isSupported()`，未处理通知发送失败；`NotificationTracker.take()` 在发送前记录去重时间，失败仍可能被 24 小时去重挡住。每分钟检查不等于每分钟重试成功投递。
- 后续验收：获准处理后，在独立副本上验证正确签名与应用注册、首次授权弹窗、允许后的通知投递，以及关闭窗口但保持后台运行时的到期提醒；另行修复并验证失败后的去重／重试逻辑。不得覆盖现有正式资料，也不得将本记录视为修复或发布完成。
