# D01 运行器中断与升级终止补验（2026-10-11）

结论：补齐本组此前缺少的 **SIGINT 中断及三秒升级退出分支运行证据**。真实 Windows/Edge 隔离探针收到终端 Ctrl+C 后，现有运行器执行自有子进程清理；受控 Vite 首次终止信号传输失败后，运行器在 3002 ms 后升级为 SIGKILL。两次正式观察结束时，记录到的自有进程身份均已消失，6273 无监听。D01 的 worker 通知/跨标签 CAS 仍归部分一，整项不关闭。

## 实际对象与隔离

root 运行已有 `apps/web/tests/run-browser.mjs`，没有改运行器、生产源码或依赖；其 SHA256 为 `cb1d5a18854b40f819846c25bede73330fc96e66a2c7a69c1b86191f9425635e`。Vite 固定 `127.0.0.1:6273 --strictPort`；实际 Playwright CLI 使用临时 config，启动非持久 Edge context。页面只访问 `/tests/browser/idb-harness.html`，确认 `window.q7.open` 可用后保持等待，未创建测试数据库、加载真实账户或输入 Key。HTTP 仅放行该本地 origin，WebSocket 关闭。

临时 preload/config/spec 和事件/进程快照全部在 ignored `logs/`。preload 只观察现有运行器的直接子进程，升级分支另做下述明确注入；无系统级进程名终止或用户浏览器清理。子任务只静态复核，所有实际运行和清理核对由 root 集中执行。

## 两条正式观察

| 路径 | 运行证据 | 清理核对 |
| --- | --- | --- |
| 原生 Ctrl+C | Node 43692，Vite 18596，Playwright 15652；测试输出确认 q7 API ready。UTC 03:15:33.940 收到 SIGINT，随后执行 Playwright/Vite 的 SIGTERM 清理；33.970 运行器记录退出码 130 | 中断前记录 13 个自有进程（含 9 个 Edge），按 PID 与创建时间核对，残留 0；6273 监听 0 |
| 三秒升级 | Node 32432，Vite 39308，Playwright 32696；q7 API ready。UTC 03:16:05.985 收到 SIGINT；Playwright 正常结束。06.005 注入丢弃 Vite 首次 SIGTERM，09.007 运行器实际发出 SIGKILL（3002 ms），09.026 Vite 退出，09.028 运行器记录退出码 130 | 同样记录 13 个自有进程（含 9 个 Edge），退出后身份残留 0；6273 监听 0 |

第二条 preload 仅把自己启动的 Vite 放入独立控制台并隐藏窗口，避免 Ctrl+C 提前结束它，然后单次丢弃 `child.kill('SIGTERM')` 的实际传输。之后 SIGKILL 使用原生 child handle，并由真实子进程退出事件确认。此结果是**受控信号传输故障注入**，不能描述为 Windows 原生 Vite 忽略 SIGTERM、操作系统挂死或浏览器自行恢复。

终端通过自有 PTY 的 Ctrl+C 字符触发，不用 Windows `child.kill('SIGINT')` 代替。两次外层 PowerShell/tool 均返回 1；父 Node 的退出事件记录为 130。分别保留两个层次的状态，不把 tool 的 1 改写成 130，也不把它当作 IDB 断言失败。这是故意中断的生命周期探针，没有“新测试用例通过 2/2”的计数。

## 初轮探针修正与边界

初轮使用空 harness 的 `body visible` 判断就绪；页面没有可见正文，因此这个判断不适用。该轮实际中断清理也发生，但不纳入上表的两条正式证据。探针随后改为现有 q7 API 就绪，没有修改产品或放宽 IDB 行为断言；正式结果来自修正后的 normal/force-vite 两次观察。

本次不覆盖父进程 SIGTERM、Playwright/Edge 的 SIGKILL 升级、启动期中断、重复信号或 OS 故障等全部退出路径；也不替代 IndexedDB 行为、worker 通知、跨标签 CAS、持久账户或 Android 验收。已有 Fake6/Edge6 及其他稳定门禁未重跑。

主要 ignored 证据：`logs/d01-runner-exit-{normal,force-vite}.jsonl`、两组 `*-owned.json` 与 `*-cleanup.json`；浏览器 API ready 输出保留在本轮工具记录中，不在父 Node JSONL 内。预加载文件 SHA256 为 `4927c9f2387dbc88550e74a190dd1a3ff0f4471b1d5fc54c8d626dd56c82a946`。独立 Luna 静态复核确认仅上述窄缺口可关闭。

本轮没有真实模型调用、服务器操作、提交、push 或部署。当前余项仍按 [5组外部真实验收与7组部分一交接](./2026-10-10-task-status-ui-preanalysis.md)分别记账。

## 同日接续重核

用户再次指定在本对话继续这1个验证缺口后，root只读重核：当前runner SHA与上述实演版本相同；两组原始事件的父SIGINT/退出130及Vite升级PID对应一致，升级间隔仍为3002 ms；清理快照均为0残留/0监听。按原PID与创建时间查询当前进程，两组原有13个自有进程身份都已消失，当前6273无监听。静态复核确认无需重复未改动门禁；此轮没有重新运行浏览器或退出探针。

修正EVAL的10-08历史矩阵行，明确“当时未实测、10-11已补验”并链接本报告，不改变历史门禁数字。此前这1个本组窄缺口已关闭；5组真实验收、7组部分一交接仍未关闭，UI新对话另行推进。
