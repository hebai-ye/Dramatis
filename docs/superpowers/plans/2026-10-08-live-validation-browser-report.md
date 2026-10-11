# 可控隔离浏览器验证记录（2026-10-08）

2026-10-11最新接续覆盖下文旧离线安排：内置浏览器已实际新建/导航/读取/下载，原账本与无归属旧锁核对并留存后按4096普通启动host，实际页面locked、busy=false、仍1次/¥0.01213。未再次恢复或发送；当前等待用户仅在内置新页输入Key。详见[接续记录](./2026-10-11-real-validation-rejoin.md)，不据此声明所有Computer Use能力恢复或真实验收通过。

2026-10-09 最新决定覆盖本页历史接续安排：用户要求停止初始化排障、重新获取Computer Use后继续项目。官方CLI插件安装退出0，post-list installed/enabled=true、bundled版本不变；不据此认定内置浏览器恢复，不再重试或要求用户填Key。6285仍离线，原账本SHA不变，仍1/48、quality1/44、¥0.01213；未重复initialize/recovery、首条发送或新增模型调用。D02无可评分真实输出，C05正式保持Report-Only，待验证（归 Codex）；最新交付与外部条件见[26项收口矩阵](./2026-10-09-ui-bridge-ops-closeout.md)。

2026-10-09 15:49后：用户离线官方配置已合法success=true、自有server正常exit0，前中后ledgerSHA不变；重开后实际default/Cua仍失败，新日志继续node_repl.exe ACL os32。官方PR51822修复机制高度吻合，尚无已验证含修复的desktop/Store包。6285现在离线，禁止沿用旧locked状态或重复账本恢复/首条发送。故障未修复；仍1次/¥0.01213。

2026-10-09 最新：完整退出重开及一次官方 elevated setup 均未修复；合法 setup 完成通知 success=false，readiness=ready 不代表实际执行正常。Store仅“打开”、未更新。定点回收三个已精确核验的工具进程后仍有 runtime ACL os error32，Cua transport已关闭；不继续追杀。离线官方配置脚本已准备，其临时关闭 code_mode_host 的独立只读预检双 census均0；离线 setup 尚未执行，成功也需重开后实测内置浏览器。

2026-10-09 账本保全：旧锁 PID已证明退出，完整账本链/已知字节hash保持；旧锁和原账本副本均留证，再以4096普通启动恢复locked host（PID46992，busy=false）。锁/loopback归属及Node字节比较通过，仍1次/¥0.01213，无重复恢复/初始化/发送。下段离线状态是此次恢复前观察；下次 app退出后重新核验host归属与账本。

2026-10-09 当前状态覆盖本页历史 ready 描述：用户选择内置浏览器后，临时外部 Edge 已停止并确认收尾，无后续真实调用。6285 当前无监听，host session 不再存在，残留锁留待归属与账本核对；原账本完整 hash 链及恢复后的 checkpoint 已只读验证，仍 1 次 / ¥0.01213。用户完整退出重开 Codex 后，Cua 与默认 shell 初始化错误依然存在。当前不等待外部窗口 Key，不运行外部发送脚本；恢复步骤见 [运行时记录](2026-10-09-codex-browser-runtime-recovery.md)。

用户批准后续4096并保留原账本继续。Cua初始化仍不可用，使用已批准Playwright依赖创建全新可见Edge上下文，禁止导入用户profile/storageState与截图/HAR/trace/video，禁止读取Key输入框。页面只能访问本次loopback origin；真实上游经host固定为官方API。Key由用户页内输入，本次runId start指令只由root在收到新窗口填入回复后原子写入。

计划读取私有映射只为跳过`affect-1/shared/repeat2`原已发样本；新盲号不能代替语义身份。当前目录30个样本，剩余29；不会重发旧B001对应语义样本。管理员两轮最多涉及两个实际请求，每轮分别准入、fsync、计账；48次/5元、quality44次/C05留4次不变。冻结1200历史与实际4096profile分别保留，三种hash不混同。运行进度只输出blindId/family/count/费用。

## 复审收尾修订

独立Sol发现并由root修正：busy时先lock会被拒绝并遗漏证据；stopMonitor错误被延迟观察可能导致未处理rejection；fake初始化失败可能清理真实origin；download事件超时同样须立即观察。最终流程为abort当前页面→等待host和UI空闲→lock并验证mode/busy→在Key仍可用于页内脱敏时下载证据→清Key→关闭自有context/browser。任何未退休传输或证据/清理失败记录NEEDS_ATTENTION并退出1，不声称完成。server clean还必须无busy/activeControllers，socket close不能冒充settle。复审两遍规格/质量PASS。

## Root集中演练

| 场景 | 实际结果 | 日志 |
| --- | --- | --- |
| 正常fake | exit0；1行、4096、hash可复算、锁定/清Key/关闭/host clean均确认 | `logs/live-profile-fake-normal.log` |
| fake发送后停止 | 预期exit1；1行aborted，已settle，锁定/导出/清Key/关闭/host clean均确认 | `logs/live-profile-fake-stop.log` |
| fake指令损坏 | 预期受控exit1；无未处理rejection，最终1行aborted，全部收尾确认 | `logs/live-profile-fake-fault.log` |
| fake启动故障 | 预期exit1；不建立真实origin清理路径，真实6285 mode和完整real state前后完全不变 | `logs/live-profile-fake-setup.log` |

前三例的run-summary和中止原始行另由root独立断言，真实调用与费用均0。全桌面validation40/40，quality50/50、专用tsc、449文件lint和27模块隔离构建通过。增强fake smoke通过。最终生产产物fresh=true、根锁SHA256不变。子任务未执行任何门禁。

## 真实恢复接续

原账本完整history与已知首条截断已核验并保存原字节/锁；仅停止空闲、端口及PID验证归属的旧Node。首次PowerShell活动文件hash读取受共享限制失败，严格退出后复核与原Node读取副本一致；没有按失败输出判断hash通过。stale lock留存，不删旧账本、重置或退款。

4096启动仅追加entry1/checkpoint绑定的恢复审计。原历史字节前缀及entries保持不变，当前1/48、quality1/44、¥0.01213/5保守扣记；halted=false但mode=locked、busy=false。新的自有可见Edge窗口ready，等待用户填入Key后继续；此记录没有后续真实发送/评分结论。正式CSP仍Report-Only，待验证（归 Codex）。
