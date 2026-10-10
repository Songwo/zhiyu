import assert from "node:assert/strict";

/**
 * 在已经打开用量工作区、使用隔离合成来源的页面中验证管理交互。
 * 由桌面集成脚本复用当前实例；不自行启动 Electron，也不读取真实账号。
 */
export async function runUsageSubscriptionUiQa(page, { sourceName, screenshotPath } = {}) {
  assert.ok(sourceName, "需要指定隔离测试订阅名称");
  const sourceTab = page.getByRole("tab", { name: /订阅与来源/ });
  const overviewTab = page.getByRole("tab", { name: "用量概览", exact: true });
  await sourceTab.click();
  const card = page
    .locator(".subscription-source-card")
    .filter({ has: page.getByRole("heading", { name: sourceName, exact: true }) });
  await card.waitFor({ state: "visible" });
  assert.equal(await card.count(), 1, "同一来源只渲染一张订阅卡");
  assert.match(await card.innerText(), /机场累计已用/);
  assert.match(await card.innerText(), /剩余流量/);
  assert.match(await card.innerText(), /总额度/);

  await card.getByRole("button", { name: `编辑 ${sourceName}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑用量来源", exact: true });
  await edit.waitFor({ state: "visible" });
  assert.equal(await edit.getByLabel("来源名称", { exact: true }).inputValue(), sourceName);
  assert.equal(
    await edit.getByLabel("机场订阅地址", { exact: true }).inputValue(),
    "",
    "编辑不能回显订阅密钥",
  );
  assert.equal(
    await edit.getByLabel("机场订阅地址", { exact: true }).getAttribute("required"),
    null,
  );
  assert.equal(
    await edit.getByRole("combobox", { name: "来源类型", exact: true }).isDisabled(),
    true,
  );
  await edit.getByRole("button", { name: "取消", exact: true }).click();
  await edit.waitFor({ state: "detached" });

  await card.getByRole("button", { name: `移除 ${sourceName}`, exact: true }).click();
  const removal = page.getByRole("dialog", { name: "移除用量来源", exact: true });
  assert.match(await removal.innerText(), /历史用量会保留/);
  await removal.getByRole("button", { name: "取消", exact: true }).click();
  await removal.waitFor({ state: "detached" });
  assert.equal(await card.count(), 1, "取消删除保留来源");

  await card.getByRole("button", { name: /节点详情/ }).click();
  await card.locator(".subscription-details-heading").waitFor({ state: "visible" });
  const nodes = card.locator(".subscription-node");
  const nodeCount = await nodes.count();
  if (nodeCount) {
    await card
      .getByRole("textbox", { name: "搜索订阅节点", exact: true })
      .fill("nonexistent-synthetic-node-query");
    await card.getByText("没有匹配的节点", { exact: true }).waitFor();
    assert.equal(await nodes.count(), 0);
    await card.getByRole("textbox", { name: "搜索订阅节点", exact: true }).fill("");
    assert.equal(await nodes.count(), nodeCount);
  }
  await card.getByRole("button", { name: /节点详情/ }).click();
  assert.equal(await card.locator(".subscription-details").isVisible(), false);

  await overviewTab.click();
  const category = page.getByRole("combobox", { name: "用量类型", exact: true });
  await category.click();
  await page.getByRole("option", { name: "流量增量", exact: true }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "模型筛选", exact: true }).isDisabled(),
    true,
    "流量不能残留模型筛选",
  );
  await page.getByRole("combobox", { name: "来源筛选", exact: true }).click();
  assert.ok(
    (await page.getByRole("option").allTextContents()).some((text) => text.includes(sourceName)),
  );
  await page.keyboard.press("Escape");

  const previousViewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await sourceTab.click();
    await card.getByRole("button", { name: `编辑 ${sourceName}`, exact: true }).click();
    await edit.waitFor({ state: "visible" });
    const bounds = await edit.evaluate((element) => {
      const dialog = element.getBoundingClientRect();
      const footer = element.querySelector(".editor-footer").getBoundingClientRect();
      return {
        left: dialog.left,
        right: dialog.right,
        top: dialog.top,
        bottom: dialog.bottom,
        footerBottom: footer.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, "窄屏弹窗不得横向溢出");
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height, "窄屏弹窗高度有边界");
    assert.ok(bounds.footerBottom <= bounds.height, "保存与取消始终位于可见操作栏");
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
    await edit.getByRole("button", { name: "取消", exact: true }).click();
  } finally {
    if (previousViewport) await page.setViewportSize(previousViewport);
  }
  return { sourceName, nodeCount, management: "passed", filters: "passed", narrowDialog: "passed" };
}
