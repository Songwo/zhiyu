import test from "node:test";
import assert from "node:assert/strict";
import { filterUsage, summarizeUsage, exportUsage, usageDay } from "../src/lib/usage-insights.mjs";
import * as insights from "../src/lib/usage-insights.mjs";

const row = {
  sourceId: "api",
  sourceName: "测试组织",
  key: "day",
  kind: "tokens",
  label: "model",
  checkedAt: "2026-10-06T10:00:00Z",
  bucketStart: "2026-10-06",
  input: 100,
  output: 20,
  cached: 50,
};
test("本机日志与组织用量分开，缓存不重复累加", () => {
  const summary = summarizeUsage([row, { ...row, origin: "local", input: 50 }]);
  assert.equal(summary.api, 120);
  assert.equal(summary.local, 70);
});
test("流量只累计可确认增量，首采和重置不伪造数据", () => {
  const base = { ...row, kind: "traffic", upload: 9000, download: 10000 };
  const summary = summarizeUsage([
    base,
    { ...base, deltaUpload: 30, deltaDownload: 50 },
    { ...base, counterReset: true, deltaUpload: 1, deltaDownload: 2 },
  ]);
  assert.equal(summary.upload, 30);
  assert.equal(summary.download, 50);
  assert.equal(summary.unknownTraffic, 2);
});
test("时间、来源、范围及模型筛选同时生效", () => {
  const rows = [
    row,
    { ...row, origin: "local", sourceId: "local:codex", model: "gpt-test" },
    { ...row, bucketStart: "2026-09-01" },
  ];
  const now = new Date(2026, 9, 6, 15).getTime();
  assert.equal(
    filterUsage(
      rows,
      { category: "local", source: "local:codex", period: "1", model: "gpt-test" },
      now,
    ).length,
    1,
  );
  assert.equal(filterUsage(rows, { category: "api", period: "7" }, now).length, 1);
  assert.equal(filterUsage(rows, { period: "all" }, now).length, 3);
});
test("导出不会透传凭据和完整文件路径", () => {
  const output = exportUsage([
    { ...row, apiKey: "secret", path: "C:/private/log", prompt: "private text" },
  ]);
  assert.equal(output[0].input, 100);
  assert.doesNotMatch(JSON.stringify(output), /secret|private|apiKey/);
});
test("本机统计日按本地午夜还原，不被UTC日期切到前一天", () => {
  const local = { ...row, origin: "local", bucketStart: new Date(2026, 9, 6, 0).toISOString() };
  assert.equal(usageDay(local), "2026-10-06");
  assert.equal(filterUsage([local], { period: "1" }, new Date(2026, 9, 6, 1).getTime()).length, 1);
});

test("模型只限制 Token，全部类型下仍保留流量与额度", () => {
  const rows = [
    { ...row, model: "gpt-a" },
    { ...row, sourceId: "other-api", model: "gpt-b" },
    { ...row, sourceId: "airport", kind: "traffic" },
    { ...row, sourceId: "account", kind: "quota" },
  ];
  assert.deepEqual(
    filterUsage(rows, { period: "all", model: "gpt-a" }).map((value) => value.sourceId),
    ["api", "airport", "account"],
  );
});

test("来源与模型按类型联动，同名来源保留身份且历史来源标记已移除", () => {
  const data = {
    sources: [
      { id: "airport-a", name: "同名", type: "subscription" },
      { id: "api-a", name: "同名", type: "openai-api" },
      { id: "local:codex", name: "Codex", type: "local-codex" },
    ],
    records: [
      { ...row, sourceId: "api-a", sourceName: "旧名称", model: "gpt-a" },
      { ...row, sourceId: "removed-a", sourceName: "同名", model: "gpt-b" },
      { ...row, sourceId: "airport-a", kind: "traffic" },
      { ...row, sourceId: "local:codex", origin: "local", model: "gpt-local" },
    ],
  };
  const all = insights.usageFilterOptions(data, { category: "all", source: "all" });
  assert.equal(all.sources.find((value) => value.id === "api-a").name, "同名");
  assert.equal(all.sources.filter((value) => value.name === "同名").length, 3);
  assert.equal(all.sources.find((value) => value.id === "removed-a").removed, true);
  assert.equal(all.sources.find((value) => value.id === "api-a").duplicate, true);
  const api = insights.usageFilterOptions(data, { category: "api", source: "api-a" });
  assert.deepEqual(
    api.sources.map((value) => value.id),
    ["api-a", "removed-a"],
  );
  assert.deepEqual(api.models, ["gpt-a"]);
  const traffic = insights.usageFilterOptions(data, { category: "traffic" });
  assert.deepEqual(
    traffic.sources.map((value) => value.id),
    ["airport-a"],
  );
  assert.deepEqual(traffic.models, []);
});

test("切换类型或来源时重置不兼容筛选，保留日期范围", () => {
  const data = {
    sources: [
      { id: "airport", name: "机场", type: "subscription" },
      { id: "api", name: "API", type: "openai-api" },
    ],
    records: [{ ...row, model: "gpt-a" }],
  };
  assert.deepEqual(
    insights.normalizeUsageFilters(data, {
      category: "traffic",
      source: "api",
      model: "gpt-a",
      period: "7",
    }),
    { category: "traffic", source: "all", model: "all", period: "7" },
  );
  assert.equal(
    insights.normalizeUsageFilters(data, { category: "all", source: "airport", model: "gpt-a" })
      .model,
    "all",
  );
});

test("机场额度区分未知、不限额、用尽、超限与过期", () => {
  const now = Date.parse("2026-10-10T00:00:00Z");
  const base = {
    ...row,
    kind: "traffic",
    upload: 30,
    download: 70,
    expiresAt: "2026-10-09T00:00:00Z",
  };
  const known = insights.subscriptionTrafficSummary({ ...base, total: 80 }, now);
  assert.equal(known.used, 100);
  assert.equal(known.remaining, 0);
  assert.equal(known.percent, 100);
  assert.equal(known.exceeded, true);
  assert.equal(known.expired, true);
  const exhausted = insights.subscriptionTrafficSummary({ ...base, total: 100 }, now);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.exceeded, false);
  const unlimited = insights.subscriptionTrafficSummary({ ...base, total: 0 }, now);
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.remaining, null);
  assert.equal(unlimited.percent, null);
  const unknown = insights.subscriptionTrafficSummary({ ...base, total: null }, now);
  assert.equal(unknown.unlimited, false);
  assert.equal(unknown.remaining, null);
  assert.equal(insights.subscriptionTrafficSummary(undefined, now).used, null);
});

test("更换订阅地址后不把旧版本历史当作新套餐，最新采样不依赖数组顺序", () => {
  const rows = [
    {
      ...row,
      sourceId: "airport",
      kind: "traffic",
      revision: 1,
      checkedAt: "2026-10-10T02:00:00Z",
    },
    {
      ...row,
      sourceId: "airport",
      kind: "traffic",
      revision: 0,
      checkedAt: "2026-10-10T01:00:00Z",
    },
    {
      ...row,
      sourceId: "airport",
      kind: "traffic",
      revision: 1,
      checkedAt: "2026-10-10T00:00:00Z",
    },
  ];
  assert.equal(insights.latestSubscriptionRecord(rows, { id: "airport", revision: 2 }), undefined);
  assert.equal(
    insights.latestSubscriptionRecord(rows, { id: "airport", revision: 1 }).checkedAt,
    "2026-10-10T02:00:00Z",
  );
  assert.equal(insights.latestSubscriptionRecord(rows, { id: "airport" }).revision, 0);
});
