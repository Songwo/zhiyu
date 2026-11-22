import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  locale: "zh-CN",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const output = resolve("release/screenshots/composer");
await mkdir(output, { recursive: true });
const screenshot = async (name) => {
  // 等待弹窗有限动画结束，避免把进入过渡状态当作最终布局。
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="dialog"]')].every((element) =>
      element
        .getAnimations({ subtree: true })
        .every(
          (animation) =>
            animation.playState !== "running" ||
            animation.effect?.getTiming().iterations === Infinity,
        ),
    ),
  );
  await page.screenshot({ path: resolve(output, name) });
};
const saved = async () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("sinan-assets-v1")).state);
const ready = async () => page.locator('[data-app-ready="true"]').waitFor();
const navigate = (kind) => navigateDesktop(page, kind === "ai" ? "AI 订阅" : "服务器");
const open = async (kind) => {
  await navigate(kind);
  await page.keyboard.press("Control+n");
};
try {
  await page.goto(process.env.NANPAD_QA_URL || "http://127.0.0.1:8080/", {
    waitUntil: "networkidle",
  });
  await ready();
  await page.evaluate(() =>
    localStorage.setItem(
      "sinan-assets-v1",
      JSON.stringify({
        version: 0,
        state: {
          servers: [],
          domains: [],
          certs: [],
          mailboxes: [],
          secrets: [],
          aiAssets: [],
          phoneNumbers: [],
          activity: [],
          links: [],
        },
      }),
    ),
  );
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  await open("server");
  const dialog = page.getByRole("dialog", { name: "服务器", exact: true });
  assert.equal(await dialog.getByRole("radio", { name: "仅记录", exact: true }).isChecked(), true);
  assert.equal(await dialog.locator("details").getAttribute("open"), null);
  await dialog.getByRole("textbox", { name: "主机名", exact: true }).fill("QA 仅记录主机");
  await dialog.getByRole("textbox", { name: "IP / Host", exact: true }).fill("record.example.test");
  await screenshot("server-simple-desktop.png");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const first = (await saved()).servers[0];
  assert.equal(first.sshConfigured, false);
  assert.equal(first.lastSeen, "");
  assert.equal(first.cpu, 0);
  const card = page.locator(`[data-asset-id="${first.id}"]`);
  assert.match(await card.innerText(), /未采集/);
  assert.doesNotMatch(await card.innerText(), /0%/);
  await page.evaluate((id) => {
    const snapshot = JSON.parse(localStorage.getItem("sinan-assets-v1"));
    const item = snapshot.state.servers.find((x) => x.id === id);
    Object.assign(item, {
      port: 2222,
      username: "deploy",
      label: "保留备注",
      os: "Debian",
      notes: "保留说明",
      tags: ["qa"],
      docs: "# 原文",
      nodes: [
        { id: "node-qa", name: "节点", protocol: "vless", host: "record.example.test", port: 443 },
      ],
      customSecrets: [{ id: "secret-qa", key: "note", value: "保留内容" }],
    });
    localStorage.setItem("sinan-assets-v1", JSON.stringify(snapshot));
  }, first.id);
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  await navigate("server");
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.getByRole("button", { name: "编辑 QA 仅记录主机", exact: true }).click();
  assert.equal(await dialog.getByRole("radio", { name: "仅记录", exact: true }).isChecked(), true);
  await dialog.getByRole("textbox", { name: "主机名", exact: true }).fill("QA 已改名");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const edited = (await saved()).servers[0];
  for (const [key, value] of Object.entries({
    port: 2222,
    username: "deploy",
    label: "保留备注",
    os: "Debian",
    notes: "保留说明",
    docs: "# 原文",
    sshConfigured: false,
  }))
    assert.equal(edited[key], value, key);
  assert.equal(edited.nodes[0].id, "node-qa");
  assert.equal(edited.customSecrets[0].value, "保留内容");
  await open("ai");
  const ai = page.getByRole("dialog", { name: "添加 AI 订阅", exact: true });
  await ai.getByRole("button", { name: /^订阅账号/ }).click();
  assert.equal(
    await ai.getByRole("tab", { name: "快速登录", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await ai.getByRole("button", { name: "重新选择来源", exact: true }).click();
  await ai.getByRole("button", { name: /^API 调用用量/ }).click();
  await ai.getByRole("button", { name: "OpenAI API", exact: true }).click();
  await ai.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "用量记录", exact: true }).waitFor();
  await open("ai");
  await ai.getByRole("button", { name: "仅手动记录", exact: true }).click();
  assert.match(await ai.innerText(), /手动记录不会自动采集用量/);
  await ai.getByRole("textbox", { name: "名称", exact: true }).fill("QA 手动订阅");
  await ai.getByRole("button", { name: "添加", exact: true }).click();
  await ai.waitFor({ state: "hidden" });
  assert.equal((await saved()).aiAssets[0].name, "QA 手动订阅");
  await open("server");
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("textbox", { name: "主机名", exact: true }).fill("手机端主机");
  await dialog.getByRole("radio", { name: "配置 SSH", exact: true }).check();
  assert.equal(
    await dialog.getByRole("spinbutton", { name: "SSH 端口", exact: true }).inputValue(),
    "22",
  );
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot("server-mobile.png");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await open("ai");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("ai-source-mobile.png");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "minimum-server-save",
        "edit-hidden-fields-preserved",
        "uncollected-not-live",
        "subscription-entry",
        "api-usage-entry",
        "manual-entry",
        "mobile-no-overflow",
      ],
      screenshots: output,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() }));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
