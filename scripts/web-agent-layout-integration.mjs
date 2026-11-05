import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { webResearchFixture } from "./web-research-fixture.mjs";

const f = await webResearchFixture({ built: true }),
  browser = await chromium.launch(),
  checks = [],
  errors = [];
await mkdir("screenshots", { recursive: true });
try {
  for (const [name, width, height, zoom] of [
    ["desktop", 2048, 1048, 1],
    ["laptop", 1280, 720, 1],
    ["zoom150", 1440, 900, 1.5],
    ["mobile", 390, 844, 1],
    ["short", 390, 540, 1],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: "zh-CN",
      reducedMotion: "reduce",
    });
    await context.addCookies([
      { name: "zhiyu_session", value: f.cookie.split("=")[1], url: f.base },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(f.base);
    await page.locator('[data-app-ready="true"]').waitFor();
    if (width < 768) {
      await page.getByRole("button", { name: "打开菜单", exact: true }).click();
      await page.getByRole("button", { name: "AI 助手", exact: true }).last().click();
    } else
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "AI 助手", exact: true })
        .click();
    const input = page.getByRole("textbox", { name: "向模型提问", exact: true });
    await input.waitFor();
    if (zoom !== 1)
      await page.evaluate((factor) => {
        document.documentElement.style.zoom = String(factor);
        document.documentElement.style.setProperty(
          "--app-viewport-height",
          `calc(100dvh / ${factor})`,
        );
      }, zoom);
    await input.fill("保留中的合成草稿，不要打断");
    if (height >= 720 && zoom === 1) {
      const footer = await page.locator(".agent-permissions").evaluate((element) => ({
        bottom: element.getBoundingClientRect().bottom,
        viewport: innerHeight,
        clip: document.querySelector(".agent-shell").getBoundingClientRect().bottom,
      }));
      await page.screenshot({ path: `screenshots/web-agent-initial-${name}.png` });
      assert.ok(
        footer.bottom <= Math.min(footer.viewport, footer.clip) + 1,
        `${name} 权限行默认被裁切：${JSON.stringify(footer)}`,
      );
    }
    for (const expanded of [false, true]) {
      if (expanded) await page.getByLabel("Web 安全提醒").locator("summary").click();
      for (const label of ["本次允许查询邮箱", "本次允许检索文档正文", "本次生成修改建议"]) {
        const checkbox = page.getByRole("checkbox", { name: label, exact: true });
        await checkbox.scrollIntoViewIfNeeded();
        const geometry = await checkbox.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          let top = 0,
            bottom = innerHeight;
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (["hidden", "clip", "auto", "scroll"].includes(getComputedStyle(parent).overflowY)) {
              const r = parent.getBoundingClientRect();
              top = Math.max(top, r.top);
              bottom = Math.min(bottom, r.bottom);
            }
          }
          const nav = document.querySelector(".web-bottom");
          if (nav && getComputedStyle(nav).display !== "none")
            bottom = Math.min(bottom, nav.getBoundingClientRect().top);
          return { top: rect.top, bottom: rect.bottom, visibleTop: top, visibleBottom: bottom };
        });
        assert.ok(
          geometry.top >= geometry.visibleTop - 1 && geometry.bottom <= geometry.visibleBottom + 1,
          `${name}/${expanded}/${label}: ${JSON.stringify(geometry)}`,
        );
        await checkbox.setChecked(!(await checkbox.isChecked()));
      }
      assert.equal(await input.inputValue(), "保留中的合成草稿，不要打断");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    await page.screenshot({ path: `screenshots/web-agent-layout-${name}.png` });
    checks.push({ name, permissionsReachable: true, draftPreserved: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks, errors }, null, 2));
} finally {
  await browser.close();
  await f.close();
}
