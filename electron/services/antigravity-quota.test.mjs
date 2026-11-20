import test from "node:test";
import assert from "node:assert/strict";
import { parseAntigravityQuota } from "./antigravity-quota.mjs";

test("本机额度解析区分时段、保留满额和耗尽状态，并忽略无效行", () => {
  const windows = parseAntigravityQuota(
    [
      "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-29T09:00:00Z",
      "Gemini Models\tFive Hour Limit Remaining\t0%\tinvalid",
      "Claude and GPT models\tFive Hour Limit Remaining\t51.25%",
      "Gemini Models\tWeekly Limit Remaining\t180%",
      "Gemini Models\tUnknown Limit\t50%",
      "Please sign in",
    ].join("\r\n"),
  );
  assert.deepEqual(
    windows.map(({ label, usedPercent, resetsAt }) => [label, usedPercent, resetsAt]),
    [
      ["Gemini Models/seven_day", 0, "2026-11-29T09:00:00.000Z"],
      ["Gemini Models/five_hour", 100, null],
      ["Claude and GPT models/five_hour", 48.75, null],
    ],
  );
  assert.deepEqual(parseAntigravityQuota("Authentication required\n"), []);
});
