/** @typedef {{ number: string; holder: string; cvv: string; iccid: string; eid: string; activationCode: string; note: string }} CardPrivate */

/** 卡片敏感资料独立写入密钥库，不属于资产快照、关系或 AI 元信息。 @param {unknown} value @param {"payment" | "esim"} kind @returns {CardPrivate} */
export function normalizeCardPrivate(value, kind) {
  if (kind !== "payment" && kind !== "esim") throw new Error("卡片类型无效。");
  const result = {
    number: "",
    holder: "",
    cvv: "",
    iccid: "",
    eid: "",
    activationCode: "",
    note: "",
  };
  if (value == null) return result;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("加密卡片资料格式无效。");
  const input = /** @type {Record<string, unknown>} */ (value);
  for (const key of /** @type {const} */ ([
    "number",
    "holder",
    "cvv",
    "iccid",
    "eid",
    "activationCode",
    "note",
  ])) {
    const text = input[key] ?? "";
    if (
      typeof text !== "string" ||
      text.length > (key === "note" ? 10000 : key === "activationCode" ? 4096 : 200)
    )
      throw new Error("加密卡片字段无效或过长。");
    result[key] = text.trim();
  }
  if (kind === "payment") {
    result.number = result.number.replace(/[\s-]/g, "");
    if (result.number && !/^\d{12,19}$/.test(result.number))
      throw new Error("完整卡号需要是 12 至 19 位数字。");
    if (result.cvv && !/^\d{3,4}$/.test(result.cvv))
      throw new Error("安全码需要是 3 至 4 位数字。");
    result.iccid = result.eid = result.activationCode = "";
  } else {
    result.iccid = result.iccid.replace(/[\s-]/g, "");
    result.eid = result.eid.replace(/[\s-]/g, "");
    if (result.iccid && !/^\d{18,22}$/.test(result.iccid))
      throw new Error("ICCID 需要是 18 至 22 位数字。");
    if (result.eid && !/^\d{32}$/.test(result.eid)) throw new Error("EID 需要是 32 位数字。");
    result.number = result.holder = result.cvv = "";
  }
  return result;
}

/** @param {string} id */
export const cardPrivateId = (id) => `card-private:${id}`;
