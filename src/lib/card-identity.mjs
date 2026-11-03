import { CHINA_BANK_BINS } from "../../electron/services/data/card-bank-bins.mjs";
import { CHINA_BANKS, findChinaBank } from "../../electron/services/card-issuers.mjs";

/**
 * 仅在本机匹配固定版本的参考号段。6/8 位前缀可作提示；完整号码必须同时匹配长度。
 * 最长号段优先，同号段跨行歧义不猜测。不验证账户有效性，也不从 BIN 推断信用/借记。
 * @param {unknown} input
 * @param {[string, string, number][]} [rows]
 */
export function detectChinaBank(input, rows = CHINA_BANK_BINS) {
  const number = String(input ?? "").replace(/[\s-]/g, "");
  if (!/^(?:\d{6}|\d{8}|\d{12,19})$/.test(number)) return undefined;
  const full = number.length >= 12;
  const matches = rows.filter(
    ([bin, , length]) => number.startsWith(bin) && (!full || length === number.length),
  );
  const longest = Math.max(0, ...matches.map(([bin]) => bin.length));
  const codes = [
    ...new Set(matches.filter(([bin]) => bin.length === longest).map(([, code]) => code)),
  ];
  if (codes.length !== 1) return undefined;
  const bank = CHINA_BANKS.find(([code]) => code === codes[0]);
  if (!bank) return undefined;
  return {
    code: bank[0],
    provider: bank[1],
    region: "中国大陆",
    regionGroup: /** @type {const} */ ("mainland"),
  };
}

/** 不覆盖用户已填写的服务商和地区；显式采用后才替换。 @param {{provider?: string; region?: string; regionGroup?: string}} current @param {ReturnType<typeof detectChinaBank>} bank @param {boolean} [adopt] */
export function bankMetadataPatch(current, bank, adopt = false) {
  if (!bank) return {};
  if (adopt) return { provider: bank.provider, region: bank.region, regionGroup: bank.regionGroup };
  const sameBank = !current.provider?.trim() || findChinaBank(current.provider)?.[0] === bank.code;
  return {
    ...(!current.provider?.trim() ? { provider: bank.provider } : {}),
    ...(sameBank && !current.region?.trim() && !current.regionGroup
      ? { region: bank.region, regionGroup: bank.regionGroup }
      : {}),
  };
}
