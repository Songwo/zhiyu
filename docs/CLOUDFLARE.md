# Cloudflare 接入

知屿通过 Cloudflare 官方 REST API 读取域名、Workers、Pages 和 Tunnel。账户列表用于确定资源范围；账户列表无权限时，会继续尝试从域名所属账户读取对应资源。每一类资源独立报告失败，权限不足不会让其他可读取的资源消失。

## Token 权限

创建自定义 API Token，按要使用的功能授予最小权限并限制账户、域名范围。仅查看资源不需要写权限。

| 功能         | 所需读取范围      |
| ------------ | ----------------- |
| 账户发现     | 账户设置          |
| 域名发现     | Zone              |
| DNS 列表     | DNS               |
| Workers 清单 | Workers Scripts   |
| Pages 清单   | Cloudflare Pages  |
| Tunnel 清单  | Cloudflare Tunnel |

新增、修改、删除 DNS 另外需要对应 Zone 的 DNS 编辑权限。不要使用 Global API Key，也不要将 Token 放进资源地址、文档、截图或 Git 配置。

## 资源与状态

- Zone 展示 Cloudflare 的域名状态。
- Tunnel 展示 Cloudflare 的 `healthy`、`degraded`、`inactive` 或 `down` 状态。
- Workers 和 Pages 清单只能证明资源存在；未执行主动探测时，状态为未知。可在探针中建立 HTTP 检查获得实际可用性。
- Pages 使用官方返回的 `*.pages.dev` 地址；Workers 清单不包含完整访问地址，因此不拼接猜测出来的 URL。
- 同一账户下资源按类型和远端标识区分。账户、Zone、Pages、Tunnel、DNS 逐页读取；Workers 的官方清单接口为单页。

## DNS 支持

可查看所有记录类型；高级记录仅展示经过白名单筛选的标量字段。当前可新增或修改 A、AAAA、CNAME、TXT、MX、NS。SRV、CAA、HTTPS 等高级记录请前往 Cloudflare 控制台编辑，也可在知屿查看后删除。

记录名称填写完整域名，例如 `www.example.com` 或 `_dmarc.example.com`；支持中文域名转换为 Punycode 和左侧通配符。不接受省略域名的 `@`。TTL 支持自动（1）或 60–86400 秒；开启代理时使用自动 TTL。Enterprise 专属 30 秒 TTL 当前仅可读取。MX 必须填写 0–65535 的优先级。

更新使用 PATCH，只发送支持的字段，保留未编辑的服务商高级配置。DNS 变更通过桌面端预览及确认后提交；网络失败后的最终状态应重新读取 Cloudflare 核对，客户端不会自动重试不明确的写入结果。

## 请求边界

请求固定发往 `https://api.cloudflare.com/client/v4`，不会跟随重定向。Token 不进入资源 DTO，服务商错误正文和网络错误原文不会直接展示给界面。

每次请求（包括读取响应体及限流等待）默认 15 秒截止，HTTP 429 最多重试两次，并遵守 `Retry-After`。服务商要求等待超过 10 秒时，直接提示稍后重试，不提前重发。分页最多 100 页，单次清单最多 10000 条，账户最多 100 个，单页响应体最多 8 MiB；到达边界会明确报错或给出该类资源的失败提示，不把截断结果标作完整清单。

## 接口依据与验证范围

接口依据为 Cloudflare 官方 API 和当前官方 TypeScript SDK（2026-10-12 核对）：

- [Cloudflare API](https://developers.cloudflare.com/api/)
- [账户](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/accounts/accounts.ts)
- [域名](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/zones/zones.ts)
- [Workers](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/scripts.ts)
- [Pages](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/pages/projects/projects.ts)
- [Tunnel](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/zero-trust/tunnels/cloudflared/cloudflared.ts)
- [DNS](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/dns/records.ts)

协议测试使用合成响应覆盖分页、权限、限流、重定向、超时、取消、DNS CRUD、输入校验和敏感数据隔离。开发阶段未使用真实用户 Token，也未修改真实 Cloudflare 资源。
