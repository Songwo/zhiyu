# 网页版（自托管）

把知屿部署在你自己的服务器上，在家里和公司都用浏览器打开同一份资料，公司电脑上不用安装任何东西。

- 资料只在你的服务器上：资产、文档存成和桌面版相同的文件（`assets.json`、`documents/`），没有第三方云。
- 整站需要登录：登录密码用 scrypt 加盐保存，会话 Cookie 为 HttpOnly + SameSite=Strict，登录失败过多会暂停 15 分钟。
- 密码类资料端到端加密：密钥库在浏览器里用主密码解密，服务器上的 `vault.enc` 只有密文，主密码从不发送到服务器。文件格式与桌面版完全相同。
- 与桌面版互通：网页版「设置 → 数据」可以下载与桌面版同格式的加密备份，也能把桌面版的备份恢复到服务器上。

## 用 Docker 部署（推荐）

正式版镜像为 `ghcr.io/songwo/zhiyu-web`（amd64 / arm64），不用克隆源码：

```bash
mkdir zhiyu && cd zhiyu
curl -fsSLO https://raw.githubusercontent.com/Songwo/zhiyu/main/docker-compose.yml
docker compose up -d
docker compose logs zhiyu    # 找「设置口令」
```

不用 compose 也可以：

```bash
docker run -d --name zhiyu --restart unless-stopped -p 8848:8848 \
  -v "$PWD/zhiyu-data:/data" ghcr.io/songwo/zhiyu-web:latest
```

升级：`docker compose pull && docker compose up -d`。想从源码构建镜像：克隆仓库后运行 `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`。

浏览器打开 `http://服务器地址:8848`，第一次会进入「创建网页版账号」：填写日志里的**设置口令**、用户名和登录密码（至少 10 位）。设置口令只能用一次，用来防止别人抢先注册你的实例。

资料保存在 `./zhiyu-data`：

```text
zhiyu-data/
  workspace/   资料（与桌面版资料目录一致，备份与恢复的范围）
  server/      网页登录账号与会话、提醒推送配置
```

容器以 root 启动后会把资料目录交给容器内的 node 用户，再降权运行服务。

## 不用 Docker

需要 Node.js 22：

```bash
npm ci
npm run web:build
ZHIYU_DATA=./zhiyu-data npm run web:start
```

## 放到公网前

网页版会保存你的资产清单，务必放在 HTTPS 后面：

1. 用 Caddy 或 Nginx 反向代理到 `127.0.0.1:8848`，并把 `docker-compose.yml` 的端口改成 `127.0.0.1:8848:8848`，只让本机代理访问。
2. 设置 `ZHIYU_SECURE_COOKIE=1`，登录 Cookie 只在 HTTPS 上发送。
3. 代理会传真实 IP 时设置 `ZHIYU_TRUST_PROXY=1`，登录限流按真实 IP 计算。

Caddy 示例：

```text
zhiyu.example.com {
  reverse_proxy 127.0.0.1:8848
}
```

也可以只在家庭内网或 Tailscale / WireGuard 里访问，不暴露到公网。

用 `http://局域网地址` 直接访问也可以使用全部功能：浏览器在非 HTTPS 页面里不提供 WebCrypto，此时密钥库改用纯 JavaScript 的 AES-256-GCM 加解密，文件格式不变。但 http 下登录密码以明文传输，跨网络访问请使用 HTTPS 或 VPN。

## 环境变量

| 变量                  | 默认                                  | 说明                                      |
| --------------------- | ------------------------------------- | ----------------------------------------- |
| `ZHIYU_PORT`          | `8848`                                | 监听端口                                  |
| `ZHIYU_HOST`          | `0.0.0.0`                             | 监听地址                                  |
| `ZHIYU_DATA`          | `./zhiyu-data`（Docker 内为 `/data`） | 资料目录                                  |
| `ZHIYU_SECURE_COOKIE` | `0`                                   | 设为 `1` 时 Cookie 只走 HTTPS             |
| `ZHIYU_TRUST_PROXY`   | `0`                                   | 设为 `1` 时信任反向代理的 `X-Forwarded-*` |
| `ZHIYU_SETUP_TOKEN`   | 随机生成                              | 指定首次设置口令                          |

## 网页版能做什么

和桌面版共用同一套界面：资产总览、关联、标签、文档、费用与续费日历、备忘提醒、自定义资产类型、密钥库都可以用；打开页面时会按设定提前天数弹浏览器通知（需要允许通知）。

## 提醒推送到手机

「设置 → 提醒推送」选择 Telegram、Server酱 / 微信、企业微信群机器人或 WxPusher，填写凭据和接收目标后开启。服务器启动一分钟后检查一次，之后每小时检查一次续费与备忘提醒，按「资产到期前多少天开始提醒」推送；同一件事每天最多一次，只发名称和剩余天数。可以先点「发送测试消息」确认渠道。

推送凭据保存在 `zhiyu-data/server/push.json`，只有服务器能读，不会返回给浏览器，也不在备份范围内（换服务器后重新填写）。服务器需要能访问对应渠道的接口（例如 `api.telegram.org`）。

需要直连主机或本机能力的功能只在桌面版提供：SSH 终端与文件、主机探测与监控、本机用量采集、邮箱 IMAP 检查与新邮件推送、AI 助手、浏览器插件配对、系统托盘和系统通知。

## 备份、恢复与换电脑

- **网页版 → 桌面版**：网页版「设置 → 数据 → 下载加密备份」，在桌面版「设置 → 数据 → 从备份恢复」。
- **桌面版 → 网页版**：桌面版创建加密备份，在网页版「设置 → 数据 → 从备份恢复」选择文件并输入备份密码；服务器上原有资料会移到 `workspace/restore-snapshots/`。
- 恢复后密钥库用原来的主密码解锁。

## 两台设备同时编辑

每次保存都带版本号。家里和公司同时修改时，后保存的一方会提示「资料已在另一台设备更新」，自动载入最新资料，刚才那次修改需要重做。切回页面时也会检查并载入其他设备的更新。

## 忘记登录密码

登录密码和密钥库主密码是两回事。忘了登录密码时，停止服务，删除 `zhiyu-data/server/account.json`，重新启动后用日志里的新设置口令重新创建账号；资料与密钥库不受影响。密钥库主密码无法找回。
