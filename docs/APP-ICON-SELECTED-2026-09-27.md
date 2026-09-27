# 应用图标定稿 · 2026-09-27

## 用户裁定

用户选择自己提供的方形 PNG 作为最终应用图标。画面为白色圆角方形背景、彩色细线声波、深色圣杯轮廓及杯内银发角色。此前的概念图仅用于探索，本次正式资源以该附件为唯一视觉母版，不重新绘制角色、圣杯或波形。

## 资源与适配

| 用途 | 文件 | 处理 |
| --- | --- | --- |
| 原始母版 | `apps/web/public/brand/icon-master.png` | 原样复制，1254 × 1254 PNG；SHA-256 `a93e29a222fa88b5474231f53c414120a9072745c6f8ef199a264130cc95ee12` |
| 普通安装图标 | `apps/web/public/icon-192.png`、`icon-512.png` | 从母版等比缩放 |
| 浏览器图标 | `apps/web/public/favicon.png` | 从母版缩至 64 × 64 |
| Android 自适应图标 | `apps/web/public/icon-maskable-192.png`、`icon-maskable-512.png` | 画面缩至 90%，外侧补白；只裁去母版白色圆角方形以外的黑色角像素，避免圆形启动器出现黑圈 |

生成命令：`python tools/art/prepare-assets.py --icons-only`。它只更新上述五张衍生 PNG，不重做角色立绘。`manifest.webmanifest` 与 `index.html` 保持既有路径；Service Worker 缓存版本升为 v3，以替换旧路径下的图标响应。桌面快捷方式安装脚本继续从 `icon-192.png` 生成 `.ico`。

## 验收边界

已检查 192 像素普通图标、圆形裁切的 maskable 图标及放大的 64 像素 favicon。普通图标保留母版构图；圆形裁切下圣杯底座与两端声波仍可见。favicon 因尺寸较小，脸部和细波形的细节会自然减少。自动化门禁、线上静态文件核对与真实设备安装结果记录在 [EVAL.md](./EVAL.md) 第八十三节。
