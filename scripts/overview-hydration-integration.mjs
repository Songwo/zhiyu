import assert from "node:assert/strict";
import { chromium } from "playwright";
import { checkedUrl } from "./browser-guard.mjs";

// 首页服务端渲染与客户端首帧必须一致：浏览器时钟或时区与服务端不同，都不能触发 hydration 报错。
// 服务端时间无法伪造，所以让浏览器站在另一天、跨午夜加载，覆盖示例活动跨日期桶的情形。
const origin = new URL(checkedUrl(process.env.NANPAD_QA_URL || "http://127.0.0.1:8080/")).origin;
const dateKey = (date, timeZone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(date)
    .replaceAll("/", "-");
const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// +14 与 -11 相差 25 小时，任何时刻至少有一个与服务端所在时区不是同一天。
const otherZone = ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find(
  (zone) => dateKey(new Date(), zone) !== dateKey(new Date(), serverZone),
);
/** 浏览器所在时区的下一个午夜前 1.5 秒，加载过程会跨过日期边界。 */
function beforeMidnight() {
  const now = Date.now();
  const today = dateKey(new Date(now), serverZone);
  let at = now;
  while (dateKey(new Date(at), serverZone) === today) at += 60_000;
  while (dateKey(new Date(at - 1000), serverZone) !== today) at -= 1000;
  return new Date(at - 1500);
}

const scenarios = [
  { name: "当前时间", repeat: 3 },
  { name: "浏览器跨午夜", time: beforeMidnight(), crossesMidnight: true },
  { name: "浏览器早一天", time: new Date(Date.now() - 24 * 3600_000 - 7 * 60_000) },
  { name: "浏览器晚一天", time: new Date(Date.now() + 26 * 3600_000 + 30_000) },
  { name: `浏览器时区 ${otherZone}`, timezoneId: otherZone },
];

const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  for (const scenario of scenarios) {
    for (let run = 0; run < (scenario.repeat ?? 1); run += 1) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 960 },
        locale: "zh-CN",
        timezoneId: scenario.timezoneId ?? serverZone,
      });
      const page = await context.newPage();
      if (scenario.time) await page.clock.install({ time: scenario.time });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && /hydrat/i.test(message.text()))
          errors.push(message.text());
      });
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.locator('[data-app-ready="true"]').waitFor();
      const journal = page.getByRole("region", { name: "每日活动", exact: true });
      await journal.locator("button.activity-day").first().waitFor();
      assert.equal(await journal.locator("button.activity-day").count(), 14);
      // 挂载后图表要按浏览器的日期计算，而不是沿用服务端的日期；跨午夜时两天都算对。
      const expected = await page.evaluate((crossesMidnight) => {
        const key = (date) =>
          `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const now = new Date();
        const earlier = new Date(now.getTime() - 60_000);
        return crossesMidnight ? [key(earlier), key(now)] : [key(now)];
      }, Boolean(scenario.crossesMidnight));
      const last = await journal.locator("button.activity-day").last().getAttribute("aria-label");
      if (!expected.some((day) => last?.startsWith(`${day}，`)))
        failures.push({ scenario: scenario.name, run, expected, last });
      if (errors.length) failures.push({ scenario: scenario.name, run, errors });
      await context.close();
    }
  }
  assert.deepEqual(failures, [], "首页 hydration 不一致");
  console.log(JSON.stringify({ ok: true, scenarios: scenarios.map(({ name }) => name) }));
} finally {
  await browser.close();
}
