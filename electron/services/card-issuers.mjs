/** 发卡银行与卡组织分别管理；这里的卡面是应用内设计，不是官方卡面复刻。 */
export const CHINA_BANKS = [
  ["ICBC", "中国工商银行", "工行|工商银行", "ruby", "rings"],
  ["CCB", "中国建设银行", "建行|建设银行", "cobalt", "facets"],
  ["ABC", "中国农业银行", "农行|农业银行", "jade", "contours"],
  ["BOC", "中国银行", "中行|Bank of China", "garnet", "rings"],
  ["COMM", "交通银行", "交行|Bank of Communications", "cobalt", "facets"],
  ["PSBC", "中国邮政储蓄银行", "邮储|邮政储蓄|邮政银行", "forest", "contours"],
  ["CMB", "招商银行", "招行|China Merchants Bank", "garnet", "orbits"],
  ["CITIC", "中信银行", "中信|China CITIC Bank", "ruby", "facets"],
  ["CEB", "中国光大银行", "光大银行|光大", "amethyst", "orbits"],
  ["HXBANK", "华夏银行", "华夏", "ruby", "contours"],
  ["CMBC", "中国民生银行", "民生银行|民生", "jade", "facets"],
  ["SPABANK", "平安银行", "平安|Ping An Bank", "copper", "facets"],
  ["CIB", "兴业银行", "兴业|Industrial Bank", "navy", "orbits"],
  ["SPDB", "上海浦东发展银行", "浦发银行|浦发|浦东发展银行", "navy", "contours"],
  ["GDB", "广发银行", "广发|广东发展银行", "ruby", "orbits"],
  ["CZBANK", "浙商银行", "浙商", "garnet", "facets"],
  ["BOHAIB", "渤海银行", "渤海", "navy", "contours"],
  ["EGBANK", "恒丰银行", "恒丰", "copper", "orbits"],
  ["BJBANK", "北京银行", "北京银行", "ruby", "facets"],
  ["SHBANK", "上海银行", "上海银行", "cobalt", "orbits"],
  ["JSBANK", "江苏银行", "江苏银行", "cobalt", "contours"],
  ["NJCB", "南京银行", "南京银行", "ruby", "rings"],
  ["NBBANK", "宁波银行", "宁波银行", "copper", "facets"],
  ["HZCB", "杭州银行", "杭州银行", "cobalt", "contours"],
  ["CDCB", "成都银行", "成都银行", "copper", "rings"],
  ["CSCB", "长沙银行", "长沙银行", "garnet", "orbits"],
  ["CQBANK", "重庆银行", "重庆银行", "ruby", "facets"],
  ["GCB", "广州银行", "广州银行", "ruby", "orbits"],
  ["HSBANK", "徽商银行", "徽商", "garnet", "contours"],
  ["DLB", "大连银行", "大连银行", "cobalt", "rings"],
];

/** @param {unknown} input */
export function findChinaBank(input) {
  const text = String(input ?? "").trim();
  if (!text) return undefined;
  return CHINA_BANKS.find(([code, name, aliases]) =>
    [code, name, ...aliases.split("|")].some((alias) => alias.toLowerCase() === text.toLowerCase()),
  );
}

/** 说明中的中文全称/别名或独立英文名称；不把 CMB 错配成 CMBC。 @param {string} text */
export function bankFromDescription(text) {
  return CHINA_BANKS.find(([code, name, aliases]) =>
    [name, ...aliases.split("|"), code].some((alias) =>
      /[\u3400-\u9fff]/.test(alias)
        ? text.includes(alias)
        : new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
    ),
  );
}

export const CARD_REGION_GROUPS = ["mainland", "hmt", "overseas", "global", "unknown"];
export const CARD_REGIONS = [
  "中国大陆",
  "中国香港",
  "中国澳门",
  "中国台湾",
  "日本",
  "新加坡",
  "美国",
  "英国",
  "加拿大",
  "澳大利亚",
  "德国",
  "法国",
  "韩国",
  "欧洲",
  "全球 / 多地区",
];

/** 优先尊重手动分组；不根据 Visa / 银联推断发行地区。 @param {{region?: string; regionGroup?: string}} card */
export function cardRegionGroup(card) {
  if (card.regionGroup && CARD_REGION_GROUPS.includes(card.regionGroup)) return card.regionGroup;
  const region = (card.region || "").trim();
  if (!region) return "unknown";
  if (
    /^(中国(大陆|内地)?|大陆|内地|中华人民共和国|CN|CHN|China|Mainland China|中国大陆地区)$/i.test(
      region,
    )
  )
    return "mainland";
  if (
    /^(中国)?(香港|澳门|台湾)(特别行政区|地区)?$|^(HK|MO|TW|Hong Kong|Macau|Macao|Taiwan)$/i.test(
      region,
    )
  )
    return "hmt";
  if (/全球|多地区|多国|global|worldwide|international/i.test(region)) return "global";
  return "overseas";
}

/** 只提供显示风格，不推断卡片权益或真实级别。 @param {string} provider @param {string} network @param {string} kind */
export function cardAppearance(provider, network, kind) {
  const bank = findChinaBank(provider);
  if (bank)
    return {
      mark: bank[0] === "HXBANK" ? "HXB" : bank[0] === "SPABANK" ? "PAB" : bank[0],
      palette: bank[3],
      motif: bank[4],
    };
  const presets = /** @type {Record<string, string[]>} */ ({
    redotpay: ["R", "ruby", "orbits"],
    bybit: ["B", "graphite", "facets"],
    wise: ["W", "forest", "contours"],
    revolut: ["R", "amethyst", "orbits"],
    "crypto.com": ["C", "navy", "facets"],
    nexo: ["N", "cobalt", "facets"],
    airalo: ["A", "copper", "orbits"],
    tello: ["T", "cobalt", "contours"],
    nomad: ["N", "forest", "contours"],
    holafly: ["H", "garnet", "orbits"],
  });
  const key = provider.trim().toLowerCase();
  const known = presets[key];
  if (known) return { mark: known[0], palette: known[1], motif: known[2] };
  const hash = [...(key || network || kind)].reduce(
    (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );
  return {
    mark: provider.trim().slice(0, 2).toUpperCase() || (kind === "esim" ? "e" : "Z"),
    palette: ["navy", "jade", "graphite", "copper", "amethyst"][hash % 5],
    motif: ["rings", "contours", "facets", "orbits"][hash % 4],
  };
}
