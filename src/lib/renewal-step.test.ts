import assert from "node:assert/strict";
import { test } from "node:test";
import { addCycle, renewalStep } from "./renewal-step.ts";

test("按周期顺延一期，月底取较短月份的最后一天", () => {
  assert.equal(addCycle("2026-10-27", "month"), "2026-11-27");
  assert.equal(addCycle("2026-12-15", "month"), "2027-01-15");
  assert.equal(addCycle("2027-01-31", "month"), "2027-02-28");
  assert.equal(addCycle("2028-02-29", "year"), "2029-02-28");
});

test("只处理实际到期日与月付、年付；AI 订阅写续费日", () => {
  assert.deepEqual(
    renewalStep({ kind: "domain", date: "2026-11-03", billing: { cycle: "year" } }),
    { field: "expiresAt", next: "2027-11-03" },
  );
  assert.deepEqual(
    renewalStep({ kind: "ai", date: "2026-10-31", billing: { cycle: "month" } }),
    { field: "renewsAt", next: "2026-11-30" },
  );
  assert.equal(renewalStep({ kind: "server", date: "2026-11-05", billing: { cycle: "once" } }), null);
  assert.equal(renewalStep({ kind: "server", date: "2026-11-05" }), null);
  assert.equal(
    renewalStep({ kind: "server", date: "2026-12-05", projected: true, billing: { cycle: "month" } }),
    null,
  );
  assert.equal(renewalStep({ kind: "cert", date: "2026-11-01", billing: { cycle: "year" } }), null);
});
