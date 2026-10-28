# 发布流程

当前发布目标为 Windows x64 NSIS 安装包。其他平台的打包配置不代表已验证可发布。

## 宣传与下载页同步

[GitHub Pages 下载页](https://songwo.github.io/zhiyu/)使用 `site/` 下的模板和图片，版本、日期、更新摘要、安装包、插件及校验文件地址由最新已发布的 GitHub 正式版生成，不读取尚未发布的 `package.json` 版本。

`产品主页` 工作流在页面源码改动、正式 Release 发布或编辑、以及 `Windows 正式版` 流水线成功后自动部署，也支持手动运行。使用 `workflow_run` 接续自动发布，因为 `GITHUB_TOKEN` 创建的 Release 不会触发另一条 `release` 工作流。草稿、预发布、缺失或尚未上传完成的附件会使页面构建失败，现有线上页面保留。

本地预览先将 `gh api repos/Songwo/zhiyu/releases/latest` 的 JSON 保存到 `release/pages-latest.json`，执行 `node scripts/build-site.mjs release/pages-latest.json release/site`，再使用静态服务器查看 `release/site`。页面为完整静态 HTML，访客无需请求 GitHub API；所有下载入口绑定同一个正式版本，资源使用内容摘要更新缓存。

界面改动后，在开发预览已启动时运行 `node scripts/capture-site.mjs`，重新生成资产总览、文档阅读、用量图表与浏览器密码迁移四张展示图。只更新迁移界面可使用 `--passwords-only`。脚本只使用独立浏览器上下文和示例资料，不连接真实桌面数据或外部账号。检查图片后随 `site/` 一起提交；截图不会在每次发布时自动重拍。

## 版本准备

更新 package.json、package-lock.json、browser-extension/manifest.json 与 src/lib/changelog.ts，执行 `node scripts/write-changelog.mjs` 同步 CHANGELOG.md。本版说明保存在 `docs/releases/v1.17.1.md`。README 的安装包名、构建目录及教程应与版本一致；描述实际支持范围，不将本机协议测试写成真实账号登录成功。

## 必须验证

```bash
npm ci
npm run typecheck
npm run lint
npm run i18n:check
npm test
npm run desktop:build
node scripts/agent-integration.mjs
node scripts/ai-subscription-integration.mjs
node scripts/website-account-integration.mjs
node scripts/mail-client-integration.mjs
npm run build
```

检查桌面首次启动、升级解锁、Markdown 输出、主题化下拉菜单、锁库状态以及未配置网络服务时的错误。AI 订阅需检查快速登录入口、自动及手动回调、重复授权、分类额度，以及刷新失败后仍保留账号和上次结果。本版还需确认等待授权时回调输入直接可见，验证授权与同步额度阶段分别显示，令牌请求的 403 / 429 不被误写成额度查询错误。头像与资产图片需检查上传、更换、移除、保存及重启恢复，并确认超限文件和无效格式被拒绝。

0.3.0 另外检查网站账号类型选择、URL 清理、加密保存失败处理、注册邮箱关联、重载和导出无凭据。邮箱覆盖 TLS 验证、首次基线、UID 重置、未读与新增区分、取消和锁库。Agent 的实时邮箱许可必须在主进程检查，定位凭据只能返回位置。推送覆盖默认关闭、首次不发送、独立游标、渠道验证、失败重试、取消和不含邮件内容的通知正文。真实推送验收由维护者使用自己授权的接收目标操作，不能用自动化向私人或群聊目标发测试消息。

网页开发和生产输出均执行 browser-smoke，查看桌面及移动截图。真实供应商登录由账户持有人在网页完成，不通过自动化读取私人浏览器会话。Release 说明分别记录自动化验证和真实账号验证的范围；额度查询来源不能写成各家网页订阅的全部权益。

## 生成与上传

```bash
npm run desktop:dist -- --win --x64 --publish never
```

打包脚本将主进程及编译后的界面放入系统临时目录中的独立暂存区，使用仓库锁文件版本安装 `ssh2`、`electron-updater`、`imapflow`、`openai`、`minisearch`、`nodemailer`、`mailparser`、`html-to-text`、`sanitize-html`、`unified`、`remark-parse`、`remark-gfm`、`js-yaml`、`@noble/hashes` 及其运行依赖（清单在 `scripts/package-stage.mjs`，主进程新引用的第三方包没有加入清单时打包会直接报错），再通过 electron-builder 内置的目录遍历器收集依赖，避免将网页构建工具装进桌面包。暂存区先解析真实路径，npm 子进程只通过工作目录定位项目，避免 macOS 符号链接路径与 `--prefix` 解析不一致。排除可选原生加速模块，SSH 使用库自带的 JavaScript 实现；无需 Visual Studio 编译环境。复用本机已安装的同版本 Electron，输出到 `release/v版本号/`；构建结束清理暂存区。

安装包生成后检查版本和包内容，运行 `node scripts/release-smoke.mjs release/v1.17.1/win-unpacked/Zhiyu.exe` 验证打包程序，计算 SHA256，补齐 Release 说明中的验证记录。该脚本使用独立临时数据目录，不修改日常资料。发布时显式选择源码、文档和必要资源，不提交临时截图、日志、用户数据或运行目录。将发布标签指向已经验证的提交，再上传 `Zhiyu-1.17.1-setup.exe`、便携版 ZIP、浏览器扩展包与 `SHA256SUMS.txt`，以及下文要求的应用内更新附件。

1.3.1 的 Windows 正式发布流水线额外运行 `passwords-desktop-integration.mjs` 验证实际打包程序的 CSV、加密库、后台资产同步、锁库与文档保存，并在 `extension:build` 后运行 `browser-companion-integration.mjs` 加载真实扩展，覆盖原生表单整页导航、多账号填写与文档提示。依赖中文界面标签的 Electron 测试必须显式设置 `locale: "zh-CN"`，不能依赖开发机的系统语言。测试只使用独立临时资料和合成账号，不读取真实浏览器密码库；真实浏览器原生 CSV 导入结果与第三方在线文档兼容性应单独记录。

0.5.0 还需验证文件夹默认收纳、自定义分组、批量移动及重载恢复，邮件阅读、显式已读、加密草稿、发送确认、锁库取消与窄窗口布局。协议使用本机 fixture 测试，不向真实收件人发送测试邮件；真实 IMAP/SMTP 登录与最终投递单独记录，不能由 mock IPC 成功推断。

0.6.0 还需检查纯文本 Markdown 与 HTML 排版、原文切换、表格窄屏滚动、加载占位及减少动态效果。安全回归应验证脚本、事件属性、表单和外部样式被移除，远程图片在授权前无请求，切换或刷新邮件不继承许可，CID 图片受格式和大小限制。检查账号及发件人头像上传、重载恢复、移除和导出边界。Agent 覆盖空组、未分组、分组改名与移动、分页目录，以及工具和 RAG 结果不含密码、正文、草稿或图片。

首次公开仓库时检查可达历史、截图和附件，不只扫描当前目录。确认源码许可证及第三方声明，排除用户数据、真实邮箱、Token、回调链接及个人浏览器截图。历史中已存在的信息不能靠删除当前文件解决，历史处理和仓库可见性变化应由维护者明确决定。

当前发行未配置 Authenticode 证书。需要签名发行时，在维护者受保护的构建环境中配置 electron-builder 签名参数；证书与密码不得写入仓库。

## 1.4.0 应用内更新验证

发布必须包含安装包、`.exe.blockmap`、`latest.yml`、Windows 便携版 ZIP、配套插件 ZIP 和 SHA256SUMS。便携版由 `npm run desktop:portable` 从同一次构建的 `win-unpacked` 打包，附加 `portable.txt` 标记，不重新编译。`latest.yml` 由同一次 electron-builder 构建生成，不手写摘要；安装包的 SHA512 和长度必须匹配元数据。只上传安装包会导致应用内检查或下载失败。验证默认监控及锁库采集、Markdown 导入与重启保存，并运行更新引擎真实下载和坏校验拒绝测试、更新 UI 与保存失败测试。

## 1.5.0 工作区与缓存验证

除上述检查外，开发预览运行时执行文档导航、关系与监控界面、AI 修改建议交互回归；密钥库回归使用 Electron 与隔离数据目录：

```bash
node scripts/document-navigation-integration.mjs
node scripts/relations-usage-ui-integration.mjs
node scripts/agent-actions-ui-integration.mjs
node scripts/vault-usability-integration.mjs
```

正式包生成后，另运行工作区集成验证：

```bash
node scripts/workspace-v150-integration.mjs release/v1.6.0/win-unpacked/Zhiyu.exe
```

该命令从参数指定的实际程序启动，核对版本并使用独立临时资料；通过本机合成模型服务验证文档修改、账号元信息修改与关系提案的真实主进程链路，不使用日常凭据或真实模型额度。省略程序参数会启动源码主进程，不能替代正式包验证。

验证文档「＋」菜单、跨页面拖入、目录与首尾定位、切页缓存及未保存草稿保护；文档保存、删除与一次导入 50 篇应通过增量通知更新缓存，不触发全列表重新枚举，无载荷的旧式通知仍可补读。检查关系图只显示真实关联、建议经确认写入、文档绑定和解除后的持久化。用量页应先展示图表与明细，「采集与监控」详情可打开、关闭并切换历史筛选；来回切页不能反复触发远程采集。

密钥库检查整行打开账号、取消／错误／正确解锁后继续操作、主动锁定及再次隐藏凭据。导航在明暗主题、不同缩放和窄窗口下检查图标与选中背景居中、阴影边界、滚动区域和固定底部入口；文档与弹窗动画须尊重减少动态效果设置。

AI 回归用本机合成模型服务，验证失败重试采用当前配置与权限、建议只读预览、确认写入、重复应用与过期拒绝，以及并发编辑后的版本冲突。`npm test` 包含文档、关系、缓存和修改提案单元测试；不能以协议回归通过宣称用户的真实 API Key 或服务商鉴权已经修复。Release 验证记录须在实际命令结束后填写，并区分开发预览、打包程序及真实账号验证范围。

## 1.5.1 导航入口验证

检查窗口顶部「系统设置…」可打开设置，侧栏底部保留解锁／锁定密钥库，且侧栏不再显示独立关系图入口。进入「标签 → 关系图 → 全部资源」确认资产、未绑定文档和已保存关联仍可查看；服务器等分类页的卡片／表格／关系图切换继续可用。历史版本发布说明保留其当时的入口描述，不改写为新版行为。

## 1.5.2 AI 授权、用量刷新与输入区验证

开发预览运行时执行下列回归：

```bash
node scripts/agent-access-ui-integration.mjs
node scripts/agent-composer-integration.mjs
node scripts/usage-live-chart-integration.mjs
```

检查缺正文／提案权限时出现明确授权卡，点击后复用原问题且不重复添加用户消息；新问题不继承本次权限。标题改名不应读取正文，提案须呈现前后标题并经确认才保存；并发正文或标题变化、文档删除及重复应用应被拒绝。实际打包程序还需通过主进程与本机合成模型服务验证此链路；浏览器桥接回归不能代替正式包验证，更不能据此断言真实 API Key 已通过鉴权。

输入区检查单行、多行、发送／停止切换、100%／125%／150% 缩放与窄屏，固定操作区不得偏下、越界或遮挡文字。能力面板展开与收起均应有过渡，关闭时不可操作；减少动态效果设置须生效。

用量检查采集完成事件更新当前页面，统计未变化的状态通知不重新读取全量记录；切页和图表渲染不得触发额外远程采集。以大额历史值和今日小额非零值同时存在的合成数据，核对今日明细、真实坐标圆点、提示框和数据表一致，零值与缺失日期不画成非零用量。保持约 10 秒本机日志扫描，发布说明不得写成所有 AI 软件均可实时读取。

1.5.2 插件仅同步版本号与下载包名，没有新增插件功能。版本一致性检查应确认 `package.json`、锁文件根版本和 `packages[""].version`、扩展清单与首条更新日志一致；锁文件依赖版本不作整体替换。

## 1.6.0 身份、账号与社区反馈验证

开发预览运行后检查 Markdown 源码、GFM 预览、转换确认、原文导出及重载；文档账号提取检查候选修改、多选、锁库失效、同站多账号与来源文档关联。界面回归命令如下：

```bash
node scripts/document-markdown-integration.mjs
node scripts/document-account-extract-integration.mjs
node scripts/service-assets-ui-integration.mjs
node scripts/wxpusher-ui-integration.mjs
node scripts/page-scroll-integration.mjs
```

运行 `node scripts/identity-totp-desktop-integration.mjs release/v1.6.0/win-unpacked/Zhiyu.exe` 验证隔离正式程序中的身份授权、本人帖子全文与账号提取、TOTP 和锁库链路。通过测试进程替换网络与系统浏览器调用，不读取真实身份或向论坛发送授权信息，并明确关闭测试资料的本机日志采集。省略程序参数会启动源码主进程，不能替代打包程序检查。

`npm test` 包含身份回调与缓存、TOTP、文档账号提取、采集周期、Markdown 源码、服务资产、WxPusher 和打包暂存目录回归。检查服务器仅手动模式不自动连接，切换周期后复用相应缓存；本机 Token 监控不随之停止。WxPusher 只用合成响应验证请求格式与失败处理，不向真实接收目标发送测试消息。

Linux.do 的真实 OAuth 需要账户持有人在软件里配置自己的 Connect 应用并授权。公开帖子访问还取决于论坛权限与网络策略，HTTP 403 必须原样解释为请求被拒，不能绕过或宣称取得私有帖子。发布记录应分别列出协议测试与真实账号验证范围。

macOS 的 Apple Silicon / Intel 构建由「macOS 打包检查」工作流验证，成功后仅产生未签名测试 ZIP。具体命令、路径与限制见 [macOS 构建说明](MAC-BUILD.md)。没有实际工作流结果时，不填写 macOS 构建通过；Windows 测试不能替代 macOS 构建、运行、签名或公证验证。

1.6.0 发布附件使用 `Zhiyu-1.6.0-setup.exe` 和 `Zhiyu-1.6.0-browser-extension.zip`，插件目录为 `zhiyu-browser-extension`。仓库、Pages 下载页、更新源和新附件统一使用知屿 Zhiyu。内部安装身份、原用户目录和已有协议用于升级兼容，不随外部品牌更名而随意修改；历史附件名与历史验证结果保持事实原状。

## 1.7.0 主身份登录与兼容验证

本版将 Linux.do 新登录入口移到首次设置和个人资料，普通用户通过统一登录服务绑定主身份，不再在密钥库里填写 Connect 应用配置。以上 1.6.0 章节保留当时的入口和验证事实，不作为当前主身份登录步骤。

开发预览运行时验证首次设置、个人资料、同步选择、改绑确认、退出、帖子失败重试及窄窗口布局：

```bash
node scripts/main-identity-ui-integration.mjs
```

正式包生成后，验证实际 Electron 程序中的主身份链路，同时保留旧身份与 TOTP 兼容回归：

```bash
node scripts/main-identity-desktop-integration.mjs release/v1.7.0/win-unpacked/Zhiyu.exe
node scripts/identity-totp-desktop-integration.mjs release/v1.7.0/win-unpacked/Zhiyu.exe
```

两个桌面脚本都以第一个参数指定实际可执行文件，通过 `--user-data-dir` 使用独立临时资料，检查运行的是打包程序，并关闭测试资料的本机用量扫描。省略程序参数会启动源码主进程，不能替代正式包验收。

`main-identity-desktop-integration.mjs` 使用真实 Electron、本机随机端口回调和系统安全存储；外部登录服务、论坛响应和系统浏览器调用使用合成样本。检查未创建密钥库时可预览身份但不跳过主密码设置，锁库状态可刷新主身份，昵称／头像同步与缺失头像可重启恢复，界面与普通资料不返回登录凭据，帖子全文保存不创建虚构账号关联，以及退出后清除凭据、帖子缓存但保留身份和文档。

`identity-totp-desktop-integration.mjs` 在本版用于历史身份兼容：通过保留的旧接口准备身份记录，检查已有账号的资料维护、本人帖子全文、文档账号提取、TOTP 与锁库，并确认密钥库没有新的「导入身份」入口。它不替代主身份登录验证，也不表示普通用户仍需自己申请 Connect 应用。

本次 `npm test` 已通过 913 项测试（820 项 Node 测试、93 项 TypeScript 测试），失败、取消和跳过均为 0。新增回归覆盖统一登录服务、桌面主身份与个人资料同步；测试数量只记录本次实际结果，后续修改应重新运行并更新对应发布记录。

截至 2026 年 10 月 9 日，公网 `https://auth.allinsong.top/healthz` 已返回 `configured: true`，`POST /v1/login/start` 已返回 HTTP 200，并核对官方授权地址、`https://auth.allinsong.top/oauth/linuxdo/callback` 回调和 S256 PKCE。随后已通过用户本人发起的真实授权与绑定，本机已连接状态、邮箱和等级字段已核对；没有公开其账号信息。未提供可用头像时继续保留本地头像，不能据此宣称任意头像或受限帖子均可读取。协议测试与真实 OAuth 结果必须分别记录，不发布完整授权链接、应用密钥或服务凭据。

1.7.0 安装包、更新元数据、下载页和扩展版本保持一致，附件使用 `Zhiyu-1.7.0-setup.exe` 与 `Zhiyu-1.7.0-browser-extension.zip`。插件本版只同步版本号。升级继续保留原数据目录及 1.6.0 密钥库身份资产，不把旧账号自动迁移为主身份；主身份使用独立系统加密文件，登录不能代替本地主密码。

## 1.7.1 安全与性能修补验证

本版新建和改密要求 10 至 256 位，新库写入 v2 与当前 scrypt 参数；旧 v1 库仍可用原来的 6 位主密码解锁，普通读写不改格式，改密后才升级。回归应检查非法 KDF 参数与内存、运算量上限，恢复不同密钥备份后的自动锁定，以及异步读取、派生或保存期间外部文件变化时拒绝覆盖。

除前述完整检查外，以下定向回归覆盖密钥库、模型 API Key 的系统加密存储边界、OAuth 配置导入与本机用量采集：

```bash
node --test electron/services/vault.test.mjs electron/services/agent-service.test.mjs
node --test electron/services/oauth-client-file.test.mjs electron/services/local-usage.test.mjs
```

桌面权限检查剪贴板正常使用而其他权限被拒，正式包加载时内容安全策略不得阻止现有功能。展开服务器详情后核对历史指标展示、加载过程与控制台；构建输出应将 recharts 从初始加载路径分离。

OAuth 客户端 JSON 检查非普通文件、超过 256 KB、读取期间增长、无效 JSON 和客户端字段类型错误，界面提示不得带出原文件片段。Windows 本机用量检查大文件标识的精确路径与句柄比较，并保留已有日志断点的哈希格式，避免升级后重复统计 Token。

版本一致性检查包括 package.json、锁文件根版本与 `packages[""].version`、浏览器插件清单和首条更新日志。Windows 安装包、扩展 ZIP、更新元数据及校验文件必须来自同次构建。官网正式版继续由已发布 Release 动态渲染；macOS 默认目标为 `mac-test-1.7.1.1` 独立 Pre-release，不影响 Windows 正式更新源。

测试、正式包和 macOS 构建结果应在各命令完成后分别记录；1.7.0 的测试数量和实机反馈不能作为本版通过的证据。

## 1.7.2 订阅来源与本机流量验证

本版新增订阅来源管理、节点摘要和 v2rayN 本机流量。先完成上述类型、lint、中英文、完整测试及构建检查，再核对本版定向回归：

```bash
node --test electron/services/subscription-parser.test.mjs electron/services/usage-subscription.test.mjs electron/services/v2rayn-usage.test.mjs
node --test scripts/usage-connect.test.mjs scripts/usage-setup.test.mjs scripts/usage-insights.test.mjs scripts/v2rayn-match.test.mjs
```

桌面界面构建完成后，使用源码主进程检查已有 3x-ui 配置流程和新的订阅管理交互：

```bash
node scripts/usage-usability-integration.mjs
node scripts/subscription-desktop-integration.mjs
```

正式包生成后，必须另跑同一条订阅集成链路：

```bash
node scripts/subscription-desktop-integration.mjs release/v1.7.2/win-unpacked/Zhiyu.exe
```

`subscription-desktop-integration.mjs` 用第一个参数指定实际程序，使用独立临时资料并校验是否为打包实例。测试只启动本机合成订阅／指标服务，预先写入合成 v2rayN 目录，避免探测或读取日常客户端。`usage-subscription-ui-qa.mjs` 是由该脚本调用的交互检查模块，不作为独立启动命令。检查完成后查看 `screenshots/` 下本次生成的桌面与窄窗口截图；源码主进程通过不能替代正式包验证。

检查新增／编辑弹窗、空凭据保留、同一规范化 URL 并发去重、同名来源独立、换 URL 后基线隔离、移除与历史保留、失败重试及旧采样提示。节点覆盖 URI、Base64、Clash、sing-box，拒绝超过 2 MiB 的正文，最多展示 1000 个可识别节点，普通缓存和返回值不得含订阅 URL、节点认证参数或原始正文。展开缓存和搜索不应额外发起订阅下载。筛选检查类型、来源、模型联动、无效选择清除、同名与已移除来源标签，模型不得影响流量与额度。

v2rayN 回归检查只读打开数据库、手动目录选择与重启保留、无管理员／锁库状态读取、已保存 KB 和实时字节分开、跨日统计、节点唯一匹配、核心重置及切换时重新建立监测基线。只连接已有 Xray 回环指标接口，不修改客户端配置、不启用原本关闭的接口；统计关闭、读取失败、接口缺失及其他核心不支持时明确提示，不显示为零流量。机场总量、本机已保存统计与当前核心实时值不得相加，也不得描述成逐节点账单或所有设备总量。

版本检查包括 package.json、锁文件根版本与 `packages[""].version`、浏览器插件和首条更新日志，插件本版只同步版本号。桌面包需包含订阅解析所需的 `js-yaml` 运行依赖与 Windows v2rayN 探测脚本。macOS 目标为 `mac-test-1.7.2.1` 独立未签名双架构 Pre-release；其构建、附件验证和实机结果分别记录，不能用 Windows 验证结果替代。

本章节记录验证要求，不预填测试总数或通过结果。真实 v2rayN 客户端探测与合成桌面回归应分别记录范围；公开记录不包含用户节点、订阅地址、凭据、路径或用量数值。
