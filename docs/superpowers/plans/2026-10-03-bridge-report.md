# B01 / B02 本地桥接实施报告（2026-10-03）

状态：**DONE（代码与 fixture 验证）；CONCERNS（真实 DeepSeek 对话页未验证）**。本批只修改 `tools/local-bridge/**` 与本报告；未提交、推送、读取浏览器凭据、使用既有浏览器 profile 或发起真实模型请求。

## 结果

- B01：`site-adapter.mjs` 提供 `readSnapshot(call)` 严格语义契约。发送前读取基线并确认页面未生成；观察本次 prompt 对应的新 user 身份，再等待其后的新 assistant 身份。正文非空、明确终态、`generating=false` 后还需稳定三轮。旧消息、重复正文、身份复用/消失、列表截断、思考区混入和状态缺失均无法被当成成功。未知网页在点击前失败并提示“自动识别未验证，请使用手动回填”。`--pattern` 仅选择标签，不代表网页兼容。
- B02：队列期限从入队计起，覆盖目标 fetch、WebSocket 握手、CDP 命令和轮询；单命令上限取剩余期限和 15 秒的较小值。排队超时会移除任务且不执行。CDP 的错误、发送异常、断线、取消、超时都清理 pending、计时器和监听器，晚到响应被忽略。客户端响应未完成即断开会取消任务；队列在实际工作结束后才释放名额。首次写入输入框的命令发出后如无法确认结果，同一 target ID 的后续 `/ask` 会拒绝，直到关闭旧标签并打开新独立标签；不会自动重发。`/health` 目标发现限时 5 秒，并提示不确定目标的恢复办法。
- 访问控制、429、413 与成功时 `200 {"text": ...}` 的服务协议保持。README 已写明兼容契约、期限范围和恢复路径。

## 首轮 Red / Green 证据（review 前）

1. 初始 `node --test tools/local-bridge/bridge.test.mjs` 为 **1 fail**：新 `site-adapter.mjs` 尚不存在，模块加载失败。随后添加严格快照和传输实现。
2. 增加“新 user 身份匹配后正文不得变化”行为测试时，同命令为 **12 tests / 11 pass / 1 fail**，失败为 `Missing expected exception`；补上新 user 身份正文冻结后转绿。
3. 注入 fake fetch 的期限测试首次运行时，因 `fetchTargets` 尚未导出而报 `does not provide an export named 'fetchTargets'`；抽出目标发现 helper 后转绿。
4. 首轮结束时 `node --test tools/local-bridge/*.test.mjs`：**30 tests / 30 pass / 0 fail**，包括原 `policy.test.mjs`。`node --check` 对 server、policy、session、site-adapter、transport、bridge.test 六个文件通过。`node_modules/.bin/biome check` 对本批 7 个 `.mjs` 直接路径检查通过：`Checked 7 files ... No fixes applied.`

## Fix1 review 修复（已关闭）

- **目标锁**：未确认 ID 改为集合；A→B→A 仍拒绝 A，B 再失败也不会解锁 A。成功清锁移到 `withCdp` 真正结束关闭之后，关闭失败会保留锁。完整 `runPageAsk` 测试覆盖点击命令发出后确认丢失；`runTargetAsk` 测试覆盖异步关闭前后锁状态。
- **回复归属**：本轮新消息只允许一条匹配 prompt 的 user，后面至多一条 assistant。另一个 user、重复 prompt 或其他交错消息直接报归属歧义，避免跨轮串回复。
- **CDP 关闭**：`withCdp` 等实际 close 事件才返回；关闭卡住时在有界时间内尝试 `terminate()`，无法确认则报错并让已点击目标维持不确定。队列测试带一条已发出的 CDP 命令，确认下一任务只在异步关闭后开始。双 pending 命令、计时器、监听器和晚响应均有断言；单命令 12ms 上限单独测过。
- **期限与契约测试**：仅给 `deadline` 的队列任务自动使用 `deadline.signal`。`waitForReply` 在虚拟时间里经历 6 秒不变但仍生成的文本，随后明确终态稳定三轮才通过。思考区测试执行真实 `readSnapshot` 表达式的 VM DOM fixture，而非直接预置 unsupported 对象。

Fix1 的行为 red：`node --test tools/local-bridge/bridge.test.mjs` 初次为 **18 tests / 14 pass / 4 fail**，分别暴露归属交错、仅传 deadline 排队不及时移除、A 锁被 B 清除；异步 close 用例首次还有测试 open 事件发送时序错误，修正 fixture 后实施等待 close。另一个明确 red：`node --test --test-name-pattern="keeps a completed page reply" tools/local-bridge/bridge.test.mjs` 为 **1 fail**（`false !== true`，页面回复完成即过早清锁）。这些是本轮修复证据；模块缺失的 red 仅说明接口尚未建立，不作为行为证明。

Fix1 green：`node --test tools/local-bridge/bridge.test.mjs tools/local-bridge/policy.test.mjs` 为 **41 tests / 41 pass / 0 fail**；七个修改/新增 `.mjs` 文件 `node --check` 通过；`node_modules/.bin/biome check` 对八个本批 `.mjs` 直接路径为 `Checked 8 files ... No fixes applied.`

## Fix2 review 修复（已关闭）

- 默认 CDP socket 改由助手自己启动的独立 Node 子进程持有原生 WebSocket。父进程通过 IPC 实现 `open/message/error/close`、`send` 和 `readyState`；不访问浏览器 profile、不开全局进程操作，也不记录提示词。父进程断开时子进程退出。正常关闭等待子进程的真实 `close`；超过 1.5 秒则只 `kill` 自己的子进程，并等待 child `close` 事件确认。若测试注入的 socket 没有终止能力且永不关闭，队列持续持有 lease，不会假装清理完成。强制终止作为失败返回，目标维持不确定状态。
- 锁定时点前移到首次会修改输入框的 CDP 命令发出之前。输入已发但点击尚未发出时如确认丢失，也维持该目标锁；只有页面成功回复且实际传输清理完成后才清锁。无自动重发。
- 实际子进程 fixture 故意忽略优雅关闭：测试确认关闭等待中下一任务不启动，超时后仅终止该子进程并等真实退出，再释放队列。其余 fixture 覆盖无 `terminate` 且不关闭、输入已发但未点击两个失效边界。

Fix2 red：`node --test --test-name-pattern="composer mutation|cannot terminate" tools/local-bridge/bridge.test.mjs` 为 **2 tests / 0 pass / 2 fail**，分别是输入写入后目标仍可重试、无终止能力且永不关闭时过早释放 lease。修复后同命令 **2/2 pass**。

Fix2 green：`node --test tools/local-bridge/bridge.test.mjs tools/local-bridge/policy.test.mjs` 为 **44 tests / 44 pass / 0 fail**；十个本批 `.mjs` 文件 `node --check` 通过；`node_modules/.bin/biome check` 十一个直接路径结果为 `Checked 11 files ... No fixes applied.`。真实已登录模型站点仍属外部待验，fixture 结果不能证明其 DOM 兼容或真实发送成功。

## 尚待真实验收

只读查看真实站点时落在登录页并提示登录信息失效，尚无已登录对话 DOM 证据。本批没有猜测 DeepSeek 的选择器；内建 `data-local-bridge-*` 是严格 fixture 契约，**不能据此声称真实 DeepSeek 自动发送可用**。真实页面的角色、稳定 ID、正文/思考分离和明确终态必须在用户自己的独立调试标签中验收后才能配置适配器。由于没有真实对话页，本批也没有执行真实 CDP 发送或验证真实站点的 `200 {text}` 端到端路径；当前应使用手动回填。D08/Android 真机验证仍由用户后续处理。
## 2026-10-05 root补充原生传输运行证据

`node logs/bridge-native-runtime.mjs`（ignored探针，受控loopback服务器，无凭据/模型/网页发送）退出0。默认ProcessSocket实际启动ws-worker，原生WebSocket握手、IPC命令/回复及正常关闭通过；直接启动实际worker后父IPC断开，worker实际exit0；服务器收到close但不回复ack时，ProcessSocket.terminate等待实际子进程关闭后settle通过。

首次探针等待父主动IPC断开后的Node `close`事件超时，诊断证据显示该worker已exit0；改以实际`exit`事件验证父断开退出语义后通过，没有修改桥接实现。此补验不等于真实DeepSeek DOM或端到端桥接验收，未知站点仍在输入前拒绝。
