import assert from "node:assert/strict";
import test from "node:test";
import { historySeries } from "../src/components/integrations/history-series.mjs";

const at = (seconds) => new Date(Date.UTC(2026, 9, 12) + seconds * 1000).toISOString();
test("主机长时间无上报后恢复，历史曲线插入空值而不是跨空档连线", () => {
  const rows = historySeries(
    [0, 30, 60, 3600, 3630, 3660].map((seconds) => ({ at: at(seconds), cpu: 12 })),
  );
  assert.equal(rows.length, 7);
  assert.equal(rows[3].cpu, null);
  assert.equal(rows[3].time, Date.parse(at(60)) + 1);
});
test("七日 720 点下采样连续区间保持连接，只打断较长空档", () => {
  const normal = Array.from({ length: 720 }, (_, index) => ({ at: at(index * 840), cpu: 12 }));
  assert.equal(historySeries(normal).length, 720);
  const offline = normal.map((sample, index) =>
    index < 360 ? sample : { ...sample, at: at(index * 840 + 7200) },
  );
  assert.equal(historySeries(offline).filter((sample) => sample.cpu === null).length, 1);
});
test("未知指标和失败服务检查不变成零，单点和乱序数据可展示", () => {
  const sample = { at: at(0), latencyMs: null, status: "down" };
  assert.equal(historySeries([sample])[0].latencyMs, null);
  assert.deepEqual(
    historySeries([{ at: at(60) }, { at: "invalid" }, { at: at(0) }]).map((row) => row.at),
    [at(0), at(60)],
  );
});

test("稀疏主机样本能识别离线空档，长间隔检查按配置保留连续性", () => {
  const two = [
    { at: at(0), cpu: 1 },
    { at: at(3600), cpu: 2 },
  ];
  assert.equal(historySeries(two).length, 3);
  assert.equal(historySeries(two, 3600000).length, 2);
});
