import assert from "node:assert/strict";
import { test } from "node:test";
import { quickStartSteps, type QuickStartInput } from "./quick-start.ts";

const empty: QuickStartInput = {
  servers: [],
  domains: [],
  services: [],
  phoneNumbers: [],
  aiAssets: [],
  certs: [],
  mailboxes: [],
  secrets: [],
  links: [],
  documentCount: 0,
};
const done = (input: QuickStartInput) =>
  Object.fromEntries(quickStartSteps(input).map((step) => [step.id, step.done]));

test("空工作区：五步都未完成，顺序固定", () => {
  const steps = quickStartSteps(empty);
  assert.deepEqual(
    steps.map((step) => step.id),
    ["asset", "billing", "document", "link", "tag"],
  );
  assert.ok(steps.every((step) => !step.done));
});

test("按已有资料判断完成：资产、费用、文档、关联与标签", () => {
  assert.deepEqual(
    done({
      ...empty,
      domains: [{ tags: ["博客"], billing: { amount: 69, currency: "CNY", cycle: "year" } }],
      links: [{}],
      documentCount: 2,
    }),
    { asset: true, billing: true, document: true, link: true, tag: true },
  );
});

test("只有号码也算添加了资产；未知月费的 AI 订阅不算记录了费用", () => {
  const result = done({
    ...empty,
    phoneNumbers: [{}],
    aiAssets: [{ monthlyUsd: 0, monthlyUsdKnown: false }],
  });
  assert.equal(result.asset, true);
  assert.equal(result.billing, false);
  assert.equal(done({ ...empty, aiAssets: [{ monthlyUsd: 20 }] }).billing, true);
});

test("文档列表尚未读取时，文档一步按未完成处理", () => {
  assert.equal(done({ ...empty, documentCount: null }).document, false);
});
