import { calendarDay, daysUntilDay } from "./renewals.mjs";
import { bankFromDescription, CARD_REGION_GROUPS, CHINA_BANKS } from "./card-issuers.mjs";

export const CARD_NETWORKS = [
  "Visa",
  "Mastercard",
  "UnionPay",
  "American Express",
  "Discover",
  "JCB",
  "Diners Club",
  "Maestro",
  "RuPay",
  "Mir",
  "Elo",
  "Troy",
];
export const CARD_PROVIDERS = [
  ...CHINA_BANKS.map(([, name]) => name),
  "RedotPay",
  "Bybit",
  "Crypto.com",
  "Nexo",
  "Wirex",
  "Wise",
  "Revolut",
  "Payoneer",
  "Airwallex",
  "Reap",
  "Privacy",
  "PSTNET",
  "Wallester",
];
export const ESIM_PROVIDERS = [
  "Airalo",
  "Nomad",
  "Holafly",
  "Ubigi",
  "Saily",
  "aloSIM",
  "GigSky",
  "BNESIM",
  "Keepgo",
  "Roamless",
  "eSIM.me",
  "3HK",
  "giffgaff",
  "Tello",
  "US Mobile",
  "中国移动",
  "中国联通",
  "中国电信",
];

/** 仅识别卡组织，不从卡号猜发卡商、信用属性或虚拟/实体；输入只在本机使用。 */
/** @param {unknown} input */
export function detectCardNetwork(input) {
  const number = String(input ?? "").replace(/[\s-]/g, "");
  if (!/^\d{6,19}$/.test(number)) return "";
  const prefix = Number(number.slice(0, 4));
  if (/^4/.test(number)) return "Visa";
  if (/^5[1-5]/.test(number) || (prefix >= 2221 && prefix <= 2720)) return "Mastercard";
  if (/^3[47]/.test(number)) return "American Express";
  if (/^62/.test(number)) return "UnionPay";
  if (/^(6011|65|64[4-9])/.test(number)) return "Discover";
  if (prefix >= 3528 && prefix <= 3589) return "JCB";
  if (/^(30[0-5]|36|38|39)/.test(number)) return "Diners Club";
  if (/^(50|5[6-9]|6[36789])/.test(number)) return "Maestro";
  return "";
}

/** 仅从用户粘贴的卡片说明提取明确标注的类型，不通过卡号推断信用或实体属性。 @param {string} input */
export function identifyCardDescription(input) {
  const text = input.slice(0, 2000);
  const result =
    /** @type {{ network?: string; funding?: string; formFactor?: string; provider?: string; region?: string; regionGroup?: string }} */ ({});
  const aliases = [
    ["Mastercard", /master\s?card|万事达/i],
    ["UnionPay", /union\s?pay|银联/i],
    ["Visa", /\bvisa\b/i],
    ["American Express", /american express|\bamex\b|美国运通/i],
    ["Diners Club", /diners club|大来/i],
    ["Discover", /\bdiscover\b/i],
    ["JCB", /\bjcb\b/i],
  ];
  for (const [network, pattern] of aliases) {
    if (pattern instanceof RegExp && pattern.test(text)) {
      result.network = String(network);
      break;
    }
  }
  const provider = CARD_PROVIDERS.find((name) => text.toLowerCase().includes(name.toLowerCase()));
  if (provider) result.provider = provider;
  const bank = bankFromDescription(text);
  if (bank) {
    result.provider = bank[1];
    result.region = "中国大陆";
    result.regionGroup = "mainland";
  }
  if (/prepaid|预付/i.test(text)) result.funding = "预付卡";
  else if (/debit|借记/i.test(text)) result.funding = "借记卡";
  else if (/credit|信用/i.test(text)) result.funding = "信用卡";
  else if (/crypto|加密货币|\bUSDT\b/i.test(text)) result.funding = "加密货币消费卡";
  if (/virtual|虚拟|digital card/i.test(text)) result.formFactor = "虚拟卡";
  else if (/physical|实体/i.test(text)) result.formFactor = "实体卡";
  return result;
}

/** 卡面只有月份时，严格取该月最后一天，不用 30 天近似。 */
/** @param {unknown} month */
export function cardMonthEnd(month) {
  if (
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    Number(month.slice(0, 4)) < 1900
  )
    return "";
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value, 0));
  return date.toISOString().slice(0, 10);
}

/** @param {unknown} value @returns {import('../../src/lib/types').ManagedCard | undefined} */
export function normalizeManagedCard(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("卡片资料格式无效。");
  const input = /** @type {Record<string, unknown>} */ (value);
  if (input.kind !== "payment" && input.kind !== "esim") throw new Error("卡片类型无效。");
  const result = /** @type {import('../../src/lib/types').ManagedCard} */ ({ kind: input.kind });
  if (input.regionGroup != null && input.regionGroup !== "") {
    if (typeof input.regionGroup !== "string" || !CARD_REGION_GROUPS.includes(input.regionGroup))
      throw new Error("卡片地域分组无效。");
    result.regionGroup = /** @type {import('../../src/lib/types').ManagedCard['regionGroup']} */ (
      input.regionGroup
    );
  }
  for (const key of /** @type {const} */ ([
    "network",
    "funding",
    "formFactor",
    "region",
    "phone",
    "plan",
    "carrier",
  ])) {
    const text = input[key];
    if (text == null || text === "") continue;
    if (
      typeof text !== "string" ||
      text.length > 160 ||
      [...text].some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error("卡片字段格式无效或过长。");
    result[key] = text.trim();
  }
  if (input.last4) {
    if (typeof input.last4 !== "string" || !/^\d{4}$/.test(input.last4))
      throw new Error("尾号需要填写 4 位数字。");
    result.last4 = input.last4;
  }
  if (input.expiryMonth) {
    if (!cardMonthEnd(input.expiryMonth)) throw new Error("有效月份无效。");
    result.expiryMonth = String(input.expiryMonth);
  }
  for (const key of /** @type {const} */ (["planExpiresAt", "keepAliveAt", "activatedAt"])) {
    if (!input[key]) continue;
    const date = calendarDay(input[key]);
    if (!date || date !== input[key]) throw new Error("卡片日期无效，请填写完整日期。");
    result[key] = date;
  }
  for (const key of /** @type {const} */ (["validityDays", "dataGb"])) {
    if (input[key] == null || input[key] === "") continue;
    const number = Number(input[key]);
    if (
      !Number.isFinite(number) ||
      number < 0 ||
      number > 100000 ||
      (key === "validityDays" && (!Number.isInteger(number) || number < 1))
    )
      throw new Error("套餐天数或流量无效。");
    result[key] = number;
  }
  return result;
}

/** 日期级套餐：激活当天计为第一天；不推断供应商的激活规则与具体失效时刻。 */
/** @param {import("../../src/lib/types").ManagedCard} card */
export function esimPlanEnd(card) {
  if (card.planExpiresAt) return card.planExpiresAt;
  if (!card.activatedAt || !card.validityDays) return "";
  const date = new Date(card.activatedAt + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + card.validityDays - 1);
  return date.toISOString().slice(0, 10);
}

/** 最近的硬性期限进入现有续费、通知和日历链路；两种 eSIM 期限独立保存。 */
/** @param {import("../../src/lib/types").ManagedCard} card */
export function managedCardExpiry(card) {
  if (card.kind === "payment") return cardMonthEnd(card.expiryMonth);
  return [esimPlanEnd(card), card.keepAliveAt].filter(Boolean).sort()[0] ?? "";
}

/** @param {string} date @param {Date} [now] */
export function managedCardDue(date, now = new Date()) {
  if (!calendarDay(date)) return { state: "unknown", days: null };
  const days = daysUntilDay(date, now);
  return { state: days < 0 ? "expired" : days <= 30 ? "due" : "active", days };
}
