export async function completeOnboarding(page) {
  await page.getByRole("textbox", { name: "工作区名称", exact: true }).fill("桌面验证用户");
  await page.getByRole("textbox", { name: "主密码", exact: true }).fill("integration-master-2026");
  await page
    .getByRole("textbox", { name: "确认主密码", exact: true })
    .fill("integration-master-2026");
  await page.getByRole("button", { name: "进入知屿", exact: true }).click();
  await page.getByRole("dialog", { name: "首次设置" }).waitFor({ state: "detached" });
}
