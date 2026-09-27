# 应用图标定稿 · 2026-09-27

## 用户裁定

用户选择自己提供的方形 PNG 作为最终应用图标。画面为白色圆角方形背景、彩色细线声波、深色圣杯轮廓及杯内银发角色。此前的概念图仅用于探索，本次正式资源以该附件为唯一视觉母版，不重新绘制角色、圣杯或波形。

## 资源与适配

| 用途 | 文件 | 处理 |
| --- | --- | --- |
| 原始母版 | `apps/web/public/brand/icon-master.png` | 原样复制，1254 × 1254 PNG；SHA-256 `a93e29a222fa88b5474231f53c414120a9072745c6f8ef199a264130cc95ee12` |
| 普通安装图标 | `apps/web/public/icon-192.png`、`icon-512.png` | 从母版中央裁出 850 × 850 近景，再等比缩放；保留原路径供桌面快捷方式等使用 |
| 新安装入口 | `apps/web/public/icon-home-192.png`、`icon-home-512.png` | 与普通近景图标相同，供 Android manifest 使用新 URL |
| iPhone 桌面图标 | `apps/web/public/apple-touch-icon.png` | 近景裁切后输出 180 × 180，`index.html` 使用新 URL |
| 浏览器图标 | `apps/web/public/favicon.png` | 近景裁切后缩至 64 × 64 |
| Android 自适应图标 | `apps/web/public/icon-maskable-192.png`、`icon-maskable-512.png` 与新的 `icon-home-maskable-*` | 近景图案缩至 90%，外侧补白，以适应圆形/圆角裁切；manifest 使用新 URL |

生成命令：`python tools/art/prepare-assets.py --icons-only`。它只更新图标，不重做角色立绘。近景裁切框 `HOME_ICON_CROP = (202, 325, 1052, 1175)` 位于该脚本顶部，可由用户调整后重跑生成；母版始终保留原图。`manifest.webmanifest` 和 `index.html` 的安装图标改用新路径，Service Worker 缓存版本升为 v4。桌面快捷方式安装脚本继续从更新后的 `icon-192.png` 生成 `.ico`。

## 验收边界

第一次上线的全画布缩放版在手机桌面被用户实际发现过小。修正时并排比较原版、900/850/800 像素近景裁切在 192 像素和 60 像素下的效果，又比较圆形启动器裁切。选择 850 像素近景：角色脸部显著放大，圣杯底座仍能识别，两侧保留部分波形；原画上下波峰与线条端点被裁去，这是小尺寸可读性的取舍。自动化门禁、线上静态文件核对与真实设备安装结果记录在 [EVAL.md](./EVAL.md) 第八十四节。
