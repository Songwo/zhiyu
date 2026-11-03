/** 只使用公开服务商与系统字段，不把卡号、邮箱、主机地址、密码、备注或文档正文拼入查询。
 * @param {string} kind
 * @param {{provider?:string;os?:string;registrar?:string;issuer?:string;card?:{kind?:string};name?:string;address?:string}} asset
 */
export function publicResearchQuery(kind, asset = {}) {
  /** @param {unknown} value */
  const text = (value) =>
    typeof value === "string" ? value.replace(/[\r\n]/g, " ").slice(0, 160) : "";
  if (kind === "server") return `${text(asset.os)} 服务器维护 官方文档`.trim();
  if (kind === "domain") return `${text(asset.registrar)} 域名续费 官方说明`.trim();
  if (kind === "cert") return `${text(asset.issuer)} 证书续期 官方文档`.trim();
  if (kind === "ai") return `${text(asset.provider)} 套餐 额度 官方说明`.trim();
  if (kind === "service")
    return `${text(asset.provider)} ${asset.card?.kind === "esim" ? "eSIM 保号与到期规则" : asset.card?.kind === "payment" ? "支付卡费用与有效期" : "使用说明"} 官方文档`.trim();
  return "";
}
