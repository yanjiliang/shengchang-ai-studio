# 声场品牌资源

本目录是应用与项目文档使用的轻量资源，Vite 构建时会复制到 `dist/brand/`。原始宣发图片位于 `output/brand-launch-2026-09-07/`，本目录不依赖原图目录即可运行。

| 资源 | 用途 | 原始素材 |
| --- | --- | --- |
| `icon-256.png` | 应用导航、欢迎与加载状态、空作品页 | `03-logo-app-icon.png` |
| `favicon-32.png` | 浏览器标签页图标 | `03-logo-app-icon.png` |
| `apple-touch-icon.png` | Apple 主屏幕图标，180 × 180 | `03-logo-app-icon.png` |
| `stage-background.jpg` | 欢迎页与空作品页背景，长边 1440 | `07-campaign-background-wide.png` |
| `launch-cover.jpg` | README 发布主视觉，长边 1440 | `04-launch-landscape.png` |
| `logo-dark.png` | 项目文档深底主 Logo，640 × 640 | `01-logo-primary-dark.png` |
| `logo-light.png` | 项目文档浅底横排 Logo，960 × 640 | `02-logo-horizontal-light.png` |

派生资源使用 macOS `sips` 等比缩小；背景 JPEG 质量 82，发布封面 JPEG 质量 85，保留原始构图。独立图标采用深底版本，不使用透明实验稿。

品牌名称为「声场 / SHENGCHANG」，主文案为「让故事，有声有场。」。工作台只在导航放置小图标，宣发背景用于欢迎和空作品状态。图标按钮保留可访问名称，辅助图形使用空 alt，文案使用真实文本。

这些资源为 PNG / JPEG 栅格图，不是 SVG 矢量母版。延展宣发时直接复用选定标志并保持宽高比。
