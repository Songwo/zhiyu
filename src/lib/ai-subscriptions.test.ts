import test from "node:test";
import assert from "node:assert/strict";
import { subscriptionFromAccount } from "./ai-subscriptions.ts";
import type { AiAccount } from "./ai-accounts.ts";

const account: AiAccount = {
  id: "ai-oauth:test-grok",
  provider: "grok",
  accountId: "person-one",
  email: "person@example.test",
  plan: "",
  tokenExpiresAt: "2026-10-01T00:00:00Z",
  subscriptionExpiresAt: null,
  refreshable: true,
  usage: null,
};

test("网页登录缺少价格、套餐、用量和订阅日期时不推算数据", () => {
  const item = subscriptionFromAccount(account);
  assert.equal(item.oauthAccountId, account.id);
  assert.equal(item.provider, "xAI / Grok");
  assert.equal(item.plan, "");
  assert.equal(item.monthlyUsdKnown, false);
  assert.equal(item.usageAvailable, false);
  assert.equal(item.renewsAt, "");
  assert.equal(item.subscriptionExpiresAt, null);
});

test("同一账号使用稳定标识，刷新保留手动资料并同步真实额度", () => {
  const first = subscriptionFromAccount(account);
  const previous = {
    ...first,
    name: "我的研发账号",
    monthlyUsd: 30,
    monthlyUsdKnown: true,
    tags: ["研发"],
    notes: "工作用",
    renewsAt: "2026-11-01",
    imageDataUrl: "data:image/png;base64,test-image",
  };
  const next = subscriptionFromAccount(
    {
      ...account,
      plan: "SuperGrok",
      usage: {
        checkedAt: "2026-09-07T00:00:00Z",
        windows: [
          { label: "weekly", usedPercent: 31, resetsAt: "2026-09-14T00:00:00Z" },
          { label: "model", usedPercent: 93, resetsAt: null },
        ],
      },
    },
    previous,
  );
  assert.equal(next.id, first.id);
  assert.equal(next.name, previous.name);
  assert.equal(next.imageDataUrl, previous.imageDataUrl);
  assert.equal(next.plan, "SuperGrok");
  assert.equal(next.usagePct, 93);
  assert.equal(next.status, "warning");
  assert.equal(next.usageAvailable, true);
  assert.equal(next.monthlyUsd, 30);
  assert.deepEqual(next.tags, ["研发"]);
  assert.equal(next.renewsAt, "2026-11-01");
  assert.equal(next.subscriptionExpiresAt, null);
});

test("只有剩余数量时不伪造百分比", () => {
  const item = subscriptionFromAccount({
    ...account,
    usage: {
      checkedAt: "2026-09-08T00:00:00Z",
      windows: [{ label: "model", usedPercent: null, remaining: 1500, resetsAt: null }],
    },
  });
  assert.equal(item.usageAvailable, false);
});

test("不同账号不会合并，额外的令牌字段不会进入资产导出", () => {
  const privateAccount = { ...account, tokens: { access_token: "secret-token-for-test" } };
  const first = subscriptionFromAccount(privateAccount);
  const second = subscriptionFromAccount({ ...account, id: "ai-oauth:other-account" });
  assert.notEqual(first.id, second.id);
  assert.equal(JSON.stringify(first).includes("secret-token-for-test"), false);
  assert.equal("tokens" in first, false);
});

test("订阅同步保留提醒偏好，旧记录仍继承，新记录默认开启", () => {
  const initial = subscriptionFromAccount(account);
  assert.deepEqual(initial.expiryReminder, { enabled: true, leadDays: 3 });
  const previous = { ...initial, expiryReminder: { enabled: false, leadDays: 7 } };
  assert.deepEqual(
    subscriptionFromAccount(account, previous).expiryReminder,
    previous.expiryReminder,
  );
  delete initial.expiryReminder;
  assert.equal(subscriptionFromAccount(account, initial).expiryReminder, undefined);
});
