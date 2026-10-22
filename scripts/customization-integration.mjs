import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "nanpad-customization-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
try {
  instance = await electron.launch({ args: [resolve("electron/main.mjs")], env, timeout: 45000 });
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  const page = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await completeOnboarding(page);
  await page.getByText("桌面验证用户", { exact: true }).waitFor();
  const images = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 640;
    const context = canvas.getContext("2d");
    context.fillStyle = "#287963";
    context.fillRect(0, 0, 960, 640);
    context.fillStyle = "#edeff1";
    context.fillRect(260, 100, 440, 440);
    context.fillStyle = "#287963";
    context.font = "bold 300px sans-serif";
    context.textAlign = "center";
    context.fillText("N", 480, 420);
    return { webp: canvas.toDataURL("image/webp"), jpeg: canvas.toDataURL("image/jpeg") };
  });
  const payload = (format) => ({
    name: `custom.${format}`,
    mimeType: `image/${format}`,
    buffer: Buffer.from(images[format].split(",")[1], "base64"),
  });
  const openProfile = async () => {
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByText("系统设置…", { exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "个人资料", exact: true }).click();
    await settings.getByLabel("个人头像", { exact: true }).waitFor({ state: "attached" });
    return settings;
  };
  const loadedImage = async (locator) => {
    await locator.waitFor();
    await locator.evaluate((image) => image.decode());
    assert.equal(
      await locator.evaluate((image) => image.naturalWidth > 0 && image.naturalHeight > 0),
      true,
    );
  };
  const profileSaved = async (dialog) => {
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByRole("status").filter({ hasText: "已保存" }).waitFor();
    return page.evaluate(() => window.sinan.profile.get());
  };
  let settings = await openProfile();
  await settings.getByLabel("个人头像", { exact: true }).setInputFiles(payload("webp"));
  await loadedImage(settings.getByRole("img", { name: "个人头像", exact: true }));
  const profile = await profileSaved(settings);
  assert.match(profile.avatarDataUrl, /^data:image\/png;base64,/);
  assert.equal(
    await instance.evaluate(
      ({ nativeImage }, data) =>
        Math.max(...Object.values(nativeImage.createFromDataURL(data).getSize())) <= 256,
      profile.avatarDataUrl,
    ),
    true,
  );
  assert.equal(
    JSON.parse(await readFile(join(directory, "profile.json"), "utf8")).avatarDataUrl,
    profile.avatarDataUrl,
  );

  await mkdir("release/screenshots", { recursive: true });
  await settings.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: "release/screenshots/nanpad-profile-image-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "release/screenshots/nanpad-profile-image-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await loadedImage(page.getByRole("img", { name: "个人头像", exact: true }));
  assert.equal(
    await page.evaluate(() => window.sinan.profile.get().then((value) => value.avatarDataUrl)),
    profile.avatarDataUrl,
  );
  settings = await openProfile();
  await settings.getByLabel("个人头像", { exact: true }).setInputFiles({
    name: "invalid.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  });
  await settings.getByRole("alert").waitFor();
  assert.equal(
    await settings.getByRole("img", { name: "个人头像", exact: true }).getAttribute("src"),
    profile.avatarDataUrl,
  );
  await settings.getByRole("button", { name: "移除图片", exact: true }).click();
  assert.equal((await profileSaved(settings)).avatarDataUrl, "");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await settings.waitFor({ state: "detached" });

  await page
    .locator("nav")
    .getByRole("button", { name: /^AI 订阅/ })
    .click();
  await page.getByRole("button", { name: "添加 AI 订阅", exact: true }).click();
  let composer = page.getByRole("dialog", { name: "添加 AI 订阅", exact: true });
  await composer.getByRole("button", { name: "仅手动记录", exact: true }).click();
  await composer.getByLabel("名称", { exact: true }).fill("图片验证订阅");
  await composer.getByLabel("厂商", { exact: true }).fill("自定义 AI");
  await composer.getByLabel("资产图片", { exact: true }).setInputFiles(payload("jpeg"));
  await loadedImage(composer.getByRole("img", { name: "资产图片", exact: true }));
  await composer.getByRole("button", { name: "添加", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  const saved = () =>
    page.evaluate(() => window.sinan.store.load().then((value) => value.state.aiAssets));
  let asset = (await saved()).find((item) => item.name === "图片验证订阅");
  assert.match(asset.imageDataUrl, /^data:image\/png;base64,/);
  assert.equal(
    await instance.evaluate(
      ({ nativeImage }, data) =>
        Math.max(...Object.values(nativeImage.createFromDataURL(data).getSize())) <= 512,
      asset.imageDataUrl,
    ),
    true,
  );
  await loadedImage(
    page
      .locator(`[data-asset-id="${asset.id}"]`)
      .getByRole("img", { name: "资产图片", exact: true }),
  );
  await page.locator(`[data-asset-id="${asset.id}"]`).click();
  let details = page.getByRole("region", { name: "资产详情", exact: true });
  await loadedImage(details.getByRole("img", { name: "资产图片", exact: true }));
  await details.getByRole("button", { name: "编辑", exact: true }).click();
  composer = page.getByRole("dialog", { name: "编辑 AI 订阅", exact: true });
  await loadedImage(composer.getByRole("img", { name: "资产图片", exact: true }));
  await page.waitForFunction(() => {
    const panel = document.querySelector('[role="dialog"][aria-label="编辑 AI 订阅"]');
    return panel?.getAttribute("data-shown") === "true" && getComputedStyle(panel).opacity === "1";
  });
  await page.screenshot({ path: "release/screenshots/nanpad-asset-image-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "release/screenshots/nanpad-asset-image-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await composer.getByLabel("名称", { exact: true }).fill("图片修改后保留");
  await composer.getByRole("button", { name: "保存", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  assert.equal(
    (await saved()).find((item) => item.id === asset.id).imageDataUrl,
    asset.imageDataUrl,
  );
  await page.reload();
  await page.getByText("桌面验证用户", { exact: true }).waitFor();
  assert.equal(await page.getByRole("img", { name: "个人头像", exact: true }).count(), 0);
  await page
    .locator("nav")
    .getByRole("button", { name: /^AI 订阅/ })
    .click();
  await loadedImage(
    page
      .locator(`[data-asset-id="${asset.id}"]`)
      .getByRole("img", { name: "资产图片", exact: true }),
  );
  assert.equal(
    (await saved()).find((item) => item.id === asset.id).imageDataUrl,
    asset.imageDataUrl,
  );

  const rejected = await page.evaluate(async () => {
    const result = {};
    for (const value of [
      "https://example.com/image.png",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
    ]) {
      try {
        await window.sinan.profile.save({ name: "不得写入", avatarDataUrl: value });
        result[value] = false;
      } catch {
        result[value] = true;
      }
      const snapshot = await window.sinan.store.load();
      snapshot.state.aiAssets[0].imageDataUrl = value;
      try {
        await window.sinan.store.save(snapshot);
        result[value + "asset"] = false;
      } catch {
        result[value + "asset"] = true;
      }
    }
    return result;
  });
  assert.equal(Object.values(rejected).every(Boolean), true);
  assert.equal(
    await page.evaluate(() => window.sinan.profile.get().then((value) => value.name)),
    "桌面验证用户",
  );
  assert.equal(
    (await saved()).find((item) => item.id === asset.id).imageDataUrl,
    asset.imageDataUrl,
  );
  await page.locator(`[data-asset-id="${asset.id}"]`).click();
  details = page.getByRole("region", { name: "资产详情", exact: true });
  await details.getByRole("button", { name: "编辑", exact: true }).click();
  composer = page.getByRole("dialog", { name: "编辑 AI 订阅", exact: true });
  await composer.getByRole("button", { name: "移除图片", exact: true }).click();
  await composer.getByRole("button", { name: "保存", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  assert.equal((await saved()).find((item) => item.id === asset.id).imageDataUrl, "");
  await page.reload();
  await page.getByText("桌面验证用户", { exact: true }).waitFor();
  assert.equal((await saved()).find((item) => item.id === asset.id).imageDataUrl, "");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      isolated: true,
      avatarWebpToPng: true,
      assetJpegToPng: true,
      dimensions: true,
      persistence: true,
      removal: true,
      maliciousImageRejected: true,
      desktopMobile: true,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
}
