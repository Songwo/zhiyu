# 知屿界面动效

桌面与 Web 共用 Motion for React，功能模块异步加载。沿用现有主题、卡面与布局，覆盖页面入场、侧栏选中高亮、资产详情、编辑弹窗和任务步骤；已有条目的状态更新不重新挂载。资产列表打开详情后仍保留原有挂载方式，文档与终端不因动效新增缓存副本。

## 档位与预览

进入「设置 → 外观 → 界面动效」：

- 完整动效：短弹簧与位移；系统启用减少动态效果时自动使用轻量档，不改写用户保存的选择。
- 轻量动效：新组件只保留短淡入淡出，卡片直接切换正反面，停用旧界面的 CSS 位移、闪烁和景深。
- 关闭动效：立即切换状态，停用过渡和自动滚动动画。

偏好只保存在当前设备，不随资产导出或同步。系统的减少动态效果设置变化后立即生效。

「预览动效」提供关联展开、卡片正反面和逐项进度的本地示例。示例不读取私人资产，不调用 Exa、模型或服务器，不扣额度。步骤中的时间是本地示例运行时间。切换示例或关闭弹窗会清理计时器。示例卡不含真实卡号或安全码。

预览中按 Esc 仅关闭最上层弹窗；当原按钮仍在最上层设置窗口中时，还原其键盘焦点。

## 验证

先运行 `npm run typecheck`、`npm run lint`、`npm run i18n:check` 和 `npm test`，再分别执行 `npm run build`、`npm run web:build`、`npm run desktop:build`。三个构建输出目录不同；UI 回归应在构建完成后执行，避免开发服务器因构建产物变化而重载。

交互回归使用独立浏览器会话或独立资料目录的 Electron 示例，初始条件是简体中文、完整动效、系统未开启减少动态效果，并已进入首页。打开既有资料时不要直接执行这些测试。

PowerShell 示例（先将独立会话导航到当前测试地址，或连接该示例程序的本地调试端口）：

```powershell
Get-Content scripts/motion-open-preview.json -Raw | npx --yes agent-browser@0.27.0 --session zhiyu-motion-test batch --bail
Get-Content scripts/motion-preview-interactions.json -Raw | npx --yes agent-browser@0.27.0 --session zhiyu-motion-test batch --bail
Get-Content scripts/motion-preferences-interactions.json -Raw | npx --yes agent-browser@0.27.0 --session zhiyu-motion-test batch --bail
```

第一组检查关联展开/返回、反向翻转、步骤完成及节点身份保持、切换清理和 Esc 焦点恢复。第二组检查偏好持久化、关闭后的最终状态、系统实时降级与恢复、手机边界和桌面截图。截图写入 `screenshots/`。
