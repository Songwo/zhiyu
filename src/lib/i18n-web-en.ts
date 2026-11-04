export const WEB_EN: Record<string, string> = {
  "部署服务器已加密保存授权": "Authorization encrypted on the deployment server",
  "服务器授权已断开，已导入资料已保留": "Server authorization disconnected; imported data retained",
  "服务器已删除此授权令牌，已导入资料与关联文档仍然保留。": "The server deleted this authorization token. Imported data and linked documents remain.",
  "断开后删除服务器保存的身份令牌，保留身份资料与文档。平台侧授权需前往 Linux.do Connect 撤销。": "Disconnecting deletes identity tokens on this server and retains identity data and documents. Revoke the provider grant in Linux.do Connect.",
  "确认断开服务器授权": "Confirm disconnecting server authorization",
  "断开服务器授权": "Disconnect server authorization",
  服务器提醒推送: "Server reminder push",
  "删除部署服务器保存的授权令牌？服务商侧授权还需前往服务商账号撤销。":
    "Delete authorization tokens stored on this deployment server? Revoke the provider-side grant in your provider account as well.",
  "我允许服务器加密保存本次 AI 授权凭据，用于授权和定时刷新额度；移除账号会删除服务器凭据。此配置不随密钥库同步。":
    "I allow this server to store encrypted AI authorization credentials for authorization and scheduled quota refresh. Removing the account deletes them. This configuration is not synced with the vault.",
  "服务器加密保存仍允许部署管理员访问授权令牌。请仅在可信的自托管服务使用；敏感账号建议通过桌面端授权。":
    "Server encryption still allows the deployment administrator to access authorization tokens. Use only a trusted deployment; the desktop app is recommended for sensitive accounts.",
  "请在官方页面完成授权。返回本机地址若无法打开，复制完整地址栏链接或官方显示的 code#state，粘贴到下方；不要粘贴账号密码。":
    "Authorize on the official page. If the local callback cannot open, paste its complete address or the official code#state below. Never paste your password.",
  打开官方授权页面: "Open official authorization page",
  "测试连接需要解锁已保存的 SSH 凭据。": "Unlock saved SSH credentials to test the connection.",
  "重置主机指纹需要先解锁密钥库。": "Unlock the vault before resetting the host fingerprint.",
  "已清除旧指纹。下次连接会记录新指纹，请核对后再测试连接。":
    "The previous fingerprint was cleared. The next connection will record the new fingerprint. Verify it before testing again.",
  重置主机指纹: "Reset host fingerprint",
  确认重置主机指纹: "Confirm fingerprint reset",
  "指纹变化可能来自服务器重装，也可能是连接劫持。请通过云控制台等可信渠道核对新指纹；仅在确认服务器密钥已更换后清除旧记录。此操作不会自动重连。":
    "A changed fingerprint may mean a server reinstall or a hijacked connection. Verify the new fingerprint through a trusted channel such as the cloud console before clearing the old record. This does not reconnect automatically.",
  输入完整主机地址和端口以确认: "Enter the complete host address and port to confirm",
  确认清除旧指纹: "Confirm clearing the old fingerprint",
  "Web 端连接会将本次 SSH 凭据交给部署服务器处理。请仅连接可信部署；敏感主机建议使用桌面端。":
    "Web connections send the required SSH credentials to the deployment server for processing. Use a trusted deployment; the desktop app is recommended for sensitive hosts.",
  "在插件里选择 Web 工作区并填写当前站点地址。保持此标签页打开并解锁后才能配对、填写和保存；关闭、刷新或锁库后需要重新配对，密码不会由服务器解密。":
    "Select Web workspace in the extension and enter this site's address. Keep this tab open and unlocked to pair, fill, and save. Closing, reloading, or locking requires pairing again. The server does not decrypt passwords.",
  "我允许服务器加密保存独立身份的客户端密钥和授权令牌；管理员仍有能力访问。断开授权会删除该身份的令牌，接入配置与桌面端不互通。敏感账号建议使用桌面端。":
    "I allow the server to store encrypted client secrets and tokens for this independent identity. Administrators can still access them. Disconnecting deletes the identity's tokens. Configuration is separate from the desktop app, which is recommended for sensitive accounts.",
  "完成授权后，本机回调页面可能无法打开。请复制完整地址栏链接粘贴到下方；不要输入账号密码。":
    "After authorization, the local callback page may not open. Copy its complete address and paste it below. Do not enter your password.",
  完整授权回调地址: "Complete authorization callback URL",
  确认授权回调: "Confirm authorization callback",
  重新连接身份: "Reconnect identity",
  "我允许服务器加密保存所选邮箱的用户名和授权码，用于后台检查；部署管理员仍有能力访问。关闭自动推送并保存会删除这些凭据。敏感邮箱建议使用桌面端。":
    "I allow the server to store encrypted usernames and app passwords for the selected mailboxes for background checks. Administrators can still access them. Disable automatic push and save to delete these credentials. The desktop app is recommended for sensitive mailboxes.",
  "请先确认允许服务器临时处理邮箱授权。":
    "First allow the server to temporarily process mailbox authorization.",
  "我允许可信部署服务器临时处理客户端密钥和邮箱授权令牌，仅用于核验邮箱地址；服务器不持久保存此次令牌，刷新令牌随资产保存到浏览器加密密钥库。敏感邮箱建议使用桌面端。此授权不会赋予邮件收发权限。":
    "I allow this trusted server to temporarily process the client secret and mailbox tokens solely to verify the email address. These tokens are not persisted on the server; the refresh token is saved with the asset in the browser-encrypted vault. Use the desktop app for sensitive mailboxes. This grant does not permit reading or sending email.",
  完成邮箱授权: "Complete mailbox authorization",
  "编辑 SSH 凭据与指纹": "Edit SSH credentials and fingerprint",
  "Web 安全提醒": "Web security notice",
  "Web 端存在浏览器与服务器风险，敏感资产建议优先使用桌面端。查看安全说明":
    "Web use carries browser and server risks. Prefer the desktop app for sensitive assets. View security details",
  "只访问自己信任的部署并使用 HTTPS，开启两步验证，避免公共设备和不可信浏览器扩展。密钥库在浏览器解锁后，恶意脚本或扩展仍可能读取明文；SSH、邮箱等服务端操作会将所需凭据交给服务器处理。服务器加密存储不等于端到端加密，管理员仍有能力访问。桌面端同样需要可信设备与更新。":
    "Use a trusted deployment with HTTPS and two-factor authentication. Avoid public devices and untrusted browser extensions. Malicious scripts or extensions can read plaintext after the vault is unlocked. Server operations such as SSH and mail send required credentials to the server for processing. Server encryption is not end-to-end encryption; administrators can still access these credentials. The desktop app also requires a trusted, updated device.",
  "Web 端公开部署会增加攻击面；登录、接口、浏览器脚本和扩展都需要保护。敏感资产建议优先使用桌面端，Web 请使用可信部署、HTTPS、两步验证和来源限制。":
    "A public Web deployment increases the attack surface across login, APIs, browser scripts, and extensions. Prefer the desktop app for sensitive assets. On the Web, use a trusted deployment, HTTPS, two-factor authentication, and source restrictions.",
  "请先同意服务器保管后台检查凭据。":
    "First consent to server storage of background-check credentials.",
  "请使用邮箱授权面板完成 Web 手动回调。":
    "Complete the manual Web callback in the mailbox authorization panel.",
  "在官方页面完成授权，独立身份凭据由可信部署服务器加密保存，与桌面密钥库分别配置。":
    "Authorize on the official page. Independent identity credentials are encrypted on the trusted server and configured separately from the desktop vault.",
  "仅发送新增、未读数量和检查时间，不发送邮箱地址、标题或正文。明确同意并保存后，服务器可在浏览器关闭时检查所选邮箱；首次检查仅建立基线。":
    "Send only new/unread counts and check time, never mailbox addresses, subjects, or bodies. After explicit consent and saving, the server can check selected mailboxes while the browser is closed. The first check only establishes a baseline.",
};
