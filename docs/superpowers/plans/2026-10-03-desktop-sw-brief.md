# B03 / B06 实施要求

允许tools/desktop/**、apps/web/public/sw.js和报告。禁止改web tools（109清单已完成）、main.tsx、根锁/清单及任何其他禁区；不提交/push，不spawn子代理。保持已有shell-assets.json生成/上版懒模块保留逻辑目标，不重做分包。

## B03 桌面构建新鲜度

新build-inputs.mjs按规范化相对路径+文件内容sha256+模式/Node/Vite版本/相关构建环境合成fingerprint。目录web/src,public,tools与core/src，显式root/web/core package.json、root lock/workspace、web index/vite config、实际tsconfig引用链、Vite会读取的.env/.env.local/.env.production/.env.production.local。env值只hash、不在日志/报告写原值。新增删除/保mtime内容变都stale；必需文件缺失/读取错误/危险symlink failstale。
成功build前后指纹一致且dist/index.html、sw.js、shell-assets.json存在，清单全部路径安全/资源存在，sw.js内生成尾注清单与JSON一致，才原子写ignored dist provenance；旧dist无provenance需重建。避免把旧构建输入metadata留下导致失败后错用。输入在build中改变时本次不能标fresh并且不能继续宣称最新启动；可要求重跑或受控重建一次再失败。生产已有服务早return须提示其构建来源无法确认/可能旧，不能杀未知进程，也不能依据本地dist为既有进程背书。
node:test临时repo夹具覆盖public/头像/tools/lock/env/tsconfig改、新增删除、保mtime、构建失败/中途改变/缺资源清单、不安全路径。可导出helper测试，launchCLI保持。

## B06 SW同字节刷新

用户Q6A：只改public worker。成功同源受控navigation event同步注册waitUntil，再异步后台refresh；网络导航响应仍原样返回，offline/HTTP错误不刷新。不force reload当前页面。刷新去重、合理节流，失败保留当前离线外壳，下一导航可重试。
为防cache.addAll成功后manifest写入失败导致状态混杂，接受generation shell cache+单一active pointer提交的内部改动；全部最新index/modules/manifest/static下载验证且上一代modules迁入新generation成功，再单写pointer发布。失败/任意中断不得切pointer/清旧shell。保留上一代所有懒模块供oldtab；后台刷新不能删旧tab需要的上一代。只清本应用不再引用的generation；runtime portraits/brand独立缓存并从老v5迁入，绝不能每次清外壳时删头像。稳定头像路径通过no-store后台更新，成功且basic/image可替换，失败保留原图。版本迁移已有v5离线外壳可fallback，不丢已有缓存。
active pointer/清理都是CacheAPI操作，不冒充跨cache事务；单pointerput是发布点，只有发布后清理旧代，清理失败不影响active。并发refresh共用promise。导航waitUntil同步接续promise，不能晚异步调用。缓存white list/sync/api/跨域模型POST pass、ignoreVary修复保留。
先行为red测试（VM执行真实worker+内存Cache mock，非源码grep），tests放tools/desktop/sw-lifecycle.test.mjs以保持路径边界。既有apps/web/src/lib/sw.test.ts若依赖源码策略需要相关测试检查兼容，不能修改该禁区测试；使worker保留公共策略函数签名。
关键case：same worker bytes A→B HTML/manifest受控导航→offline B；modulelist未变时稳定public更新；staging各阶段失败/配额/指针写失败current A保留；oldtab lazy A；runtime头像刷新失败保旧成功新；重复nav只一刷新；非GET跨域/sync/api不缓存。真实ChromiumPWA测试由D01后补，不称VM真浏览器。

报告docs/superpowers/plans/2026-10-03-desktop-sw-report.md，具体red/green命令、资源安全/迁移策略、关注点；node tests+现web SW策略测试即可，不重跑全仓。
