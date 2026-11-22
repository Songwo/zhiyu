// 旧版预览仍使用折叠分组；本地临时验收脚本也可能沿用原入口。
export async function expandNavigationGroups(page) {
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  for (const toggle of await navigation
    .locator('.sidebar-group-toggle[aria-expanded="false"]:visible')
    .all())
    await toggle.click();
}

const activeSidebarNav = (page) =>
  page.locator(
    '#primary-navigation:visible .sidebar-nav, .app-sidebar.anim-drawer[data-shown="true"]:visible .sidebar-nav',
  );

export async function openDesktopDirectory(page) {
  const nav = activeSidebarNav(page);
  if (!(await nav.isVisible())) {
    await page.getByRole("button", { name: "打开菜单", exact: true }).click();
    await nav.waitFor();
  }
  await nav.getByRole("button", { name: "全部功能", exact: true }).click();
  return page.getByRole("dialog", { name: "全部功能", exact: true });
}

export async function navigateDesktop(page, name) {
  const shortcut = activeSidebarNav(page).getByRole("button", { name, exact: true });
  if (await shortcut.isVisible()) {
    await shortcut.click();
    return;
  }
  const directory = await openDesktopDirectory(page);
  await directory.getByRole("button", { name, exact: true }).click();
  await directory.waitFor({ state: "detached" });
}
