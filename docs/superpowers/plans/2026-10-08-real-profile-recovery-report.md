# 4096 执行 profile 与保账恢复实现记录（2026-10-08）

状态：代码及 fixtures 已准备；子任务未执行 test、type、lint、build、smoke，未启动或关闭真实 host，未发送任何请求，未修改真实 ledger 或 lock。由 root 集中验证和独立审查后决定真实启用。不能据本报告声称恢复或后续样本已经完成。

依据：用户明确选择“4096 并保留账本继续”；范围见 `2026-10-08-real-budget-truncation-proposal.md`。官方 `deepseek-flash`、Low、总 48 次 / ¥5、质量最多 44 次并为 C05 留 4 次保持。首条 `affect-1/shared/repeat2` 的失败、次数和保守收费保留，不重发。

## 公开契约

- `createValidationHost({ maxOutputTokens: 1200 | 4096 })`：缺省 1200 兼容历史 fixtures；4096 必须显式选择。任意其它数值或类型在绑定端口和打开 journal 前拒绝。
- `GET /validation-api/status` 包含 `executionProfile = { profileId: 'deepseek-flash-low-output-4096-v1', maxOutputTokens: 4096, model: 'deepseek-flash', reasoningEffort: 'low' }`；1200 对应 `1200-v1`。另含 `executionProfileHash`（canonical SHA256）和最新可信 `checkpointHash`。损坏链的 checkpointHash 返回 null。
- 成功的 fake / real completion 都提供同源响应头 `x-validation-execution-profile`、`x-validation-max-output-tokens`、`x-validation-upstream-wire-hash`。后者是实际 upstream JSON UTF-8 bytes 的 SHA256，包含 host 固定的模型、Low、thinking、stream/include_usage 和完整后续 wire；不是历史 baseline 的 canonical hash。非成功路径尽可能保留 profile/max header。
- host 检查客户端显式 `max_tokens` 与 server profile 一致，再写实际 wire。完整 wire 的 UTF-8 byte 上界 + 实际 validated `max_tokens × 8` 用于保守预留。输出 4096 部分为 ¥0.032768，另加输入。真实派发仍须先同步写入并 fsync pending checkpoint。
- 新 entry 保存 profile、profileHash、maxOutputTokens、upstreamWireHash；不保存请求 body、Key 或私有 reasoning chain。原 entry 不补写 metadata。证据清洗只允许非秘密 `reasoningEffort: 'low'` 原样保留，仍删除 chain、Auth、Key 字段。

## 显式恢复

CLI 选择：

```text
node tools/desktop/validation-host.mjs --output-tokens=4096 --resume-truncation=1 --resume-checkpoint=<最新可信64位小写hex digest>
```

程序选项为 `recovery: { lastEntryId: 1, checkpointHash, approvedChoice: '4096-preserve-ledger' }`。不新增页面恢复 API；默认启动、普通 arm、body 中 recover 都无法恢复。CLI 严格拒绝未知/重复参数、缺失配对 checkpoint、非 4096、非 entry 1 或与 initialize 同时使用。initialize 也拒绝非空历史账本，防止追加零预算 checkpoint。

恢复须 journal 无 poison/corrupt，且完整 hashchain 的整个历史为原始 zero → pending(entry 1) → 已结算 budget-truncation。账本必须仅有首条质量请求、预算与原保守 charge 一致、无其它历史 stop/未知状态、超费、回滚或已存在 recoveryAudit。legacy 单 checkpoint 不满足完整链，不能用此例外恢复。任何后续失败继续 halted；此许可不能重复使用。

通过后克隆 state，保留所有原 entries/count/spent，只追加 recoveryAudit，记录明确选择、旧停止原因、旧 checkpoint、保留的计数费用和新 profile，fsync 新 checkpoint 后才把克隆 state 暴露为 unhalted。启动仍 locked，需要正常显式 arm。恢复后重启必须继续同 4096 profile，不能缺省降回 1200。恢复审计持久写入失败保留排他 lock，无请求可被派发。

Ruling：恢复只限本次原始首条失败，并校验完整历史，而非泛化“任何最后一次 truncation 可解锁”。这与仅批准 entry 1 的范围一致；代价是其它情形需要另行明确设计，不能重用本次许可。

## 退出与真实切换边界

新 CLI 安装 SIGINT/SIGTERM bounded shutdown handler，关闭自己持有的 server/journal，停止新增请求并 abort 活动传输。正常 settle 后关闭；超时强制断开连接，已经 fsync 的 pending reservation 仍保留并阻止下次 arm。关闭接口不提供给页面。

旧真实 host 没有上述 handler。本子任务没有关闭它，也没有读取/改写真实 lock。root 需独立核验 busy=false、端口进程归属与 lock pid，再停止自有旧 Node 并显式保留/quarantine stale lock；不能把删除旧 lock 当作成功恢复或退款。

## Fixtures 与未执行验证

新增 `validation-profile.test.mjs`：1200/4096 实际 upstream wire、三 header / SHA256、实际 reservation、Low 固定、include_usage、fsync 前 pending、无 Key/chain 落盘、任意/超限拒绝、4096 完整第二轮 wire 的预算及 hash。

新增 `validation-recovery.test.mjs`：普通 arm 不解锁；明确 checkpoint 许可追加 audit 后跨 restart 保留 entry/count/spent；后续失败再停；错误 checkpoint/id/choice/profile、pending、非 truncation、损坏 suffix、legacy、超费、历史 unknown stop/回滚、重复恢复拒绝且不追加 journal；审计写入失败保留 lock；CLI/initialize 拒绝案例。

扩展 `validation-budget.test.mjs`：4096 下 44/48/¥5 准入及非秘密 Low profile 清洗。扩展 `validation-durability.test.mjs`：自有 shutdown abort 后落盘，以及忽略 abort 的传输超时后 durable pending / restart 拒绝。该文件直接 Ledger fixture 现明确写 1200，以满足实际 max_tokens 验证。

所有验证均未执行，RED/GREEN 均无声称。上述测试须 root 集中运行，相关质量 client/protocol fixtures 与独立审查也由主任务安排。冻结 baseline/manifest、产品 core、价格、CSP/SW 均未在本子任务编辑。

## Root 首次集中 gate 反馈与修订（子任务未执行复验）

root 提供 `logs/profile-recovery-central.log`，子任务只读核对：desktop 31 cases，30 pass / 1 fail。唯一失败为 durability 的 normal shutdown SSE fixture：upstream aborted 断言已通过，`shutdown.clean` 为 false（期望 true）。不能把首次 gate 描述为全部通过。

只读追踪表明 shutdown 调用 `server.close()` 时，SSE 仍是 active response；abort 后 handler 完成 settle、res.end，连接变成 keepalive idle。Node [v22 官方源码](https://github.com/nodejs/node/blob/v22.x/lib/_http_server.js) 的 `httpServerPreClose` 只在调用 close 时 reap 当时 idle；`resOnFinish` 的 keepalive 路径不会为本服务再次 reap。最小修订是在 response finish 时，若 shuttingDown，则调用 `closeIdleConnections()` 关闭已结束请求的 idle 连接。未放宽 `clean`，仍只有 server.close 回调在 timeout 前完成才为 true，超时仍 false；未增加全连接强制关闭到正常路径。该判断与修订仍需 root 复验。

另新增 test-only `validation-profile-test-helpers.mjs`：recursive cleanup 前验证 absolute lexical target 是 tmpdir 直属 child，名称匹配指定 fixture prefix + 六位 mkdtemp suffix，lstat 是非 symlink 目录，再 realpath 验证 actual target 正好在 canonical tmpdir 的同名直属 child，最后才 rm。profile/recovery 全部新 fixture 和两条新 shutdown fixture使用该 helper；新增拒绝 temp root、非直属 child、错误 prefix、旁目录的 fixture。没有执行任何清理或测试。

## 独立 review 的 clean 条件修订（待 root 复验）

reviewer 指出客户端先断开、upstream 忽略 abort 时，server.close 回调可早于 pending handler 结束，原 clean 条件可能令 CLI exit 0。最小收紧：clean 同时要求 connection close 在 bounded timeout 前成功、busy === false、activeControllers.size === 0；客户端已经离开但 handler 仍在执行时返回 clean=false，CLI 由既有 clean 判定 exit 1。保留原 timeout 和 pending checkpoint，不假装结算完成或退款。

新增 durability 对照 fixture：等真实 host transport 被调用后先 abort 客户端，fake upstream 观察但故意忽略 abort；检查关闭前 busy/pending、shutdown clean=false 且 busy=true、durable checkpoint 不下降不改写、restart arm 拒绝，最后让延迟 fake completion 返回仍不可改写已关闭 journal。新增临时目录使用已校验 helper 的 `validation-shutdown-disconnect-` 前缀。与既有 normal abort（clean=true / busy=false）及 bounded abort-ignore（clean=false）形成对照。子任务仍未运行任何检查，未操作真实 host、账本或 root live helper。

## Root 后续集中验证与原账本恢复

两项 shutdown 修订完成后，root 运行完整 `node --test tools/desktop/validation-*.test.mjs`：40/40，退出0，包含 normal abort、bounded abort-ignore、client disconnect 三种关闭对照、受限恢复与样本跳过。日志 `logs/profile-recovery-final-central.log`。首次30/31失败记录继续保留，未改变期望或延长正常关闭超时来获得通过。全仓 lint449文件退出0，`logs/profile-phase-lint-final.log`；隔离页构建27模块及增强fake smoke退出0。独立Sol两遍复审规格/质量PASS，子任务均未运行门禁。

root随后核验真实账本完整链、busy=false、端口与lock PID归属，并留存原账本/锁。旧host没有shutdown handler，停止仅这个自有Node，验证旧进程退出和端口释放，原锁quarantine保存。PowerShell首次活动文件Get-FileHash被Windows共享模式拒绝；退出后以严格失败模式重新核验账本与保留锁的SHA256，均与先前Node读取副本一致，不把首次命令的非终止错误当作hash通过。原账本不重新初始化，明确entry1/checkpoint启动4096并追加审计；旧历史字节前缀和原entries逐字段不变，1请求/1质量请求/¥0.01213保留。恢复后mode=locked、busy=false、halted=false，没有新请求。新可控Edge窗口已ready，待用户在页内填Key；恢复不是质量验收通过。
