import { BookOpen, Copy, Download, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Markdown } from "./markdown";
import { AssetDocuments } from "./asset-documents";
import { Button } from "./ui/button";
import { useDocuments } from "@/lib/documents";
import { rawMarkdownContent } from "@/lib/document-migration.mjs";
import { useAppStore } from "@/lib/store";
import type { Server } from "@/lib/types";
import { t } from "@/lib/i18n";

const DOCS_TEMPLATES: { label: string; icon: string; content: (s: Server) => string }[] = [
  {
    label: "VLESS-Reality 部署与维护",
    icon: "⚡",
    content: (s) => `# ${s.name} - Xray VLESS Reality 节点运维指南

## 1. 服务端配置 (/usr/local/etc/xray/config.json)
\`\`\`json
{
  "inbounds": [
    {
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [
          {
            "id": "YOUR_UUID_HERE",
            "flow": "xtls-rprx-vision"
          }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "gateway.icloud.com:443",
          "xver": 0,
          "serverNames": ["gateway.icloud.com"],
          "privateKey": "YOUR_SERVER_PRIVATE_KEY",
          "shortIds": ["1a2b3c4d"]
        }
      }
    }
  ],
  "outbounds": [
    { "protocol": "freedom" }
  ]
}
\`\`\`

## 2. 常用维护指令
- 重启服务: \`systemctl restart xray\`
- 查看状态: \`systemctl status xray\`
- 实时日志: \`journalctl -u xray -f\`
`,
  },
  {
    label: "Nginx 反代与 SSL 配置",
    icon: "🌐",
    content: (s) => `# ${s.name} - Nginx 反向代理与 SSL 备忘

## 1. 站点反代配置 (/etc/nginx/conf.d/${s.host || "app"}.conf)
\`\`\`nginx
server {
    listen 80;
    server_name ${s.host || "example.com"};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${s.host || "example.com"};

    ssl_certificate /etc/letsencrypt/live/${s.host || "example.com"}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${s.host || "example.com"}/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
\`\`\`

## 2. 重新加载
\`\`\`bash
nginx -t && systemctl reload nginx
\`\`\`
`,
  },
  {
    label: "Docker Compose 常用基础栈",
    icon: "🐳",
    content: (s) => `# ${s.name} - Docker 服务编排清单

\`\`\`yaml
version: '3.8'

services:
  caddy:
    image: caddy:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
\`\`\`

## 维护命令
- 后台启动: \`docker compose up -d\`
- 停止容器: \`docker compose down\`
- 查看日志: \`docker compose logs -f\`
`,
  },
  {
    label: "Linux SSH 安全硬化清单",
    icon: "🛡️",
    content: (s) => `# ${s.name} - 服务器安全与硬化备忘

## 1. SSH 配置强化 (/etc/ssh/sshd_config)
- 禁止 Root 密码远程登录: \`PermitRootLogin prohibit-password\`
- 禁用纯密码验证: \`PasswordAuthentication no\`
- 更改默认端口: \`Port ${s.port || 22}\`

## 2. UFW 防火墙放行
\`\`\`bash
ufw default deny incoming
ufw default allow outgoing
ufw allow ${s.port || 22}/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
\`\`\`

## 3. 安装 Fail2ban
\`\`\`bash
apt install fail2ban -y && systemctl enable --now fail2ban
\`\`\`
`,
  },
];

export function ServerDocsPanel({ server }: { server: Server }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const original = server.docs ?? "";
  async function enter(template?: (typeof DOCS_TEMPLATES)[number]) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (template)
        await useDocuments.getState().create([{ kind: "server", id: server.id }], {
          title: server.name + " · " + t(template.label),
          content: rawMarkdownContent(template.content(server)),
        });
      else await useDocuments.getState().importServer(server);
      useAppStore.getState().setExpanded(null);
      useAppStore.getState().setView("docs");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  function exportOriginal() {
    const url = URL.createObjectURL(new Blob([original], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${server.name || "server"}-runbook.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="space-y-6 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink">
            <BookOpen className="size-4 text-muted" />
            {t("服务文档")}
          </h3>
          <p className="mt-1 text-2xs text-muted">
            {t("统一使用图文文档，编辑自动保存；可插入图片、链接，也可随时解除关联。")}
          </p>
        </div>
      </header>
      <AssetDocuments asset={{ kind: "server", id: server.id }} />
      {error && (
        <p role="alert" className="mx-4 break-words text-sm text-crit">
          {t("迁移或创建失败，旧文档仍保留：")}
          {error}
        </p>
      )}
      {original.trim() && (
        <section className="mx-4 rounded-xl border border-line p-4">
          <h4 className="text-sm font-semibold">{t("旧版 Markdown 文档")}</h4>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {t(
              "旧记录只读保留。迁移会将完整 Markdown 原文保存为代码块，不自动转换格式；重复迁移只打开已有文档，不覆盖后续编辑。",
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void enter()}>
              {busy ? t("正在处理…") : t("迁移并编辑旧文档")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  .writeText(original)
                  .then(() => toast.success(t("已复制全文 Markdown 内容")))
                  .catch(() => toast.error(t("复制失败")));
              }}
            >
              <Copy />
              {t("复制原文")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={exportOriginal}>
              <Download />
              {t("导出 Markdown 文件")}
            </Button>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-muted">{t("查看保留的旧文档")}</summary>
            <div className="mt-3 max-h-80 overflow-auto rounded-lg border border-line p-3">
              <Markdown>{original}</Markdown>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-muted">
                {t("查看 Markdown 原文")}
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                {original}
              </pre>
            </details>
          </details>
        </section>
      )}
      <details className="mx-4 pb-4">
        <summary className="flex cursor-pointer items-center gap-2 text-sm text-muted">
          <Sparkles className="size-4" />
          {t("从运维模板创建新文档")}
        </summary>
        <p className="mt-2 text-xs text-muted">
          {t("模板以 Markdown 代码块保存，不覆盖已有文档。")}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {DOCS_TEMPLATES.map((template) => (
            <Button
              type="button"
              size="sm"
              variant="outline"
              key={template.label}
              disabled={busy}
              onClick={() => void enter(template)}
            >
              {t(template.label)}
            </Button>
          ))}
        </div>
      </details>
    </div>
  );
}
