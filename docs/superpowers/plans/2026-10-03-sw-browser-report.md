# B06 真 ServiceWorker 浏览器夹具

实施者交付时状态：**prepared, not run**，只准备隔离夹具、用例、runner 和报告。root 于 2026-10-08 实际运行后，当前状态为：**Edge 六项 6/6 通过**。该证据覆盖本机 Edge 中的真实 ServiceWorker、CacheStorage 与 WorkerNavigator locks，以及 loopback fixtures；没有使用 production dist 的 SW shell，也不代表 App BYOK 已验收。

## 运行范围

- `apps/web/tests/sw/fixture-host.mjs`：每个用例自有 `127.0.0.1` 随机端口 HTTP server，固定 A/B/C HTML、manifest、完整 eager/lazy JS 模块图、CSS、SVG 图像（稳定 `.png`/`.webp` URL，真实 `image/svg+xml` MIME）。不使用生产 dist、真实账户、上游或应用 session。SW 是每个用例启动时读取的真实 `apps/web/public/sw.js` 字节快照；部署切换和 query 注册更新始终返回相同快照。
- `apps/web/tests/sw/fixture.ts`：Playwright 每个用例的新非持久 context、真正 `navigator.serviceWorker.register`/ServiceWorker 事件/CDP 生命周期、真实 CacheStorage 和 WorkerNavigator Web Locks。使用现有隔离 Playwright 依赖和本机 Edge，`SW_BROWSER_CHANNEL` 可选择已安装 Chromium channel，不安装浏览器或新依赖。
- `apps/web/tests/browser/sw-lifecycle.browser.ts`：六个真实浏览器行为用例。VM `tools/desktop/sw-lifecycle.test.mjs` 仍属 VM 行为模拟，不能当作真浏览器证据。
- `apps/web/tests/sw-playwright.config.ts`：单 worker、零 retry、允许 ServiceWorker、关闭 trace/HAR/video/screenshots、关闭 Chromium 常见背景联网开关。固定资源和 server CSP 仅允许同源；context route 默认拒绝并记录外域请求，结束要求外域记录为空。没有真实网络服务调用，也不使用用户浏览器 profile。
- `apps/web/tests/sw-run-browser.mjs`：仅启动自有 Playwright child，限制六分钟总时长，终止等待有界。server、屏障和 CDP session 由用例 finally 释放；关闭该用例自有 context 后再关闭 loopback server。不修改 Windows 系统设置，不终止其它进程。

## 已准备覆盖

1. 安装 A 后保留 A tab；用 CDP **只停止本 context 随机 origin 下实际观察到的 active worker version**，等待真实 stopped 生命周期；受控网络导航 B 重新启动同字节 worker。lazy B staging 下载屏障释放前 pointer 保 A，完成后 pointer B/previous A，SHA-256 和 controller URL 不变。真正断网后新 tab 启动 B，首次动态 import B lazy 与依赖成功，旧 A tab 首次 import A lazy 与依赖仍成功；manifest 和稳定 public icon 是 B。
2. C HTML + 不变 A modulelist 经同样真实停启和受控导航发布，离线 C HTML/icon 更新且 A lazy 可用。
3. B lazy staging 真实 503 后 pointer 保 A、断网仍启动 A+lazy；解除失败后下一受控导航可发布 B。
4. 首次运行时加载 portrait A 实际进入独立 CacheStorage；失败更新保 A、shell 换 B 保留头像，成功更新后断网读取 portrait B。
5. 旧 worker 持原生 publication Web Lock，server 暂停其 index fetch；同字节 `sw.js?generation=two` 创建真正第二 ServiceWorker，新 worker 的安装处于原生 lock pending。实际记录 WorkerNavigator 能力、断言 held=1/pending=1 和 pointer 未提前提交。部署 B 后释放旧 A index 时混版 staging 被拒绝，新 worker随后发布 B。
6. 旧 worker 网络导航已捕获 A response，但尚未开始 refresh；新 query worker 安装并发布 B，再释放旧 A 导航 response，检查旧 response 正常返回 A、最终 pointer 仍为完整 B、断网 B 可启动，旧 tab lazy A 可用。后台 staging 必须在锁内重新抓当前 B index，不能复用旧 navigation response。

没有固定 sleep：等待注册/activation、CDP runningStatus、server 屏障、真实锁 held/pending 和 CacheStorage 内容。Playwright 条件轮询的 deadline 是失败边界，不是部署时序假设。

## 明确限制与总测前复核

- 成功 refresh 的 30 秒节流避免靠硬等待：上述导航 case 通过真实终止并重新启动同一 worker 清空其内存状态。**这些 case 不证明无需重启的 30 秒内更新**；同 worker 的节流/去重由既有 VM 行为用例覆盖，真实常驻 worker 超过节流间隔的刷新留未来补验。
- 真浏览器仅注入 HTTP/network staging 失败，不声称覆盖浏览器配额、Cache put 或 pointer put 故障；这些故障仍由 VM 可控夹具准备覆盖。
- WorkerNavigator 能力由实际 ServiceWorker target evaluate 获取并打印；本次日志为 `WorkerNavigator [object WorkerNavigator]`, `locks:true`, `cacheStorage:true`。运行 channel 为 `msedge`；日志没有记录可核实的精确 Edge 版本，因此本报告不填版本号。
- 跨 worker query case 的目标是实际并发 install/refresh 与互斥；query URL 提供第二个真实版本，SW 产品源码字节没有改写。
- 结束条件基于锁和真实缓存；所有成功结论仅能在 root 运行后的证据中更新，不能以源码阅读代替运行。
- 最终 SW 与 fixture 公共声明已在本次浏览器运行中使用：`dramatis-shell-control-v1`、`/__dramatis/active-shell`、pointer `{ active, previous }`、`dramatis-shell-generation-v1-`、`dramatis-images-v1`、锁 `dramatis-shell-publish-v1`。

## root 实际运行结果（2026-10-08）

`logs/sw-browser-final.log` 记录 channel `msedge`，六项 **6/6 通过**。首轮为4/6，图片和迟到导航两个夹具等待环超时；修复只调整屏障顺序，没有放宽断言。修复后两例2/2通过，随后完整六项复跑6/6：

- 同字节 controlled B、offline B 与旧/新 lazy 模块可用；稳定 modulelist HTML 和 public icon 更新。
- staging HTTP 503 时保留 A，解除失败后重试发布 B。
- 独立头像更新失败保留旧图，成功后更新为 B。
- 两个 actual worker 的原生锁状态为 held/pending；旧 worker 使用已捕获的 A 导航响应时，新 worker 发布的 B 不被反转。

错误的 fixture 等待环已收敛为：图片用实际锁任务完成屏障；迟到导航先等 B 发布，再释放旧 response，之后等待 install。没有放宽产品或夹具断言。此结果仍是实际 `sw.js` 字节加 loopback fixtures 的浏览器证据，不是 production dist SW shell 或 App BYOK 验收；配额/pointer 故障只由 VM 夹具覆盖。

## 中央运行命令（root 已执行）

在 root 多功能改动全部完成后，从 repo 根运行，需既有 `apps/web/tests/node_modules/@playwright/test` 可用且本机 Edge 已安装：

```powershell
$env:SW_BROWSER_CANDIDATE = '1'
node apps/web/tests/sw-run-browser.mjs
```

可选：`--grep 'same actual worker bytes'` 只选主 case；`--headed` 使用自有临时浏览器窗口。默认 headless、无 profile/trace/HAR/video/screenshots。无需 build、Vite 或生产 API。

root 已执行上述命令。最终日志 `logs/sw-browser-final.log` 记录六项 6/6 与实际 WorkerNavigator 能力；未记录精确 Edge 版本。此前首轮4/6超时及屏障修复也已如实记录。此运行没有证实同一 worker 不重启、超过30秒后的刷新行为；成功刷新30秒节流仍依赖既有 VM 行为用例。无 Web Locks 平台仍不建立首次离线壳；真实浏览器停止自有 observed worker 以清除30秒节流，因此不能据此宣称不重启的30秒后刷新已验证。

## 2026-10-09 常驻路径补验

root另用ignored独立用例复用本fixture，保持同一native worker真实事件存活：437 ms内导航不staging，31,020 ms后导航发布public-only C（模块仍A），worker timeOrigin/target/CDP生命周期交叉核对无重启，离线C+lazy A通过。新增1/1、退出0；未重跑上述六项或改产品SW。最初ESM启动错误与 `Sec-Fetch-Dest` 屏障错误均保留，后者是新夹具错误；[完整补验记录](./2026-10-09-b06-standing-worker-report.md)。完整Android离线/系统回收仍待真机，事件保活不能代表后台自主常驻。
