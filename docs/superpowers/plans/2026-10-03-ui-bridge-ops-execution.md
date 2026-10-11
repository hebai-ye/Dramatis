# 执行台账 — plan: docs/superpowers/plans/2026-10-03-ui-bridge-ops-review.md

基线：4c5169a；2026-10-03；用户选择：Q1B Q2A Q3A Q4A Q5A Q6A Q7A Q8A Q9A Q10A。

本轮实施已获准；原报告是第一轮只读记录，不覆盖本轮实际结果。

Ruling: 执行记录和brief保存在docs内，不使用会修改忽略规则或Git元数据的SDD脚本 — 用户限定写入边界，当前为外部管理的detached worktree。
Ruling: 原报告Global Constraints的“第一轮只交报告”仅适用于上一轮 — 本轮明确选择方案后执行本组允许工作；不自动修改部分一文件或生产部署。
Ruling: Q7允许测试依赖、浏览器安装和测试路径，根lock仍归部分一 — 优先隔离测试harness的依赖/lock，避免跨组改共享根锁。
Ruling: Q8明确批准最多48次请求、5元，指定DeepSeek V4.1 Flash、Low — API目标为deepseek-flash/low；可用配置仍待用户通过界面设置，准备夹具和预算守卫，不读取密钥。
Ruling: Q10批准安排验证，未提供设备/配置不等于设备已可用 — 先发现可用条件；CSP在真实强制BYOK验收前保持Report-Only。

## 预检接口与重叠

| 任务/重叠 | 产出与消费 | 处理 |
| --- | --- | --- |
| C02→C04/C01/C03/D09/D10 | 真实主机替换先于后续文档修改 | 单一文档实施者按用户顺序完成，不复制真实值 |
| C04/C01/D09 | 共享README/DESIGN | 同批顺序修改，当前能力与愿景区分 |
| C03/C06/C05 | 部署现状、备份策略、安全模板 | 先如实说明现状；目标策略/真验未完成不勾通过 |
| D10/其余项 | 阅读证据与结果记录 | 只记录实际阅读范围，不补造旧§49 |
| A11/B05/A10/D03/A13 | 共享App/组件/CSS | 顺序提交工作diff，不并行改共享实现 |
| B04/A09/A10 | admin与SideChat接口 | bridge守卫先落；目标在请求时固定；世界书沿用实体payload |
| B01/B02 | 回复状态机与CDP期限 | 回复身份严格识别；断线/超时取消实际工作后释放队列 |
| B03/B06/D05 | public/build输入/离线资源 | 保留109清单，worker导航触发；依赖下载与首屏执行分开计量 |
| B07/A09/A10/A13 | session版本与写入/启动 | 先固定时序复现，UI提交守卫不冒充存储CAS；recovery等部分一契约 |
| D01/各UI测试 | 真实浏览器/IDB与隔离数据库 | 不改db/sync，测试数据独立于用户数据 |
| A01/D05/D04 | 仅复审/方案 | 不实现密钥变更、不重分包、不开展大拆分 |
| 每项内部一致性 | 文件、方案、测试与状态 | 当前报告26项均有对应段落；新测试不假称已存在，外部验收不以模拟替代 |

## 状态

| 项 | 状态 |
| --- | --- |
| C02 C04 C01 C03 D09 D10 | Task1 complete：独立复核fix1已通过，文档完成 |
| A11 B04 B05 | Task2代码/状态机complete：fix1独立复核通过；D01/B07最终联测未关闭 |
| B01 B02 | Task3代码fixture complete：fix2独立复核通过；真实站适配待验 |
| B03 | Task4代码complete：fix1两遍复核通过；最终真实Vite构建待验 |
| A09 A10 D03 | Task5代码范围完成：fix1只读两遍复审通过，root确认当前增量与审阅补丁完全一致；新收尾待集中验证 |
| B06 | Task6实施中：public-only导航刷新，子任务不运行检查 |
| B07 | root集中固定时序5/5复现失败；版本设计准备中，继B06候选后实施 |
| A13 | 等部分一安全告警契约；可先准备web展示 |
| C05 | 候选模板/清单；强制提交等真BYOK |
| C06 | 30成功快照/桶策略已选；实现交部分一，演练等服务器条件 |
| D01 | fake6/6、Edge真实双页6/6且独立复核通过；产品UI/SW/session最终联测待补 |
| D02 | 已批48次/5元；DeepSeek V4.1 Flash / Low，用户选隔离测试页输入Key；先准备入口 |
| D08 | 用户澄清真机验证由其之后处理；本轮交清单，未实测 |
| A01 | 复审选择B，交部分一后续，不改crypto/sync |
| D04 | 分期方案已交，不拆代码 |
| D05 | 已复审，文档改口，不关闭全部打包任务 |

## 环境与验证

- 既有依赖：pnpm install --frozen-lockfile --ignore-scripts，退出0，根锁未修改。
- 当前为linked worktree、detached HEAD，不另建checkout。
- 基线pnpm test退出0：core 74文件/857项、web 31文件/209项、sync-admin 88项；同步工具编译通过。
- 基线web生产构建退出0，187模块；首屏三个静态JS496453+17106+135853=649412B。D05旧记录649422B是当时构建值，差10B不改历史；分包/懒加载已存在，后续只在新节说明。
- C02审阅附件已脱敏，真实映射只留deploy/LOCAL-NOTES.md；该文件与logs附件均check-ignore确认忽略。

## 审阅循环

- 文档批次review1：规格❌/质量Needs fixes；Important README:188绝对“不存Key”与账户密文同步矛盾，已退回原实施者修正。私有映射忽略状态、未连生产/恢复未实测由root独立确认；阅读台账只列实际局部范围。
- Task1 fix round1/5：README修正为同步服务器不能读取Key明文；review ADDRESSED，无新增Important。Task1 complete（工作区diff，未提交；review clean）。
- Task2实施者ui_navigation_implementation：brief为ui-navigation-brief.md，报告ui-navigation-report.md；基线HEAD仍4c5169a。
- Task2中途red证据：Composer 4/5失败（disabled/busy/bridgeOpen/空白Enter误发）；聊天导航5/5失败（桥接清输入、定位无消费和离底反馈）。green及A11待实施者完整报告，尚不计完成。
- Task2报告green：4文件22项通过、web typecheck通过；review规格✅但quality Needs fixes，root真实lint发现21errors且报告“Biome不可用”需校正。fix1已派原实施者；保留messages依赖并说明节点重试，不删以逃过lint。
- Task2 fix round1/5：22 tests/typecheck/9文件Biome0errors0warnings通过，复核ADDRRESSED（Important及报告Minor均已修）；Task2 scoped complete（工作区diff，无提交，review clean）；跨批B07/D01仍按表待联测。
- Task3实施者bridge_implementation：bridge-brief.md→bridge-report.md，HEAD仍4c5169a。

## 实施裁定

Ruling: B01未知真实DOM只接受可验证的角色/身份/终态契约，未支持页先拒绝发送并提示手动回填；--pattern保留选页能力 — 旧算法会把用户或旧回复当成功，猜选择器没有依据 — 若真实站点缺契约将暂不能自动桥接，待真站适配恢复。
Ruling: B02提交状态不确定的target拒绝下一轮，关闭旧标签后新target或人工重启复位 — socket关闭不能证明网页撤销已发命令 — 保守恢复增加一次人工步骤但避免双发。
Ruling: B06使用generation/pointer和独立runtime cache，保留109清单与上一版模块 — 导航频繁刷新会暴露旧cache多步写/清理中断和头像丢失 — 内部迁移较大，需失败测试与真浏览器验收。
Ruling: 本轮C05/D02真实调用共用48次/5元，预留CSP四次，未覆盖的质量矩阵如实记录 — 额外CSP不能绕开预算 — 最多先44质量样本，可能无法完成原48样本矩阵。
Ruling: D02相同prompt hash的角色/抽取/情绪复用现状结果，只有变化admin做A/B；每admin最多2轮，整体最多42+4=46请求 — 禁区core未变，重复相同prompt不能证明改进 — 不能给非admin相对提升结论；实际少于原48样本草案。
Ruling: B05本批保护focus目标/序号和取消；session旧选择迟到重写快照交B07统一修并最终联测，不在App做重开旧世界恢复层 — 两个版本/选择实现会相互冲突 — B05跨快照导航的最终验收在B07后才能关闭。
Ruling: 独立D01测试基础设施与B01/B02并行，分别独占tests目录与local-bridge；生产缺陷仍按用户顺序，SDD其它规格/审阅门槛照常 — 开发者要求可独立并行时主动委派；隔离依赖不改共享根锁、src或桥接 — 若隔离失败可能影响依赖，必须hash确认根锁未变并停该安装。
- 新测试与五门禁结果逐批追加；历史测试结果不充当当前通过。
Ruling: C05/D02 入口及 C06/D08 清单与桥接、D01 并行，独占 quality/**、validation-* 和新验证文档，不改 product src、IDB package/lock/config 或桌面启动实现 — 开发者要求独立工作主动委派，先冻结管理员基线并减少等待 — 若候选装配稍后变化必须重生成 hash，测试入口不代表最终真 BYOK 通过。
Task3 review1：规格部分符合/质量Request changes；Important：不确定target切换解锁、回复跨其它user归属、WS未等实际关闭即释放、核心行为测试不足。fix round1/5退回原实施者；Minor deadline-only signal默认同批修。真实站点依旧待验。
- D01基础设施报告：fake6/6、Edge154.0.4258.48真双页5/5，根lock hash未变；独立review中，非IDB await负向及worker/CAS接口仍待补验。
- D02 baseline已从4c5169a真实admin源码装配冻结为079b8bd082d6131fddfd20b7b7846a48e29b3c8e18c051967f939ebc276156d5，12case候选当前同hash；后续管理员改动后重生成。当前0/48请求、0/5元。
D01 review1：规格PARTIAL/质量CONCERNS；Important原生delete pending未真等待、cleanup异常跳过context.close；Minor runner仅kill不等exit/未处理中断。fix round1/5原实施者修，浏览器失败清理要留证据。
D01 fix round1/5：3 findings ADDRESSED，无新Critical/Important；scoped基础设施complete（工作区无提交，review clean）。fake6/6、Edge5/5，rootlock未变；真实UI/SW联测仍未关闭，worker/CAS依赖交部分一。Minor deferred：信号中断与强制升级退出分支未有实测；final broad review需复核。
Task3 fix1 re-review：4 ADDRESSED，关闭卡住路径Important仍open；Node原生WS无terminate，click前输入已发但未标锁。fix round2/5：采用独立子进程承载native WS且强制终止后等exit再lease释放，mutating命令前标不确定，成功关闭后解锁；保留unknown DOM与access policy。
Ruling: B02默认CDP WebSocket由可终止独立Node子进程承载，关闭卡住则kill并等待实际exit；输入写入发出也标target不确定 — 原生WS无公开terminate且新依赖未获批，不能靠可选fake能力假称关闭 — 每连接增加进程开销，已发网页命令不能撤销所以仍需target guard。
- 日期续记：客户端已到2026-10-04（Asia/Shanghai），延续同一批次；冻结夹具固定时间2026-10-03不改、报告文件名不重命名。
Ruling: D02真实费用账本按DeepSeek官方未命中高峰价格预留，真实代理限定https://api.deepseek.com/v1/chat/completions；自定义HTTPS C05路径另以无真实Key的fake验证 — 用户只授权DeepSeek V4.1 Flash/Low和5元，无第三方价格或密钥传递许可 — 若用户实际Key来自第三方，需要其明确端点和定价后再调整，不默认发送。
- 用户2026-10-04明确配置来源：DeepSeek官方Key，隔离页输入；官方端点限制与价格预算假设已确认，仍0真实请求。
Task3 fix round2/5：剩余Important ADDRESSED，无新Critical/Important；B01/B02代码fixture scoped complete（无提交，review clean），44tests通过。真实DeepSeek DOM/端到端与实际ws-worker native handshake尚待运行验收，不能称真站自动桥接可用。
D01补充auto-commit：真实Edge6/6，新用例单例1/1；非法callback越过原生complete后第二笔reject、第一已持久，区别正常throw回滚。增量review规格/质量PASS，无新Important；CAS/worker通知仍依赖部分一。
Task4 B03开始：desktop-brief.md→desktop-report.md，继桥接review clean按顺序实施；quality准备只独占validation-*不碰launch/build-inputs。
- D02冻结元数据升级schema2：逐builder完整输入，经12请求canonical完全相等才允许元数据修正；baselineHash更新a490d9633ebf203737f87890b429b1181120cc1f6f9cd618a5b55f3d22820f3b，旧079b值为schema1初始记录，不作为当前基线。
Ruling: 质量审阅包保留完整手写实现/测试，冻结manifest仅提供路径/完整文件hash/逐case hash，由reviewer按需读取实际数据与生产builder对照 — JSON重复保存两组完整prompt，直接打印淹没审阅上下文且不提供新的实现信息 — 若派生数据有误仍需实际抽样/生成测试发现，不能仅凭metadata批准。
C05/D02入口与C06/D08清单报告DONE准备，Node6/6、web243/qualitytypecheck/build/Edgefake通过，真实0。root scoped Biome check发现25errors/26warnings/9infos（报告仅format）；独立规格/质量review中，未交真实Key页启动。
Task4 B03 review1：Important产物index未核对manifest入口、产物内容未记录导致dist更改仍fresh；Minor existing服务检测在依赖前置之后。fix1/5原实施者修，真实Vite产物验收待最终。
C05/D02准备 review1：Important预算write+rename未同步落盘、盲评缺共同case背景、25lint errors；Minor实际wireHash无法由导出子集重建。fix1/5原实施者修，真实Key页尚未开始。
Ruling: B03将入口JS/CSS与清单一致性及全部dist产物内容摘要纳入复用校验 — 仅存在/尾注校验允许旧或损坏入口、JS和SW正文被判fresh — 额外hash I/O，但产物更改/缺失保守重建更符合已验证最新的承诺。
- 日期续记2026-10-05：恢复B03与质量准备fix1，已通过批次不重做；真实0/48、0/5不变。
Ruling: A11/B04/B05 真浏览器fixture先与桌面/质量修正并行，仅独占tests/ui/**与ui-*，D03/SW/session候选联测仍后置 — 独立测试实现可缩短后续等待，用户产品缺陷顺序未改变 — 若B07改变接口/状态，必须重跑相关真实行为，不沿用旧green。
Task4 fix round1/5：此前两项Important与Minor均ADDRRESSED，规格PASS/质量PASS，无新Critical/Important；B03代码范围complete（无提交），9/9、Biome和语法证据复用，真实Vite构建与prod入口待最终验证。
Task5 A09/A10/D03开始：admin-dialog-brief.md→admin-dialog-report.md；按顺序实施，保留先前导航/bridge守卫，不并行改共享产品源码。
A11/B04/B05真实Edge阶段报告：7/7，Edge154.0.4258.53；真实App/CSS、实际Composer/MainChat/SideChat与90条历史滚动。新增fixture独立审查中；B07后相关联测、D03及B06尚未关闭。
UI真实fixture review1：3 Important（定位/保位断言假阳性、手动回底与非空第二会话跟随证据不足、负向消费缺DOM/effect屏障）及2 Minor，fix1/5退回原实施者；初始7/7不计最终阶段验收完成。
UI真实fixture fix1：加强断言在旧fixture先6pass/2fail，补提交标记和非空第二会话后Edge8/8、6文件Biome通过；两遍复审PASS，3Important/2Minor全部ADDRRESSED，无新Critical/Important。全web typecheck受并行admin-session.test.tsx四处TS2554暂阻，留产品批收口；B07后相关联测/D03/B06仍后置。
桥接补充原生运行探针：`node logs/bridge-native-runtime.mjs`退出0，真实默认ws-worker在loopback受控WebSocket服务器上握手/IPC回复/正常关闭、父IPC断开实际exit0、不给close ack后terminate等待实际子进程结束均通过。首次探针把父IPC主动断开后的Node close事件当作worker exit屏障而超时；日志显示worker已exit0，改用实际exit事件后通过，未改桥接产品源码。真实DeepSeek DOM/端到端仍待验。
- UI fixture与质量准备fix1遇模型服务usage limit中断；用户继续后恢复同一实施者的已有工作，不重做已通过批次、不增预算。
Ruling: D03真实Modal浏览器fixture可与管理员实施者并行准备，只独占已有UI测试目录；最终运行与验收等管理员候选稳定 — 独立测试不改共享产品源且D03单测不能证焦点/inert — 如候选变化仍需针对重跑，不把暂态失败算生产结论。
C05/D02准备fix1两遍复审通过：3Important、追加并发要求和wire Minor均ADDRRESSED，无新Critical/Important；Node13/13、quality10/10与25文件Biome证据复用。最终freeze/typecheck/build/增强smoke仍等管理员候选固定，真实0/48、0/5。
Ruling: C05零成本App浏览器fixture可并行准备，独占tests/csp/**及csp-*，不改质量host/产品/CSP；假HTTPS只允许精确invalid源+dummy Key的隔离脚本例外 — loopback不能验证HTTPS策略，开发者要求独立测试主动并行 — 必须保留真实enforced策略与默认外部拒绝，fake不计真BYOK通过，最终仍待新dist及真实调用。

## 2026-10-07 最新执行策略

用户要求子任务不单独测试、多个功能完成后总测试。后续实施者只实现/准备测试与报告，不运行测试、typecheck、lint、build或smoke；此前已执行结果仍按日期保留，不重做。root集中门禁和真实浏览器验收；独立只读审查仍可并行，不假称新代码已通过。

Ruling: B07仍先构造固定时序用例；version算法前由root在多个功能已完成后的集中验证窗口确认复现，子任务不自行运行 — 用户最新测试节奏覆盖原brief/skill的逐项red/green要求，但先定性要求保留 — 无复现证据前只准备夹具与设计，报告不写旧A覆盖B已复现。

root官方协议核对：带tools的Low思考后续assistant必须回传reasoning_content；当前provider序列化/admin追加消息未保留该字段。D02私有内存协议shim待补，两侧同用且导出不含chain；正式provider禁区兼容交部分一，C05仍待真BYOK。不会用付费失败来发现已知协议问题；当前真实账本尚未初始化、0/48、0/5。
Task5候选报告已交：条目delta/diff/反向draft、固定场景目标与bridge持久绑定、通用Modal接DialogShell完成；10-07最后收尾未跑测试。历史core65、web76/typecheck/24文件Biome绿仅作为历史，admin-dialog-review做只读规格+质量审查。
Task5 review1：Important早期真实生成器无before/base但“新建世界书”摘要可识别，被无条件undefined-base分支误判修改；Minor目标读取失败后旧world错误可能显示到新world。root以git show f5065ba^的真实生成器和当前源码核对后退回原实施者fix1/5；只编辑/静态审查，运行仍集中。
Task5 fix1只编辑5文件完成，历史缺省before/base新建形状与旧错误scope已处理，独立只读复审中；未执行运行门禁。
D02 Protocol只读review1：Important生产parser会补缺失工具ID/arguments，shim只看归一化calls无法证明真实身份；Minor SSE明确空reasoning被过滤后与JSON不同。root核对provider finishToolCalls源码后退回原隔离实施者fix1，要求原始协议字段校验且不改core；只准备用例，中央运行待后。
2026-10-08接续：保留用户集中总测策略；admin fix1两遍静态复审ADDRRESSED，无新Critical/Important。默认shell/node通道出现本机沙箱初始化故障，无命令执行；root以自动审核允许的限定只读shell核对当前增量与已审阅admin-fix1.diff，完全一致（True），关闭当前磁盘一致性缺口。源码编辑仍用正常apply_patch，未改沙箱/系统设置；运行门禁未执行。
Task5代码范围complete（工作区未提交，静态review clean），历史测试不冒充当前通过。Task6 B06按顺序开始；B07仅独立夹具准备并行，不编辑生产session/App，root集中复现后才允许版本原语实现。
D02 Protocol review1 fix1候选完成：新增原始SSE/JSON观察，缺工具ID/arguments在第二fetch前拒绝，显式空reasoning与缺失分开；继续只读复审，所有新用例未运行，真实0/48、0/5。
D02 Protocol fix1只读两遍复审通过：原Important/Minor均ADDRRESSED，无新Critical/Important；补充挂起SSE abort/损坏事件源取消及缺name/变化ID用例准备中，root集中运行。此隔离shim不关闭正式App Low工具多轮协议的部分一交接项。

## 2026-10-08 root首个集中验证窗口

多项界面、桥接、管理员与弹窗功能已完成后，由root统一运行（子任务没有执行测试）。默认沙箱初始化故障仍在，使用自动审核允许的受限任务命令；未改系统设置、未访问真实Key或用户数据库。

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| `pnpm --filter @dramatis/web test -- src/components/SessionHarness.test.tsx` | 退出1，5/5预期行为断言失败 | 固定Promise屏障与真实Repository/useSession：旧open、reload、message/scene更新、ABA均复现UI覆盖；失败后的lastRoom断言未到达，不称元数据缺陷已验证 |
| `pnpm --filter @dramatis/web exec vitest run tests/quality` | 退出0，4文件37项通过 | 包含原始协议身份/空值及挂起abort/源取消等fake测试，无真实调用 |
| `pnpm typecheck` | 退出0 | 当前core/web/tools与sync-admin类型检查通过；后续B06/B07改动不继承此结果 |
| `pnpm exec tsc -p apps/web/tests/quality/tsconfig.json --noEmit` | 退出0 | 隔离质量页独立类型配置通过 |
| `node --test` 六个桌面/质量/桥接测试文件 | 退出0，51/51 | build-inputs、validation baseline/budget/durability/host、bridge；全部受控本地fixture，fake上游不访问供应商 |

日志：ignored `logs/session-fixed-sequence-red.log`、`logs/quality-protocol-central.log`、`logs/typecheck-central-pre-session.log`。B07先定性要求已满足，允许版本设计；按用户顺序待B06候选完成后编辑生产session/App。最终门禁、真实浏览器与新产物验证仍待收口，真实0/48、0/5。
同一窗口补充日志：ignored `logs/quality-typecheck-central.log`、`logs/tools-central-2026-10-08.log`。后续仅在新改动、实际失败或未关闭问题需要时重跑对应范围，不重复已稳定检查。

## 2026-10-08 用户模型配置约束

用户明确禁止后续使用gpt-6-astra，允许GPT-6.1 Sol与Luna各思考强度。会话恢复后旧子代理不再在活动团队中；沿用磁盘已有候选和已核实证据，未从零重做。

安排：SW与session等时序/一致性实现用6.1 Sol high，复杂最终复核用6.1 Sol xhigh；隔离冻结依赖核验用6.1 Sol high，浏览器runner整合用6.1 Sol medium；有限文档台账整理用Luna medium。子任务不运行测试，root统一验证不变。

新静态整合发现：D01的通配testMatch会带入后新增UI/CSP不同端口用例；browser runner清理等待不完整；candidate源码hash只枚举旧Git树，漏新增admin/world-book.ts。均在本组允许文件内准备修复，不改根锁或部分一源码；新增admin hash只加入candidate，旧baseline保持不变。

用户明确新增边界授权：仅更新 `apps/web/src/pwa/sw-policy.test.ts` 最后两例及必要mock以匹配B06。这不扩展到其它pwa/lib文件；保留两例的上一代lazy正向留存与失败保旧验收，使用独立命名缓存和实际WebLocks调用mock，不用无锁跳过替代。其余策略断言不改，root集中验证。此前“禁区测试待归属方更新”仅为授权前状态，现已解除这一限定阻塞。

验证基础设施source-hash与runner整合候选已完成，6.1 Sol high做合并只读复审；真ServiceWorker浏览器夹具由6.1 Sol high独立准备，只写tests/sw与sw-*，所有新运行仍归root集中。
整合两遍静态复审规格PASS/质量PASS。root额外按Windows递归删除约束补CSP realpath/自有直接子目录检查，准备集中运行；代理followup通道报agent thread limit reached，改用executing-plans接手剩余小项，不改模型禁用约束，不重做既有成果。仍活跃的6.1 Sol SW与浏览器夹具继续本任务。

B06候选交付后root集中运行生命周期+依赖测试：依赖6/6通过，39个SW case和策略suite均被同一SyntaxError阻断（runtime图片分支的async IIFE括号/调用缺失），尚无SW行为green。root定位共同解析点并改为显式async块调用，继续对应范围验证；B07已按顺序进入生产实现，禁止把此初次失败计为生命周期通过。
B06修补后策略11/11通过，生命周期38/39；唯一交错例在部署移除剩余A资产后错误地期望old A staging成功，产品拒绝404是正确保守行为。root修正夹具为old阶段失败释放锁、new阶段成功发布B，并用两次真实lock request屏障替换单microtask等待，不放宽产品下载校验；继续集中对应范围验证。独立复审工具受续接上限限制，现由未编写SW产品的6.1 Sol浏览器实施者独立只读审产品（不自审其浏览器夹具）。
独立review的图片迁移竞态/缓存拒绝两项Important经root实测3例失败，再修URL共享锁/网络降级，VM42/42通过；增量review新增static cache拒绝Important，两例实测失败后补降级，完整44例待验证。真实SW首次Edge4/6，两个fixture等待环已修，未以超时推断产品失败或称全部通过。
候选freeze和quality bundle构建已实际退出0：12case中9相同、admin1～3不同，baseline完整hash保持a490d9633ebf203737f87890b429b1181120cc1f6f9cd618a5b55f3d22820f3b；新candidateOnly映射包含admin/world-book.ts。真实账本未初始化、真实0/48、0/5。
B07/A13web候选已交：统一epoch/revision/scope及lastRoom队列，固定时序夹具10例+恢复报告/notice5例；生产运行门禁和独立复审待root，坏marker世界保留仍依赖部分一core安全契约。

root集中首轮：web48文件311项通过、类型检查修SW mock override后退出0；SW VM44/44、真实Edge首轮4/6与修夹具后的两例2/2通过。全仓test初轮core877/878，旧历史回答解析缺完整原书。用户新增限定授权仅对齐`packages/core/src/eval/prompt-samples.test.ts`的原书种子/解析上下文/必要断言；按最小提案实施，不改变历史回答或放宽生产校验。首次lint31 errors，安全格式修复后7 errors，继续收口。全部真实模型请求仍0，未初始化真实账本。

B07独立6.1 Sol xhigh复审发现首轮311项未覆盖的两个Important：已选C1可见时重新点击C1未撤销延迟C2；repo clone整实体的引用比较误判nested字段delta，可能将较晚discarded artifact覆盖成pending UI。已退原6.1 Sol实施者补固定时序与最小修复，不由子任务执行测试；先前green不能作为这两项完成证据。

独立session复审累计第3项为旧add迟到复活已reload再remove的角色。root新增4固定时序集中3fail/1pass，按revision冲突守卫重读后web315/315、typecheck退出0，原3项静态ADDRRESSED。增量review第4项：rename在pending会话切换中持久化旧active，冲突全量读将其带回UI；第15fixture root确认1fail/14skip（仅UI错、存储旧active明确作为部分一CAS边界）。继续最小保留mutation重读中的有效已提交选择，不使用filtered loadRoom损坏完整世界集合。

root追加集中证据：core878/878、sync-admin88/88、工具7文件57/57、quality专用tsc退出0，SW VM44/44和真实Edge6/6；D01修改后runner真实双页6/6。全仓lint修manifest重复格式漂移后439文件0errors/0warnings。真实`pnpm build`190模块退出0，B03实际产物fresh=true、第二次reused；后续session/UI若改动必须重建，不沿用此前产物状态。UI11项初轮10pass/1fail（新增独立历史后离底145px），仅失败单例复验1/1通过，尚未定位事件时序，不能称全量11通过。所有子任务本窗口仍未运行任何门禁。

## 2026-10-08 最终候选集中收口

显式导航冲突两例先red后改target策略，root补startConversation同族固定用例，完整web319通过。最终复审又发现归档回顾被过滤、普通fullread仍接受旧stored active两类Important；新增九个真实Repository/Promise屏障用例后集中27例为7fail/20pass。修补完整读取站点与提交时归档排除后，27/27及完整web48文件328项通过；独立Sol xhigh两遍增量复审确认两类ADDRRESSED、规格/质量PASS，无新Critical/Important。持久active/CAS及background loaded读取边界仍保留，未越界改core。

UI提前scroll新真实DOM用例先red gap145px；MainChat跟底改layout effect后完整Edge12/12。此固定竞争路径可证明修补有效，首轮10/11历史flaky根因仍不能据此确定；不把合成scroll事件称真用户输入。对应UI报告已追加准确范围。

| 最终门禁 | 结果与日志 |
| --- | --- |
| session / web | 27/27；48文件328项，`logs/session-policy-final-green.log` / `logs/web-final-closeout.log` |
| 全仓 typecheck | 退出0，`logs/typecheck-final-closeout.log` |
| 全仓 lint | 新fixture仅格式1项修正后439文件通过，`logs/lint-final-clean.log` |
| 实际生产构建与B03 | 190模块；fresh=true；第二次reused，`logs/production-build-closeout.log` |
| 最终隔离quality smoke | 真实新Edge上下文PASS：双盲共同背景、原始/评分下载、完整wire hash、刷新保账/清Key、enforced内联阻止及App默认外部fetch拒绝，`logs/quality-smoke-final-closeout.log` |

上述门禁均由root集中执行，子任务未运行测试。quality smoke使用假模型和临时账本，真实请求0/48、费用0/5；真实host尚未启动。实际App CSP矩阵首次运行出现UI等待超时，正在检查固定dummy夹具与实际可访问名，尚不记通过。正式CSP继续Report-Only；真实Low工具多轮产品协议、坏marker核心安全、服务器恢复和Android真机仍待相应归属或外部条件。

### 最终CSP矩阵与首个真实质量请求

root最终Edge实际App CSP fake **7通过/1已知skip**，`logs/csp-browser-final-pass.log`退出0；精确Key标签、桌面副对话、真正保存栏及错误透明动作夹具对齐经Sol两遍复审PASS。保留最初5fail、后续单项错误动作/保存状态fail的日志；未改产品或放宽CSP/落库验证。strict Low工具续传仍skip，正式Report-Only，待验证（归 Codex）。

真实6285 host首次创建共享账本，默认locked；app打开工具返回queued，用户确认页内已填官方Key。Cua两次因Windows helper setup refresh故障退出；备用只读调试端口诊断无可控browser，不涉及自动审核拒绝/Key/profile。用户手动只发送当前样本并下载原始/映射/总账。19:57证据核对：B001/shared affect-1 repeat2，真实1/48、质量1/44、保守扣记¥0.01213/5、halted=true、budget-truncation；没有完整可评分text/usage/parse。该金额是预留上限，非供应商实际账单。未读推理链，不以截断判断模型能力。

指定Downloads三份文件已验凭据/reasoning字段缺失、exportedWireHash可复算一致，复制到ignored `quality/.local/evidence/2026-10-08-first-real/`并记录大小/SHA256；没有扫描用户其它文件。原账本保留，不重发当前样本、减计数/费用或自动解除停止锁。输出1200→4096的共同执行profile/限定恢复/预算验证可审阅方案已写`2026-10-08-real-budget-truncation-proposal.md`，待用户选择；总授权48/5不增加。服务器、Android和部分一边界仍按表保持待验。

### 4096保账恢复（用户已批准）

用户选择“4096并保留账本继续”。Sol high分别实现profile/恢复与quality接线，Sol xhigh独立两遍静态合审，Luna仅整理提案，均未运行门禁。首次31项30通过/1关闭失败如实保留；最小关闭修订及断客户端对照后root集中validation40/40，quality5文件50项及专用tsc通过，lint449文件通过，隔离构建27模块、增强fake smoke通过。helper四种fake演练正常/停止/指令损坏/启动故障达到预期，前三例收尾独立断言通过，fake启动失败未改变真实mode或real state；最终独立规格/质量PASS。日志与边界见[浏览器报告](./2026-10-08-live-validation-browser-report.md)。

root核验真实原账本完整链、busy=false、端口与旧lock PID归属，保存原字节及lock后仅停止这个旧host。PowerShell活动文件hash读取受Windows共享模式拒绝，退出后严格失败模式重新验证原账本和quarantine保留锁SHA256，未把先前非终止错误当作通过。4096启动未带initialize，只追加一次绑定entry1与旧checkpoint的恢复审计；旧history字节前缀和entries逐字段保持，当前1/48、quality1/44、¥0.01213/5，halted=false但mode=locked、busy=false，无后续真实发送。新的自有可见Edge隔离窗口ready，等待用户在新窗口填Key；脚本不读取/转移旧Key，不重发旧语义样本。生产产物fresh仍true、根锁hash仍未变。正式CSP仍Report-Only，待验证（归 Codex）；本次恢复不关闭服务器/真机或部分一依赖项。
