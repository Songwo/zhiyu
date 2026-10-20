/** 加密备份、恢复与自动备份的英文文案。 */
export const BACKUP_EN: Record<string, string> = {
  "只导出资产记录；账号密码与 SSH 凭据不会跟着出去。完整迁移请使用下方的加密备份。":
    "Exports asset records only; account passwords and SSH credentials do not come along. Use an encrypted backup below to move everything.",
  两次输入的备份密码不一致: "The two backup passwords do not match",
  "包含系统保护的凭据需要先解锁密钥库。":
    "Unlock the vault to include system-protected credentials.",
  "已创建加密备份 {0}：{1} 项资产、{2} 篇文档":
    "Encrypted backup {0} created: {1} assets, {2} documents",
  "{0} 类系统保护的凭据无法在本机解密，未放入备份。":
    "{0} kinds of system-protected credentials could not be decrypted on this computer and were left out.",
  加密备份: "Encrypted backup",
  "把资产、文档、密钥库、个人资料、用量与接入配置打包成一个文件，用备份密码加密。不需要退出知屿。":
    "Packs assets, documents, the vault, your profile, usage and connections into one file encrypted with a backup password. No need to quit Zhiyu.",
  "创建加密备份…": "Create encrypted backup…",
  备份密码: "Backup password",
  "至少 10 位，可以与主密码相同。忘记备份密码将无法恢复；备份里的密钥库仍需要创建备份时的主密码解锁。":
    "At least 10 characters; it may match your master password. A forgotten backup password cannot be recovered, and the vault inside still unlocks with the master password in use when the backup was made.",
  同时包含系统保护的凭据: "Include system-protected credentials",
  "模型 API Key、云服务与探针连接、图床 Key、Linux.do 主身份由操作系统加密，换电脑后无法解密。勾选后会在本机解密，再用备份密码加密放进备份；恢复时交给新电脑重新加密。需要先解锁密钥库。":
    "Model API keys, cloud and probe connections, the image host key and the Linux.do primary identity are encrypted by the operating system and cannot be read on another computer. When checked, they are decrypted here, sealed with the backup password, and re-encrypted by the new computer on restore. Requires an unlocked vault.",
  "当前系统没有可用的安全加密存储，无法读取这些凭据。":
    "This system has no secure storage available, so these credentials cannot be read.",
  "密钥库已锁定，创建时会先请你解锁。":
    "The vault is locked; you will be asked to unlock it first.",
  选择保存位置并备份: "Choose location and back up",
  创建时间: "Created",
  知屿版本: "Zhiyu version",
  自动备份: "Auto backup",
  文档: "Documents",
  "{0} 篇": "{0}",
  密钥库凭据: "Vault credentials",
  无密钥库: "No vault",
  "{0} 条": "{0}",
  系统保护的凭据: "System-protected credentials",
  "未包含，恢复后需重新输入": "Not included; re-enter them after restoring",
  文件: "Files",
  "{0} 个，共 {1}": "{0}, {1} in total",
  "本机安全加密不可用，系统保护的凭据未恢复，请重启后重新输入。":
    "Secure storage is unavailable here, so system-protected credentials were not restored. Re-enter them after the restart.",
  "备份已准备好，知屿即将重启并完成恢复。":
    "Backup is ready. Zhiyu will restart to finish restoring.",
  从备份恢复: "Restore from backup",
  "用备份替换当前全部资料。替换前会把当前资料完整移到资料目录的 restore-snapshots 中，随后自动重启。":
    "Replaces all current data with the backup. Your current data is first moved, intact, into restore-snapshots inside the data folder, then Zhiyu restarts.",
  "上次启动已从备份恢复；恢复前的资料保存在 {0}。":
    "Restored from a backup at the last start; the earlier data is kept in {0}.",
  "上次恢复未完成：{0}": "The last restore did not finish: {0}",
  "选择备份文件…": "Choose backup file…",
  读取备份: "Read backup",
  "恢复会替换当前的资产、文档、密钥库和设置，完成后自动重启。之后请用创建备份时的主密码解锁密钥库。":
    "Restoring replaces your current assets, documents, vault and settings, then restarts. Afterwards, unlock the vault with the master password in use when the backup was made.",
  恢复并重启: "Restore and restart",
  "按周期把加密备份写入你选择的文件夹（建议另一块磁盘或网盘同步目录），只保留最近几份。自动备份不包含系统保护的凭据。":
    "Writes an encrypted backup to a folder you choose on a schedule (ideally another drive or a synced cloud folder) and keeps only the most recent ones. Auto backups leave out system-protected credentials.",
  更换文件夹: "Change folder",
  选择文件夹: "Choose folder",
  尚未选择: "Not chosen",
  备份周期: "Frequency",
  每天: "Daily",
  "每 3 天": "Every 3 days",
  每周: "Weekly",
  保留份数: "Keep",
  "最近 {0} 份": "Latest {0}",
  自动备份密码已保存: "Auto-backup password saved",
  自动备份密码: "Auto-backup password",
  保存密码: "Save password",
  "自动备份密码已由系统加密保存在本机。":
    "The auto-backup password is stored on this computer, encrypted by the system.",
  更换: "Change",
  "已保存的自动备份密码在本机无法读取（可能来自其他电脑的资料），请重新设置。":
    "The saved auto-backup password cannot be read here (the data may come from another computer). Set it again.",
  启用自动备份: "Enable auto backup",
  已完成一次自动备份: "Backup completed",
  立即备份: "Back up now",
  "上次：{0}（{1}）": "Last: {0} ({1})",
  尚未运行: "Not run yet",
  "下次：{0}": "Next: {0}",
  "最近一次自动备份失败：{0}": "The last auto backup failed: {0}",
  服务: "Services",
  "AI 资产": "AI assets",
  账号与密钥: "Accounts & keys",
  手机号: "Phone numbers",
  "模型 API Key": "Model API key",
  云服务与探针连接: "Cloud & probe connections",
  "图床 Key": "Image host key",
};
