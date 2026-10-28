param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$target = (Resolve-Path -LiteralPath $Path).Path
$thumbprint = $env:ZHIYU_SIGN_CERT_SHA1
if (!$thumbprint) {
  if ($env:ZHIYU_REQUIRE_SIGNING -eq '1') { throw '签名为必选，但未配置 ZHIYU_SIGN_CERT_SHA1。' }
  Write-Output '未配置受信任代码签名证书：该产物未签名。'
  exit 0
}
if ($thumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw '证书指纹格式无效。' }
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint"
if (!$certificate.HasPrivateKey -or $certificate.NotAfter -lt (Get-Date)) { throw '证书没有可用私钥或已过期。' }
if ('1.3.6.1.5.5.7.3.3' -notin $certificate.EnhancedKeyUsageList.ObjectId.Value) { throw '证书不包含代码签名用途。' }
$result = Set-AuthenticodeSignature -LiteralPath $target -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
if ($result.Status -ne 'Valid' -or !$result.TimeStamperCertificate) { throw "签名或可信时间戳校验失败：$($result.Status)" }
Write-Output 'Authenticode 签名与可信时间戳校验通过。'
