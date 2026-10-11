# D01 IndexedDB 独立验证报告

2026-10-11续记：本组另补齐真实SIGINT中断清理及受控Vite首次SIGTERM传输故障后的三秒升级运行证据，进程/6273无残留，见[退出补验](./2026-10-11-d01-runner-exit-report.md)。下文DONE指独立测试设施及已列存储用例，不表示worker通知/跨标签CAS或所有运行器退出分支整体验收关闭。

状态：DONE。只新增 `apps/web/tests/**` 的独立依赖、运行器、Fake 测试和浏览器 harness，以及本报告。没有修改生产 `src`、web/root package 或根锁。

## 范围与隔离

- 独立 `apps/web/tests/pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 安装 `fake-indexeddb@6.2.5`、`@playwright/test@1.63.0`；使用既有 Web Vitest `5.0.1` 和 Vite `8.3.0`。未执行根依赖安装。
- 测试库名为每用例随机 `q7-test-${UUID}`，harness 拒绝其他名字；只关闭、删除本用例创建的库。没有初始化应用、访问真实账户、Key 或既有浏览器 profile。
- Playwright 使用本机系统 Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，版本 `154.0.4258.48`，每用例 `browser.newContext()` 创建非持久隔离 context 和两个同源 page。Vite 固定 `127.0.0.1:6273 --strictPort`，页面 `/tests/browser/idb-harness.html`。
- Browser specs 使用 `*.browser.ts` 和独立 Playwright config；Web Vitest 的目标命令只选择 `tests/indexeddb.test.ts`。

## 行为结果

`node node_modules/vitest/vitest.mjs run tests/indexeddb.test.ts`（工作目录 `apps/web`）：6/6 通过，0 失败，0 跳过。覆盖跨集合单事务提交与 throw 回滚、重复键覆盖和 structured clone、`roomId` 复合索引与 `listSince` inclusive、v1→v2 保留旧行并建索引、native v1 阻塞生产升级事件及关连接后成功、生产 v2 的 blocking 事件与自动关连接让 native v3 成功。Fake 只证明存储门面行为，不代表真实 Chromium 引擎。

`pnpm test:browser browser/indexeddb.browser.ts --reporter=list`（工作目录 `apps/web/tests`）：Edge 真浏览器 6/6 通过，退出码 0，0 失败，0 跳过。覆盖两个 page 的跨集合提交/回滚、structured clone/重复键/room 复合索引、v1 阻塞生产升级后释放、生产连接在另一 page 请求 v3 时自动关闭、native 持库时 delete blocked 明确 reject、关闭前页再在另一页重开读到持久写入，以及下文的自动提交负向用例。

Playwright 内置 `webServer` 在该 Windows 环境测试完成后无法正常结束 Vite 进程，虽然断言已通过，但 runner 无退出状态。已改为测试目录独立 `run-browser.mjs` 启动和关闭 Vite，最终完整命令以退出码 0 完成。期间诊断还以系统 Chrome channel 跑过同样 5 个断言；最终正式结果来自上述 Edge 命令。

## 检查与后续边界

- 根 `pnpm-lock.yaml` SHA256 安装前后均为 `00B46BCC55233B38C4B5E1D832E6D01D3E7EDA4BBAFDE9FE7707D44F68191795`。
- 根 Biome CLI `check` 新增的 TS/JS/JSON：6 个文件，0 错误。独立 lock 与 workspace YAML 由 pnpm 生成。
- Worker `tx.done` 之后的通知、跨标签逻辑时钟与 CAS 的端到端交互取决于部分一新增生产接口；本批没有声称验证这些行为，也没有用 Fake 代替真实多页验证。
- 正常事务测试只证明连续 IDB 请求链的提交与在尚未提交时显式 throw 的回滚。非法 callback 中插入非 IDB 等待时的结果另见下文；不能把那种失败说成事务包装器提供了整批原子回滚。

## Fix round 1：删除完成与清理保证

前版 harness 在 `onblocked` 时立即拒绝用户可见 Promise，又把它的 `catch` 结果存入 cleanup 等待表，因此 cleanup 等到的只是“已拒绝”，没有证明原生 `deleteDatabase` 请求结束。现将用户可见的 blocked Promise 与原生请求最终 `onsuccess`/`onerror` Promise 分开；cleanup 等后者，成功时数据库已经被原生请求删除，失败时明确抛错。真实 Edge 用例先断言 blocked 拒绝且原生状态仍为 `pending`，关闭另一个 page 的 native 连接后，再断言同一个原生请求变为 `success`。因此“blocked 拒绝不会取消底层删除请求”现有实际浏览器证据。

双页 helper 现把 page 创建也包在 `try` 内，清理流程外再套一层 `finally`；即使 cleanup evaluate 失败或超时，也会调用并等待 `context.close()`。两页都已关闭时会新建同一隔离 context 内的 harness page，尝试只清理本用例库名。

独立 runner 只向自己启动的 Vite/Playwright 子进程发终止信号，并有 3 秒升级、5 秒等待的上限；收到 SIGINT/SIGTERM 时也请求终止，分别保留 130/143 退出码。正常退出等待 Vite 真正结束。命令 `pnpm test:browser browser/indexeddb.browser.ts --reporter=list`：5/5 通过、退出码 0；`pnpm test:browser browser/no-such.browser.ts --reporter=list`：按预期无测试、退出码 1，runner 随即退出。修后根 Biome 对所改 3 文件检查通过。

## 真实事务自动提交负向用例

在同一 `q7-test-UUID` 库上，harness 只拦截该库的一次原生 `readwrite` 事务并监听其真实 `complete`/`abort` 事件，没有模拟事务状态。生产 `store.transaction` 回调先 `await scope.put('auto-first')`，再等待该原生事务的 `complete` 事件（这段等待不提交新的 IDB 请求），之后尝试 `await scope.put('auto-second')`。实际观察为：原生 `complete` 已发生；第二次 `scope.put` 自身拒绝，外层事务包装器也拒绝；事务作用域的 `scope.transaction` 为 `undefined`。另一同源 page 重新读取后，第一笔存在、第二笔不存在。这是原生自动提交后继续写入的失败，**不是**对第一笔的回滚。

命令 `pnpm test:browser browser/indexeddb.browser.ts --reporter=list`：6/6 通过，退出码 0；进一步只跑该用例 `pnpm test:browser browser/indexeddb.browser.ts --grep "non-IDB await" --reporter=list`：1/1 通过，退出码 0。此测试明确生产事务 callback 只能等待存储操作；跨出 IDB 请求链后，已提交的部分无法由后续异常回滚。
