# 0.2.0 发布验证记录

验证日期：2026-09-07。目标：Windows x64，Electron 44.1.1。

## 通过的检查

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 0 个错误，8 个已有警告 |
| `npm run i18n:check` | 521 个字面量键、637 个翻译条目 |
| `npm test` | 298 项通过，包含服务端模块与 TypeScript 业务测试 |
| `npm run desktop:build` | 通过 |
| `npm run build` | 通过；未配置 DATABASE_URL，本地桌面版本不使用该数据库，迁移按项目规则跳过 |
| `node scripts/agent-integration.mjs` | 首次设置、模型协议、流式与最终正文、Markdown、来源、工具、取消、持久化通过 |
| `node scripts/frontend-integration.mjs` | 表格、关系图、分页、筛选、减少动态效果通过 |
| `node scripts/desktop-integration.mjs` | 指标、托盘、关联、ICS 通过 |
| `npm run desktop:dist -- --win --x64` | 成功生成 NSIS 安装包 |
| `node scripts/release-smoke.mjs release/v0.2.0/win-unpacked/Nanpad.exe` | 实际打包程序的版本、隔离数据目录、首次设置、重载保留姓名、四家服务商、禁用演示数据、无页面错误均通过 |

包内 `package.json` 版本为 0.2.0，主进程、preload、AI 账号、Agent、个人资料源码与工作区逐字节一致。应用声明的运行依赖为 ssh2、imapflow、openai、minisearch；归档未包含后端测试和用户资料文件。

桌面、移动版与 Markdown 截图已人工查看。安装包生成后验收了其打包程序；没有在日常环境重新安装或覆盖现有安装。

## 未通过或未验证的项目

- 网页开发和生产 smoke 均检测到平台外部脚本 `https://grok.com/grok-app-builder/extensions.js` 加载失败，错误为 `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`，因此两次 smoke 整体退出码均为 1。页面有可见内容、无溢出、无 pageError，开发与生产一致。按平台要求保留该脚本，没有隐藏或屏蔽错误。桌面构建不依赖此脚本。
- OpenAI、Claude、Grok、Gemini 授权使用自动化协议测试验证。未代替用户登录四家真实账号，实际账号权限、地区可用性和额度响应需要账号持有人完成登录后确认。
- 未提供签名证书，Windows 安装包 Authenticode 状态为 `NotSigned`。没有发布或验证 macOS/Linux 安装包。
- 未使用用户私密 API Key 对远端模型进行本次发布验收；本地 RAG、Agent 与 OpenAI 兼容调用链通过隔离协议服务测试。

## 下载校验

文件：`Nanpad-0.2.0-setup.exe`，114011295 字节。

SHA256：

```text
54a6c7c35689ccbbe70126e5550096218374366e65ca864b9e1734172362ffa2
```
