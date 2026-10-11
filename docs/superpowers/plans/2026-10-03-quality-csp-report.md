# D02 / C05 隔离入口与 C06 / D08 交付报告

完成时间：2026-10-04（任务编号沿用2026-10-03）。**真实模型请求0/48，真实费用¥0/5**。本任务没有读取已有配置/环境/profile凭据、没有发送真实模型请求、没有部署、提交或push。正式CSP仍Report-Only。

## 可交接状态

**2026-10-07 Protocol 补充：隔离实现与 fake 回归已准备，按用户新指令未执行任何测试/typecheck/lint/build/smoke，未重冻 manifest。下列 fix1 通过记录不覆盖该补充；root 候选固定后集中验证。真实请求仍 0。**

**最新状态（2026-10-05 fix1）：下述初版构建/smoke 为历史证据。fix1 定向 Node 13/13、quality 10/10、本任务 25 个源文件 Biome check 已通过；最终候选 freeze、quality typecheck/build/增强版 fake smoke 待 A09/A10 稳定后由 root 补验，详见末尾修复记录。真实请求仍为 0/48、¥0/5。**

质量页和隔离production dist host已准备；入口构建及专用全新Edge上下文fake smoke通过。管理员已实际接入production `runAdminTurn(maxRounds:2)`，execute仅返回工具摘要并注明未写库；按实际HTTP逐轮预算扣账，缺usage立即停止，不自动重试。baseline使用4c5169a的真实turn/tools/parser，candidate使用工作区production实现，缺baseline engine时拒绝调用。**这些是假transport的功能证据，真实质量A/B与真实App BYOK尚未执行。**

用户已明确Key来自DeepSeek官方。真实端点只接受字面量`https://api.deepseek.com/v1/chat/completions`；第三方、http、query、userinfo、fragment被拒绝，上游redirect为error。UI端点只读。任意HTTPS C05仅允许不带真实Key的fake验证，当前未完成该直连矩阵，不套用官方价格向第三方发送Key。

root交用户前使用 [验证清单](../../VALIDATION-2026-10-03.md) 的命令：

```powershell
node tools/desktop/validation-freeze.mjs
node tools/desktop/validation-build.mjs
# 只在账本不存在且本轮真实消耗确为0时首次初始化；已存在即拒绝覆盖。
node tools/desktop/validation-host.mjs --initialize-ledger
# 以后重启：node tools/desktop/validation-host.mjs
```

host默认locked，质量页`http://127.0.0.1:6285/validation/`出现“准备完成”；App dist在同源`/`。本worker只运行自动测试期间的临时host并在finally关闭，**没有留下真实模式的服务或自动调用**。用户输入masked Key之后，只有root/用户显式开始并逐条发送才能花费。

## 文件范围与来源

- `apps/web/tests/quality/**`：固定夹具、provider/两轮runner、masked输入页、人工评分和下载、专用类型检查、行为测试；`.local/`与`build/`局部ignored。
- `tools/desktop/validation-*`：canonical/hash/总账、git-blob基线装配、冻结、构建、enforced host、隔离bootstrap、Node测试、无trace/HAR的Edge smoke。
- `docs/quality-fixtures/**`：冻结manifest及来源说明。
- `docs/VALIDATION-2026-10-03.md`与本报告：入口、限制、C05/C06/D08清单及运维交接。

未改D01独占package/lock/config/IDB；quality子目录自有tsconfig没有修改共享config。未改launch/build-inputs、core/admin、server、生产web src/public、正式deploy header。未安装依赖；使用已有Vite/Vitest/隔离Playwright。构建只写ignored质量build，不写production dist。

基线commit：`4c5169a23ecc901ab892bae182f8f4ac78c4b8b8`。十二组由真正`assemblePrompt/buildExtractionMessages/buildAffectMessages/buildAdminMessages + ADMIN_TOOLS`装配，固定branded IDs、`2026-10-03T00:00:00.000Z`，无random creator。prompt/tools从git blob在临时目录实际执行；baseline两轮turn/tools/parser也从该commit取出，完成构建后删除临时源码。shared core production依赖逐文件核对规范化换行SHA256，差异时拒绝共同基线。

输入与request均canonical递归排序对象、保持数组顺序；fixtureHash/requestHash/commit/sourceHash记入manifest。候选标明working-tree，不将HEAD冒称无改动源码。Schema1早期只存共享实体，随后在所有旧baseline请求canonical完全相同的前提下补完整builder input为schema2；未替换baseline prompt。最终baseline hash为：

`a490d9633ebf203737f87890b429b1181120cc1f6f9cd618a5b55f3d22820f3b`

2026-10-04重跑freeze仍12/12请求相同、baseline hash稳定。当前只评共同现状；A09/A10改完后必须重跑freeze与build再抽样。此时共享9组×2=18请求；不同admin 3组×2侧×2重复×最多2轮=24，D02最多42，加C05预留4=46。当前12组全相同的共享矩阵最多30请求。不是为了凑满48而增加重复。

## 行为与原始证据

- 固定deepseek-flash/Low/thinking enabled/max_tokens1200，通过production provider fetchImpl注入，删除无效采样变量；产品本身尚无Low设置。
- 每轮保存实际wire canonical SHA256、messages/tools/参数、text/toolCalls/usage/error；管理员工具回馈是独立第二轮，不计作首轮重复。生产parser按对应baseline/candidate源码运行，parseDraft新生ID/time排除语义比较。
- 原始结果、人工五项0/1/2及N/A、任务正确性、证据/判分人、评分后侧别映射分别下载。页面只向评分人显示回复/工具/parse/error，不显示请求prompt。随机顺序隐藏侧别；两次重复仅探索，不宣称总体或400轮提升。
- 不收集reasoning stream；Key/Authorization/secret字段和已知Key回显递归剔除，异常body不导出。清除Key、离页清除；真实调用禁止trace/HAR及带凭据截图。
- 48请求/¥5共享持久账本，质量最多44，为C05留4；发送前先落盘预留，按UTF-8 wire字节输入上界及1200输出、2/8元每百万保守计价，微人民币精度累计。失败/中止/缺usage保留请求数和预留并halt；恢复时pending也halt。重启默认locked，刷新不归零。预算ledger不含Key。
- 刷新会丢内存原始结果与盲评映射，但不丢预算；root需及时下载、按既有账本安排剩余矩阵，禁止删账重启当新预算。当前没有自动导入旧评分/原始证据功能。

## 实际验证命令与结果

| 命令 | 实测结果 |
|---|---|
| `node tools/desktop/validation-freeze.mjs` | 12组，12 identical，稳定baseline hash；重复执行通过 |
| `node --test tools/desktop/validation-budget.test.mjs tools/desktop/validation-host.test.mjs tools/desktop/validation-baseline.test.mjs` | 6/6通过：48/44/5边界、失败/缺usage/中止保留预算、恢复pending封锁、凭据脱敏、host/CSP、官方pin、重启总账、真实git-blob基线两轮parser |
| `node apps/web/node_modules/vitest/vitest.mjs run apps/web/tests/quality/fixtures.test.ts apps/web/tests/quality/provider.test.ts` | 2文件6测试通过（也包含在web全套） |
| `pnpm --filter @dramatis/web test` | 38文件243测试通过（2026-10-04最终运行） |
| `pnpm --filter @dramatis/web typecheck` | 通过（此前当前web源码检查；未将其冒称包含quality目录） |
| `node apps/web/node_modules/typescript/bin/tsc -p apps/web/tests/quality/tsconfig.json` | quality目录单独类型检查通过 |
| `node tools/desktop/validation-build.mjs` | 21 modules，Vite isolated build成功，包含独立git-blob baseline engine |
| `node tools/desktop/validation-smoke.mjs` | 全新headless Edge通过：准备完成、masked Key、fake provider、刷新保留账、inline script被enforced CSP阻止、记录违例、App dist加载、默认拒绝外部fetch；真实0/¥0 |

测试中“real-mode durable ledger”案例只注入fake `upstreamFetch`，从不联网模型；它的临时账本数字是合成测试值，测试finally删除，不是本轮真实消费。

TDD记录：预算/host/runner测试先于实现写入，最早RED是缺失模块；fixture路径初次多写一层，修正后生成成功。host fake场景切换错误重置账本出现预期计数`1 != 2`，修正为显式fake reset；浮点累计出现`0.000359999... != 0.00036`，改为微人民币精度。后续official pin新增测试先实测第三方被接受`200 != 400`；admin两轮测试先实测`1 != 2`，实现后转绿。所有这些失败已修复，未掩盖为初次即全过。

格式化最初`pnpm exec biome`在该Windows会话提示命令未识别；改用已安装`node node_modules/@biomejs/biome/bin/biome format --write <仅本任务文件>`成功，没有安装或改锁。未宣称执行全仓库lint。

最终重跑曾出现baseline断言已PASS但Node进程未退出的测试harness问题；中断该运行后关闭测试Vite的依赖发现、watch与HMR，独立重跑正常退出0，再跑组合测试确认。没有把被中断的运行算成成功结果。

fake页面截图：ignored `apps/web/tests/quality/.local/quality-fake.png`，已人工视觉检查。截图中没有真实Key。

## 外部待验证与精确限制

C05：host实际enforced策略与正式候选一致，但正式header保持Report-Only。独立页只证明production provider/预算接线；App真实主/副对话BYOK流式、非流式/回退、stop/errors、自定义HTTPS、PNG/JSON导入、data/blob背景、lazy worker、offline/cache更新尚未验收。当前代理浏览器路径为loopback，不能证明浏览器直接连接任意HTTPS源的CSP；自定义源fake直连拦截/验收尚未实现。完整检查表与“App显式BYOK配置怎样经过同一预算”步骤已经交付，所有后台/意图先行/多轮请求都会计数，不能把异构App请求硬当质量重复。

生产dist smoke只证明测试时磁盘上已有artifact加载；首次artifact时间2026-10-03 19:16:20。B03与后续候选需要root在获准构建流程重新产出dist，并做最终App验收；本任务不声称旧dist包含那些改动。

C06：没有服务器目录与窗口，未实演。建议Windows同卷`recovery-drills/<timestamp>/`、源只读成功VACUUM INTO快照、30分钟窗口、专用loopback端口、新测试账户、不停止生产不换生产DB。快照hash/quick_check/schema/counts/解密/epochcursor/实测RPO-RTO/安全清理清单已交。真实host值仅入LOCAL-NOTES。

部分一交接：当前周期backup.mjs直接VACUUM INTO target再按30删旧，缺quick_check/partial发布；管理员前置快照有partial+quick_check+rename但无GC。30成功快照每桶策略未修，不能宣称成功发布后裁剪已实现。install-server生成unit与tools/sync-server/systemd模板的ProtectSystem及其他硬化项差异逐项写入验证文档，本任务不改禁区模板。

D08：Android设备/OS/WebView/buildsource/USB或远程/PWA安装启动/离线/keyboard/back/BYOK/账户同步/缓存更新均交用户之后真机勾选，本轮无真机结果。桌面目前PWA app-window，不是原生Tauri壳。

**准备任务已完成；本报告不宣称真实模型质量、生产CSP强制切换、恢复演练或Android验收完成。**

## Fix1 独立审阅修复（2026-10-05）

本轮处理 3 项 Important 与完整 wire 导出的 Minor；代码仅涉及原获准的 quality 与 validation-*，未改产品 core/admin、D01 配置/package/lock、桌面 launch/build-inputs 或根账本。`logs/quality-fix1-before/` 未改。没有启动可供实际使用的真实 host、读取用户 Key/profile 或发送真实模型请求；测试中的 real mode 均注入 fake upstream。

### 发送前同步持久化与并发守卫

新增 `validation-journal.mjs`，用同一打开文件追加带序号/前项摘要/当前摘要的 checkpoint，完整 `writeSync` 后 `fsyncSync` 成功才允许上游 dispatch。Windows 使用 Node 的原生同步 flush；不再把异步 writeFile 加 rename 当成已经持久化。启动验证 flush 能力，无能力拒绝。真实预留持久化失败不 dispatch，内存 pending 不丢；结算持久化失败恢复原 pending 并 halt。故障标记 journal poisoned，保留排他 `.lock`，防止重启从旧记录继续花预算；无法写入时不声称 pending 已在盘上，磁盘保证仅到最后成功 flush 的 checkpoint。

端口先 bind 成功再打开账本，失败启动者不会覆盖正在使用的总账。账本路径 realpath 规范化、`.lock` 用 `wx` 排他创建，同一账本即使不同端口也拒绝并发。正常关闭释放锁，异常退出/持久化失败遗留锁不自动回收，需人工核对最后可信 checkpoint、进程与用量，不可直接删锁重启。重启 pending 和损坏尾部均 fail closed；旧单 JSON checkpoint 可读且不覆盖。这里验证的是操作系统 flush 确认和故障行为，没有做真实断电/硬件缓存实验。

测试覆盖同步 flush 必须先于 dispatch、无 flush 能力拒绝启动、写入/flush 故障不 dispatch 且保留 pending/锁、结算故障恢复 pending、同账不同端口排他、已占端口启动不改账、pending 重启拒绝 arm，以及真实 host 客户端 abort 传递到 fake upstream 并持久 halt。

### 可评分的共同背景与可重建 wire

新增 typed `types.ts`、`presentation.ts` 与 `evidence.ts`。盲评展示冻结共同原卡/性格、世界书、场景、相关历史、用户任务和约束，不暴露侧别或侧别 prompt。两侧读取同一冻结背景；修改 candidate 卡片或两侧 prompt 不改变共同评分依据。切换样本清空旧回复，发送期间禁切换。原始结果和人工评分导出均含共同背景，评分写入时立即脱敏，避免清空 Key 后再导出已录入的 Key 回显。

每轮导出完整实际 `wire`，包括原来遗漏的 `stream_options` 和原名 `reasoning_effort`。`wireHash` 明确指脱敏前完整 canonical body；`exportedWireHash` 可由下载的 `wire` 重建；`wireRedacted` 说明是否发生变化。删除 reasoning/reasoning_content 不误删 reasoning_effort 配置。测试分别验证正常重建、含秘密时两种 hash 的准确语义、双方背景一致、评分/背景导出。增强版 `validation-smoke.mjs` 已增加合成双方样本的背景、评分与 wire 下载检查，但未把此前构建 smoke 当成该增强版的执行结果。

### 实测与剩余集成检查

| 检查 | fix1 结果 |
|---|---|
| `node --test tools/desktop/validation-budget.test.mjs tools/desktop/validation-host.test.mjs tools/desktop/validation-durability.test.mjs tools/desktop/validation-baseline.test.mjs` | 13/13 通过，exit 0；含真实 git-blob baseline 两轮测试，传输全部 fake |
| 在 `apps/web` 运行 `node node_modules/vitest/vitest.mjs run tests/quality` | 3 文件 10/10 通过，exit 0：fixtures 2、provider 6、context 2 |
| 已安装 Biome 对全部 validation-* 的 `.mjs/.js` 与 quality 直属 `.ts/.css/.html/.json` 执行 `check --max-diagnostics=100` | 25 文件通过，exit 0，无 error/warning/info；不仅 format，无全局 disable，移除本任务 explicit any/非空断言 |
| quality 专用 `tsc -p apps/web/tests/quality/tsconfig.json` | typed 重写后曾通过；最新一次 exit 1 来自并行修改中的 core/admin/tools.ts 导入 world-book.js 尚未导出的 diffWorldBook、reverseWorldBookDraft、worldBookArtifactConflict、isModifiedWorldBookArtifact。未修 core；按 root 指示不在半写产品源码上反复执行 |
| 最终 freeze、quality typecheck/build、增强版 fake smoke | 待 A09/A10 稳定后由 root 执行；不宣称当前旧 bundle/dist/screenshot 已验证新背景与最终候选 |

最初新增行为测试曾以 wire 缺失、presentation 模块缺失、dispatch 前未同步 flush 等原因呈 RED，修复后上述定向组均转绿。一次从仓库根按路径筛选 Vitest 意外匹配 `logs/quality-fix1-before/` 的备份测试，改为在 `apps/web` 定向执行，没有改备份或扩大产品范围。13/13 与 10/10 后仅补评分保存即脱敏及格式；25 文件 plain Biome check 已覆盖该最后源码状态。未无必要重复全 web 测试。

交 root 独立审阅本轮 diff。候选稳定后执行 freeze、专用 typecheck、validation-build、validation-smoke，并按已有生产构建授权刷新 App dist 后再验 C05 真 App 矩阵；真实启动和发送仍须由 root/用户掌控。C06/CSP模板差异、恢复演练与 Android 条件保持前述未完成状态。**本轮真实消耗：0 请求、¥0；fix1 集成验收尚有明确待项。**

## Protocol：Low 工具多轮私有回传（2026-10-07，未执行验证）

依据 `2026-10-03-quality-protocol-brief.md` 的官方协议核对结果：工具后续请求需要完整 reasoning_content，而现有 production provider JSON 分支和管理员历史序列化未完整保留此字段。本轮仅修改 quality 的 `protocol.ts`、runner/types、fake 测试及必要 validation-baseline 测试；没有改 core provider/admin、正式 App、manifest、package/lock、部署策略或用户账本。

`createQualityProtocol(signal)` 为每次 run 创建私有闭包，同一个 runner 为 baseline/candidate 应用相同适配。SSE 使用真实 production provider 产生的 reasoning 增量按序拼接；JSON 回退读取本次响应的临时副本，原响应仍由 production provider 实际解析。协议内容不交管理员 engine，也不放进 QualityResult；只有真实 wire 发送前才按工具回填身份注入。production `runAdminTurn(maxRounds:2)` 及各侧 parser 保持真实执行，不将 shim 归因成 A09/A10 的功能或质量改进。

回传绑定原请求历史前缀、assistant 完整正文、工具 calls 的 ID/名称/参数以及 tool 消息顺序；未知历史工具 assistant、重复 ID、错配或缺失 reasoning 均拒绝继续发送，错误为固定可读说明，不能用空串伪造缺失内容。适配上限两次 dispatch，与 D02 约定一致；它不是任意历史/长期会话的通用协议实现。每次 run 独立创建，即使另一 case 使用相同 call ID 也无共享链。成功、错误、abort 清除闭包中的私有引用；JSON 读取器在退出时取消并释放，已注入临时 wire 的字段在 finally 删除。清理指释放应用引用，不承诺 JS 运行时字符串内存安全擦除。

wireHash 在注入协议内容之后按完整实际 body 计算。保存证据时立即 scrub，因此 `wire`/UI/导出没有 reasoning_content；`exportedWireHash` 对应脱敏 body，后续轮应显示 `wireRedacted=true`。传给原 nativeFetch/隔离 host 的 JSON 仍含完整协议 body，现有 host 的 UTF-8 字节预算据此预留，不对脱敏体计费；48/5、质量44、失败停止/不重试规则均不变。链不写账本，账本仅保留已有计数/预留/usage 字段。

准备交 root 的 fake 回归：

- 新 `protocol.test.ts`：SSE 两块非空 reasoning（含换行/空白/Unicode，传输按7字节切块）与 JSON 两轮；断言第二轮对应 assistant 的完整 chain 相等、实际 wire hash、脱敏导出 hash、完整 body 预留和账本不含 chain。
- 前缀/assistant 正文/call ID/参数/tool 回馈顺序篡改拒绝；未知历史首轮零 fetch；缺失 reasoning 不发第二轮；同 ID 跨 run 不泄漏；abort/error 后无 chain 导出；JSON 捕获时 abort 释放读取并关闭协议。
- 已有 provider 两轮 fake 响应补真实非空协议字段；`validation-baseline.test.mjs` 的真实 git-blob 引擎 fake 响应也补非空字段，并断言第二轮实际回传与结果脱敏，以覆盖 baseline 路径。

**执行状态：以上用例仅写入，未运行；本轮没有运行测试、类型检查、lint、build、smoke、freeze 或真实 host。** 不把历史 13/13、10/10、25 文件 lint 当成本补充的证据。root 完成候选固定后统一集中验证与 freeze/build；若发现新缺陷按结果修复，不预先写“通过”。

C05/部分一边界：正式 App 没有这层隔离 shim，工具 Low 多轮兼容缺口仍需产品归属方处理，不能用 D02 fake/真样本替代 App 验收。正式 CSP 继续 Report-Only，C05“待验证（归 Codex）”；真实模型消耗继续 **0/48 请求、¥0/5**，没有读 Key/profile、联网模型、生产部署或提交。

### Protocol review1 / fix1（2026-10-08，仅实现与用例准备）

处理审阅的 Important：production `finishToolCalls` 会将缺失 ID 归一化为 `call_0`、缺失 arguments 补成 `{}`，此前只绑定归一化 calls 无法证明这些字段真实存在。新增隔离 `protocol-response.ts`，每 run 私有观察原始响应；JSON 观察私有副本，SSE 通过按原字节转发的流包装器观察事件，生产 parser 不改。工具按原始 SSE index/JSON 数组位置累计，ID/名称要求真实非空字符串且分块一致，arguments 必须真实出现为字符串并按片段拼接。原始字段与 production normalized calls 的数量、顺序、ID、名称和参数逐项一致才允许生成待回传上下文；缺字段或补默认值导致的差异在第二 fetch 之前拒绝。原有历史前缀/assistant/tool 回馈顺序绑定继续生效。

同时处理 Minor：不再依赖 production 仅产生非空 reasoning 事件的行为。原始观察独立区分“未见字符串字段”与“明确出现空字符串”，SSE 与 JSON 的显式 `reasoning_content:""` 均可完整回传空值；缺失/null 不伪造空链。前述初版“SSE 从 production reasoning 事件收集”的描述已由本轮原始 SSE 字段观察替代。普通 null 增量只代表本片段无该值，不抹掉已收集的字符串内容。

新增准备的回归覆盖：SSE/JSON × 缺原始 ID/arguments，断言实际 production parser 确实生成 `call_0`/`{}`，但 runner 只发生一次 fetch 并给出可读协议拒绝；SSE/JSON × 显式空 reasoning/字段缺失，分别断言两次回传明确空值或一次后拒绝；SSE 的工具字段分片到达仍按原始身份与参数拼接，并保留前后 reasoning 空片段及非空片段。既有前缀/身份/顺序单测改为经过真实 JSON 原始观察准备上下文，不再直接注入 reasoning；跨 run、导出脱敏、hash/预留和 abort/error 清理用例继续交中央运行。

原始观察状态、SSE 私有缓冲、待回传链均位于单 run 闭包；完成/取消/错误释放源 reader 并清除引用，normalized call 证据不会附带原始链。完整 wire hash、脱敏 exported hash、代理按实际完整 body 预留规则保持。本轮只写 quality 源码/用例与本报告，未改 production parser/core、账本、manifest 或 `logs/protocol-fix1-before`。

**未运行测试、typecheck、lint、build、smoke、freeze；没有本轮通过声明。** 最初默认 exec/node_repl 因 Windows sandbox setup refresh 故障无法读取；随后仅以 root 指定的只读 Get-Content 通道取得本任务源码，正常 apply_patch 完成编辑，没有更改沙箱/环境配置。交 root 只读复审和集中验证；真实请求仍 **0/48、¥0/5**，未启动真实 host 或读取 Key。

### Protocol fix1 补充中央用例（静态复审后，仅准备）

root 回传两遍静态复审 clean，原 Important/Minor 已 ADDRESSED；这属于静态审阅状态，不是运行通过证据。按 reviewer 建议，仅在 `protocol.test.ts` 补充 5 个有意义用例，没有改已审查的 shim、production 实现或测试接口：

- SSE 源流 `highWaterMark:0`、pull 不 enqueue/close，等待真实 read 开始后 abort。断言 fake fetch 仅一次、源实际 cancel 恰一次、源 locked 从 true 变 false，并重新取得源 reader 读到 done，以验证取消和锁释放而非只查内部标记。
- 未主动结束的 SSE 源先返回私有 reasoning，再返回 malformed JSON。断言固定 provider-error、没有第二 fetch、实际 cancel 一次、源 reader 锁释放，错误/导出不含损坏原文或 chain。
- 同一个 SSE tool index 的 ID 从 original-id 改为 changed-id；确认 production parser 确实采用 changed-id，但隔离原始观察拒绝继续，fetch 仅一次。
- SSE 与 JSON 分别缺工具 name；确认 production parser 丢弃该 call 后，原始观察仍检测到不一致并拒绝第二 fetch，而非将其当作正常无工具回复。

现有 `runFixture` 注入 fake Response 与原生 ReadableStream 的 cancel/locked/getReader 接口足以观察这些行为，无需暴露私有 chain 或增加实现接口。**上述新增用例未执行，待 root 中央总测；未运行测试、typecheck、lint、build、smoke 或 freeze。** 真实请求继续为 0，未启动真实 host 或读取 Key。

### D02 最终冻结依赖补充（2026-10-08，仅实现与用例准备）

静态审阅发现 freeze 仅以 `4c5169a` 的 git tree 枚举生产 core TS，遗漏本批新增、由 candidate `admin/tools.ts` 实际导入的 `admin/world-book.ts`。新增独立 `validation-dependencies.mjs`：工作区递归枚举完整生产 TS，包括新增未跟踪文件，延续排除 `.test.ts` 与 `/eval/`；旧依赖仍逐文件核对规范化换行 SHA256，非 admin 变化、缺失旧源或新增非 admin 生产源均拒绝共同基线。无法证明源码的符号链接明确拒绝。

历史 `dependencyHashes` 的 baseline/candidate 对保留；新增 admin 依赖仅写入 `candidateOnlyDependencyHashes` 并合入 candidate `sourceHash`，不向 baseline 添加新文件或空 baseline hash。旧 baseline `sourceHash` 的原始文件集合与 canonical 算法保持不变，完整冻结 baseline hash 仍要求为 `a490d9633ebf203737f87890b429b1181120cc1f6f9cd618a5b55f3d22820f3b`。baseline 引擎装配无需改动，新候选元数据不参与其共享旧依赖校验；manifest 尚未重冻。

准备 6 项 Node 回归：已持久化完整 baseline hash 与历史 source map 固定；新增 admin 源的两次内容变化分别改变 candidate source/fixture hash 而 baseline 全量 canonical hash 保持；新增源与历史源 CRLF/LF 规范化稳定；新增非 admin 在任何 source read 前拒绝；共享源变化及旧源缺失拒绝；工作区实际临时目录枚举纳入无 git 记录的新 admin 并排除测试/eval。测试直接使用独立依赖 helper，不运行 freeze 或模型请求。

**本子任务只准备源码、测试和文档，未执行 test/typecheck/lint/build/smoke/freeze。** 交 root 统一静态复审、最终集中 freeze 与验证；不把先前中央通过记录归因于本次修复。未修改 core、协议实现、manifest、锁文件或用户总账；没有真实 host、Key 读取、真实请求、提交或 push。真实消耗仍 **0/48 请求、¥0/5**。

### 2026-10-08 root最终准备与首次真实结果

root集中质量fake37项、递归依赖6项、最终freeze及专用类型/构建通过；baseline完整hash不变，9共同/3管理员差异，新增world-book只进candidate。增强Edge fake smoke通过，实际最终App CSP fake为7通过/1已知协议skip；各日志见VALIDATION及执行台账。这些运行均由root完成，子任务没有执行门禁。

6285真实host首次初始化并启动后，用户在页内填Key；浏览器控制helper初始化故障，用户只手动发送当前一次并下载指定证据。最新总账1/48、保守记账¥0.01213/5、budget-truncation/停止锁生效。shared affect-1 repeat2导出没有完整text/usage/parse，不能评分或推断模型质量。指定三份下载已验无凭据/推理字段、导出wire hash一致并保存ignored证据；原账本保留，不重试或解锁。恢复提案另列，真实App BYOK仍未通过、正式CSP继续Report-Only。
