import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextRenewal,
  SUBSCRIPTION_TEMPLATES,
  TEMPLATE_GROUPS,
  templatePreset,
} from "./subscription-templates.ts";

test("下次续费日：按周期推算，月底顺延到较短月份的最后一天", () => {
  assert.equal(nextRenewal("month", new Date(2026, 9, 22)), "2026-11-22");
  assert.equal(nextRenewal("month", new Date(2027, 0, 31)), "2027-02-28");
  assert.equal(nextRenewal("year", new Date(2028, 1, 29)), "2029-02-28");
  assert.equal(nextRenewal("month", new Date(2026, 11, 15)), "2027-01-15");
});

test("服务资产模板预填费用字段与到期日，AI 模板预填美元月费", () => {
  const today = new Date(2026, 9, 22);
  const workers = SUBSCRIPTION_TEMPLATES.find((item) => item.id === "cloudflare-workers")!;
  assert.deepEqual(templatePreset(workers, today), {
    name: "Cloudflare Workers Paid",
    category: "custom",
    provider: "Cloudflare",
    url: "https://dash.cloudflare.com",
    billingAmount: "5",
    billingCurrency: "USD",
    billingCycle: "month",
    expiresAt: "2026-11-22",
    tags: "订阅",
  });
  const chatgpt = SUBSCRIPTION_TEMPLATES.find((item) => item.id === "chatgpt-plus")!;
  assert.deepEqual(templatePreset(chatgpt, today), {
    name: "ChatGPT Plus",
    provider: "OpenAI",
    plan: "Plus",
    monthlyUsd: "20",
    renewsAt: "2026-11-22",
    tags: "订阅",
  });
});

test("模板数据完整：标识唯一、分组存在、金额为正、AI 模板都用美元", () => {
  const ids = new Set(SUBSCRIPTION_TEMPLATES.map((item) => item.id));
  assert.equal(ids.size, SUBSCRIPTION_TEMPLATES.length);
  const groups = new Set(TEMPLATE_GROUPS.map((group) => group.id));
  for (const item of SUBSCRIPTION_TEMPLATES) {
    assert.ok(groups.has(item.group), item.id);
    assert.ok(item.amount > 0, item.id);
    if (item.kind === "ai") assert.equal(item.currency, "USD", item.id);
  }
});
