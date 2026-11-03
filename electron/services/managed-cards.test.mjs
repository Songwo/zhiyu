import test from "node:test";
import assert from "node:assert/strict";
import {
  cardMonthEnd,
  detectCardNetwork,
  identifyCardDescription,
  esimPlanEnd,
  managedCardExpiry,
  managedCardDue,
  normalizeManagedCard,
} from "./managed-cards.mjs";
import { normalizeService } from "./service-assets.mjs";
import { normalizeSnapshotImages } from "./image-data.mjs";
import { extraExpiryCandidates, spendSummary, renewalCalendar } from "./renewals.mjs";
import { notificationCandidates } from "./notifications.mjs";
import { assetDocuments } from "./rag.mjs";

const asset = (card) =>
  normalizeService({
    id: "card-fixture",
    name: "测试支付卡",
    provider: "自定义服务商",
    category: "custom",
    status: "online",
    tags: ["家庭"],
    url: "",
    card,
  });

test("卡片说明只提取明确标注的信息，服务商本身不能决定类型", () => {
  assert.deepEqual(identifyCardDescription("Wise Visa virtual debit card"), {
    network: "Visa",
    provider: "Wise",
    funding: "借记卡",
    formFactor: "虚拟卡",
  });
  assert.deepEqual(identifyCardDescription("自定义发卡商 银联 实体信用卡"), {
    network: "UnionPay",
    funding: "信用卡",
    formFactor: "实体卡",
  });
  assert.deepEqual(identifyCardDescription("RedotPay"), { provider: "RedotPay" });
  assert.deepEqual(identifyCardDescription("一张未知的卡"), {});
});

test("只识别卡组织，不伪造信用属性；Mastercard 新旧号段边界正确", () => {
  for (const [number, network] of [
    ["4242 4242 4242 4242", "Visa"],
    ["5555555555554444", "Mastercard"],
    ["2221000000000009", "Mastercard"],
    ["2720990000000000", "Mastercard"],
    ["378282246310005", "American Express"],
    ["6200000000000000", "UnionPay"],
    ["6011111111111117", "Discover"],
    ["3530111333300000", "JCB"],
    ["30569309025904", "Diners Club"],
  ])
    assert.equal(detectCardNetwork(number), network);
  for (const value of [null, "", "424", "4242xxx4242", "2220000000000000", "2721000000000000"])
    assert.equal(detectCardNetwork(value), "");
});

test("有效月份严格取最后一天，覆盖闰年、跨年与非法月份", () => {
  assert.equal(cardMonthEnd("2028-02"), "2028-02-29");
  assert.equal(cardMonthEnd("2027-02"), "2027-02-28");
  assert.equal(cardMonthEnd("2026-12"), "2026-12-31");
  for (const value of ["2026-00", "2026-13", "2026-2", "0099-12", "no-date", undefined])
    assert.equal(cardMonthEnd(value), "");
});

test("卡片导入丢弃完整卡号、CVV、密码等非白名单信息，保留自定义类型", () => {
  const result = normalizeManagedCard({
    kind: "payment",
    last4: "4242",
    network: "自定义卡组织",
    funding: "自定义类型",
    formFactor: "虚拟卡",
    expiryMonth: "2028-02",
    number: "4242424242424242",
    cvv: "123",
    password: "never-persist",
  });
  assert.deepEqual(result, {
    kind: "payment",
    last4: "4242",
    network: "自定义卡组织",
    funding: "自定义类型",
    formFactor: "虚拟卡",
    expiryMonth: "2028-02",
  });
  const stored = asset(result);
  assert.equal(stored.expiresAt, "2028-02-29");
  assert.doesNotMatch(JSON.stringify(stored), /4242424242424242|never-persist|"cvv"/);
});

test("拒绝非法期限、天数、负流量、尾号与危险字段", () => {
  for (const patch of [
    { last4: "12345" },
    { expiryMonth: "2026-13" },
    { activatedAt: "2026-02-30" },
    { planExpiresAt: "2026-11-02T00:00:00Z" },
    { validityDays: 0 },
    { validityDays: 1.5 },
    { dataGb: -1 },
    { network: "bad\nvalue" },
  ])
    assert.throws(() => normalizeManagedCard({ kind: "esim", ...patch }));
  assert.throws(() => normalizeManagedCard({ kind: "unknown" }));
  assert.equal(normalizeManagedCard(undefined), undefined);
});

test("eSIM 以实际日期优先，未激活不推算，激活当天计第一天", () => {
  assert.equal(esimPlanEnd({ kind: "esim", validityDays: 30 }), "");
  assert.equal(
    esimPlanEnd({ kind: "esim", activatedAt: "2028-02-28", validityDays: 3 }),
    "2028-03-01",
  );
  assert.equal(
    esimPlanEnd({ kind: "esim", activatedAt: "2026-12-31", validityDays: 1 }),
    "2026-12-31",
  );
  const card = normalizeManagedCard({
    kind: "esim",
    activatedAt: "2026-11-02",
    validityDays: 30,
    planExpiresAt: "2026-11-15",
    keepAliveAt: "2026-11-10",
  });
  assert.equal(esimPlanEnd(card), "2026-11-15");
  assert.equal(managedCardExpiry(card), "2026-11-10");
});

test("日历日倒计时今天为零，过期和未知不能显示正常剩余天数", () => {
  const now = new Date(2026, 10, 2, 23, 59);
  assert.deepEqual(managedCardDue("2026-11-02", now), { state: "due", days: 0 });
  assert.deepEqual(managedCardDue("2026-11-01", now), { state: "expired", days: -1 });
  assert.deepEqual(managedCardDue("", now), { state: "unknown", days: null });
  assert.deepEqual(managedCardDue("2027-01-01", now), { state: "active", days: 60 });
});

test("快照往返、提醒与费用链路保留卡片，不丢两种 eSIM 期限", () => {
  const stored = asset({
    kind: "esim",
    planExpiresAt: "2026-11-20",
    keepAliveAt: "2026-11-10",
    carrier: "自定义运营商",
  });
  stored.billing = { amount: 10, currency: "USD", cycle: "month" };
  const snapshot = {
    servers: [],
    domains: [],
    certs: [],
    aiAssets: [],
    mailboxes: [],
    secrets: [],
    services: [stored],
    links: [],
  };
  const restored = normalizeSnapshotImages(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.services[0].card, stored.card);
  assert.equal(extraExpiryCandidates(restored, new Date(2026, 10, 2))[0].days, 8);
  assert.equal(
    notificationCandidates(restored, new Date(2026, 10, 2).getTime()).filter(
      (x) => x.id === stored.id,
    ).length,
    1,
  );
  assert.equal(spendSummary(restored).byCurrency.USD.monthly, 10);
});

test("卡片有效期不因月费而推算出不存在的未来续期", () => {
  const stored = asset({ kind: "payment", expiryMonth: "2026-11" });
  stored.billing = { amount: 5, currency: "USD", cycle: "month" };
  const entries = renewalCalendar(
    { services: [stored] },
    { from: "2026-11-01", to: "2027-03-01", now: new Date(2026, 10, 1) },
  );
  assert.ok(entries.every((entry) => !entry.projected));
});

test("AI 能查询卡片类型与两种期限，无法读取尾号、号码和激活资料", () => {
  const stored = asset({
    kind: "esim",
    plan: "旅行套餐",
    last4: "9876",
    phone: "+12025550123",
    planExpiresAt: "2026-12-10",
    keepAliveAt: "2027-01-01",
  });
  stored.card.activationCode = "private-activation-marker";
  const sources = assetDocuments({ services: [stored], links: [] });
  const output = JSON.stringify(sources);
  assert.match(output, /旅行套餐/);
  assert.match(output, /2026-12-10/);
  assert.match(output, /2027-01-01/);
  assert.doesNotMatch(output, /9876|12025550123|private-activation-marker/);
});
