import assert from "node:assert/strict";
import test from "node:test";
import {
  billedItems,
  billingFromForm,
  calendarDay,
  combinedInCny,
  daysUntilDay,
  dueTotals,
  normalizeBilling,
  renewalTimeline,
  spendSummary,
} from "./renewals.mjs";
import { normalizeService } from "./service-assets.mjs";
import { normalizePhoneNumber } from "./phone-numbers.mjs";
import { notificationCandidates } from "./notifications.mjs";

const now = new Date(2026, 9, 20, 9, 30);
const snapshot = {
  servers: [
    {
      id: "vps",
      name: "东京 VPS",
      expiresAt: "2026-11-05",
      billing: { amount: 5, currency: "USD", cycle: "month" },
    },
    { id: "old", name: "无到期的服务器" },
  ],
  domains: [
    {
      id: "d1",
      name: "example.com",
      expiresAt: "2026-12-31",
      billing: { amount: 79, currency: "CNY", cycle: "year" },
    },
    { id: "d2", name: "unpriced.dev", expiresAt: "2026-10-25" },
  ],
  services: [
    {
      id: "s1",
      name: "图床",
      expiresAt: "2026-10-10",
      billing: { amount: 120, currency: "CNY", cycle: "year" },
    },
  ],
  phoneNumbers: [
    {
      id: "p1",
      number: "+86 170 0000 1234",
      label: "",
      expiresAt: "2027-06-01",
      billing: { amount: 29, currency: "CNY", cycle: "once" },
    },
  ],
  aiAssets: [
    { id: "a1", name: "ChatGPT", monthlyUsd: 20, renewsAt: "2026-10-28T08:00:00.000Z" },
    {
      id: "a2",
      name: "Claude",
      monthlyUsd: 0,
      monthlyUsdKnown: false,
      oauthAccountId: "acc",
      renewsAt: "",
      subscriptionExpiresAt: "2026-11-15",
    },
  ],
  certs: [{ id: "c1", cn: "*.example.com", expiresAt: "2026-11-01" }],
};

test("费用字段：合法值保留并取整到分，残缺或非法值视为未填写", () => {
  assert.deepEqual(normalizeBilling({ amount: 9.999, currency: "USD", cycle: "month" }), {
    amount: 10,
    currency: "USD",
    cycle: "month",
  });
  assert.deepEqual(normalizeBilling({ amount: "12.5", currency: "CNY", cycle: "year" }), {
    amount: 12.5,
    currency: "CNY",
    cycle: "year",
  });
  for (const bad of [
    undefined,
    null,
    [],
    "79",
    { amount: -1, currency: "CNY", cycle: "year" },
    { amount: Number.NaN, currency: "CNY", cycle: "year" },
    { amount: 1, currency: "EUR", cycle: "year" },
    { amount: 1, currency: "CNY", cycle: "week" },
    { currency: "CNY", cycle: "year" },
  ])
    assert.equal(normalizeBilling(bad), undefined);
});

test("表单金额留空不记录费用，非法金额报错，默认人民币年付", () => {
  assert.equal(billingFromForm({ amount: "  " }), undefined);
  assert.deepEqual(billingFromForm({ amount: "1,299" }), {
    amount: 1299,
    currency: "CNY",
    cycle: "year",
  });
  assert.deepEqual(billingFromForm({ amount: "0", currency: "USD", cycle: "once" }), {
    amount: 0,
    currency: "USD",
    cycle: "once",
  });
  assert.throws(() => billingFromForm({ amount: "abc" }));
  assert.throws(() => billingFromForm({ amount: "-5" }));
});

test("日期统一成本地日历日，非法日期为空", () => {
  assert.equal(calendarDay("2026-02-28"), "2026-02-28");
  assert.equal(calendarDay("2026-02-30"), "");
  assert.equal(calendarDay("not a date"), "");
  assert.equal(calendarDay(undefined), "");
  const local = new Date(2026, 0, 5, 23, 30);
  assert.equal(calendarDay(local.toISOString()), "2026-01-05");
  assert.equal(daysUntilDay("2026-10-20", now), 0);
  assert.equal(daysUntilDay("2026-10-21", now), 1);
  assert.equal(daysUntilDay("2026-10-10", now), -10);
});

test("时间线按日期排列窗口内到期项，含近期已过期，跳过没有日期的资产", () => {
  const within30 = renewalTimeline(snapshot, { withinDays: 30, now });
  assert.deepEqual(
    within30.map((x) => [x.key, x.days]),
    [
      ["service:s1", -10],
      ["domain:d2", 5],
      ["ai:a1", 8],
      ["cert:c1", 12],
      ["server:vps", 16],
      ["ai:a2", 26],
    ],
  );
  const within90 = renewalTimeline(snapshot, { withinDays: 90, now });
  assert.equal(within90.at(-1)?.key, "domain:d1");
  assert.equal(
    within90.some((x) => x.kind === "phone"),
    false,
  );
  // 过期超过 30 天的视为弃用，不再列出。
  const stale = renewalTimeline(
    { servers: [{ id: "x", name: "x", expiresAt: "2026-08-01" }] },
    { now },
  );
  assert.deepEqual(stale, []);
});

test("号码没有名称时只显示末四位，OAuth 订阅使用平台到期日且未知月费不算 0", () => {
  const all = renewalTimeline(snapshot, { withinDays: 400, now });
  assert.equal(all.find((x) => x.kind === "phone")?.name, "••••1234");
  const claude = all.find((x) => x.id === "a2");
  assert.equal(claude?.date, "2026-11-15");
  assert.equal(claude?.billing, undefined);
  assert.deepEqual(
    billedItems(snapshot).map((x) => x.id),
    ["vps", "d1", "s1", "p1", "a1"],
  );
});

test("按币种折算月度与年度支出，一次性费用单列，不做汇率换算", () => {
  const summary = spendSummary(snapshot);
  assert.deepEqual(summary.byCurrency.USD, { monthly: 25, yearly: 300, once: 0, count: 2 });
  assert.deepEqual(summary.byCurrency.CNY, {
    monthly: 16.58,
    yearly: 199,
    once: 29,
    count: 3,
  });
  // 有日期但没填费用的：unpriced.dev 和无月费的 Claude；证书和无日期服务器不计入。
  assert.equal(summary.unpriced, 2);
});

test("只有设置了有效汇率才合并为人民币", () => {
  const summary = spendSummary(snapshot);
  assert.equal(combinedInCny(summary, null), null);
  assert.equal(combinedInCny(summary, 0), null);
  assert.equal(combinedInCny(summary, Number.NaN), null);
  assert.deepEqual(combinedInCny(summary, 7.2), { monthly: 196.58, yearly: 2359, once: 29 });
});

test("窗口内到期费用按币种合计", () => {
  assert.deepEqual(dueTotals(renewalTimeline(snapshot, { withinDays: 30, now })), {
    CNY: 120,
    USD: 25,
  });
});

test("旧数据缺费用字段时保持兼容：服务与号码规范化保留合法费用、丢弃非法费用", () => {
  const base = { id: "svc", name: "博客", category: "blog", status: "online", tags: [] };
  assert.equal("billing" in normalizeService(base), false);
  assert.equal("expiresAt" in normalizeService(base), false);
  const priced = normalizeService({
    ...base,
    expiresAt: "2027-01-01",
    billing: { amount: 10, currency: "USD", cycle: "month" },
  });
  assert.equal(priced.expiresAt, "2027-01-01");
  assert.deepEqual(priced.billing, { amount: 10, currency: "USD", cycle: "month" });
  const broken = normalizeService({ ...base, expiresAt: "soon", billing: { amount: "x" } });
  assert.equal("billing" in broken, false);
  assert.equal("expiresAt" in broken, false);

  const phone = {
    id: "p",
    number: "+86 138 0000 0000",
    expiresAt: "",
    subscriptionIds: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
  assert.equal("billing" in normalizePhoneNumber(phone), false);
  assert.deepEqual(
    normalizePhoneNumber({ ...phone, billing: { amount: 8, currency: "CNY", cycle: "month" } })
      .billing,
    { amount: 8, currency: "CNY", cycle: "month" },
  );
});

test("托盘通知包含服务器与服务资产的到期日，跳过演示数据与远期到期", () => {
  const items = notificationCandidates(
    {
      servers: [
        { id: "vps", name: "VPS", status: "online", expiresAt: "2026-10-25" },
        { id: "later", name: "Later", status: "online", expiresAt: "2027-01-01" },
        { id: "demo", name: "Demo", status: "online", expiresAt: "2026-10-22", demo: true },
      ],
      services: [{ id: "s", name: "图床", expiresAt: "2026-10-18" }],
    },
    now.getTime(),
  );
  assert.deepEqual(
    items.map((x) => [x.kind, x.id, x.days]),
    [
      ["server", "vps", 5],
      ["service", "s", -2],
    ],
  );
  assert.match(items[0].key, /:week$/);
  assert.match(items[1].key, /:expired$/);
});
