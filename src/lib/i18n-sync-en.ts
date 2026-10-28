export const SYNC_EN: Record<string, string> = {
  同步: "Sync",
  同步只在桌面版提供: "Sync is only available in the desktop app.",
  "同步只在桌面版提供。": "Sync is only available in the desktop app.",
  与网页版同步: "Sync with the web app",
  桌面端同步: "Desktop sync",
  资产与关联: "Assets and links",
  "服务器、域名、邮箱、订阅等记录与它们之间的关联":
    "Servers, domains, mailboxes, subscriptions and the links between them",
  工作区里的全部文档: "All documents in the workspace",
  "密钥库（只传密文）": "Vault (ciphertext only)",
  "密码、密钥等凭据以 AES-256-GCM 密文同步，服务器看不到明文；两边必须使用同一个主密码":
    "Passwords and keys sync as AES-256-GCM ciphertext; the server never sees plaintext. Both sides must use the same master password.",
  "已与你自己服务器上的网页版配对，每 2 分钟和每次修改后自动同步。冲突时不会丢数据，两份都会保留。":
    "Paired with the web app on your own server. Syncs every 2 minutes and after each change. Conflicts never lose data: both copies are kept.",
  接受服务器当前状态: "Accept the server's current state",
  以桌面版为准: "Use the desktop version",
  以网页版为准: "Use the web version",
  服务器指纹: "Server fingerprint",
  这台设备: "This device",
  上次同步: "Last sync",
  还没有同步过: "Never synced",
  失败: "Failed",
  "当前地址是 http://：同步内容仍由 ZSP 端到端加密并认证，但建议为服务器配置 HTTPS。":
    "This address uses http://. Sync content is still encrypted and authenticated end to end by ZSP, but HTTPS is recommended.",
  立即同步: "Sync now",
  "拉取 {0} · 推送 {1} · 合并 {2} · 删除 {3}": "Pulled {0} · pushed {1} · merged {2} · deleted {3}",
  同步哪些内容: "What to sync",
  "系统加密保存的 Cloudflare Token、模型 API Key 等不会同步，需要在网页版里重新填写。":
    "Cloudflare tokens, model API keys and other credentials kept in system secure storage are not synced. Enter them again in the web app.",
  最近记录: "Recent activity",
  "解除配对后，这台设备不再同步；两边已有的资料都保留。之后可以重新配对。":
    "After unpairing this device stops syncing; the data on both sides is kept. You can pair again later.",
  确认解除配对: "Confirm unpair",
  解除配对: "Unpair",
  "把桌面版的资产、文档（以及可选的密钥库）同步到你自己 VPS 上部署的网页版，两边都能改，合并后一致。配对只需要一次。":
    "Sync assets, documents and, optionally, the vault from the desktop app to the web app on your own VPS. Both sides can edit and changes are merged. Pairing is needed only once.",
  "在网页版打开「设置 → 同步」，点「生成配对码」。":
    "In the web app open Settings → Sync and click “Generate pairing code”.",
  "在这里填入网页版的地址和配对码（5 分钟内有效，只能用一次）。":
    "Enter the web app address and the pairing code here (valid for 5 minutes, single use).",
  "配对成功后，核对两边显示的服务器指纹是否一致（可选）。":
    "After pairing, compare the server fingerprint shown on both sides (optional).",
  网页版地址: "Web app address",
  配对码: "Pairing code",
  配对: "Pair",
  "http:// 地址也可以配对：配对码不会在网络上明文传输，同步内容也由 ZSP 端到端加密。跨网络使用仍建议配置 HTTPS。":
    "Pairing also works over http://: the pairing code is never sent in the clear and sync content is encrypted end to end by ZSP. HTTPS is still recommended across networks.",
  设备已配对: "Device paired",
  "配对码已失效，请重新生成": "The pairing code is no longer valid. Generate a new one.",
  "让桌面版和这台服务器上的网页版保持一致。配对用一次性配对码，之后每次同步都用设备密钥互相认证并加密，即使服务器没有 HTTPS 也不会被中间人篡改。":
    "Keep the desktop app and this server's web app in step. Pairing uses a one-time code; every sync afterwards is mutually authenticated and encrypted with device keys, so a man in the middle cannot tamper with it even without HTTPS.",
  这台服务器的指纹: "This server's fingerprint",
  "配对成功后，桌面版会显示同一个指纹，可以核对确认连的是这台服务器。":
    "After pairing the desktop app shows the same fingerprint, so you can confirm it connected to this server.",
  "在桌面版「设置 → 同步」里输入这个配对码：":
    "Enter this pairing code in the desktop app under Settings → Sync:",
  "{0} 秒后失效，只能用一次。填错 3 次会作废。":
    "Expires in {0} s and works once. Three wrong attempts invalidate it.",
  取消配对码: "Cancel pairing code",
  "已配对 {0} 台设备。要添加另一台，生成新的配对码。":
    "{0} device(s) paired. To add another, generate a new pairing code.",
  "还没有配对的设备。": "No devices paired yet.",
  生成配对码: "Generate pairing code",
  已配对的设备: "Paired devices",
  已撤销: "Revoked",
  "最近同步 {0}": "Last synced {0}",
  移除记录: "Remove record",
  撤销: "Revoke",
  "撤销后这台设备立即无法同步，已有的连接也会断开。":
    "A revoked device can no longer sync and its open connections are cut immediately.",
  同步与安全记录: "Sync and security log",
  已复制: "Copied",
  复制: "Copy",
  生成了配对码: "Pairing code generated",
  取消了配对码: "Pairing code cancelled",
  有人用错误的配对码尝试配对: "Someone tried to pair with a wrong code",
  配对码因多次错误或尝试过多已作废: "Pairing code invalidated after too many attempts",
  设备已被撤销: "Device revoked",
  设备主动解除了配对: "Device unpaired itself",
  设备完成了同步: "Device finished a sync",
  其他事件: "Other event",
};
