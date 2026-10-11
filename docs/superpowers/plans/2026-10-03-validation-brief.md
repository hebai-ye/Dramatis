# D01 / C05 / D02 / C06 / D08 验证准备与可运行部分

用户批准Q7 fake-indexeddb、@playwright/test及浏览器安装/测试路径；D02最多48请求/5人民币，模型DeepSeek V4.1 Flash（官方API id deepseek-flash）、reasoning_effort low。用户已选择在隔离测试页输入Key，页需有masked输入、不读取/保存聊天/已有profile/环境凭据。C05允许本机隔离源及应用内BYOK配置；真机验证（D08）用户之后处理。C06用户不知目录，交推荐方案先。
本批允许apps/web/tests/**、web/package.json测试脚本、docs/**、deploy/**、tools/desktop/**测试harness。不改db.ts/sync/worker/root package/lock/core非admin/server/admin。禁止提交/push、生产部署、读取密钥或既有用户browser profile。无子代理。

## D01 隔离依赖与IDB/多标签

独立apps/web/tests/package.json+pnpm-workspace.yaml+pnpm-lock.yaml、node_modules，用pnpm --dir apps/web/tests install不纳入根workspace。fake-indexeddb测试*.test.ts可由web既有Vitest跑，Playwright用*.browser.ts自定义testMatch避免Vitest抓取。package web可加test:browser脚本，不改根锁。安装可用Chromium或专用测试context的channel msedge，不读既有profile；需要下载受网沙箱阻挡时报告再由root处理。
真实production导出createIndexedDbEntityStore(name)返回{store,db}无需改srcdb。每测试随机q7-test-*库，finally关闭连接且只删除其前缀。Fake层跨集合tx提交/异常回滚、复合key&结构化clone、listSince inclusive与room过滤、v1→v2升级保留row/索引、blocked与blocking events。minimalwindow/CustomEvent仅测试。真正两个page同源测blocked升级后手动close成功、生产blocking关闭让v3成功、delete blocked reject后原生请求继续须close持库再cleanup。harness页/tests/browser/idb-harness.html直接import db，只能测试前缀API，不初始化App/读取账户DB，不用现world-seed-probe。
UI真实浏览器fixture页可以import实际Composer/Modal/MainChat，播种隔离的最小props，测试A11（可App全新context）、B04键盘保输入、B05跳原句/新消息/回底、D03通用Modal Tab/Esc/还焦点；不写生产testhooks。此前实施代码接口看对应report。真实browser优先必要行为，不无意义宽测试。

## C05

准备局部HTTP server/代理在127.0.0.1隔离端口送productiondist并实际enforced候选CSP，测试非流式/流式BYOK、stop/errors、自定义https及loopback、导入PNG/JSON/background data/blob、lazyworker/offline。
不得通过读取userdata/环境/.env取得Key。仅用户在隔离app UI配置；用户会在页准备好后输入，先把页面/代理/fixture准备好供root交用户，不发真实model调用。Fake端点只证明CSP路径/错误展示，不能冒称真BYOK。deploy实际header在真BYOK通过前必须Report-Only，“待验证（归 Codex）”。systemd tools/server模板禁改，把所需对齐写交接清单；deploy/install-server.sh在其现允许范围可对齐template，但勿更改模板造成不一致无验收。

## D02

在docs/quality-fixtures新建12cases(角色扮演/抽取/情绪/管理员各3)冻结manifest。使用production assemblePrompt/buildExtractionMessages/buildAffectMessages/buildAdminMessages+ADMIN_TOOLS装配，不手写近似prompt；字面量固定branded IDs与时间2026-10-03T00:00:00.000Z，不用newId/nowIso creator。输入与请求canonical JSON递归排序object/保留array顺序，sha256覆盖messages/tools/params，并保存caseId/fixtureHash/commit。基线仍可经git show 4c5169a的admin源码在ignored临时模块中实际装配（其它core未变，dependency hash核对），不能拿candidate假充baseline；生成后只冻结JSON，临时源不进公开提交，不需另建worktree。
角色/抽取/情绪prompt若hash相同仅每case两次，复用作共同现状，不称改善；3admin若hash不同，每侧每case两次，可用production runAdminTurn(maxRounds:2)、execute仅回tool摘要不落库，每轮真实请求独立计数。这样共同9×2=18、admin3×2侧×2sample×最多2round=24，D02最多42+C05四次=46，比上限48留两次余量，不主动耗完。parsedraft新生id/time不纳hash语义比较。
质量rubric沿QUALITY五项0/1/2，非角色类不适用项记N/A，另列抽取/情绪/admin任务正确性，不把N/A算满分；隐藏侧别随机A/B顺序盲评，raw text/tool_calls/usage/parse/error与人工每项评分/证据/判分人分开存下载JSONL，Key不进入任何记录。两次重复仅探索证据，不宣称总体或400轮改善。
预算守卫总请求48/总费用5，未知usage按已保守预留费用计并停，不能退款假定；失败/中止也耗一次request保留预算，不自动重试。最大输出1200（包含reasoning，任何length终止记录预算截断，不推定模型能力低）。官方配置只承认deepseek-flash/low；primary source https://api-docs.deepseek.com/api/list-models/ 和 create-chat-completion。
提供从应用内配置执行的具体流程或独立临时配置执行入口，Key用户界面/临时environment设置，禁止Key写报告/日志；目前只准备，不真实调用。源码prompt-samples禁区，不修改。不要把12case小样本说成长期质量通过。
官方已核实模型价（2026-10-03）：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ ，高峰按未命中输入2元/百万、输出8元/百万保守估算，cache-hit与闲时不提前折扣。https://api-docs.deepseek.com/guides/thinking_mode/ 明确low并启用thinking，temperature/presence/frequency不起效不可当实验变量；使用max_tokens且完整completion含reasoning计费。每次发送前按输入文本UTF-8字节保守token上限+max_tokens预留费用；usage缺失按已预留上限计并停，不重新用同请求预算。
现production ModelParams不支持reasoning_effort，测试页可经ProviderConfig.fetchImpl包装实际adapter发出的body注入/校验low（或非流式直接用同wire），复用真实流式/tool解析而不改禁区core adapter；必须明确这是隔离验证配置，不称产品已有Low选项。不得落盘/console输出Authorization；真实调用关闭Playwright trace/HAR录制。
所有本轮真实模型调用（含C05复验）共用48请求/5元总账，单独预留C05四次；若只够44份质量样本就如实记录部分矩阵，不能为追求48份夹具超额再发CSP请求。可将真BYOK请求复用质量case但须请求messages与条件一致，不能硬算异构请求为质量重复。

## C06 / D08

docs交C06建议：以现役Windows数据目录同卷旁路`recovery-drills/<timestamp>/`隔离，源只读已成功完成VACUUM INTO snapshot，30分钟窗口、另起专用loopback端口测试服务、所有test实体使用新测试账户、不替换生产DB，不停止生产。实际目录从用户私有运维记录确认，仅真实host值LOCAL-NOTES。先列输入(快照路径/可写旁路目录/窗口)、quick_check/hash/schema/counts/测试账户解密/epochcursor/RPO-RTO实际计时/清理清单。核心保留实现归部分一，无服务器不伪造演练记录。
D08 checklist buildsource/Androiddevice/os/webview/USB或远程/pwa install启动/离线/keyboard/back/BYOK/账户同步/缓存更新，桌面目前PWA app-window不是nativeTauri；用户之后真机勾选，本轮待真机。

报告docs/superpowers/plans/2026-10-03-validation-report.md，按真实/fake/外部待验证列结果与请求账本（当前0/48,0/5），red/green或浏览器命令真实输出。源未验证不能改CSP强制。
