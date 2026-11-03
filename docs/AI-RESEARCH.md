# 联网检索与原文提示

## 入口与边界

桌面端的资产详情、AI 工作台和文档阅读页提供「联网检索」。Linux.do 主身份在个人资料中连接，搜索只发送用户确认的查询文字。默认种子只取服务商、系统、注册商或证书签发者，不拼入主机地址、邮箱、密码、卡号、备注或文档正文。

「设置 → 模型与知识库 → Jev 文档提示」配置用户自己的 TypeSafe Key、模型、分类依据及显示方式。每次手动分析需授权本次发送正文，不自动分析打开的文档。

两项能力目前依赖桌面主进程。本次没有为自托管网页新增 Linux.do 主身份登录和共享搜索付款流程；网页原有资产、卡片和内置图标继续可用。

## Jev 只标记当前原文

Jev 对每个段落做结构化分类，返回类别和模型置信度，不生成自由形式的思考过程。分类名称、说明、颜色、阈值可修改。支持段落高亮、下划线、仅显示定位条目或隐藏标记，另有字号、行距和阅读宽度设置。

标记通过临时 DOM 属性和样式作用于当前正文，不写入文档 JSON 或 Markdown，不新建、复制、重命名或覆盖工作区文档。定位条目仅显示类别、段落位置与置信度，点击回到原文，不另外复制出一篇摘录。分析前后的文档数量和原文内容应完全一致。

真实请求按条目显示每段的状态、结果与耗时。过程在完成后可折叠查看，让原文保持为阅读主体。切换颜色、阈值或显示样式复用当前结果，不再次调用 Jev；改变模型或分类依据、关闭功能、更换密钥会停止旧任务。关闭面板移除标记，当前阅读会话重新打开可恢复；离开文档、开始编辑或原文版本变化会清理旧判断。

当前每次最多 50 段，每段最多 6000 字；标题、正文、列表、引用和表格单元格按可见叶节点处理，排除代码块。超限时发送前说明。结果不是永久批注，重新打开文档需按需分析。Key 经操作系统安全存储加密保存在 `document-analysis.json`，不进入资产快照或 AI 问答上下文；此配置不随资产同步，迁移电脑需重新设置。

## 免费、已购额度和记录

- 每个已验证的 Linux.do 主体一次性赠送 50 次，服务端按稳定身份标识记账，重装和改昵称不重新赠送。
- 免费次数用完后使用已购次数。10 LDC 购买 100 次，余额、累计购买、累计使用分开显示。
- 没有任何剩余额度时，先成功取得本次搜索结果并加密落盘，才允许核验预算并进入购买。付款确认后入账 100 次，再使用 1 次解锁已准备的结果，余额 99 次；解锁不再次调用 Exa。
- 无可用结果、失败、取消、Exa 402 和服务中断不扣用户免费或已购次数；成功交付才消耗 1 次。
- 搜索与购买记录保留状态、时间、次数、积分金额、成功订单号，按页读取。客户端不能自行修改余额或指定其他用户。

LDC 付款是用户在 Linux.do Credit 页面确认积分流转，Connect 登录不授予静默扣分权限。前端回跳不代表成功；服务端必须验签、校验金额和订单，并主动查单，再通过事务入账。重复通知和并发查单不能重复入账。创建状态未知的订单保留待核实，不生成新的重复订单。

## Exa 预算核验

公开 Search API 的 `costDollars` 是费用估算；Team Management API 提供 Key 预算和用量报告。它们都不是整个 Exa 团队的实时可用余额，不能把 Key 有效或一次搜索成功当作还有 100 次可出售的证明。

因此缺少可核实余额时默认关闭积分购买。可以接维护者可信的账务读取器，或者由维护者真实核对后提供的短期余额快照。**人工核对快照不是自动读取官方实时余额**。数据超过 60 秒、来源不明、余额不足或读取失败时都禁止创建 LDC 订单。

可售预算扣除已知请求估算、已售但未使用的额度承诺和待付款预留。每 100 次按每次 0.05 美元的保守上限预留，避免多笔订单重复出售同一预算；此上限是站点保护值，不是 Exa 官方定价。默认站点日请求估算预算上限为 5 美元。建议使用独立受控的 Exa Key 和可单独核对的资金池，其他项目对同一团队余额的消耗也要纳入核验。

Exa 返回 402 后禁止新积分订单，实际搜索成功后解除。已有用户余额保留，失败不扣次数。本地预留不是 Exa 官方冻结资金，维护者仍需维持已售额度所需的服务。余额不可自动核实时，保持购买关闭比伪造余额更合适。

## 服务端配置

在原有独立登录服务的受保护 JSON 配置或环境增加以下字段；共享 Key 不进入桌面包、网页脚本或仓库。启用搜索需要 Node.js 22.13 以上，未启用 Exa 时原登录流程仍可使用。

| 配置项 | 用途 |
| --- | --- |
| `EXA_API_KEY` | 维护者的 Exa Search Key |
| `ZHIYU_SEARCH_DB` | 持久化 SQLite 账本绝对路径 |
| `ZHIYU_RESEARCH_ENCRYPTION_KEY` | 独立的 32 字节 Base64 长期结果加密密钥 |
| `LDC_CLIENT_ID` / `LDC_CLIENT_SECRET` | LDC 商户应用配置，不是 Connect 登录密钥 |
| `ZHIYU_EXA_BALANCE_FILE` | 可选可信余额快照路径；缺省禁止购买 |

快照结构为 `{ "source": "operator-verified", "availableUsd": 真实核对的余额, "checkedAt": 实际采样的毫秒时间戳 }`。不要通过改文件时间或定时更新 `checkedAt` 把过期数据伪装成新核验。余额读取器还接受 `source: "exa-billing"`，供维护者接入自己有权限的可靠账务来源；没有此来源时保持收费关闭。

SQLite 采用事务与唯一请求、订单标识实现幂等。结果使用 AES-256-GCM，并绑定任务标识。账本和长期结果密钥应一起受保护备份；它与 OAuth 会话密钥分开，正常轮换会话密钥不应破坏已付费结果。长期结果密钥需要先迁移已有密文再轮换。不要删除账本以重新赠送免费次数。

现有登录服务升级时保留 `LINUXDO_CLIENT_ID`、`LINUXDO_CLIENT_SECRET` 和 `SESSION_ENCRYPTION_KEY`，使用 Node.js 22.13+ 启动新代码。只启用免费检索需要 Exa Key、账本绝对路径和独立结果加密密钥；LDC 商户和余额读取器可暂不配置，此时积分购买关闭。配置后 `/healthz` 应同时返回 `configured: true` 与 `researchConfigured: true`，客户端点击「刷新检索额度」即可使用，不需要重新授权。

systemd 采用 `ProtectSystem=strict` 时，还需给账本建立受保护的可写持久目录，例如以下服务覆盖项；将 `ZHIYU_SEARCH_DB` 指向 `/var/lib/zhiyu-identity/research.sqlite`，运行用户沿用专用的 `zhiyu-identity`。只为本服务指定新 Node 运行时，不必升级其他程序使用的系统 Node。

```ini
[Service]
StateDirectory=zhiyu-identity
StateDirectoryMode=0700
ReadWritePaths=/var/lib/zhiyu-identity
```

## HTTP 契约

以下 JSON POST 接口都验证原有主身份 Bearer 凭据，以服务端解密出的主体限定数据归属：

| 路径 | 输入 | 输出 |
| --- | --- | --- |
| `/v1/research/quota` | `{}` | 免费、已购计数及购买配置状态 |
| `/v1/research/start` | `{requestId,query}` | 幂等检索任务 |
| `/v1/research/status` | `{id}` | 真实条目进度，完成后返回来源和摘录 |
| `/v1/research/cancel` | `{id}` | 中止活动检索 |
| `/v1/research/records` | `{offset}` | 记录与下一页偏移量 |
| `/v1/research/checkout` | `{id}` | 结果与可售预算就绪后才返回支付地址 |

GET `/v1/research/payment/notify` 为验签和主动查单后的通知入口；GET `/v1/research/payment/return` 仅显示回跳提示。客户端用 HTTP 轮询更新，在无 WebSocket 的环境中也能逐条显示。

## 来源和验证边界

2026-11-03 核对的主要资料：

```text
https://exa.ai/docs/reference/search.md
https://exa.ai/docs/team-management-spec.yaml
https://exa.ai/docs/admin/billing.md
https://docs.typesafe.ai/api/system-one.md
https://docs.typesafe.ai/introduction/quickstart.md
https://github.com/linux-do/credit/blob/a57867678d030718748f8b89f67a5d0a9c3d5f0d/frontend/components/common/docs/api.tsx
```

自动化用本机 HTTP 模拟供应商验证序列化、请求头、错误、取消、身份隔离和幂等记账，Electron 验证设置、原文高亮和额度界面。2026-11-03 经维护者授权，已升级独立公网服务并使用真实 Exa Key 验证搜索，当前已登录身份的免费额度从 50 次变为 49 次，实际返回结果、进度和消耗记录一致。该验证没有进行 LDC 支付；LDC 商户与可信 Exa 余额来源尚未配置，积分购买保持关闭。TypeSafe 仍只有本机协议与界面回归，未宣称真实 Key 验收。
