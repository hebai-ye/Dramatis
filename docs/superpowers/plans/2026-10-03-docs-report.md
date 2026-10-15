# 文档批次实施与校验报告

基线 `4c5169a`；范围 C02 → C04 → C01 → C03 → D09 → D10；日期 2026-10-03。用户已选择同 5 文件全部 27 行主机占位、Node 22.12 构建口径和主题报告加逐文件增量阅读证据。本批只改允许的公开文档、C02 模板与被忽略的本机映射；无产品代码、根 package/lock、服务端脚本、提交、push、部署、依赖安装或真实 Key 操作。

## C02

按桥接 README 第 16 行的同一目标主机，对 `docs/STATUS.md` 7 行、`docs/EVAL.md` 15 行、`docs/TASKS.md` 1 行、`deploy/nginx-80-redirect.conf.example` 3 行、`tools/local-bridge/README.md` 1 行作字面替换为 `app.example.com`。总计 **27 行、30 处字串**（3 行各含两处），目标主机在这 5 个当前文件中残留 0。仅字符串替换阶段的差异保存在被忽略的 `logs/c02-host-only.patch`，审阅前已将原值统一脱敏为 `<DEPLOYMENT_HOST>`；真实映射仅在被忽略、未跟踪的 `deploy/LOCAL-NOTES.md`，本报告不写具体值。

**完成门槛与证据：** 对基线原行逐一核对，27 条替换后的行都仍存在；替换阶段 `git diff --numstat` 为 7/7、15/15、1/1、3/3、1/1，不涉及历史段落增删。后续 C03 在 STATUS 的新说明和历史提示调整另行记账，不属于 C02 字面替换；历史日期、路径、端口、测试结论保留。没有重写 Git 历史。 `git check-ignore` 证明映射和阶段 patch 均被忽略。

## C04

`README.md` 与当前部署说明写明完整构建的 Node 22 分支最低 **22.12**，依据根 `package.json` 当前 `engines.node >=22.5` 与锁文件中 Rolldown 的 `^20.19.0 || >=22.12.0` 交集。根声明仍是 `>=22.5`，**协调修改交部分一**；本批没有编辑根 package 或 lock。各次历史实跑版本原文保留。本批没有在 Node 22.12 上运行构建，因此“最低”来自声明对照，非该小版本实测。

## C01

`README.md`、`docs/DESIGN.md` 简述并链接 `docs/SYNC.md` §4.11 为唯一详细账户凭据数据流。同步就绪时 `providerProfiles` 和 `providerCredentials` 属同步集合；本机 Key 明文先由账户主密钥封装，整条记录再经同步循环加密，服务端只见密文和协议元数据，不能读用户 Key 明文。会话/浏览器/口令加密选择只管本机缓存，不决定账户密文是否存在。BYOK 客户端到模型服务商与托管网关调用边界另述。对照了 `providers.ts`、web `sync.ts`、core `sync/loop.ts` 与 `sync/types.ts` 相关范围；没有使用真实 Key。

## C03

`docs/SYNC-DEPLOY.md` 增加现行入口：当前记录中的网页、同步、管理宿主是 Windows/Caddy/WinSW，旧 Linux 机承担入口与隧道；Linux/systemd 说明保留作历史/可选模板。`deploy/README.md` 标明 Linux 模板性质，`docs/STATUS.md` 加当前入口并将一段旧“现状”明确标成当时记录。

备份操作区分客户端封存、逐条同步、服务器一致性快照与冷备恢复。周期脚本和管理前置备份均以 `VACUUM INTO` 生成快照；只运输完成且校验的文件，不直接复制或覆盖运行中 WAL 主库。恢复说明要求先隔离核对，再停止/隔离所有持库服务与写入，保留回退点，切换后核健康和记录数。实体内容与 Key 凭据密文不等于整个库不可读：登记、配额、会员等元数据可读。

**现状与目标分开：** 周期脚本默认在自身目录保留 30 份；管理操作快照无统一自动清理。用户选定目标为每桶最近 30 个成功快照，服务端实现交部分一；本批没有声称策略已统一或生产恢复演练已通过，也未连接生产服务器。

## D09

`README.md`、`docs/DESIGN.md`、`docs/MEMORY.md`、`docs/ROADMAP.md` 当前能力写为关键词、重要度、时效、参与者、地点、置顶、回想次数评分及角色视角过滤。向量、BM25 和模型主动 `search_memory` 明确属于未实现/未来目标。`offscreen` 当前表示不参与发言、保留已有状态和记忆，不承诺持续自主幕后模拟或重新入场自动补记忆。对照了 core `memory/recall.ts`、`director/scheduler.ts`、`session/presence.ts` 的相关范围；未改 core。

## D10

新增 [逐文件增量阅读台账](../../AUDIT-READING-2026-10-03.md)，按主题记录本轮实际读过的文件、范围、基线、验证类型与本文结论链接；局部阅读标为“部分”。2026-09-26 旧审计是 379 行、§0–7，没有 §49，本批没有补造旧逐文件覆盖，也没有把这份局部核对说成全仓审计。

## 校验与边界

- C02 五文件原行核对：27 行、30 处，替换后原行均可定位，残留 0；映射和阶段 patch 均被 Git 忽略，未跟踪。
- 冲突词检索覆盖 README/DESIGN/SYNC/SYNC-DEPLOY/MEMORY/ROADMAP/deploy README，当前绝对断言已改；仍出现的“向量”“BM25”“恢复演练通过”“22.5”等处都有未实现、历史验收或待协调语境。
- `git diff --check` 退出 0；本批为纯文档，没有新增测试。根控制器执行的门禁另记，不借用历史通过数。
- 未验证 Node 22.12 实跑、生产恢复、服务端 30 份/桶裁剪与真机行为；这些仍由相应实施/验收批次承担。

**公开文件清单：** `README.md`，`docs/DESIGN.md`，`docs/SYNC.md`，`docs/SYNC-DEPLOY.md`，`docs/STATUS.md`，`docs/EVAL.md`，`docs/TASKS.md`，`docs/MEMORY.md`，`docs/ROADMAP.md`，`docs/AUDIT-READING-2026-10-03.md`，`deploy/README.md`，`deploy/nginx-80-redirect.conf.example`，`tools/local-bridge/README.md`，本文。本机私有 `deploy/LOCAL-NOTES.md` 与 `logs/c02-host-only.patch` 不纳入提交物。

**给根控制器的四处新执行日志建议：** TASKS 标 C02/C04/C01/C03/D09/D10 文档完成，C04 根 engines 和 C03 每桶 30 成功快照实现仍交部分一；STATUS 指向本报告和现行部署入口；EVAL 记录 27 行/30 处、残留 0、diff check 及未跑真服务器/最低 Node；FILE-LOG 记上述公开文档本轮增量。请勿将本批写成恢复演练或部署完成。

## 独立复核修正 round 1

独立复核指出 README 的 BYOK 信任边界行仍写“服务器不存 Key”，与同表的密文凭据及 SYNC §4.11 冲突。已改为“同步服务器不能读取用户 Key 明文”，并逐行复查该表及表后本机缓存说明：服务端存加密凭据与不能读明文的边界一致；模型服务商直连限定在 BYOK；封存文件、SW 缓存和账单行各自限定对象。此次只改这一处 README 文案；无需新增测试。修正后 `git diff --check` 退出 0。
