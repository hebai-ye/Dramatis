# B06 同一真实worker跨30秒节流补验

状态：root实际Edge隔离验收 **1/1通过，退出0**。既有六项浏览器门禁、VM与策略测试没有重跑；本轮不改产品SW、现有测试/fixture或依赖，不提交、push或部署。

## 实测结果

| 检查 | 结果 |
| --- | --- |
| 原生能力 | `[object WorkerNavigator]`，Web Locks和CacheStorage可用 |
| 窗口内导航 | 成功refresh后437 ms完成真实受控导航；发布pointer仍为A、staging清单请求新增0 |
| 窗口后导航 | 成功refresh后31,020 ms触发真实导航；`/index.html`的SW staging请求命中屏障，完整发布C，staging清单请求新增1 |
| worker身份 | 前/跨窗/后 `performance.timeOrigin`相同；原target没有close，target数始终1；相应CDP版本无stopping/stopped记录，仍running |
| 外壳取舍 | SW字节和A模块清单都不变，只更换C HTML/manifest/稳定图标；新pointer的previous是原A |
| 离线读取 | 新页启动C，C manifest/图标可读，首次动态import仍为lazy A及dependency A |
| 运行 | 单例32.1秒、runner总计33.3秒；channel为msedge，未记录精确Edge版本 |

实际SW源码快照SHA-256：`066e73606840ae32b3461240307ee5a4e29183b6c98c3fc96a4290a87005b4d7`。host直接读取 `apps/web/public/sw.js`，不使用production dist，不能据此声称生产dist新鲜。

## 方法与隔离

专用用例和配置在ignored `logs/b06-standing-worker.spec.ts` / `b06-standing-worker.config.ts`，复用现有 `apps/web/tests/sw/fixture.ts` 和fixture-host。运行使用现有Playwright、非持久Edge context与自有随机回环源，不使用用户profile、账户、Key或模型请求；trace/HAR/video/screenshots关闭，外域请求拒绝，fixture收尾检查外域记录为空。

先让portrait A真实进入独立图片缓存，再用host屏障挂起其网络重验证，依靠实际fetch事件的 `waitUntil` 保持worker存活。真实墙钟等待超过30秒；不停止/重启/重新注册worker，不调用registration.update，不改时钟或生产状态。只读采样 `lastRefresh` 用于计时，行为断言仍依据网络请求、发布pointer和离线内容；另用启动时间、target及CDP事件交叉核对执行实例。

晚窗staging屏障接手保活后先释放图片，再释放staging，避免未来图片迁移锁形成等待。两个屏障均有10秒失败边界；用例75秒、runner100秒截止，finally释放屏障/CDP/context/自有host。

```powershell
& 'D:\Work\Node\node.exe' 'apps/web/tests/node_modules/@playwright/test/cli.js' test --config 'logs/b06-standing-worker.config.ts'
```

本地最终日志：ignored `logs/b06-standing-worker-20261009-run4.log`。

## 失败记录与剩余边界

最初两个启动尝试因独立配置的ESM目录/具名导入失败，没有进入用例；配置改为直接导出对象。首个实际浏览器用例在75秒超时：新屏障把真实 `Sec-Fetch-Dest: empty` 错写为空字符串，后窗已导航到C但屏障未命中。对照既有真实浏览器case修正为字面值 `empty`，增加阶段日志和有界等待，随后本例通过。没有修改SW产品逻辑或放宽断言；失败日志保留，不能把这次夹具错误归为产品缺陷。子任务只静态复核，未运行门禁。

本证据补齐“同一真实worker不重启跨30秒”的节流/刷新路径。它通过挂起真实事件保持worker存活，不能证明Android系统会让worker在后台持续存活；完整Android离线与系统回收矩阵仍待真机。浏览器配额和pointer put失败仍由VM夹具覆盖，App BYOK/CSP也不在本例范围。C05继续Report-Only、待验证（归Codex）；D02账本本例不触碰。
