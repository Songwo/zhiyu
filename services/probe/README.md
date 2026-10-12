# 知屿独立探针

这是知屿自己的监控协议与服务端，不兼容 Nezha Agent。常驻服务端接收主机指标、保留历史并检查 HTTP/TCP 服务；知屿桌面关闭后仍继续运行。Agent 只上报指标，没有终端、执行脚本、文件读取或远程命令入口。

## 数据链路

```text
服务器上的 Agent ── gRPC / HTTP/2 + protobuf ──> 知屿探针服务端
知屿桌面        ── HTTPS JSON API ───────────> 同一服务端端口
```

默认 TLS。服务端用 `ProtoMajor == 2`、`Content-Type: application/grpc` 和 `/zhiyu.probe.v1.ProbeService/` 前缀分流。使用 Go 原生 HTTP/2，h2c 支持 gRPC 标准客户端的 prior knowledge 连接，拒绝旧式 HTTP/1 Upgrade；不会在认证前缓存升级请求体。协议在 [proto/probe.proto](proto/probe.proto) 中，只有静态主机信息和双向状态流两个 RPC。每次 RPC 都用独立的 `client-uuid` 与 `client-secret` metadata 认证。注册生成 256 位随机凭据，服务端只存 SHA-256 摘要；删除主机会立即终止其现有状态流，并删除该主机及历史。

管理员 API 使用另一份随机 Bearer Token，不能把它填到 Agent 的 secret。重复认证头、无效凭据、短或明显重复的管理员 Token 会被拒绝。`/healthz` 公开返回 `{ "status": "ok" }`，不暴露主机信息。

## 构建和验证

需要 Go **1.27.2** 或更新的稳定版。生成的 protobuf Go 文件已提交，正常构建无需 protoc。

```sh
go build -trimpath -o zhiyu-probe ./cmd/zhiyu-probe
go test ./...
go test -race ./...
go vet ./...
```

Windows 可输出 `zhiyu-probe.exe`。`-race` 需要可用的 C 编译器。如需重新生成协议，使用 protoc 28.3+、`protoc-gen-go` 和 `protoc-gen-go-grpc`：

```sh
protoc --go_out=. --go_opt=paths=source_relative \
  --go-grpc_out=. --go-grpc_opt=paths=source_relative proto/probe.proto
```

## 部署服务端（Linux）

首先将独立域名（例如 `probe.example.com`）解析到服务器，准备匹配该域名的有效 TLS 证书和私钥。程序不关闭证书验证，不会自动申请证书。建议使用 DNS-only 记录直连探针端口，并通过防火墙限制管理端访问；如果已有反向代理，必须让它正确支持 HTTP/2 gRPC 和长连接。

**Cloudflare Tunnel 能访问网页登录页不代表可以承载公网 gRPC。** 不要直接复用网页登录 Tunnel 路由。部署时分别验证 Agent 的 gRPC 和桌面的 HTTPS API；可以使用直连 TLS，或自己的私有网络。示例不会修改已有 Cloudflare、Tunnel 或 DNS 配置。

以下配置路径供专用服务账户使用；文件内容请在本机编辑器中填入，不要发送到聊天或仓库。

```sh
sudo useradd --system --home /var/lib/zhiyu-probe --shell /usr/sbin/nologin zhiyu-probe
sudo install -m 0755 zhiyu-probe /usr/local/bin/zhiyu-probe
sudo install -d -m 0700 -o zhiyu-probe -g zhiyu-probe /etc/zhiyu-probe
umask 077
./zhiyu-probe token > admin-token
sudo install -m 0600 -o zhiyu-probe -g zhiyu-probe admin-token /etc/zhiyu-probe/admin-token
sudo install -m 0600 -o zhiyu-probe -g zhiyu-probe /path/to/fullchain.pem /etc/zhiyu-probe/tls.crt
sudo install -m 0600 -o zhiyu-probe -g zhiyu-probe /path/to/privkey.pem /etc/zhiyu-probe/tls.key
sudo install -m 0644 deploy/zhiyu-probe-server.service /etc/systemd/system/zhiyu-probe-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now zhiyu-probe-server
```

用本机安全方式移除临时 `admin-token` 副本。证书续期后更新副本并重启服务端；当前版本不会自动重载证书。管理员 Token 更换也需要更新文件并重启，随后更新桌面连接配置。程序日志不会输出 Token 或 Agent secret。

也可以直接启动（前台进程）：

```sh
zhiyu-probe server --listen 0.0.0.0:8008 \
  --data /var/lib/zhiyu-probe/probe.db \
  --admin-token-file /etc/zhiyu-probe/admin-token \
  --tls-cert /etc/zhiyu-probe/tls.crt --tls-key /etc/zhiyu-probe/tls.key
```

管理员 Token、Agent 配置及数据库在 Unix 上必须禁止组和其他用户读取（`0600`），父目录建议 `0700`。Windows 不使用 POSIX 权限位，请用 NTFS ACL 限制到运行服务的账户。数据库内有主机名称、地址、指标和检查目标，虽然没有 Agent 明文 secret，也要保护备份。

## Docker Compose

Compose 只容器化**服务端**。主机 Agent 推荐原生运行；普通容器采到的是容器命名空间，不能冒充宿主机指标。

```sh
docker compose build
umask 077
mkdir -p private data
chmod 700 private data
docker run --rm zhiyu-probe:local token > private/admin-token
cp /path/to/fullchain.pem private/tls.crt
cp /path/to/privkey.pem private/tls.key
chmod 600 private/*
sudo chown -R 10001:10001 private data
docker compose up -d
```

镜像使用非 root UID `10001`，只读根文件系统、空 capability、独立持久化目录。`private/` 和 `data/` 已加入忽略规则。提供给 Docker 的证书链需要与域名匹配。服务端 CPU/内存限额在 Compose 中可按主机数量调整。不要把数据库放 NFS/SMB；bbolt 要求本机可靠文件锁。

## 桌面连接与 Agent 注册

1. 在知屿的「云服务与探针」添加探针连接，填 `https://probe.example.com:8008` 和管理员 Token。桌面使用操作系统加密保存，不依赖资产密钥库解锁。
2. 在探针工作区注册主机。注册后显示一次 `{ id, secret }`，仅供对应 Agent 使用，遗失时删除原主机并重新注册。
3. 复制 `deploy/agent.example.json` 到采集主机的 `/etc/zhiyu-probe/agent.json`，替换地址、id 和 secret，设置 `0600`、所属用户 `zhiyu-probe`。
4. 安装 `deploy/zhiyu-probe-agent.service`，执行 `systemctl daemon-reload` 和 `systemctl enable --now zhiyu-probe-agent`。服务端与采集主机分离时，只在各自主机安装对应单元。
5. 桌面会显示在线主机、最新指标及历史；将主机绑定到已有服务器资产，可与文档、账号和服务继续建立关系。

直接运行 Agent 的命令：

```sh
zhiyu-probe agent --config /etc/zhiyu-probe/agent.json
```

Agent 默认每 3 秒采样，支持 1–4 秒。连接中断后以 1、2、4…30 秒退避自动重连；单次上报确认最多等待 10 秒。生产使用系统信任的 TLS 证书；私有 CA 可在 JSON 中填 `caFile`。没有 `insecureSkipVerify` 开关。

仅在明确控制的本机或私网，可在服务端加 `--insecure` 启用 h2c。Agent 同时需要 `http://127.0.0.1:8008` 或字面私网 IP，以及 `"allowInsecure": true`；公网 IP 和普通 DNS 域名的明文连接均拒绝。服务端若监听 `0.0.0.0`，必须由防火墙或内部网络确保 h2c 端口不暴露公网。

## 指标和历史语义

- CPU、内存、swap、磁盘是 `0–100` 百分比。磁盘是系统分区，不是所有挂载点总和。内存和磁盘总容量以字节计。
- 网络总量是操作系统接口计数器之和，包含虚拟接口/回环，因此可能重复计算转发流量；这是主机网络活动指标，不是服务商账单流量。速率单位字节/秒，首个样本或计数器重置后速率留空。
- 还采集 uptime、1/5/15 分钟负载、TCP/UDP 连接数、进程数。非 root 运行时，系统权限可能限制可见范围；系统不支持或采集失败则留空。
- 温度取可用传感器最高读数。当前无通用 GPU 采集器，`gpu` 保留在协议中并保持缺省，不填假零。首个 CPU 样本也留空，下一次采样得到真实区间占用率。
- 样本 `at` 与 `lastSeen` 一律由服务端生成 UTC 时间，桌面按本地时区展示。15 秒无样本判为离线；未收到过样本显示待连接。离线仍保留最后样本，不代表当前实时状态。
- 持久化历史每 30 秒保留最新样本，实时 `latest` 每次上报更新。保留 7 天、每主机或服务最多 20,160 个历史桶，每小时清理；API 对长时间范围等距抽样至最多 720 点。清理周期内最多多存一小时数据。数据库文件会复用空页，删除数据不会立即缩小文件。
- 最多 100 台主机和 100 项检查。适用于个人/小团队监控，当前是单实例服务端，没有高可用或多租户隔离。

## HTTP/TCP 服务检查

服务端每秒调度到期任务，最多并发 8 个；同一任务不会重叠执行。先执行从未运行及等待最久的任务，避免慢检查长期占满槽位；修改配置后在下一次可用调度中使用新配置，不必等待旧的检查周期。间隔 10–3600 秒，超时 100–30000 毫秒且不超过间隔。HTTP 接受有效 HTTP(S) URL，TCP 接受 `host:port`，IPv6 用 `[地址]:端口`。HTTP `2xx` 为 up，其余状态为 down；不跟随重定向，检查目标应填最终地址。HTTP 响应体最多读取 64 KiB、响应头最多 32 KiB。

允许用户自己的局域网、回环服务。拒绝 metadata/link-local、多播、未指定地址、已知云元数据地址、URL 内嵌凭据；DNS 解析后再次检查所有地址，再直接拨号到校验过的 IP，避免重绑定。不会继承环境代理，也不把管理员或 Agent 凭据发送给检查目标。

可用率 `uptime24h` 是近 24 小时**已有历史样本**中成功的比例，尚无结果时为 null；停机期间缺失样本不算成功，也不会补造失败。每 30 秒桶保留最后一次检查，因此它不是 SLA 或按持续时间计费的百分比。修改检查目标或协议类型会清空该检查旧历史；仅改名、间隔、超时会保留历史。所有配置变更都拒绝旧请求覆盖新结果。删除正在运行的检查也不会被旧结果复活。

## HTTP API

所有 `/api/v1/*` 都需要 `Authorization: Bearer <管理员Token>`，写请求需要 `Content-Type: application/json`。成功直接返回对象或数组，错误为 `{ "error": "..." }`，删除成功为 204。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/v1/hosts` | 主机列表、在线状态、最新样本 |
| `POST /api/v1/hosts` | `{name}` 注册，返回一次性 `{id,secret}` |
| `DELETE /api/v1/hosts/:id` | 撤销凭据、断开流、删除主机和历史 |
| `GET /api/v1/hosts/:id/history?range=1h\|24h\|7d` | 历史曲线 |
| `GET /api/v1/checks` | 服务检查配置、结果和样本可用率 |
| `POST /api/v1/checks` | `{id?,name,type,target,intervalSeconds,timeoutMs}` 新增或替换 |
| `DELETE /api/v1/checks/:id` | 删除服务检查及历史 |
| `GET /api/v1/checks/:id/history?range=1h\|24h\|7d` | 服务检查历史 |

## 备份和验收

停止服务端后备份 `probe.db` 与管理员 Token；不要直接复制仍在写入的数据库。恢复时设置正确的所有者及权限，再启动。Agent 凭据摘要、配置、最后指标和历史会随数据库恢复。服务端机器时间应使用 NTP 同步。

测试使用临时目录、合成凭据和本机监听端口，覆盖 TLS/h2c 真实流、重复认证头、非法数值、限频、撤销、并发、自动采集、重启恢复、历史上限、服务超时/重定向/metadata 拒绝、检查配置变更竞态。没有连接你的真实服务器，也不会改生产 DNS。
