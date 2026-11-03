import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { expandNavigationGroups } from "./navigation-helper.mjs";
import { chooseOption } from "./select-helper.mjs";
import { demoSnapshot } from "../electron/services/demo.mjs";
import { resolveBrandIcon } from "../src/lib/brand-icons.mjs";

// 全程使用隔离资料和合成账号，不读取用户日常卡片、服务器或模型配置。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-cards-"));
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
delete env.NODE_PATH;
let instance;
const errors = [];
try {
  const sample = demoSnapshot();
  const customAi = sample.aiAssets.at(-1);
  const userImage = `data:image/png;base64,${(await readFile("public/brands/bank-ccb.png")).toString("base64")}`;
  customAi.imageDataUrl = userImage;
  await writeFile(join(directory, "assets.json"), JSON.stringify({ state: sample, version: 0 }));
  const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  instance = await electron.launch({
    cwd: process.env.NANPAD_QA_APP_CWD ?? process.cwd(),
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...(executablePath ? [] : [resolve("electron/main.mjs")]),
      `--user-data-dir=${directory}`,
    ],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  // 隔离剪贴板：验证真实解密与解锁接续交出的值，不覆盖用户系统剪贴板。
  const captureClipboard = () => {
    window.__cardCopied = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__cardCopied = text;
        },
      },
    });
  };
  await page.addInitScript(captureClipboard);
  await page.evaluate(captureClipboard);
  await instance.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    win.showInactive();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await completeOnboarding(page);
  await expandNavigationGroups(page);
  assert.equal(await instance.evaluate(({ app }) => app.getPath("userData")), directory);
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  const nav = () => page.getByRole("navigation", { name: "主导航", exact: true });
  // AI 与其他资产的默认图标直接来自包内，已上传的资产图片优先。
  await nav().getByRole("button", { name: "AI 订阅", exact: true }).click();
  const knownAi = sample.aiAssets.find((asset) => !asset.imageDataUrl && resolveBrandIcon(asset));
  assert.ok(knownAi, "演示资产应有可识别的 AI 服务商");
  const expectedBrand = resolveBrandIcon(knownAi).id;
  await page
    .locator(`[data-asset-id="${knownAi.id}"] [data-brand-icon="${expectedBrand}"] img`)
    .waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[data-brand-icon] img")].every(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/brands-ai-desktop.png" });
  const savedImage = (await page.evaluate(() => window.sinan.store.load())).state.aiAssets.find(
    (asset) => asset.id === customAi.id,
  ).imageDataUrl;
  assert.ok(savedImage.startsWith("data:image/png;base64,"));
  assert.equal(
    await page.locator(`[data-asset-id="${customAi.id}"] img`).getAttribute("src"),
    savedImage,
  );
  assert.equal(await page.locator(`[data-asset-id="${customAi.id}"] [data-brand-icon]`).count(), 0);
  // 新建支付卡，说明识别可校正、卡号不落普通资料。
  await nav().getByRole("button", { name: "U 卡与支付卡", exact: true }).click();
  await page.getByRole("button", { name: "添加支付卡", exact: true }).first().click();
  let editor = page.getByRole("dialog", { name: "添加支付卡", exact: true });
  await editor.getByRole("textbox", { name: "卡片名称", exact: true }).fill("合成订阅 Visa");
  await editor
    .getByRole("textbox", { name: "卡片说明", exact: true })
    .fill("Wise Visa virtual debit card");
  assert.equal(await editor.getByLabel("资金类型", { exact: true }).inputValue(), "借记卡");
  await editor.getByLabel("用于识别的卡号", { exact: true }).fill("4242424242424242");
  await editor.getByLabel("卡面有效月份", { exact: true }).fill("2028-02");
  await editor.getByLabel("发行地区", { exact: true }).fill("美国");
  await editor.getByRole("button", { name: "保存卡片", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.getByRole("region", { name: "资产详情", exact: true }).waitFor();
  const saved = await page.evaluate(() => window.sinan.store.load());
  const payment = saved.state.services.find((x) => x.name === "合成订阅 Visa");
  assert.equal(payment.card.network, "Visa");
  assert.equal(payment.card.last4, "4242");
  assert.equal(payment.card.formFactor, "虚拟卡");
  assert.equal(payment.expiresAt, "2028-02-29");
  assert.ok(!JSON.stringify(saved).includes("4242424242424242"));
  const centered = await page.locator(".card-3d-scene").evaluate((element) => {
    const card = element.getBoundingClientRect();
    const parent = element.parentElement.getBoundingClientRect();
    return Math.abs(card.left + card.width / 2 - parent.left - parent.width / 2) < 2;
  });
  assert.equal(centered, true, "详情卡片必须居中");
  await page.getByRole("button", { name: "翻到背面", exact: true }).click();
  await page.locator('.card-3d-scene[data-flipped="true"]').waitFor();
  await page.getByRole("button", { name: "录入或编辑加密资料", exact: true }).click();
  let privateEditor = page.getByRole("dialog", { name: "加密卡片资料", exact: true });
  await privateEditor.getByLabel("完整卡号", { exact: true }).fill("4242424242424242");
  await privateEditor.getByLabel("持卡人", { exact: true }).fill("Synthetic cardholder only");
  await privateEditor.getByLabel("安全码 CVV", { exact: true }).fill("123");
  await privateEditor.getByRole("button", { name: "保存加密资料", exact: true }).click();
  await privateEditor.waitFor({ state: "detached" });
  assert.ok(!(await page.locator("body").innerText()).includes("4242424242424242"));
  await page.getByRole("button", { name: "复制完整卡号", exact: true }).click();
  await page.waitForFunction(() => window.__cardCopied === "4242424242424242");
  await page.getByRole("button", { name: "显示卡片资料", exact: true }).click();
  await page.getByText("4242424242424242", { exact: true }).waitFor();
  await page.getByRole("button", { name: "翻回正面", exact: true }).click();
  assert.ok(!(await page.locator("body").innerText()).includes("4242424242424242"));
  await page.getByRole("button", { name: "翻到背面", exact: true }).click();
  await page.evaluate(() => window.sinan.vault.lock());
  await page.getByRole("button", { name: "翻到背面", exact: true }).waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes("4242424242424242"));
  await page.getByRole("button", { name: "翻到背面", exact: true }).click();
  await page.evaluate(() => {
    window.__cardCopied = null;
  });
  await page.getByRole("button", { name: "复制完整卡号", exact: true }).click();
  let unlock = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await unlock.getByRole("button", { name: "取消", exact: true }).click();
  await unlock.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__cardCopied), null);
  await page.getByRole("button", { name: "复制完整卡号", exact: true }).click();
  unlock = page.getByRole("dialog", { name: "解锁密钥库", exact: true });
  await unlock.getByLabel("主密码", { exact: true }).fill("integration-master-2026");
  await unlock.getByRole("button", { name: "解锁", exact: true }).click();
  await page.waitForFunction(() => window.__cardCopied === "4242424242424242");
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/cards-flip-back.png" });
  await page.getByRole("button", { name: "翻回正面", exact: true }).click();
  await page.screenshot({ path: "screenshots/cards-flip-front.png" });
  const afterPrivate = JSON.stringify(await page.evaluate(() => window.sinan.store.load()));
  assert.ok(!afterPrivate.includes("4242424242424242"));
  assert.ok(!afterPrivate.includes("Synthetic cardholder only"));
  // 使用原有关系组件建立真实关联，落盘后重载保留。
  const target = sample.aiAssets[0];
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "选择关联资产", exact: true }),
    target.name,
  );
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  await page.waitForFunction(
    async (id) =>
      (await window.sinan.store.load()).state.links.some(
        (link) => link.from.id === id || link.to.id === id,
      ),
    payment.id,
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await nav().getByRole("button", { name: "U 卡与支付卡", exact: true }).click();
  await page.getByRole("button", { name: "查看卡片 合成订阅 Visa", exact: true }).first().click();
  await page.getByText(target.name, { exact: true }).first().waitFor();
  await page.getByRole("region", { name: "关联文档", exact: true }).waitFor();
  // eSIM 的套餐日期与保号日期独立保留；最近期限进入续费链路。
  await nav().getByRole("button", { name: "eSIM 卡", exact: true }).click();
  await page.getByRole("button", { name: "添加 eSIM", exact: true }).first().click();
  editor = page.getByRole("dialog", { name: "添加 eSIM", exact: true });
  await editor.getByLabel("卡片名称", { exact: true }).fill("合成日本 eSIM");
  await editor.getByLabel("eSIM 服务商", { exact: true }).fill("Airalo");
  await editor.getByLabel("套餐名称", { exact: true }).fill("旅行 10 GB");
  await editor.getByLabel("覆盖国家或地区", { exact: true }).fill("日本");
  await editor.getByLabel("套餐到期日（以此为准）", { exact: true }).fill("2027-01-20");
  await editor.getByLabel("保号截止日期", { exact: true }).fill("2027-02-20");
  await editor.getByRole("button", { name: "保存卡片", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  const esim = (await page.evaluate(() => window.sinan.store.load())).state.services.find(
    (x) => x.name === "合成日本 eSIM",
  );
  assert.equal(esim.expiresAt, "2027-01-20");
  assert.equal(esim.card.keepAliveAt, "2027-02-20");
  await page.getByRole("button", { name: "翻到背面", exact: true }).click();
  await page.getByRole("button", { name: "录入或编辑加密资料", exact: true }).click();
  privateEditor = page.getByRole("dialog", { name: "加密卡片资料", exact: true });
  const activation = "LPA:1$smdp.example.test$synthetic-activation-only";
  await privateEditor.getByLabel("ICCID", { exact: true }).fill("89010000000000000001");
  await privateEditor.getByLabel("激活码", { exact: true }).fill(activation);
  await privateEditor.getByRole("button", { name: "保存加密资料", exact: true }).click();
  await privateEditor.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "复制激活码", exact: true }).click();
  await page.waitForFunction((value) => window.__cardCopied === value, activation);
  assert.ok(
    !JSON.stringify(await page.evaluate(() => window.sinan.store.load())).includes(activation),
  );
  // 国内银行实际录入：只补空字段，发行行和卡组织分开，既有选择显式采用后才能替换。
  await nav().getByRole("button", { name: "U 卡与支付卡", exact: true }).click();
  await page.getByRole("button", { name: "添加支付卡", exact: true }).first().click();
  editor = page.getByRole("dialog", { name: "添加支付卡", exact: true });
  await editor.getByLabel("卡片名称", { exact: true }).fill("合成工行国内卡");
  const bankNumber = "6222020000000000000";
  await editor.getByLabel("用于识别的卡号", { exact: true }).fill(bankNumber);
  assert.equal(await editor.getByLabel("发卡服务商", { exact: true }).inputValue(), "中国工商银行");
  assert.equal(await editor.getByLabel("卡组织", { exact: true }).inputValue(), "UnionPay");
  assert.equal(await editor.getByLabel("发行地区", { exact: true }).inputValue(), "中国大陆");
  assert.equal(await editor.getByLabel("资金类型", { exact: true }).inputValue(), "");
  await editor.getByLabel("发卡服务商", { exact: true }).fill("我的发卡商");
  await editor.getByLabel("用于识别的卡号", { exact: true }).fill("6228480000000000000");
  assert.equal(await editor.getByLabel("发卡服务商", { exact: true }).inputValue(), "我的发卡商");
  await editor.getByRole("button", { name: "采用识别结果", exact: true }).click();
  assert.equal(await editor.getByLabel("发卡服务商", { exact: true }).inputValue(), "中国农业银行");
  await editor.getByLabel("用于识别的卡号", { exact: true }).fill(bankNumber);
  await editor.getByRole("button", { name: "采用识别结果", exact: true }).click();
  await editor.getByLabel("卡面有效月份", { exact: true }).fill("2029-06");
  await editor.getByRole("button", { name: "保存卡片", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  const bankAsset = (await page.evaluate(() => window.sinan.store.load())).state.services.find(
    (item) => item.name === "合成工行国内卡",
  );
  assert.equal(bankAsset.card.regionGroup, "mainland");
  await page.locator('.card-flip-front [data-brand-icon="bank-icbc"] img').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".card-flip-front [data-brand-icon] img")].every(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  assert.ok(!JSON.stringify(bankAsset).includes(bankNumber));
  // 加密录入同样识别银行；保存后公开资料依然只包含尾号。
  await page.getByRole("button", { name: "翻到背面", exact: true }).click();
  await page.getByRole("button", { name: "录入或编辑加密资料", exact: true }).click();
  privateEditor = page.getByRole("dialog", { name: "加密卡片资料", exact: true });
  await privateEditor.getByLabel("完整卡号", { exact: true }).fill(bankNumber);
  await privateEditor.getByText("参考号段识别：中国工商银行，请核对。", { exact: true }).waitFor();
  await privateEditor.getByRole("button", { name: "保存加密资料", exact: true }).click();
  await privateEditor.waitFor({ state: "detached" });
  assert.ok(
    !JSON.stringify(await page.evaluate(() => window.sinan.store.load())).includes(bankNumber),
  );
  await page.getByRole("button", { name: "翻回正面", exact: true }).click();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/cards-china-bank-detail.png" });
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "筛选地域", exact: true }),
    "中国大陆 (1)",
  );
  assert.equal(await page.locator(".managed-card-entry").count(), 1);
  await page
    .getByRole("button", { name: "查看卡片 合成工行国内卡", exact: true })
    .first()
    .waitFor();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "筛选地域", exact: true }),
    "海外 (1)",
  );
  assert.equal(await page.locator(".managed-card-entry").count(), 1);
  await page.getByRole("button", { name: "查看卡片 合成订阅 Visa", exact: true }).first().waitFor();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "筛选地域", exact: true }),
    "港澳台 (0)",
  );
  await page.getByText("没有匹配的卡片", { exact: true }).waitFor();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "筛选地域", exact: true }),
    "全部地域",
  );
  await nav().getByRole("button", { name: "eSIM 卡", exact: true }).click();
  // 桌面和窄屏都必须能看见卡片，且没有横向溢出。
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/cards-esim-desktop.png" });
  await nav().getByRole("button", { name: "U 卡与支付卡", exact: true }).click();
  await page.getByRole("button", { name: "查看卡片 合成订阅 Visa", exact: true }).first().waitFor();
  await page.screenshot({ path: "screenshots/cards-payment-desktop.png" });
  async function checkVisibleLastFour() {
    const values = await page
      .locator('.managed-card-face[data-kind="payment"] .card-number-last4')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const number = element.closest(".managed-card-number").getBoundingClientRect();
          const last = element.getBoundingClientRect();
          return {
            text: element.textContent,
            fits: last.left >= number.left - 1 && last.right <= number.right + 1,
            unclipped: element.scrollWidth <= element.clientWidth + 1,
          };
        }),
      );
    assert.ok(values.length > 0);
    assert.ok(
      values.every((value) => value.fits && value.unclipped && /^\d{4}$/.test(value.text)),
      JSON.stringify(values),
    );
  }
  await checkVisibleLastFour();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: "screenshots/cards-payment-mobile.png" });
  await checkVisibleLastFour();
  await page.getByRole("button", { name: "查看卡片 合成订阅 Visa", exact: true }).first().click();
  await page.getByRole("button", { name: "翻到背面", exact: true }).click();
  assert.equal(
    await page.locator(".card-flip-back").evaluate((element) => {
      // 纹理伪元素故意超出卡面，不能用 scrollHeight 判断内容是否被裁切。
      const face = element.getBoundingClientRect();
      return [...element.querySelectorAll("button")].every((button) => {
        const box = button.getBoundingClientRect();
        return (
          box.top >= face.top - 1 &&
          box.bottom <= face.bottom + 1 &&
          box.left >= face.left - 1 &&
          box.right <= face.right + 1 &&
          box.width >= 43 &&
          box.height >= 43
        );
      });
    }),
    true,
    "手机卡片背面不能裁切操作按钮",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: "screenshots/cards-flip-mobile.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({ path: "screenshots/cards-flip-dark-mobile.png" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 800 });
  // 删除服务器必须逐字输入完整名称；取消、错误名称和尾部空格均不能删除。
  await nav().getByRole("button", { name: "服务器", exact: true }).click();
  const server = sample.servers[0];
  await page.locator(`[data-asset-id="${server.id}"]`).first().click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  const confirmation = () => page.getByRole("dialog", { name: "确认删除资产", exact: true });
  const deleteButton = () => confirmation().getByRole("button", { name: "永久删除", exact: true });
  assert.equal(await deleteButton().isDisabled(), true);
  await confirmation()
    .getByLabel("请输入完整名称以确认删除")
    .fill(server.name + " ");
  assert.equal(await deleteButton().isDisabled(), true);
  await confirmation().getByRole("button", { name: "取消", exact: true }).click();
  assert.ok(
    (await page.evaluate(() => window.sinan.store.load())).state.servers.some(
      (x) => x.id === server.id,
    ),
  );
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await confirmation().getByLabel("请输入完整名称以确认删除").fill(server.name);
  await page.screenshot({ path: "screenshots/server-typed-delete.png" });
  await deleteButton().click();
  await page.waitForFunction(
    async (id) => !(await window.sinan.store.load()).state.servers.some((x) => x.id === id),
    server.id,
  );
  await nav().getByRole("button", { name: "U 卡与支付卡", exact: true }).click();
  await page.getByRole("button", { name: "查看卡片 合成订阅 Visa", exact: true }).first().click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await confirmation().getByLabel("请输入完整名称以确认删除").fill("合成订阅 Visa");
  await deleteButton().click();
  await page.waitForFunction(
    async (id) => !(await window.sinan.store.load()).state.services.some((item) => item.id === id),
    payment.id,
  );
  assert.equal(
    await page.evaluate((id) => window.sinan.vault.get(`card-private:${id}`), payment.id),
    null,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "centered 3D card",
          "flip both ways",
          "encrypted private details",
          "unlock-and-copy continuation",
          "cancel unlock does not copy",
          "locking and flipping hide plaintext",
          "esim activation copy",
          "deleting card removes private record",
          "card recognition",
          "offline Chinese bank recognition and manual correction",
          "region filters and issuer design",
          "built-in AI and bank brand icons load offline",
          "encrypted boundary",
          "leap-year expiry",
          "asset relation persistence",
          "document entry",
          "esim independent deadlines",
          "mobile layout",
          "typed server deletion",
          "cancel keeps server",
          "clean console",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
}
