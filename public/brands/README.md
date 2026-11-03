# 内置品牌图标

这些文件随桌面和网页构建发布，不在运行时访问第三方图标或 favicon 服务。

- 国内银行：30 家，来自支付宝公开银行标识；裁取左侧图形并缩放至 72px 白色画布，用于资产识别，不代表合作、认证或官方卡面。
- AI 与部分云平台：Lobe Icons，固定提交与 MIT 许可证见 `manifest.json`、`licenses/lobe.txt`。
- 常用服务、系统和卡组织：Simple Icons，固定提交、原始图形来源与适用说明保存在 `manifest.json`，集合许可证见 `licenses/simple.txt`。
- 银联：Payment Webfont China，固定提交与 CC0 许可证见 `manifest.json`、`licenses/payment.txt`。

商标归各自权利人所有。来源地址、处理方式、原图（银行）和内置文件 SHA256 均保存在清单中。图标仅作为识别标识，不表示背书。

维护时运行 `node scripts/vendor-brand-assets.mjs`，该脚本需要开发依赖中的 Chromium。复核银行裁切、浅色/深色显示以及清单后，再运行 `node --test scripts/brand-icons.test.mjs`。固定的上游提交只在审核后更新；银行 CDN 可能变化，更新后须检查源摘要与视觉结果。
