/** 网页版「账号安全」的英文文案。 */
export const SECURITY_EN: Record<string, string> = {
  账号安全: "Account security",
  "网页版放在公网上时，登录页是别人能碰到的唯一入口：用两步验证、HTTPS 和来源限制把它守住。":
    "When the web version is on the public internet, the sign-in page is the only door anyone can reach. Guard it with two-step verification, HTTPS and an address allowlist.",
  "当前连接没有加密（http）：登录密码会在网络上明文传输。请给服务器配置 HTTPS，或只在可信的内网 / VPN 里访问。":
    "This connection is not encrypted (http): your password travels in plain text. Set up HTTPS on the server, or only use it on a trusted LAN / VPN.",
  访问来源限制: "Allowed addresses",
  "已开启：只有 {0} 能打开这个网站，其他来源的连接会被直接断开。":
    "On: only {0} can open this site; connections from anywhere else are dropped.",
  "未设置：任何地址都能打开登录页。可以在服务器上设置环境变量 ZHIYU_ALLOWED_NETS，只允许自己的 IP、家里或公司网段、VPN（填 private 表示全部内网）。":
    "Not set: anyone can reach the sign-in page. Set ZHIYU_ALLOWED_NETS on the server to allow only your own IP, home or office network, or VPN (use private for all internal ranges).",
  登录中的设备: "Signed-in devices",
  退出其他所有设备: "Sign out all other devices",
  未知浏览器: "Unknown browser",
  当前设备: "This device",
  "最近活动 {0}": "Active {0}",
  "登录于 {0}": "signed in {0}",
  退出: "Sign out",
  "7 天没有任何操作的登录会自动失效。":
    "Sessions with no activity for 7 days expire automatically.",
  最近的登录记录: "Recent sign-in activity",
  "15 分钟内全站有 {0} 次失败": "{0} failed attempts in the last 15 minutes",
  使用了恢复码: "recovery code used",
  "开启「设置 → 提醒推送」后，新来源登录和反复失败会推送到手机。记录里不保存任何密码。":
    "With reminder push enabled, sign-ins from new addresses and repeated failures are pushed to your phone. No passwords are ever logged.",
  "两步验证（TOTP）": "Two-step verification (TOTP)",
  已开启: "On",
  "登录需要密码加手机验证器里的 6 位验证码。剩余恢复码 {0} 个。":
    "Signing in needs your password plus the 6-digit code from your authenticator app. {0} recovery codes left.",
  "开启后，只知道密码的人也登录不进来。推荐开启，Google Authenticator、Microsoft Authenticator、1Password 等都支持。":
    "Once on, knowing the password is not enough to sign in. Recommended; works with Google Authenticator, Microsoft Authenticator, 1Password and others.",
  开启两步验证: "Turn on two-step verification",
  关闭: "Turn off",
  当前登录密码: "Current sign-in password",
  继续: "Continue",
  取消: "Cancel",
  两步验证二维码: "Two-step verification QR code",
  "用验证器 App 扫描二维码；不方便扫码时手动输入下面的密钥。":
    "Scan the QR code with your authenticator app, or type the key below by hand.",
  "验证器里显示的 6 位验证码": "6-digit code shown in the app",
  确认并开启: "Confirm and turn on",
  "两步验证已开启。下面是 8 个一次性恢复码，丢了手机时可以代替验证码登录。只显示这一次，请现在抄下来或保存到密码管理器。":
    "Two-step verification is on. These 8 one-time recovery codes can replace the code if you lose your phone. They are shown only once — write them down or save them in a password manager now.",
  已复制: "Copied",
  复制: "Copy",
  我已保存: "I have saved them",
  验证码或恢复码: "Code or recovery code",
  确认关闭: "Confirm turn off",
  登录成功: "Signed in",
  登录失败: "Sign-in failed",
  被限流拒绝: "Blocked by rate limit",
  退出登录: "Signed out",
  创建账号: "Account created",
  修改登录密码: "Sign-in password changed",
  开启了两步验证: "Two-step verification turned on",
  关闭了两步验证: "Two-step verification turned off",
  退出了一台设备: "Signed out a device",
  退出了其他所有设备: "Signed out all other devices",
};
