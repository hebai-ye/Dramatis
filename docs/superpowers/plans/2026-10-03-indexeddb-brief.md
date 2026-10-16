# D01 独立验证基础设施

Q7已批准fake-indexeddb、@playwright/test与浏览器安装/测试路径。本批与桥接并行，仅隔离验证基础设施，不能改产品代码；用户确定性生产修复仍按指定顺序。无子代理/无提交push，不读Key/既有profile，不发外部模型请求。

独占apps/web/tests/**（含独立package.json+pnpm-workspace.yaml+pnpm-lock.yaml+node_modules）、本报告docs/superpowers/plans/2026-10-03-indexeddb-report.md。不改web/package.json、src、root清单/锁、vite.config、任何core或后台工具。主控制器后续补web测试脚本/其它UI测试。

## 依赖与运行

用独立workspace包安装两依赖，root lock必须byte不变。Root既有Vitest/Vite可通过node cli调用，tests/indexeddb.test.ts由既有web Vitest针对执行；browser specs命名*.browser.ts与独立Playwright config testMatch，不让Vitest扫描。Node24.16/pnpm11.22环境，pnpm命令可能宿主shim；npm/pnpm独立目录安装不要回写根。先检查项目可用依赖，不另装root。不确定时report。
Chromium可以用系统Edge/Chrome channel，始终新非持久context，禁止连接既有profile；若需官方浏览器下载，PLAYWRIGHT_BROWSERS_PATH放tests/node_modules/.cache/（忽略路径），用户已批下载，网络/文件沙箱阻挡报root处理。不要读取用户data。测试源127.0.0.1:6273 --strictPort（独立源），run Vite测试page `/tests/browser/idb-harness.html`，不打开现world-seed-probe/当前应用账户。

## 真实db接口

导出createIndexedDbEntityStore(databaseName)返回{store,db}可直接测试。harness唯一API限制^q7-test-[a-zA-Z0-9_-]+$，随机每用例库名，只关闭/删除本测试创建的库，不遍历/删除其它数据库，不初始化App。
Schema v2 entities keyPath[collection,id]，索引byCollection、byCollectionRoom=[collection,value.roomId]、byCollectionUpdated=[collection,value.updatedAt]。

## fake行为层

先写验证行为（已有生产实现可能直接green，不能故意造red并改生产），记现状缺陷。覆盖跨集合tx提交、throw回滚，重复key更新/structuredClone（写后源对象改不影响值），listSince inclusive与roomId compoundindex/filter，v1→v2升级保旧row/新索引，blocked：保持v1native连接无auto-close→productioncreate派发DB_CONNECTION_EVENT detail=blocked且pending→关旧连接成功；blocking：productionv2→nativev3应主动关闭production并派发blocking让v3成功。Nodefake只最小window/CustomEvent必要stub；fake不当真实引擎。

## 真Chromium双页层

同源2pages升级blocked/关连接后成功；productionversionchange自动关连接；delete blocked明确reject但底层native删除request仍会等，关闭持库后清理不能假定拒绝等于取消；tx rollback/structuredclone/compoundkey索引；页面关闭重开持久化。每条独立random库，finally所有handles close，失败确保清理范围。不能靠setTimeout睡等，只等明确事件/受控promise，测试runner有合理timeout防挂。
若worker tx.done通知/跨标签逻辑时钟与CAS需要部分一新增接口，在report逐项说明依赖；不要用fake实现声称生产已验证。

## 验证/报告

每文件包含行为有意义，不源码grep，不镜像低影响函数。实际运行fake目标test+浏览器suite，记录版本/browserbinary/来源/隔离端口/测试数/失败/跳过；没有真正启动browser不能写真通过。Biome node rootcli check本新增TS/JS/JSON文件，禁全仓自动fix；rootlock SHA前后核对。完成report返回DONE/CONCERNS与命令结果，root随后独立review，本报告不改其它TASKS/STATUS/EVAL/FILELOG。
