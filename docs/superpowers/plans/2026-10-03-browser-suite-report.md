# Browser suite runner 静态整合报告

2026-10-08 接续核对：前一轮已经落盘的修复保留，没有重写或回退。按用户最新限制，本轮仅实现与静态源码审阅，未运行 test、typecheck、lint、build、smoke，也未运行语法检查或行为 probe。以下不是运行通过结论。

## 核对与实现

- `playwright.config.ts` 已严格选择 `**/indexeddb.browser.ts`，保留 6273 IndexedDB 单独 suite；没有再次修改已正确的匹配。UI / CSP 仍各用专用 config 和 6287 / 6289 端口。
- 前一轮已在三个 runner 增加自有 Playwright（以及 IDB / UI 自有 Vite）的清理：仅操作本进程 `spawn` 返回的 child，TERM 后最多等待 3 秒，未观察到真实退出再 KILL、最多等待 2 秒。以 `exitCode` / `signalCode` 或 `exit` 事件证明退出，不以 `child.killed` 证明。UI 已会等待 Playwright child，CSP 已取消仅 TERM 后无限等待退出的逻辑。
- 本轮 IDB / UI 补上 Vite startup timer 和 readiness listener 的清理：就绪、超时、失败和中断路径都会取消。否则中断后的 30 秒启动计时器会继续占用事件循环。
- 本轮 IDB / UI 将自有 Vite 的 error / exit 放入启动与测试期间的 race；Vite 在就绪后意外退出，也会结束 runner 等待并进入清理。stdout / stderr 转发独立于 readiness 观察，移除观察监听不会停止日志。
- 三个 runner 的 TERM / KILL 发送异常会记录后继续有界等待与后续清理；反复 SIGINT / SIGTERM 仍进入同一中断逻辑，避免第二次信号恢复默认退出而跳过清理。清理正常时 SIGINT / SIGTERM 分别设置 130 / 143；清理失败设置 1；正常 runner 失败码原样保留。
- CSP host close 先正常 close，3 秒后仅关闭该 host 的连接，再最多等 2 秒真实 close callback。临时账本只来自本次 `mkdtemp` 返回路径，只有 runner 和 host 均确认关闭后才删除；删除失败记录并返回失败。若清理不能确认，保留自己的临时目录供 root 排查，避免删除仍在使用的账本。
- 未新增依赖、未改变全局环境、未终止其它进程、未访问用户 profile / Key / 真实 API。未提交或推送。本轮未新增行为 probe 文件。

## 待 root 集中执行

以下命令仅供最终候选的集中验证，本轮全部未执行：

```powershell
node apps/web/tests/run-browser.mjs --list
node apps/web/tests/run-browser.mjs --reporter=list
node apps/web/tests/run-browser.mjs browser/no-such.browser.ts --reporter=list
node apps/web/tests/ui-run-browser.mjs --reporter=list
# root 先刷新并确认最终生产 dist，然后仅为本次命令设置已有新鲜候选标志：
$env:CSP_FRESH_CANDIDATE = '1'
node apps/web/tests/csp-run-browser.mjs --reporter=list
```

第一项应只列 IndexedDB；第三项应退出 1 且关闭自己启动的 Vite。正常 / 无测试 / 启动端口占用 / runner 启动失败 / startup 和测试期间 SIGINT、SIGTERM / Vite 意外退出 / TERM 升级 KILL 的行为都仍需 root 验证。任何端口占用用例必须以 root 自己创建的可回收 listener 准备，不可终止现有端口占用者。

## 限制

root随后按Windows删除约束加强CSP路径核验：创建前核对csp目录的realpath仍在workspace，local的realpath仍在csp内；本次mkdtemp在已验证的真实local路径下创建。删除前重新解析local/temp，要求local未重定向、temp是同一个真实直接子目录且名为fake-run-*，拒绝root相等、越界与symlink重定向。仅在自有runner/host均实际关闭后递归删除，异常保留并报错；local仍合法而目标缺失可视已清理。此补充尚待root集中运行，不继承此前静态PASS为运行证据。

自有进程的信号等待有明确上限；若 OS 拒绝终止或进程在 KILL 后仍未退出，runner 会记录失败，不能声称进程已结束，也不会强制退出主进程来掩盖遗留 child。相同限制适用于 host 未回调关闭；临时账本会保留。没有进程树枚举或杀其它 PID，Playwright 启动浏览器后的子孙进程回收仍依赖 Playwright / OS，当前没有新增运行证据。此前 UI / IndexedDB 报告的历史 green 不证明本轮 lifecycle 改动通过；CSP 仍是待最终候选执行的准备状态。
