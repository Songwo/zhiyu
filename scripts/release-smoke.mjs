import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { chooseOption, verifyOptions } from "./select-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "nanpad-packaged-"));
let instance;
try {
  await writeFile(
    join(directory, "local-usage.json"),
    JSON.stringify({ version: 1, enabled: false, checkpoints: [], events: [], records: [] }),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  delete env.NANPAD_TEST_DATA_DIR;
  instance = await electron.launch({
    executablePath: resolve(process.argv[2] ?? "release/win-unpacked/Zhiyu.exe"),
    args: [
      `--user-data-dir=${directory}`,
      "nanpad://capture?url=https%3A%2F%2Frelease.example.test%2Flogin%3Ftoken%3Dprivate&title=Release",
    ],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  const actual = await instance.evaluate(({ app }) => ({
    path: app.getPath("userData"),
    packaged: app.isPackaged,
    version: app.getVersion(),
  }));
  assert.equal(actual.path, directory, "打包验证必须使用隔离数据目录");
  assert.equal(actual.packaged, true);
  assert.equal(actual.version, JSON.parse(await readFile("package.json", "utf8")).version);
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  await mkdir("screenshots", { recursive: true });
  await mkdir("release/screenshots", { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await completeOnboarding(page);
  assert.equal(
    (await page.evaluate(() => window.sinan.capture.list()))[0].url,
    "https://release.example.test/",
  );
  await page.getByRole("button", { name: "忽略网站", exact: true }).click();
  await page.getByText("桌面验证用户", { exact: true }).waitFor();
  await navigateDesktop(page, "AI 助手");
  await page.getByRole("button", { name: "模型与知识库", exact: true }).click();
  await verifyOptions(page, page.getByRole("combobox", { name: "授权服务商" }), [
    "OpenAI / ChatGPT",
    "Anthropic / Claude",
    "xAI / Grok",
    "Google / Gemini",
  ]);
  await chooseOption(page, page.getByRole("combobox", { name: "授权服务商" }), "xAI / Grok");
  await page.getByRole("button", { name: "网页登录授权" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "screenshots/nanpad-ai-accounts.png" });
  await chooseOption(page, page.getByRole("combobox", { name: "授权服务商" }), "Google / Gemini");
  assert.equal(
    await page.getByRole("combobox", { name: "授权服务商" }).textContent(),
    "Google / Gemini",
  );
  assert.equal(await page.getByRole("button", { name: "添加演示数据" }).count(), 0);
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.sinan.store.addDemo();
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.reload();
  await page.getByText("桌面验证用户", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "首次设置" }).count(), 0);
  await navigateDesktop(page, "AI 订阅");
  await page.getByRole("button", { name: "添加 AI 订阅", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "添加 AI 订阅", exact: true });
  await composer.getByRole("button", { name: /^订阅账号/ }).click();
  assert.equal(
    await composer
      .getByRole("tab", { name: "快速登录", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await composer.getByLabel("名称", { exact: true }).count(), 0);
  await verifyOptions(page, composer.getByRole("combobox", { name: "授权服务商" }), [
    "OpenAI / ChatGPT",
    "Anthropic / Claude",
    "xAI / Grok",
    "Google / Gemini",
  ]);
  await chooseOption(page, composer.getByRole("combobox", { name: "授权服务商" }), "xAI / Grok");
  await page.waitForFunction(() => {
    const panel = document.querySelector('[role="dialog"][aria-label="添加 AI 订阅"]');
    return panel?.getAttribute("data-shown") === "true" && getComputedStyle(panel).opacity === "1";
  });
  await page.screenshot({ path: "screenshots/nanpad-packaged-ai-login.png" });
  await composer.getByRole("button", { name: "完成", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  await navigateDesktop(page, "号码管理");
  await page.getByRole("button", { name: "添加号码", exact: true }).click();
  const phoneForm = page.getByRole("form", { name: "添加号码", exact: true });
  await phoneForm.getByRole("textbox", { name: "号码", exact: true }).fill("00123456789");
  await phoneForm.getByRole("textbox", { name: "号码名称", exact: true }).fill("安装包保存验证");
  await phoneForm.getByRole("button", { name: "保存号码", exact: true }).click();
  await page.waitForFunction(async () =>
    (await window.sinan.store.load())?.state?.phoneNumbers?.some(
      (phone) => phone.number === "00123456789",
    ),
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await navigateDesktop(page, "号码管理");
  await page.getByText("00123456789", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.sinan.store.load())).state.phoneNumbers.length, 1);
  for (const zoomPercent of [100, 110, 125, 150]) {
    await page.evaluate((value) => window.sinan.display.set(value), zoomPercent);
    const actualZoom = await instance.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    );
    assert.ok(Math.abs(actualZoom - zoomPercent / 100) < 0.001);
  }
  await page.evaluate(() => window.sinan.display.set(100));
  await page.screenshot({ path: "release/screenshots/v110-packaged-phone.png" });
  const localUsage = JSON.parse(await readFile(join(directory, "local-usage.json"), "utf8"));
  assert.equal(localUsage.enabled, false, "发布回归不得读取真实本机 AI 日志");
  assert.deepEqual(localUsage.records, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      version: actual.version,
      packaged: true,
      isolated: true,
      realLocalLogMonitoringDisabled: true,
      providers: 4,
      onboarding: true,
      restart: true,
      phoneDiskPersistence: true,
      zoomLevels: [100, 110, 125, 150],
      productionDemoDisabled: true,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
