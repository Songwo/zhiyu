# 知屿宣传片视觉与协作契约

- 画幅 1920×1080，30 fps，总长 156 秒。
- 底色 `#f4f7fc`，白色 `#ffffff`，正文 `#17263d`，次级正文 `#52657e`，强调蓝 `#3569e8`，线条 `#d9e3f1`。仅应用截图保留原始状态色。
- 中文字体 `Zhiyu Sans`，每个文件定义 `@font-face { font-family:'Zhiyu Sans'; src:url('assets/fonts/NotoSansSC-subset.woff2'); font-weight:100 900; }`。英文也使用该字体或 Inter。
- 主标题 72–88 px，副标题 34–42 px，故事字幕由根字幕轨统一处理，场景内不要重复字幕。截图内部小字属于真实产品上下文，镜头需推近关键结果。
- 默认标题左上 x=144、y=112，最大宽 1600。主视觉 x=144、y=268、宽=1632、高=650。字幕安全带 y=956–1040，场景内容不要进入。
- 不使用小蟹，不复用旧音乐，不使用假界面或虚构按钮，不用漂浮循环。标题落地后保持静止，镜头与操作继续发展。
- 真实截图尺寸 1600×1000。保持原始纵横比。可以裁去空白、放大局部或用同一截图中的真实组件做结果特写，禁止扭曲界面。
- 全屏实际界面可以到 1800×1125，窗口框裁切在主视觉区。密集画面优先最大化截图，不用倾斜 3D 屏幕。
- 主要转场为蓝线拉出、水平推移、窗口遮罩展开、同一组件匹配。`power4.out` 进入 0.65 秒，`power2.inOut` 镜头移动 1 秒，`power3.in` 退出 0.35 秒。可按场景有理由地变化。
- 每 3–5 秒需要一次有意义的发展，包括真实操作、结果出现、局部特写或连接关系揭示。不得让整章变成静态截图轮播。
- 所有 DOM 需要稳定且全局唯一的 id，按场景前缀命名。
- 每个文件一个 `<template>`，样式、内容、脚本都在其中。根节点 `id="root" data-composition-id="场景名" data-duration="章节秒数"`，CSS `#root{position:absolute;inset:0;overflow:hidden}`。注册 `window.__timelines['场景名']=tl`，只使用 paused GSAP timeline，不使用计时器、网络和随机数。
- 用静态 HTML 声明每个 timed element 的 class clip、data-start、data-duration。根主轨控制章节，章内多镜头也必须有明确时间，不用脚本创建 DOM。
- 素材路径统一 `assets/文件名.png`。主文件提供本地 GSAP，不在场景加载远程脚本。
- 资料是「星桥项目」的一致虚构场景，主机 hk-api-01、新加坡 PostgreSQL、api.starbridge.example、ops@starbridge.example、项目支出 U 卡、亚洲差旅 eSIM。画面一律可公开。
- Jev / Exa 是真实应用组件的离线演示回放，使用合成进度和有来源的公开文档结果。对应镜头显示「离线演示回放」，不得把结果描述成现场实时请求。

## 场景分工

1. intro，16 秒，主会话。
2. documents，30 秒，主会话，文档与 Jev。
3. operations，26 秒，独立 worker，主机/容器、域名、关系图。
4. daily，28 秒，独立 worker，U 卡重点、eSIM、邮箱号码、续费与用量。
5. research，30 秒，独立 worker，Exa 重点与 AI 工作台。
6. sync，16 秒，主会话，配对、加密同步与备份。
7. outro，10 秒，主会话，品牌与下载。
