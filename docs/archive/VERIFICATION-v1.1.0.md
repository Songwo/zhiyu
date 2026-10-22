# 司南 1.1.0 验证记录

本记录说明 1.1.0 已执行的自动化检查、产物验收状态和未覆盖范围，便于发布前核对。记录日期：2026-09-30。

## 已通过的检查

| 检查                | 结果                                                                                                                                | 证据                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 全量单元测试        | `npm test` 通过，两阶段分别为 471 和 93 项，共 564 项，失败、跳过均为 0                                                             | `release/v110-tests-final.log`                                                            |
| 类型检查            | `npm run typecheck` 退出码为 0                                                                                                      | `release/v110-typecheck-final.log`                                                        |
| 静态检查            | `npm run lint` 退出码为 0；0 个错误、20 个既有警告                                                                                  | `release/v110-lint-final.log`                                                             |
| 翻译检查            | `npm run i18n:check` 退出码为 0；核对 996 个字面量调用键和 1433 条翻译                                                              | 发布前终端记录及独立核验；旧 `release/v110-i18n.log` 为修复前失败日志，不作为通过证据     |
| Web 构建            | `npm run build` 退出码为 0                                                                                                          | `release/v110-web-build-final.log`                                                        |
| Web 开发与生产产物  | 桌面及 390×844 移动视口均有内容，无页面异常、控制台错误或横向溢出；生产对照结果 `divergesFromBaseline: false`                       | `release/v110-dev-smoke-final.log`、`release/v110-production-smoke-final.log` 及对应截图  |
| Windows 打包        | `npm run desktop:dist` 退出码为 0，生成 Windows x64 安装器                                                                          | `release/v110-desktop-dist-final.log`                                                     |
| 桌面显示设置        | 四档缩放生效；拒绝 9 个非法输入和其他窗口调用；快捷键、并发偏好写入及重启恢复通过                                                   | `scripts/display-integration.mjs`、`release/v110-display-integration-final.log`           |
| 模拟 DPI 与应用缩放 | 125/150/175/200% 模拟系统缩放 × 100/110/125/150% 应用缩放，共 16 组合通过；编辑保存及按钮可达，无横向溢出；刷新保留缩放且可恢复默认 | `scripts/display-layout-integration.mjs`、`release/screenshots/phone-display-matrix.json` |

最终 Windows 打包程序已通过 `scripts/release-smoke.mjs` 验收，退出码为 0：实际版本为 1.1.0，`packaged: true`；使用独立数据目录，首次设置、四类订阅入口、生产环境禁用演示入口、号码落盘与刷新持久化、100/110/125/150% 四档缩放均通过，`pageErrors` 为空。成功记录为 `release/v110-packaged-smoke-final.log`。
以下六组界面与桌面回归均已通过。桌面测试使用隔离数据目录，不改动现有工作区。

| 脚本                                         | 实际覆盖                                                                                 | 成功日志                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `scripts/frontend-integration.mjs`           | 排序、分页、筛选、布局保存、减少动画                                                     | `release/v110-frontend-integration.log`        |
| `scripts/ai-subscription-integration.mjs`    | 四类订阅入口、授权回调、取消、防重复、刷新与持久化；额度失败保留账号，凭据不进入普通资产 | `release/v110-ai-subscription-integration.log` |
| `scripts/usage-usability-integration.mjs`    | HY2 导入与节点归属、首次连接验证、403 后保留来源和历史、重试及凭据隔离                   | `release/v110-usage-usability-integration.log` |
| `scripts/customization-integration.mjs`      | 头像和资产图片转换、尺寸、保存与删除、恶意图片拒绝、桌面及移动界面                       | `release/v110-customization-integration.log`   |
| `scripts/desktop-integration.mjs`            | 原生窗口、菜单、托盘与通知偏好、语言保存及非法输入拒绝                                   | `release/v110-desktop-integration.log`         |
| `scripts/composer-usability-integration.mjs` | 服务器最少字段保存、编辑保留隐藏字段、未采集状态、订阅/API/手动入口及移动布局            | `release/v110-composer-usability.log`          |

文档回归已验证 Markdown 原文迁移、编辑与解绑自动保存、重复迁移不覆盖后续内容、刷新持久化；图片部分失败保留成功项，重试不重复插入，切换保存位置立即生效。报告为 `release/screenshots/documents-v110-report.json`，页面异常列表为空。图床使用固定样本桥接，未请求真实图床账号。

号码界面回归的 11 项检查通过：新建、多订阅绑定、编辑保留字段、复制、键盘新建、号码搜索、到期筛选、账号详情解绑与重绑、刷新持久化、移动布局、删除号码保留账号；页面异常列表为空。另已通过设置界面的完整号码及双关联导出、清空后导入和刷新恢复。

容量边界检查已验证：现有 10000 条号码时新增第 10001 条被拒绝，原数组引用和条数不变，之后其他 AI 资产仍能保存。上述结果来自本轮执行记录；回归脚本保存在 `scripts/phones-usability-integration.mjs` 和 `scripts/phones-backup-integration.mjs`。

## 发布验收状态

- [x] 最终 Windows 打包程序的启动、首次设置、号码持久化和四档缩放检查。
- [x] 提交、推送、`v1.1.0` 标签及对应 GitHub Actions 成功。
- [x] GitHub Release 安装器与 `SHA256SUMS.txt` 下载和校验。
- [x] 宣传页部署与公开访问核验。

发布代码提交为 `427d369a1d18c36d4d819cb5738aafc9f26e7e21`，标签为 `v1.1.0`。[CI](https://github.com/Songwo/zhiyu/actions/runs/36691159569)、[Windows 正式版](https://github.com/Songwo/zhiyu/actions/runs/36691159081)、[产品主页](https://github.com/Songwo/zhiyu/actions/runs/36691159717)均成功。[公开 Release](https://github.com/Songwo/zhiyu/releases/tag/v1.1.0) 的安装器与校验文件已经实际下载并核对，SHA256 为 `31b4177c6c6f28244eb5e984d9eeb1c1f97339b06698b7a5501b2079597b490e`。

[宣传页](https://songwo.github.io/zhiyu/)已通过公开网络的桌面和手机浏览器检查：响应 200，版本为 1.1.0，图片正常加载，无横向溢出和控制台／页面错误。报告与截图保存在本地 `release/screenshots/v110-public-site.json` 及同目录图片；远端安装包校验记录为 `release/github-v1.1.0/verification.json`。

## 验证边界

- 16 组合是浏览器模拟显示比例和应用缩放，不能替代真实显示器、驱动、多屏切换或远程桌面的清晰度检查。
- 3～5 位目标用户的[真人任务测试表](USABILITY-TEST-v1.1.md)已准备，真人试用尚未执行。
- 本轮打包目标是 Windows x64；未验证 macOS / Linux 安装包。
- 图床、AI 授权和用量的受控回归不代表所有真实账号、供应商和权限组合已经连通。订阅额度不能据此称为精确 API Token 或账单费用。
- 本地 `release/` 日志和截图用于本次验收，不作为公开仓库中必定存在的附件。自动化通过不补填真人试用或公开发布结果。
