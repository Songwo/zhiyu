import test from "node:test";
import assert from "node:assert/strict";
import { detectChinaBank, bankMetadataPatch } from "../src/lib/card-identity.mjs";
import {
  CHINA_BANKS,
  bankFromDescription,
  cardAppearance,
  cardRegionGroup,
  findChinaBank,
} from "../electron/services/card-issuers.mjs";
import { CHINA_BANK_BINS } from "../electron/services/data/card-bank-bins.mjs";
import {
  identifyCardDescription,
  normalizeManagedCard,
} from "../electron/services/managed-cards.mjs";

test("30 家银行各有离线号段，完整号码与长度一起匹配", () => {
  assert.equal(CHINA_BANKS.length, 30);
  for (const [code] of CHINA_BANKS) {
    const rows = CHINA_BANK_BINS.filter(([, bank]) => bank === code);
    assert.ok(rows.length > 0, code);
    const row = rows.find(
      ([bin, , length]) => detectChinaBank(bin.padEnd(length, "0"))?.code === code,
    );
    assert.ok(row, `${code} 至少有一个唯一号段`);
  }
  assert.equal(detectChinaBank("6222 0200 0000 0000 000")?.provider, "中国工商银行");
  assert.equal(detectChinaBank("6228480000000000000")?.provider, "中国农业银行");
});

test("最长前缀优先；跨行重复号段与未知卡不误猜", () => {
  const rows = [
    ["622202", "ICBC", 16],
    ["62220212", "CCB", 16],
  ];
  assert.equal(detectChinaBank("6222021200000000", rows)?.code, "CCB");
  assert.equal(detectChinaBank("6222021200000000000", rows), undefined);
  assert.equal(
    detectChinaBank("622202", [
      ["622202", "ICBC", 16],
      ["622202", "CCB", 19],
    ]),
    undefined,
  );
  assert.equal(
    detectChinaBank("6222020000000000000", [
      ["622202", "ICBC", 16],
      ["622202", "CCB", 19],
    ])?.code,
    "CCB",
  );
  for (const number of ["4242424242424242", "62", "622202x", "62220200000000000000", null])
    assert.equal(detectChinaBank(number), undefined);
});

test("自动补充空字段，手动服务商和地区受保护，采用结果必须显式指定", () => {
  const bank = detectChinaBank("6228480000000000000");
  assert.deepEqual(bankMetadataPatch({}, bank), {
    provider: "中国农业银行",
    region: "中国大陆",
    regionGroup: "mainland",
  });
  assert.deepEqual(
    bankMetadataPatch({ provider: "自定义服务商", region: "美国", regionGroup: "overseas" }, bank),
    {},
  );
  assert.deepEqual(bankMetadataPatch({ provider: "Wise" }, bank), {});
  assert.deepEqual(bankMetadataPatch({ provider: "Wise", region: "美国" }, bank, true), {
    provider: "中国农业银行",
    region: "中国大陆",
    regionGroup: "mainland",
  });
  assert.deepEqual(bankMetadataPatch({ provider: "农行" }, bank), {
    region: "中国大陆",
    regionGroup: "mainland",
  });
});

test("银行简称、中文说明与英文代码匹配，不串行，不推断信用属性", () => {
  assert.equal(findChinaBank("工行")?.[0], "ICBC");
  assert.equal(findChinaBank("ping an bank")?.[0], "SPABANK");
  assert.equal(bankFromDescription("CMBC 银联卡")?.[0], "CMBC");
  assert.equal(bankFromDescription("customcmbcprovider"), undefined);
  assert.deepEqual(identifyCardDescription("招行 银联 实体信用卡"), {
    provider: "招商银行",
    network: "UnionPay",
    funding: "信用卡",
    formFactor: "实体卡",
    region: "中国大陆",
    regionGroup: "mainland",
  });
  assert.deepEqual(identifyCardDescription("中国工商银行"), {
    provider: "中国工商银行",
    region: "中国大陆",
    regionGroup: "mainland",
  });
});

test("地域分组支持既有数据、港澳台、自定义地区与手动优先，序列化保留", () => {
  for (const region of ["中国", "中国大陆", "CN", "Mainland China"])
    assert.equal(cardRegionGroup({ region }), "mainland");
  for (const region of ["中国香港", "澳门", "TW", "Hong Kong"])
    assert.equal(cardRegionGroup({ region }), "hmt");
  assert.equal(cardRegionGroup({ region: "日本" }), "overseas");
  assert.equal(cardRegionGroup({ region: "全球 / 多地区" }), "global");
  assert.equal(cardRegionGroup({}), "unknown");
  assert.equal(cardRegionGroup({ region: "自定义区域", regionGroup: "mainland" }), "mainland");
  const card = normalizeManagedCard({ kind: "payment", region: "自定义区域", regionGroup: "hmt" });
  assert.equal(cardRegionGroup(JSON.parse(JSON.stringify(card))), "hmt");
  assert.throws(() => normalizeManagedCard({ kind: "esim", regionGroup: "arbitrary" }));
});

test("发卡行卡面有稳定身份，自定义卡面不随重载变色，不将卡组织当作发卡地区", () => {
  assert.equal(cardAppearance("工行", "UnionPay", "payment").palette, "ruby");
  assert.equal(cardAppearance("中国建设银行", "UnionPay", "payment").palette, "cobalt");
  assert.equal(cardAppearance("中国农业银行", "Visa", "payment").palette, "jade");
  assert.deepEqual(
    cardAppearance("自定义银行", "Visa", "payment"),
    cardAppearance("自定义银行", "Visa", "payment"),
  );
  assert.equal(cardRegionGroup({ network: "UnionPay" }), "unknown");
});
