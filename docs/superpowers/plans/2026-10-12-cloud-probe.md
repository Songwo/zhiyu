# Cloudflare 与知屿独立探针实施契约

目标：提供真实可部署的知屿 Agent、常驻监控服务端，以及桌面端 Cloudflare 资源、DNS 和探针管理。用户已选择独立 Agent/服务端并授权继续实现；本轮只本地提交，不推送、不发布、不改生产部署。

## 架构和范围

- `services/probe/`：独立 Go 模块，HTTP API 与 gRPC 共用监听端口。命名空间 `zhiyu.probe.v1.ProbeService`。公网 TLS，显式 `--insecure` 才启用 h2c。Agent 每 3 秒报告主机状态，服务端持久化历史、判定离线并执行 HTTP/TCP 服务检查。无远程执行命令入口。
- `electron/services/cloudflare.mjs`：固定官方 API origin，分页、退避、资源白名单与 DNS CRUD。不保存凭据。
- `electron/services/integrations.mjs`：OS safeStorage 加密配置（拒绝 basic_text），脱敏 DTO、缓存/单飞/请求代次、DNS 一次性预览、探针 API、资产幂等绑定。无需解锁资产密钥库即可监控。
- `src/components/integrations/`：统一设置入口、Cloudflare 资源/DNS 管理、探针主机/历史/服务检查。复用资产卡片、选择框和 EditorDialog，懒加载图表。
- `src/lib/integrations.ts`：前后端共享公开类型。资产 `integration` 仅保存公开远端引用，不保存凭据。

## 桌面 IPC 契约

`desktop()?.integrations` 暴露下列 Promise 方法。方法错误由现有 IPC 包装为 Error。

```ts
list(): Promise<IntegrationConnection[]>;
save(input: {id?:string; provider:'cloudflare'|'probe'; name:string; endpoint?:string; token?:string; allowInsecure?:boolean}): Promise<IntegrationConnection>;
remove(id:string): Promise<void>;
inventory(id:string, force?:boolean): Promise<IntegrationInventory>;
bind(input:{connectionId:string; resourceKey:string; assetId?:string}): Promise<{kind:'domain'|'service'|'server';id:string}>;
unbind(input:{kind:'domain'|'service'|'server';id:string}): Promise<void>;
dnsList(connectionId:string,zoneId:string,force?:boolean): Promise<DnsRecord[]>;
dnsPreview(input:{connectionId:string;zoneId:string;action:'create'|'update'|'delete';recordId?:string;record?:DnsInput}): Promise<DnsProposal>;
dnsApply(ticket:string): Promise<void>;
probeHistory(connectionId:string,hostId:string,range:'1h'|'24h'|'7d'): Promise<ProbeSample[]>;
probeCheckHistory(connectionId:string,checkId:string,range:'1h'|'24h'|'7d'): Promise<ProbeCheckResult[]>;
probeEnroll(connectionId:string,name:string): Promise<{id:string;secret:string}>;
probeRevoke(connectionId:string,hostId:string): Promise<void>;
probeSaveCheck(connectionId:string,input:ProbeCheckInput): Promise<void>;
probeDeleteCheck(connectionId:string,id:string): Promise<void>;
```

## 探针 HTTP 契约

所有 `/api/v1/*` 使用独立管理员 `Authorization: Bearer`。`/healthz` 仅无敏感健康状态。JSON 成功为直接对象/数组，失败 `{error:string}`。Agent 独立的随机 secret 服务端只保存哈希。

- `GET /api/v1/hosts` → `ProbeHost[]`
- `POST /api/v1/hosts {name}` → `{id,secret}`（仅此次返回 secret）
- `DELETE /api/v1/hosts/:id` → 204（撤销上报能力，并踢出既有流）
- `GET /api/v1/hosts/:id/history?range=1h|24h|7d` → `ProbeSample[]`（限制返回点数）
- `GET /api/v1/checks` → `ProbeCheck[]`
- `POST /api/v1/checks ProbeCheckInput` → `ProbeCheck`
- `DELETE /api/v1/checks/:id` → 204
- `GET /api/v1/checks/:id/history?range=...` → 检查结果数组

Agent 使用 `client-uuid`、`client-secret` metadata，报告 CPU、内存、swap、磁盘、网络累计/速率、uptime/load、TCP/UDP/进程数；不可用指标缺省或 null，不伪造零。温度/GPU 仅在采集器可用时显示。

## 公共 DTO（准确属性以 src/lib/integrations.ts 为准）

所有日期 ISO 8601 UTC，桌面本地时间展示。CPU/memory/disk/swap 为 0–100 百分比；流量 bytes，速率 bytes/s。`ProbeSample.at` 由服务端接收时间确定，不相信主机时钟。

`ProbeHost {id,name,hostname,os,arch,status:'online'|'offline'|'pending',lastSeen:string|null,latest:ProbeSample|null}`。

`ProbeSample {at,cpu?,memory?,swap?,disk?,memoryTotal?,diskTotal?,networkRx?,networkTx?,rxRate?,txRate?,uptime?,load1?,load5?,load15?,tcp?,udp?,processes?,temperature?,gpu?}`，指标为 `number|null`。

`ProbeCheckInput {id?,name,type:'http'|'tcp',target,intervalSeconds,timeoutMs}`；`ProbeCheck` 加 `status:'up'|'down'|'pending',lastCheckedAt:string|null,latencyMs:number|null,message:string,uptime24h:number|null`。

服务端检查仅接受 HTTP(S) URL 或 TCP host:port；不使用 URL 内嵌凭据。允许用户自身内网，但拒绝云 metadata/link-local、multicast/unspecified 地址及跳转绕过。检查并发、响应大小、超时、历史容量均有上限。

## 实施与验收顺序

- [x] 服务端任务：实现 Go Agent/Server、protobuf 契约、真实流式协议测试、凭据撤销/重连/持久化/时间线测试；提供 Docker、systemd、配置示例和中文部署说明；执行 gofmt/build/vet/test/race。
- [x] Cloudflare 任务：按官方接口实现账户/Zone/Workers/Pages/Tunnel inventory 与 DNS CRUD；测试分页、权限局部失败、429、非法记录、超时和不泄露 Token。
- [x] 桌面后端任务：共享类型、加密配置、连接代次/单飞/缓存、预览确认、白名单 DTO、幂等导入和编辑保留绑定；测试失败/配置更换/重复导入/跨会话预览拒绝。
- [x] UI 任务：设置及服务页入口、资源选择导入或绑定、DNS 预览对话框、主机指标历史、Agent 注册与撤销、检查管理；清晰区分缓存、在线/离线/未采集、未知指标。
- [x] 整体验收：typecheck/lint/i18n/test、desktop build 和 web build；隔离测试目录启动真实 Agent/Server 与桌面，实际浏览器检查布局和完整操作；独立审查修正。

特别检查：重命名丢绑定、重复导入覆盖本地编辑、换凭据后旧请求写回、离线主机最后指标冒充实时、Token 经错误或 URL 跳转泄露。这五类由各自拥有者添加测试。

## 2026-10-12 验收记录

- 独立验证员执行 Node 全量测试 1040 项通过，无失败或跳过；类型、i18n 检查通过，ESLint 为 0 错误、19 条既有 warning。
- Electron 界面与 Web 生产构建通过。开发、生产页面在 1280px 与 390px 渲染，无控制台错误和横向溢出；生产结果与开发基线一致。Windows 不支持原 preview:restart 的 /proc 检测，改用同一 npm preview 脚本启动生产输出后验收。
- 隔离真实 Agent/Server/Electron 验收通过：gRPC 采样、HTTP 检查及历史、系统加密、锁库监控、绑定资产、实际界面改名后保留绑定、服务端重启恢复历史、主机撤销。
- Go 1.27.2 构建、格式、vet、14 项顶层测试、race、模块校验和 govulncheck 通过；Windows、Linux amd64/arm64 编译通过。
- 独立审查发现的打包依赖缺失、转义 Token 反射、DNS 备注清空、高级类型编辑、h2c 首请求、检查公平调度与历史误清除已修复并复核。
- Cloudflare 使用合成协议夹具测试，未使用真实账号 Token 或修改 DNS。Docker daemon 未启动，Docker 镜像启动及 Linux systemd 实机部署未验证；未改生产服务器、未生成安装包或发布版本。
