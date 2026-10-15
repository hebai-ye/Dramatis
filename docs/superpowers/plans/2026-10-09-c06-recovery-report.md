# C06 现役 Windows 服务器隔离恢复记录（2026-10-09）

用户已授权沿用现有运维连接，由 root 执行。**SQLite 副本恢复及旁路迁移、health、停机后检查通过；随后新副本上的合成新账户双端读写、解密、增量拉取和重载同步六阶段也通过。** 旧账户历史正文、RPO及完整应用RTO未验收，C06不整体关闭。后续客户端窗口、汇总及失败留证见[客户端实演报告](./2026-10-09-c06-account-client-report.md)；下文仍保留先前副本/health阶段的原始结果。

本轮使用私有上线记录明确记载完成的一份历史前置快照，现场文件大小与记录一致；没有宣称它是最新快照。真实主机、文件位置、完成记录索引和旁路进程信息仅留 ignored `deploy/LOCAL-NOTES.md`，没有查询或输出 Key、密码、正文、密文记录或账户明细。复制/hash只处理文件字节；SQL只读取schema及汇总计数。执行计划见 [准备方案](./2026-10-09-c06-recovery-readiness.md)。

## 真实 SQLite 副本结果

| 项 | 实际结果 |
| --- | --- |
| 服务器 Node | v22.23.3 |
| 快照大小 | 20,156,416 B |
| 源与两副本 SHA-256 | `687e381b10fe7bd4209d194ace0aa74492faa3678ac52a8f1308f35a733bc808`，复制前后及检查后一致 |
| 未迁移副本 schema SHA-256 | `c33a475171b88a3844c1bddf62d20eb9c6814788c4359bb8a0984875e0278673` |
| 只读 SQLite | `DatabaseSync(...,{readOnly:true})`、`query_only=ON`；quick_check 恰好一行 ok |
| 核心汇总 | spaces 4、records 6,880、heads 4、account_profiles 1 |
| 运营汇总 | space_policies、space_memberships、membership_events 均 0；membership_purchases、api_balance_events、api_accounts、api_requests 为 missing，未冒充零或判旧版本损坏 |
| 关联 | 孤儿 records 0、孤儿 heads 0、foreign_key_check 违规 0 |
| 复制 / SQLite 检查耗时 | 481 ms / 16 ms |
| 实际起止 UTC | 12:38:32.6055786 — 12:38:34.2649934；服务器窗口截止 13:08:32.6055786 |
| 隔离 | 同卷全新目录；源单硬链接、路径及祖先非 reparse；DACL 关闭继承，仅执行 SID 与 SYSTEM；复制不覆盖 |
| 留存 | `snapshot-original.db` 与 `sync-working.db` 均保留；本表为工作副本启动迁移前基线 |
| 生产状态 | 六个相关服务均 Running；未打开生产 SQLite、未替换或写入生产数据库、未停生产服务 |

表级计数只证明本快照的结构和已核对关联；不证明账户正文可解密。schema 原文、实体内容、空间句柄和账户明细未输出。

## 旁路程序与应用阶段

已只读核对现役 `start.mjs` 和 `dist/tools/sync-server/src/main.js` 与本工作区已编译文件 SHA 完全一致，分别为 `aae6cdc1aba0212e575f818db165971a1c7fe61e0fad30e2681be82a2beecbf7`、`fbf9d02840df6a6a936188ea4a3175a7ee982c8e2fd1a2096f071b53f439c874`；现役 ESM 作用域为 module。进一步枚举现役完整 dist 的 94 个 JS，固定文件名/大小/SHA 的有序清单摘要 `b1cf185d559305f45122b2632f8a71548f89e79d355a16865cf7d497cdc7d40e`，起服前重新计算一致。没有现场构建、安装依赖或更新生产程序。

现役 94 文件与本地 95 文件的差异仅为本组未部署的 `admin/{bridge,prompt,tools}.js` 和新增 `admin/world-book.js`；其余 JS 摘要均一致，包括 Sync、账户、存储策略、计费及 SQLite 迁移模块。没有把候选升级为生产程序；本次验证使用已固定的现役版本。独立静态复核确认当前 admin 模块顶层为定义、无 IO；旧版三个文件没有另作源码等价证明，不把该复核扩大为旧源码阅读覆盖。一次尝试使用本地 TypeScript JS API做静态编译对照因接口不可用未完成，没有据此宣称旧文件等价或更改依赖。

| 旁路阶段 | 实际结果 |
| --- | --- |
| 起止 UTC | 13:02:51.0445925 — 13:02:54.0070026，处于上述30分钟窗口内；这是迁移/health检查约2.96秒，非应用可用RTO |
| 启动目标 | 仅现役 Sync 入口；启动前工作副本及原始副本 hash 等于基线 |
| 环境 | 白名单 SystemRoot/TEMP/TMP 与显式 DRAMATIS_SYNC 配置，无 NODE_OPTIONS、TLS、API Key 或生产环境继承 |
| HTTP | 独立回环监听仅 `127.0.0.1`，PID归属确认；health 200、ok=true，无反代、无外部访问或请求重定向 |
| 关闭 | 隔离wrapper向已安装的 SIGTERM JS 钩子发出停止，沿现有 http.close/db.close 退出；exit 0、测试端口释放；Windows上未将强杀冒称优雅退出 |
| 停机后 SQLite | 工作副本只读 quick_check 通过，孤儿/外键违规均0；spaces 4、records 6,880、heads 4、account_profiles 1 保持 |
| 迁移影响 | 原 missing 的 membership_purchases/api_balance_events/api_accounts/api_requests 均创建为空表0；其余运营表仍0；未写测试账户或消息 |
| 工作副本 SHA-256 | `c59620ef93c9c2517d123ad6d6e36166e04dfc624db9fb939c7d0228c8865aa0`，启动迁移后变化符合预期 |
| 工作副本 schema SHA-256 | `c635d9dd3f1d4df25fdfc7ae810398d2f65cec9ee3a146b453849b19f9dda856` |
| 源与原始副本 | hash 仍等于上表基线；六个相关生产服务仍 Running |

health只证明服务应答；另有停机后SQLite证据才支持本次迁移/health阶段通过。该阶段没有执行账户路径；后续新账户客户端验收另见上方报告，旧账户历史解密仍待验。没有使用生产账户材料。

## 执行中的失败与处置

- 原 stdin 传输未在 45 秒内返回；自动清理因同父 conhost 子进程未通过筛选而未确认。root 随后核实精确 PID、父 PID、创建时间和本任务 loader，收尾本机 ProxyJump 与两个属于 C06 的远端读取进程。未停生产服务或其它进程。只读复核确认旁路未创建、相关 loader/Node 为零，才继续。
- 改用有界压缩命令后，首次完整载荷因长度守卫在本机拒绝，没有派发；移除重复编码并核对完整 mock 载荷语法后再执行。
- 下一次在复制前被时间守卫拒绝。按载荷行号及两端时间定位为时钟偏差；改为取本机与服务器较早截止时间，仍不超过服务器开始后 30 分钟。只读复核无目录或相关进程后重开窗口。
- 最后实际副本检查退出 0，结果如上。失败与未知态没有计为通过；没有通过覆盖、删 WAL/SHM 或重跑周期裁剪脚本修复。
- 旁路启动前的首个只读程序查询错用了平铺main/package布局，返回失败；按实际start入口校正到嵌套编译目录后核对成功。此失败没有启动服务。旁路正式检查只运行一次并退出0，没有自动重试、强杀或删除sidecar。

## 保留项与交接

RPO 未测：历史快照不能代表当前恢复点，没有生产写入参考时间。481/16 ms 分别是副本复制和 SQLite 检查耗时，不能称应用可用 RTO。

每桶 30 个成功快照、失败不驱逐有效快照的保留策略仍归部分一，尚未统一；本轮没有修改 `tools/sync-server/**` 或 `tools/sync-admin/**`。C05 正式 CSP 继续 Report-Only，待验证（归 Codex）；D02 预算及保账规则保持，Android 真机由用户后续验收。
