# 2026-10-03 D02 / C05 / C06 / D08 隔离验证

2026-10-09 C06最新覆盖：用户授权沿用运维连接后，root在现役Windows完成20,156,416B历史快照的同卷私有两副本恢复；hash/只读quick_check/关键关联通过，复制481ms、SQLite16ms。现役程序在工作副本的迁移/loopback health及优雅停机、端口释放、后只读检查通过；核心4/6880/4行数保持、源与原副本不变、六生产服务Running。账户读写/解密/增量同步仍待验，RPO/应用RTO未测、保留策略仍归部分一；C06未整体关闭。详见[服务器实演记录](./superpowers/plans/2026-10-09-c06-recovery-report.md)。下文“未实演/服务器待条件”是此前记录。

2026-10-09 最新决定覆盖下列历史状态：用户要求忽略初始化问题、重新获取插件后继续项目。官方CLI重新获取Computer Use已退出0，本地installed/enabled=true、bundled版本不变；插件列表显示和控制能力未证，不再排查初始化或官方包。6285离线、没有待Key窗口；账本SHA及1/48、quality1/44、¥0.01213保持，无新增真实调用。正式CSP继续Report-Only，待验证（归 Codex）；三处部署说明已补齐隔离actual enforced+真实BYOK完整验收门槛。服务器、Android与真实模型验收仍待外部条件，详见[26项收口矩阵](./superpowers/plans/2026-10-09-ui-bridge-ops-closeout.md)。

2026-10-09 15:49后覆盖此前状态：用户离线脚本已取得合法elevated success=true、静止计数0和server exit0；账本前中后SHA未变。但重开后root default命令/Cua kernel依然失败，最新runtime ACL目标node_repl.exe/os32。官方PR51822已修复高度吻合的EXE/DLL共享冲突，待核实包含修复的desktop/Store发行；不继续setup/回收循环。6285随本次退出离线，旧locked状态不冒充现况；原账本仍1次/¥0.01213，无新增真实调用。正式CSP仍Report-Only、C05待验证（归Codex）。

2026-10-09 最新：完整退出重开及一次公开 elevated setup 均未恢复实际默认 shell/Cua；setup 合法完成通知为 success=false，readiness=ready 不能代替执行证据。Store 仅“打开”，未下载/安装更新。三项精确核验后的工具进程定点回收也未消除 runtime ACL os error32，Cua transport 当前关闭；不继续追杀。离线脚本已准备，独立子进程临时关闭 code_mode_host 的只读双 census 均0；待用户在系统 PowerShell 中启动并正常退出 Codex后执行一次官方配置，再重开实测。故障仍未修复。

2026-10-09 账本保全：Root 核验旧锁 PID10956 已退出、端口空闲、完整账本链及已知 byte hash 未变，保留旧锁/原账本副本后仅以 `--output-tokens=4096` 重启 host，不重复恢复或初始化。新 PID46992 的 active lock/loopback listener 归属一致，在线 `mode=locked,busy=false`，仍1/48、quality1/44、¥0.01213；Node逐字节核对未改变journal。下段端口离线记录属于此前观察；下次 app 退出后须重新核验 host，而不是默认它存活。

2026-10-09 当前接续：用户已要求仅用内置浏览器，两个临时外部 Edge 运行均已收尾关闭，无新增模型调用。6285 当前无监听，原 host 的 exec session 已不存在，残留 `ledger.json.lock` 尚未处置。Root 只读校验完整追加 hash 链及最后 checkpoint `a5918101719838c48c3177a90230e232f8d00c49ac635ab64674e1bc7a62591b` 成功：仍 1/48、quality 1/44、¥0.01213，唯一条目为 `budget-truncation`，已有一次 4096 保账恢复审计。上一次 host 核验为 locked；当前不以旧 mode 代替在线状态。禁止重复恢复、初始化、删除账本或重发首条。用户完整退出 Codex 并重开后，默认只读 shell 与 Cua `getState()` 仍在初始化阶段失败；待官方沙箱修复入口核实，详见 [运行时恢复记录](superpowers/plans/2026-10-09-codex-browser-runtime-recovery.md)。此故障不是自动审批拒绝，尚未修复成功。

2026-10-08首条真实样本后的核账为 **1/48请求、保守扣记¥0.01213/5，halted=true**，条目状态`budget-truncation`，无可评分结果。用户后来批准4096并保账，集中门禁及独立复审通过后仅追加一次受限恢复审计，当前仍 **1/48、¥0.01213/5，profile4096、mode=locked、busy=false、halted=false**。新隔离窗口ready等待页内Key确认，没有后续调用。该金额是保留的预留上限，不是供应商账单。root最终candidate freeze成功：12个样本中9组相同、管理员3组不同；baselineHash `a490d9633ebf203737f87890b429b1181120cc1f6f9cd618a5b55f3d22820f3b`未变，candidateOnly含`world-book.ts`。专用类型/构建、增强Edge fake smoke及最终App CSP fake矩阵7通过/1已知skip均已完成。真实质量、真实App BYOK、服务器恢复与Android真机仍未通过。正式deploy CSP保持Report-Only，C05“待验证（归 Codex）”。

真实页点击受本机浏览器控制初始化故障阻断：`cua.getState()`两次退出，诊断为Windows helper setup refresh error；没有自动审核拒绝。备用只读诊断未发现可连接调试端口，未读取profile/Key/会话。用户按root请求只发送当前一个样本并下载三份证据，未刷新或要求重填Key，未绕过共享账本。首样本截断后停止锁保持，不自动解除或重试；提高执行输出上限及保留账本的后续方案见 [截断提案](superpowers/plans/2026-10-08-real-budget-truncation-proposal.md)。

2026-10-08历史记录：root曾集中验证隔离quality fake4文件37项及全仓typecheck，并静态复审Low原始SSE/JSON观察修补。此后最终candidate freeze、专用typecheck/build及增强fake smoke已通过；最终证据见末段。这些fake结果均不代表真模型或正式App Low多轮已通过。

2026-10-07 Protocol 补充仅完成实现与 fake 用例准备，按用户指令未运行任何测试/typecheck/lint/build/smoke、未重冻 manifest。D02 两侧共同使用隔离 Low 工具协议 shim：SSE reasoning 增量及 JSON 回退的 reasoning_content 仅保留在本次 run 私有内存，核对已有历史、assistant 内容、工具 ID/参数及回馈顺序后回传第二轮；缺失或错配在后续发送前可读拒绝，不编造空链、不自动重试。实际完整 body 先加协议内容，再计算 wireHash 并送预算代理；证据立即删除 reasoning_content，exportedWireHash 对应该脱敏 body。完成/error/abort 均清理私有引用（不承诺 JavaScript 字符串安全擦除）。root 候选固定后统一 freeze/build 与集中验证。

## 本机入口

2026-10-08 发送真实请求前再次核对官方资料：`deepseek-flash` 对应 V4.1 Flash，Low 支持及 thinking 参数继续按已冻结配置使用；官方中文价格页仍列高峰缓存未命中输入 2 元/百万 tokens、输出 8 元/百万 tokens。账本继续按这组高峰上限预留，不据当前时段折扣增加请求数；48 次/5 元总授权不变。参考 [官方模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 和 [官方更新记录](https://api-docs.deepseek.com/updates/)。直接打开页超时后通过官方域名搜索核对；未调用模型或改账户配置。

下列为初始准备流程，已有 Vite、Vitest、隔离 Playwright 依赖，不安装新依赖；当前fixture已冻结、真实账本已存在，重启不得重复初始化或重新冻结历史：

```powershell
node tools/desktop/validation-freeze.mjs
node tools/desktop/validation-build.mjs
# 仅本次验证首次建账；若账本已存在，命令拒绝覆盖。
node tools/desktop/validation-host.mjs --initialize-ledger
# 本次已获批准并完成4096保账恢复后的重启必须保持同profile。
node tools/desktop/validation-host.mjs --output-tokens=4096
```

上述两个 host 命令二选一，不同时启动。默认只监听 `127.0.0.1:6285`。质量页为 `http://127.0.0.1:6285/validation/`；production dist 为同源 `/`。先由 root/B03 按其获准构建流程准备当前 `apps/web/dist`，此 host 不构建或修改生产资源。启动后默认 locked，不发送模型请求。页面出现“准备完成”后交给用户输入 masked Key；不读环境、已有配置或 browser profile。首次 smoke 所用 dist 的 index.html 文件时间为本机 2026-10-03 19:16:20，只证明该已有 artifact 可加载；不能视为后续修改的候选 dist 已验收。

Key 只保留在本页内存/本次请求内存；清除按钮与离页清除，下载不含 Key/Authorization/reasoning；禁止 trace/HAR，真实凭据输入后不截图。fake 的零成本账与真实账明确分开。页面自身必须显式开始、逐条点击发送；获准的root控制脚本在用户确认新窗口Key后依次执行这两个按钮操作，每条等证据落定，失败不重试。脚本不读取Key。

真实账本仅含计数、用途、预留/费用/usage、状态和非秘密执行摘要，保存在 ignored 的 `apps/web/tests/quality/.local/ledger.json`，内容现为带顺序号和链式摘要的追加 checkpoint。48请求、5元人民币、质量最多44请求（给C05留4次），App与质量页共用。输入按完整 wire JSON UTF-8 字节的保守 token 上界；首条及冻结默认profile输出1200，用户批准恢复后实际profile输出4096，按每条已校验的实际wire上限预留。价格按输入2元/百万、输出8元/百万，不预扣 cache-hit/闲时优惠，微人民币精度累计。

host 先成功绑定端口，再以排他创建的 `.lock` 守卫同一账本；不同端口也不能并发打开同一账本，端口冲突的启动者不会写账本。每次发送必须先完成同步追加与 `fsyncSync`，收到系统 flush 成功确认才 dispatch；不依赖 writeFile/rename 作为持久化证明。启动时无 flush 能力即拒绝，预留写入或 flush 失败不 dispatch，保留内存 pending 并锁定会话；结算持久化失败恢复 pending。故障保留 `.lock`，防止新进程把旧 checkpoint 当作可花费余额。此保证限于操作系统确认，未进行断电或硬件缓存可靠性实验。

失败/停止/缺usage保留该次请求与预留费用并停止，重启发现pending或损坏尾记录也停止；无自动解锁或重置真实账本按钮。正常关闭释放锁，异常退出或持久化失败的残留锁必须先人工核对进程、最后可信 checkpoint、下载证据与供应商用量；不能直接删锁恢复发送。不得删除账本继续跑；丢失账本也不能当零预算重新初始化。

页面刷新会丢失内存中的原始证据、盲评映射和Key，但不会丢失服务端账本。每批发送后及时下载原始/评分/映射/总账，刷新后不得把旧样本重新当未花费样本；剩余矩阵由root依据下载映射与总账安排。管理员已实际接入对应baseline/candidate生产流程，最多两轮、逐轮计费、execute纯摘要不落库，详见 [夹具说明](quality-fixtures/README.md)。

原始 text/toolCalls/usage/parse/error 与人工评分分开记录；length/max_tokens 标为预算截断，不推定模型能力低。QUALITY 五项0/1/2与N/A见 [QUALITY](QUALITY.md)；另记抽取事实/视角/地点、情绪幅度/因果/对象、管理员保留旧素材/任务完整/工具合法性等任务正确性。两次重复和十二个固定输入不证明总体或400轮改进。

本轮采用用户已核实的官方配置与价格：[模型ID](https://api-docs.deepseek.com/api/list-models/)、[chat API](https://api-docs.deepseek.com/api/create-chat-completion/)、[Low思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。这里只准备入口，没有通过真实调用再次核实账户可用模型或账单。

## C05 App BYOK 接入与待验收矩阵

用户已确认Key来自DeepSeek官方。真实上游严格锁定`https://api.deepseek.com/v1/chat/completions`，拒绝第三方、query、userinfo、fragment与重定向，UI端点只读；不能把官方定价套到第三方。自定义HTTPS C05已完成仅精确invalid源、dummy Key的fake验证，不向第三方转发官方Key；真实任意HTTPS直连仍待共享预算接线。

使用全新临时浏览器上下文、新测试账户，不导入用户现有profile/数据库。用户在隔离App UI显式创建BYOK：Base URL `http://127.0.0.1:6285/validation-api/v1`、model `deepseek-flash`，Key由用户输入；用户配置是否保存由该真实App流程决定，测试后销毁隔离上下文。本页memory-only承诺不适用于生产App自身的显式BYOK存储逻辑。质量页确认官方端点后显式开始；App每次请求经同一代理自动归为C05，主/后台/意图先行/管理员多轮每个实际HTTP请求均计一次。为避免4次额度被后台调用花掉，先关闭不需要的后台和意图先行，只安排清单中的最小真实调用；不足则如实标部分矩阵。

host 在实际 HTTP 响应中设置 enforced 候选 CSP，原样对齐现有 Report-Only 策略。只对响应HTML注入隔离 bootstrap，不修改dist文件；bootstrap先于App模块执行，拒绝直接外部fetch和绕过代理的模型fetch。`securitypolicyviolation`只记 directive/disposition，不记URL、正文、样本或凭据。代理只接同源JSON POST且验证Host；上游禁重定向，错误体不转存。

独立质量页只证明 production provider wire/parser、Low注入及预算接线，不能替代真实App验收。当前代理的浏览器网络路径是loopback：**不能证明浏览器直连任意自定义HTTPS源的CSP兼容性**。若要验收直连路径，root必须先为全新测试context设置等价、逐请求的总账准入与用量结算拦截，再解除该测试上下文的外部fetch阻止；禁止绕开总账直接配置真实上游。该补充直连拦截本轮未实现。

部分一协议交接：当前 production provider 的 JSON 回退与管理员历史序列化没有完整保留/回传 Low 工具多轮要求的 reasoning_content。D02 shim 属于两侧共同测试适配，不能归因于 A09/A10，也不能替代 C05 实际 App 的工具 Low 兼容性验收；产品路径未在本补充修改，该缺口仍待产品归属方处理和验证。完整链只在本次内存协议回传中使用，不进入页面、导出、错误或账本。

| 项目 | 本轮证据 | 后续真实验收/证据 |
|---|---|---|
| enforced CSP | 最终Edge fake smoke与实际App正常路径/违例探针通过；inline被阻止、其它HTTPS/错误dummy被拒 | 真实BYOK与源矩阵仍需验证；正式配置仍Report-Only |
| production App | 最终dist主/副对话假模型可显示；SSE回复刷新后落盘、错误仅保留既有透明动作且刷新同ID | 真上游主/副对话验收；Low工具续传已知缺口先修 |
| streaming/nonstream | 真App fake SSE和JSON回退通过，实际provider路径 | 真上游SSE；需要时同wire `stream:false`测JSON；产品发送stream:true，JSON仅回退 |
| stop/errors | 真App slow loopback停止/刷新无完整回复、429可读且无dummy正文；透明动作唯一精确文本/同ID通过 | 真上游停止/错误/usage；失败或未知usage停止，不自动重试 |
| 自定义HTTPS/loopback | 精确invalid HTTPS/dummy与loopback fake通过，没有真实网络上游 | 任意HTTPS直连另补共享预算拦截后验；本地目标另批准 |
| PNG/JSON导入 | 真App上传固定非秘密素材、卡库内容通过 | 真实BYOK完整矩阵的相关组合仍待，不用素材测试推定模型通过 |
| background data/blob | 真App data背景显示/解码，文档内blob图像策略探针通过 | 不声称App自身使用blob背景 |
| lazy worker/offline | 设置lazy可加载，同源dedicated Worker策略探针通过；B06独立SW Edge6项通过 | dedicated Worker是探针，非App实际启动；未覆盖全部App离线/真实BYOK组合 |

正式 `deploy/nginx-security-headers.conf`、`deploy/Caddyfile.example`未改。真实BYOK与源验证前不得把正式header切enforced。

运维模板交接给部分一：`deploy/install-server.sh`当前生成unit已经有 PrivateDevices、ProtectSystem=strict、ProtectHome、kernel/controlgroups保护、AddressFamilies、RestrictSUIDSGID、LockPersonality、UMask=0077；`tools/sync-server/systemd`模板仍ProtectSystem=full并缺上述项。本轮不改禁区模板，必须在获准路径对齐后另跑服务启动/读写/备份权限验收，不宣称已一致。

## C06 Windows 同卷旁路恢复（SQLite及迁移/health通过，账户待验）

建议选现役Windows数据目录同卷的 `recovery-drills/<timestamp>/`，开30分钟窗口，在专用loopback端口启动恢复测试服务。源只读，使用已成功完成VACUUM INTO的快照，不替换生产DB、不停止生产。实际host与私有目录仅填LOCAL-NOTES，不进入公开报告。

最小准备条件是可访问的现役Windows主机、一份确认已经完成且未再写入的快照、同卷可写且空间足够的旁路目录和30分钟窗口。快照hash由操作者现场计算，不要求用户事先手报；端口仅在启动旁路服务前选定并确认空闲。真实路径与完成证据只留私有运维记录，用户不在聊天里提供地址或凭据。具体步骤见 [C06执行准备方案](./superpowers/plans/2026-10-09-c06-recovery-readiness.md)。root已完成副本及迁移/health层实演；完整账户解密恢复仍待验，详见[实演记录](./superpowers/plans/2026-10-09-c06-recovery-report.md)。

1. **SQLite副本恢复：** 记录源快照大小/hash及完成证据；复制到旁路，核对源未变、副本hash一致。在副本以只读方式跑 `PRAGMA quick_check`，核对实际schema/version、各表汇总行数及已确认的关键关联；异常立即停。这一步不需要测试账户或解密材料，也不启动服务。
2. **应用恢复：** 另复制一份可写的服务副本，保留上一步未迁移副本和证据；同步服务启动会自动迁移数据库，不能把启动后的hash当作原快照hash。仅在独立测试账户/用户自行输入解密材料就绪后，用专用loopback服务验收读写/解密、epoch/cursor、增量同步和重连。所有写入限于服务副本，测试实体不进入生产账户。
3. **结果分层：** 分别记录SQLite副本恢复和应用恢复的通过/失败/待验；quick_check通过不能证明正文可解密，缺账户材料也不抹去已完成的副本检查。快照恢复时间点及可确认的RPO、各阶段实际耗时分别记录；没有生产写入参考时间时RPO记未测，不用文件mtime猜测。RTO按所测阶段命名，不把仅打开副本的耗时写成应用可读写RTO。
4. **收尾：** 若启动服务，先停本次测试进程并确认端口释放；保留非秘密报告和hash。默认保留旁路副本，只有在核对绝对路径属于批准的本次recovery-drills子目录后才清理；不删源快照或生产文件。

每桶30个成功快照的保留策略属于部分一待修：周期 `backup.mjs` 直接写最终target，按basename前缀和`.bak`的字典序裁剪到30份，没有quick_check/partial发布；管理员前置快照有partial+quick_check+rename但没有GC，同basename同目录还可能落入周期裁剪范围。不能写成“已成功发布后才裁剪，每桶保留30成功快照”已经实现。策略统一单独验收，不作为检查一份现成完成快照的前置阻断条件。

## D08 Android 真机清单（用户之后验收）

记录 build commit/sourceHash、安装来源、Android设备型号/系统/WebView版本、USB或远程调试方式；仅记录必要非秘密信息。依次勾选PWA安装和独立启动、重启/回前台、已缓存离线启动、软键盘与输入框、系统Back、BYOK流式/停止/错误、测试账户登录与多端同步、缓存更新后版本一致。截图/日志避开Key与个人对话。当前桌面入口是PWA app-window，不能叫原生Tauri壳；本轮没有Android设备实测结果。

## 2026-10-08 最终fake运行证据与真实入口

`logs/quality-smoke-final-closeout.log`：真实新Edge上下文增强smoke PASS，盲评双方共同背景、原始/评分/映射下载、完整wire hash、刷新保fake账/清Key、enforced内联阻止和App默认外部fetch拒绝，真实0。图片仅来自fake准备窗口；用户输入真实Key后未截图/HAR/trace。

`logs/csp-browser-final-pass.log`：实际最终production dist下 **7 passed / 1 skipped**。先前首轮5个Key exact selector超时、第二轮错误动作假设、第三轮保存状态strict冲突均保留为失败记录；最小夹具对齐后通过，没有产品/CSP改动或结果断言弱化。错误真实既有fallback仅保存“CSP 测试角色看向你，暂时没有开口。”透明动作，唯一action、无角色bubble/模型文本/原始错误/dummy且刷新同message ID；不能将它描述成角色行完全为0。独立两遍增量复审PASS。

真实host由root命令`node tools/desktop/validation-host.mjs --initialize-ledger`首次启动；旧账本不可覆盖，后续重启必须不带初始化参数。首次status为locked、busy=false、real0、fake0、无违例。页面已安排在当前任务打开（app工具返回queued），用户确认已填入Key；本机控制工具初始化故障后的手动单样本等待见首段。不得重新初始化、删账本或为了获取Key读页面输入值。

### 首个真实样本（19:57下载，未通过质量验收）

用户下载的`quality-raw.jsonl`、`quality-unblind.jsonl`、`validation-ledger.jsonl`仅按指定文件读取，核对后保存在ignored `apps/web/tests/quality/.local/evidence/2026-10-08-first-real/`，另存文件大小/SHA256。递归字段核对不含Authorization/API Key/reasoning_content；实际导出wireHash复算一致。没有复制浏览器profile、截图或推理链。

本条为`B001`、shared `affect-1`、repeat2，`deepseek-flash`、thinking enabled、Low、stream=true、max_tokens1200。导出error为`budget-truncation`、text为空、usage/parse为空；这只说明没有完整可评分输出，不能推定模型能力或真实原始流没有内容。host将供应商length/max_tokens终态分类为budget-truncation；账本保守保留本次¥0.01213并停止，不退款、不自动重试。没有人工质量评分，也不将此作为管理员A/B证据。

### 用户批准4096并保账后的接续

用户明确选择4096后，root集中validation40/40、quality50/50和专用tsc、lint449文件、隔离构建及增强fake smoke通过；正常、发送后停止、指令损坏、fake启动失败四种helper演练均达到预期，独立两遍规格/质量PASS。详情见[浏览器验证记录](./superpowers/plans/2026-10-08-live-validation-browser-report.md)，子任务没有运行测试。

受限恢复仅允许完整原始zero→pending entry1→budget-truncation历史与指定可信checkpoint，无损坏/pending/poison/其它失败/重复审计；先fsync追加审计才unhalt。未知后续失败仍停止且不复用本次许可。新host确认保留1/48、quality1/44、¥0.01213/5，原history字节和entries未改，profile4096、mode=locked、busy=false、halted=false。首条不重发；新窗口按semantic tuple跳过，旧盲号不作为恢复身份。窗口ready，用户需只在新窗口输入Key后回复，由root开始；目前无后续请求或质量评分。

原1200冻结baseline和历史requestHash保持，新client/upstream/profile hash分别记账；上游hash为实际JSON.stringify UTF-8字节SHA256。预算仍合计48请求/5元、quality44/C05留4，¥0.01213不是供应商实际账单。正式CSP继续Report-Only，待验证（归 Codex）。

收到“请继续”后root尝试发布一次显式start；该窗口没有进入真实模式、未出现RUN_START、没有新增请求。助手保存0行原始证据，确认锁定、清Key及关闭自有浏览器，受控exit1；不能据此判断具体Key或UI原因，因为未读取凭据且未保留原始UI错误。新的自有窗口重新ready，必须收到用户确认这个新窗口已填入后再发布start。首条/审计/费用和4096profile不变，不再次恢复账本。

## 2026-10-09 B06 同一真实ServiceWorker跨30秒补验

独立Edge常驻worker补例 **1/1通过**：同一worker在真实墙钟437 ms内完成受控导航后仍保留A pointer、没有新增staging；31,020 ms后真实导航允许更新，发布C HTML/manifest/稳定图标，A模块清单和`sw.js`字节保持不变。前后`performance.timeOrigin`一致、CDP target始终为同一个且未关闭、worker计数为1，并且对应CDP生命周期记录没有`stopping`/`stopped`，共同支持worker未重启。新离线页读取C外壳并成功首次加载lazy A。用例32.1秒、runner 33.3秒；既有VM/策略/六项Edge门禁未重跑，产品SW和依赖未改。

本例通过挂起真实fetch事件并用`waitUntil`保活，以观察同一执行实例跨越30秒后的节流与刷新行为；这不是Android系统让worker在后台持续存活的证明，Android离线/系统回收仍待真机。用例直接读取`apps/web/public/sw.js`，本次没有用production `dist`，不能据此确认dist与源码新鲜度。详见[B06补验报告](./superpowers/plans/2026-10-09-b06-standing-worker-report.md)。

## 2026-10-09 C06真实恢复副本的合成账户验收

真实App构建新鲜度检查通过；两个独立非持久Edge context通过UI注册/登录、角色卡/世界创建、同步、世界/主对话选择及场景地点核对，六阶段往返全部通过。A增量游标从7前进至B写回15，A最终17；重载后新HTTP拉取与新增实体精确内容核对通过，quarantine/非预期外连0。恢复副本优雅停机，SQLite/关联/外键及只读再核对通过，源/原始副本hash不变；测试进程、端口、本机转发均0，六生产服务Running。原五次入口/定位失败和各隔离副本留证，不覆盖或跳过断言。

本轮没有模型Key、付费模型请求或真实质量评分；6285未重开，不等待Key输入，不重置或再次恢复账本。D02真实仍1/48、quality1/44、¥0.01213保守预留；C05正式仍Report-Only，待验证（归Codex）。新账户新密文通过不能替代旧历史正文解密，C06的旧历史/RPO/完整应用RTO及保留规则未关闭。完整结果见[客户端报告](./superpowers/plans/2026-10-09-c06-account-client-report.md)。

## 2026-10-11 D01运行器退出补验

root运行无Key、本地限定来源的真实Edge隔离探针，用自有PTY的Ctrl+C触发已有runner SIGINT；正常清理与受控Vite首次SIGTERM传输失败后的3002 ms升级SIGKILL均取得证据。两次父Node记录130，外层PowerShell/tool因中断返回1；每次记录的13个自有进程身份与6273监听均无残留。只关闭“中断/三秒升级无运行证据”这一窄缺口，未覆盖原生OS故障或所有退出分支，D01 worker通知/CAS仍待部分一。产品runner、依赖和旧门禁未改/重跑；子任务只静态复核。

真实模型账本仅做只读SHA核对，仍为`270eaf03a9cd89586ac5dbdae8aa26d904505a075daa5e06f1f544f9081ffce1`，原1/48、quality1/44及¥0.01213保持；未启动6285、输入Key、再次恢复账本或新增调用。C05正式仍Report-Only，待验证（归Codex）。详见[退出补验报告](./superpowers/plans/2026-10-11-d01-runner-exit-report.md)。
