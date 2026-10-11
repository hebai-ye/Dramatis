# 首样本截断后的执行选择（2026-10-08，已批准，验证中）

首真实样本shared affect-1 repeat2，输出请求上限1200（含thinking），返回budget-truncation。总账1/48、¥0.01213/5按预留保守扣记、halted=true。导出没有完整可评分文本或usage，不能把金额当供应商账单或据此判断模型能力。三份指定证据已校验并保存ignored目录，旧账本不得删除/重置。

用户已明确批准：后续执行profile上限改为4096并保留现有账本继续，仍使用官方V4.1 Flash/Low、总计48次/5元、质量最多44次且为C05留4次，不重新发送已截断的样本。批准后先完成受限恢复的集中fake测试和独立复审；准备阶段原1200 host一直halted，没有自动解锁。最新运行状态见下方续记，批准不等于已通过真实质量验收。

| 选择 | 行为 |
| --- | --- |
| 4096后继续（已批准，验证中） | 集中fake验证和review已通过；原账本按entry1/checkpoint受限恢复，保留1次及预留金额，新host默认locked。新窗口待用户填Key后继续未发送样本。未知pending、损坏账本、未分类失败不自动恢复。 |
| 保持1200并停止 | 保留截断证据，D02真实质量维持待验；正式CSP仍Report-Only。 |

实施文件仅限隔离runner/profile、host/reservation/journal及其测试/页面文档，不动产品core或重新冻结历史baseline。冻结fixture继续保留1200及原baselineHash；新执行profile单独记4096和实际请求hash，双方管理员使用同一profile，不能把改变请求参数的新执行伪装成原请求完全相同。4096输出按8元/百万tokens每次预留¥0.032768，再加完整wire UTF-8字节输入上界；实际总账仍逐请求先fsync和48/5硬拒绝，不能按估算总价跳过准入。C05继续保持Report-Only，等待Codex验证。

验收包括：未许可恢复/其它halt原因/pending/损坏日志继续拒绝；恢复追加审计checkpoint且计数费用不下降；不同端口同账本仍排他；4096实际wire、预留和双侧profile一致；已有截断样本不重发；后续失败继续停止。本次集中fake测试和review收口尚未通过；真实host保持1200且halted，不能记录为已恢复或已真实发送。

本机UI控制helper故障尚未恢复。继续阶段需解决可控隔离页面入口，或由用户触发发送；不读取Key、借用户profile、绕账本直连或要求在聊天提供Key。此提案不是已经恢复/已经跑完的声明，没有请求扩增总预算。

## 批准后root集中执行续记

validation40/40、quality50/50、专用tsc、lint449文件、隔离构建及增强fake smoke通过，四种helper演练与独立两遍复审通过。旧host空闲/进程归属及原账本完整链核验后停止，旧锁留存；真实账本只追加一次首条恢复审计，旧字节历史和entries不改，当前1/48、quality1/44、¥0.01213/5保守扣记、halted=false、mode=locked、busy=false、profile4096。新自有Edge窗口ready等待用户页内填Key，无后续真实请求或评分。记录见[浏览器报告](./2026-10-08-live-validation-browser-report.md)。此已执行续记替代上述提案准备时的未恢复状态，预算与后续失败停止规则不变。
