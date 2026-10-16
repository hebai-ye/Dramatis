# B03 实施要求

允许tools/desktop/**、apps/web/public/sw.js和报告。禁止改web tools（109清单已完成）、main.tsx、根锁/清单及任何其他禁区；不提交/push，不spawn子代理。保持已有shell-assets.json生成/上版懒模块保留逻辑目标，不重做分包。

## B03 桌面构建新鲜度

新build-inputs.mjs按规范化相对路径+文件内容sha256+模式/Node/Vite版本/相关构建环境合成fingerprint。目录web/src,public,tools与core/src，显式root/web/core package.json、root lock/workspace、web index/vite config、实际tsconfig引用链、Vite会读取的.env/.env.local/.env.production/.env.production.local。env值只hash、不在日志/报告写原值。新增删除/保mtime内容变都stale；必需文件缺失/读取错误/危险symlink failstale。
成功build前后指纹一致且dist/index.html、sw.js、shell-assets.json存在，清单全部路径安全/资源存在，sw.js内生成尾注清单与JSON一致，才原子写ignored dist provenance；旧dist无provenance需重建。避免把旧构建输入metadata留下导致失败后错用。输入在build中改变时本次不能标fresh并且不能继续宣称最新启动；可要求重跑或受控重建一次再失败。生产已有服务早return须提示其构建来源无法确认/可能旧，不能杀未知进程，也不能依据本地dist为既有进程背书。
node:test临时repo夹具覆盖public/头像/tools/lock/env/tsconfig改、新增删除、保mtime、构建失败/中途改变/缺资源清单、不安全路径。可导出helper测试，launchCLI保持。


报告docs/superpowers/plans/2026-10-03-desktop-report.md，具体red/green命令与边界。B06不属此批，不改public/sw.js。
