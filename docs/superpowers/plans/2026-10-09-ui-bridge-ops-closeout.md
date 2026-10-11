# 界面、桥接与运维组最终收尾矩阵（2026-10-09）

本文件汇总原26项的当前交付、复审与未关闭边界。依据：[10-08交付边界](./2026-10-08-ui-bridge-ops-delivery.md)、[第一轮复核与方案](./2026-10-03-ui-bridge-ops-review.md)、[执行台账](./2026-10-03-ui-bridge-ops-execution.md)、[TASKS本组记录](../../TASKS.md)及[EVAL最终集中验证](../../EVAL.md)。若与历史措辞不同，以最新账本/host状态及各项明确边界为准。收口初版只整理证据；10-09续跑C06隔离实演，并补B06同一真实worker跨30秒单例1/1。既有稳定门禁不重复，未提交、push或部署。

## 26 项最终矩阵

“已交付”只表示本组约定的实现、复审或文档已经交付；不能覆盖表中仍待部分一、root、用户或外部条件的验收。

| ID | 最终状态 | 交付 / 复审证据 | 不能关闭的边界 |
| --- | --- | --- | --- |
| A01 | 复审交付 | extractable 影响面与方案复审完成；用户选 B | 重新认证实现归部分一；本组未改密钥路径 |
| A09 | 本组实现完成 | 条目增改/删除/diff/陈旧拒绝；core878、Web328集中门禁通过；独立复审通过 | 真实模型质量没有评分 |
| A10 | 本组实现完成 | 请求时捕获场景目标并绑定桥接目标；集中门禁通过 | 真站真实 DOM 与端到端未验 |
| A11 | 本组实现完成 | 手机栏互斥；Edge UI12通过 | Android软键盘和真机手感待用户验收 |
| A13 | 部分交付 | web容错启动、BootReport与可读通知；5项报告/提示验证通过 | core安全恢复与坏marker下世界留存归部分一 |
| B01 | 本组实现完成 | baseline/角色/终态识别、未知站点发送前拒绝；44项回归及复审 | DeepSeek真实DOM与端到端待验 |
| B02 | 本组实现完成 | 断线/超时settle和实际worker终止后释放；native WS生命周期探针通过 | 探针不代替真实站适配 |
| B03 | 本组实现完成 | 9项回归；生产190模块构建，fresh=true、二次reused | 仅覆盖记录中的最终产物；保留大chunk提示 |
| B04 | 本组实现完成 | click/Enter/submit守卫；Edge UI12通过 | 外部桥接模型未验 |
| B05 | 本组实现完成 | 跳原句后回底/新消息两态；Edge UI12通过 | 首轮历史flaky根因未知；合成scroll只固定竞争路径 |
| B06 | 本组实现及常驻补验完成 | VM44、策略11、Edge6既有通过；10-09同一native worker在437 ms节流、31,020 ms刷新，独立Edge补例1/1通过，离线C+lazy A；见[补验报告](./2026-10-09-b06-standing-worker-report.md) | 完整Android离线/系统回收矩阵待真机；不把事件保活称后台自主常驻 |
| B07 | UI策略实现完成 | 固定时序27/27、Web328通过；两遍增量复审PASS | 存储active/CAS及后台读取旧选择归部分一 |
| C01 | 文档交付 | README/DESIGN指向SYNC权威数据流并澄清账户密文同步 | 未做真实Key探测 |
| C02 | 文档交付 | 5文件27行、30处字面替换；私有映射仅ignored `deploy/LOCAL-NOTES.md` | Git历史未重写；不公开真实地址 |
| C03 | 文档交付 | Windows/Caddy现役与Linux历史段、备份概念口径校正 | 快照隔离恢复证据见C06，备份保留策略仍归部分一 |
| C04 | 部分交付 | 文档构建最低Node 22.12 | 根 `engines` 仍22.5，归部分一对齐；最低版本没实跑 |
| C05 | 候选交付、待验 | 最终dist App enforced候选Edge fake 7通过/1已知skip；独立复审PASS；部署三处说明已补齐真BYOK/enforced门槛 | 正式仍Report-Only，“待验证（归 Codex）”；无真BYOK/源矩阵；Low工具续传及只读systemd模板对齐归部分一，差异见下节 |
| C06 | 真实服务器分层验收 | 历史快照20,156,416B的复制/SQLite/迁移/health通过；新副本合成账户双端读写/解密/增量及重载同步六阶段通过，优雅停机后只读检查与再核对通过，源/原副本不变、六生产服务Running；见[客户端报告](./2026-10-09-c06-account-client-report.md) | 旧账户历史正文/RPO/完整应用RTO未验；每桶30成功快照与管理保留策略仍归部分一，未整体关闭 |
| D01 | runner交付及退出补验 | Fake6/6、真实Edge双页6/6；10-11真实Ctrl+C清理及受控Vite首次SIGTERM传输故障后的3002 ms升级终止均取得运行证据，进程/6273残留0，见[补验报告](./2026-10-11-d01-runner-exit-report.md) | worker通知、跨标签CAS归部分一；补验不覆盖所有退出分支或原生OS故障 |
| D02 | 受限验证收尾 | validation40、quality50、lint、隔离构建及增强fake smoke按既有日志通过；4096保账恢复审计只追加一次 | 真质量不可评分。账本1/48、quality1/44、¥0.01213保守预留；不重发截断样本。6285因用户离线修复退出而离线，账本SHA `270e…`未变；不等待Key输入窗口、不新增真实调用 |
| D03 | 本组实现完成 | 通用Modal接DialogShell；3项包含在Edge UI12中 | 账户/设置既有接线未重做 |
| D04 | 方案交付 | 大文件分期拆分和兼容符号处理方案已交 | 本组未拆文件或删除兼容符号 |
| D05 | 复审交付 | 顺序109的分包/懒加载现状和文档口径复审 | 剩余打包范围未全关闭；历史数字保留 |
| D08 | 清单交付 | Android真机验收清单；桌面准确称启动器/PWA app-window | Android真机由用户后续处理，尚无结果 |
| D09 | 文档交付 | 无向量召回、无持续自主offscreen模拟的文案校正 | 文案不代表新能力已实现 |
| D10 | 文档交付 | 主题审计和逐文件增量证据分别记录 | 不补造旧§49或全仓阅读覆盖 |

## 已过的集中门禁

以下是引用既有记录，不是本次重跑：core 878；Web 最终 328；IDB fake 6、真实双页 6；真实 UI 12；SW VM 44、策略 11、Edge 6；validation 40、quality 50；生产构建 190 模块且 B03 fresh 后复用；runner真实双页6。CSP候选最终dist为7通过/1已知skip。详见执行台账和 EVAL 最终覆盖段；这里不把分散历史结果宣称成一条同时运行的全仓命令。初轮失败和修复前失败日志继续保留。

平台初始化/沙箱故障与项目代码质量分开：不得把工具启动失败写成项目代码验证失败或项目门禁失败。当前6285不可达，账本SHA未变；既往恢复审计没有增加真实请求。host曾经locked的历史状态不能代替当前在线检查。

用户要求尝试重新获取 Computer Use，随后停止初始化排障并继续项目。官方 CLI 的 `plugin add computer-use@openai-bundled --json` 退出0；重新列出后 `installed=true, enabled=true`，版本仍26.1002.52244。这只确认本地 bundled 插件已重新获取，不能证明插件列表显示、远程新版下载或浏览器控制恢复。未卸载应用、替换工具二进制或继续 MSIX 检查；真实验证页未重开，不等待新 Key 输入。

## 本次修正与部分一交接

本组修正 `deploy/README.md`、`deploy/nginx-security-headers.conf` 和 `deploy/Caddyfile.example` 的 CSP 说明：正式继续 Report-Only；隔离环境实际 enforced、真浏览器完整验收真实 BYOK 与模型来源后才可提交并推广强制。没有改变 active header 或 policy。`deploy/install-server.sh` 仅补充 NEXT 提示，周期备份参数30指保留份数；管理快照规则尚未统一，“每桶30个成功快照”仍是目标，命令和默认值不变。

C05 的 `tools/sync-server/systemd/dramatis-sync.service` 不在本组写入边界。本组未削弱 installer，也未越界修改服务模板。归属方应按 installer 的现有加固对齐：

| 指令 | 只读模板现况 | installer 已有值 / 交接目标 |
| --- | --- | --- |
| `ProtectSystem` | `full` | `strict` |
| `PrivateDevices` | 缺失 | `true` |
| `ProtectHome` | 缺失 | `true` |
| `ProtectKernelTunables` | 缺失 | `true` |
| `ProtectKernelModules` | 缺失 | `true` |
| `ProtectControlGroups` | 缺失 | `true` |
| `RestrictAddressFamilies` | 缺失 | `AF_INET AF_INET6 AF_UNIX` |
| `RestrictSUIDSGID` | 缺失 | `true` |
| `LockPersonality` | 缺失 | `true` |
| `UMask` | 缺失 | `0077` |

归属方实施后需检查 unit 语法，并在可用 Linux 隔离服务中验证数据目录写入、回环 health、重启及日志权限；当前 Windows/Caddy 运维记录和既有应用门禁不能代替这项验收。本组没有宣称模板已对齐或真实服务已验证。

本次四处 deploy 说明及本矩阵经独立 Sol 静态复核，无 Major/Important 问题，子任务没有运行门禁。root 核对矩阵包含26项、正式头仍为 Report-Only、差异格式无空白错误；6285监听数0。只读账本字节核对退出0，SHA仍为 `270eaf03a9cd89586ac5dbdae8aa26d904505a075daa5e06f1f544f9081ffce1`。这些是本次文档与保全检查，不是新增产品测试或真实质量评分。

## 下一步

本组无需外部条件的实现、复审与文档工作已收口。部分一交接仍包括 B07 持久 active/CAS、A13 core安全恢复、C04 根 Node engines、D01 worker通知/跨标签CAS、C05 Low工具续传及上述 systemd 模板；它们不能由本组现有门禁代替验证。B06 的同一真实worker跨30秒路径已补验通过，完整Android离线/系统回收验收仍保留。

需要外部条件的事项：C05正式Report-Only转强制前的真BYOK与来源矩阵由Codex完成；需可用隔离页/host且严格遵守现有账本，不重发已截断样本。C06服务器条件已取得，副本/迁移/health及合成新账户六阶段往返已实演；旧历史正文仍需用户在隔离页本地输入原密码或恢复码，RPO/完整应用RTO未测，保留策略交部分一。D08需用户Android真机；B01需真实桥接站点DOM及授权环境。D02当前没有可评分样本，不能据已过fake门禁推出质量结论。以上事项未完成前均保持未关闭。

