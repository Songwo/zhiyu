# Windows 签名接入

当前尚无受信任代码签名证书，正式产物按未签名发行，不能通过自签名证书消除普通用户电脑上的未知发布者提示。

维护者是中国大陆个人开发者。根据微软 2026 年 10 月的公开资格说明，Azure Artifact Signing 的公开信任个人验证仅面向美国和加拿大，当前不适用。开源项目可申请 SignPath Foundation 的免费签名，是否获批需审核；也可向支持个人身份验证的 CA 咨询代码签名证书（例如 Certum）。购买前确认所在地、个人身份和非商业开源许可条件，以及硬件/云端私钥的使用方式，不能假定一定支持下载 PFX。

- [微软个人开发者资格](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [SignPath Foundation 条件](https://signpath.org/terms)
- [Certum 代码签名产品](https://www.certum.eu/en/code-signing-certificates/)
- [Certum 身份材料说明](https://support.certum.eu/en/code-signing-required-documents/)

## 已准备的证书存储区接入

对 Windows 构建机当前用户证书存储区中、带代码签名用途与可用私钥的证书，配置 `ZHIYU_SIGN_CERT_SHA1` 为 40 位证书指纹。私钥可由设备或云客户端提供，无需把私钥交给项目代码。`ZHIYU_REQUIRE_SIGNING=1` 会在配置缺失或签名失败时阻止发行；未配置时明确输出未签名。

`scripts/package-desktop.mjs` 将证书指纹传给 Electron Builder，签名桌面程序与离线安装包。在线引导器在离线安装包签名完成后生成，再由 `scripts/sign-windows.ps1` 签名，并验证签名状态与时间戳。随后才能计算所有校验文件。不能先固定在线载荷哈希，再修改离线包签名。

GitHub 托管的 Windows runner 不会自动拥有本机证书。云服务、硬件证书、SignPath 等方案确定后，需要按服务方说明增加专用授权或受保护签名步骤；当前代码不虚构可用的云签名账号。首次启用时需验证整条流水线，证书过期和续期也要重新检查。

## 需要维护者提供的信息

只需先提供选择的签名服务、是否通过身份验证、证书公开主题/发布者名称，以及希望使用的构建环境。服务管理员在 GitHub 的受保护环境或 Secrets 中配置授权；证书私钥、PFX 密码、云签名令牌、身份证照片不要发到聊天、Issue 或仓库。办理身份核验应在签名服务官方平台完成。

签名不保证立即消除所有 SmartScreen 或安全软件提示；不得在下载页作此承诺。
