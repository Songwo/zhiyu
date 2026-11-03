// 旧功能回归需要浏览全部入口时，显式展开分组，保留产品的默认收起行为。
export async function expandNavigationGroups(page) {
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  for (const toggle of await navigation.locator(".sidebar-group-toggle").all())
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}
