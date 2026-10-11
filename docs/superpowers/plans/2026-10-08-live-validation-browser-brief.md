# 可控隔离浏览器入口（2026-10-08，执行设计）

用户已选择4096保留账本继续。现有Cua helper无法初始化，旧页中的Key不会被读取或转移。root将以已有隔离Playwright依赖启动一个全新、可见的Edge上下文；用户只在这个新窗口的页内再填一次Key。该窗口不导入storageState、profile、cookie或用户数据库，不开启trace/HAR/video/截图。root脚本只操纵按钮/样本选择/证据下载，不读取Key字段。

只有收到用户“已填入”回复并由root写入本次runId的start指令后，脚本才点显式开始并逐样本发送。每条等待真正新result与select解锁，及时下载原始证据和总账；遇错误、halt或停止指令即锁定，不重试。模型请求仍经过已验证4096执行profile的同源总账代理，48/5和44quality上限保留。脚本不会直接调用供应商。

新窗口blind ID会重新随机化，因此跳过依据原已发语义tuple `affect-1/shared/repeat2`，不依赖旧B001。private映射仅供脚本识别这个跳过项并完整留证，运行进度只输出blindId/family/count/费用，不提前向评阅者揭示管理员侧别。每次原始JSONL必须与当前blindId一致，没有新记录不得继续；不以固定sleep猜模型完成。

完成或错误后锁定host、在页内点清除Key，并关闭本次上下文和自有browser。下载保存于本次ignored live-run目录，保留原首样本、全量checkpoint与新的执行profile摘要，不删除旧账本/证据。fake rehearsal使用单独临时账本、抛错真实upstream、headless Edge和单role样本，所有检查由root集中执行。

独立复审后收尾顺序进一步明确为先abort、等host/UI空闲、锁定并核验、Key仍在页内时脱敏下载，再清Key和关闭。无法settle或保存时保留pending/现场报告NEEDS_ATTENTION；没有成功收尾不报COMPLETE。monitor和download所有并发Promise立即观察错误，fake初始化前origin为空，清理只针对预检成功的目标。root四种演练及复审结果见[验证记录](./2026-10-08-live-validation-browser-report.md)。

该入口是恢复控制工具故障的授权验证基础设施，不修改产品UI、同步库或正式CSP。C05真实App Low工具续传仍待部分一，不能因为D02新窗口运行成功就切正式CSP。
