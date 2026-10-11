# B07 / A13(web) 实施要求

只改web/lib/session.ts、components/**、App.tsx及docs报告，不改db/sync/core存储或任何非admin core。root/package锁/后台工具禁动，无子代理不提交/push。此前A10已改变setWorldScene接口，本批保持。

## B07 必须先固定时序复现

先components/SessionHarness.test.tsx利用真实useSession与可控repository promises（可参照既有React harness）重现：openWorld A读取snapshot完成但hold返回，openWorld B完成，release A断言UI与lastRoom都B；reload A hold期间append m2完成再release保留m2；updateMessage/Scene A hold然后open B、release不得UI回A；ABA(old A任务与新A区分)。先记录失败证据，“旧A覆盖B”此前未执行复现，不先写版本算法。
确认缺陷后在session.ts统一selectionEpoch + snapshotRevision/conditionalCommit，selectionEpoch切换选择时增，每次snapshotcommit revision增；reload只在启动scope/revision一致时提交（若期间append了则丢旧result或重新读，不无条件替换）。局部update完成对最新snapshot按scope合并，不能spread捕获current；UI切走旧A存储允许正常落A但不覆盖B。lastRoom元数据序列化按selectiontoken检查，不能旧A迟到写把B覆盖；队列内开始前检查，旧正在写的会在之后新B覆盖，同一roomABA也区分epoch。
公开API保持兼容，尽量所有async snapshot写都用统一原语，不另建重复scope函数。snapshotRevision是UI版本、不是持久化CAS，报告明确跨标签/同步仓库CAS仍归部分一。不要迁移append已存在serialized reread的正确路径。
测试实际状态/lastRoom、capture时刻控制，不睡定时、不源码grep。每用例总完成promise不能遗留pending。

## A13 web

先检查部分一core recoverPendingImports是否已新增安全验证和structuredwarnings。若已有按真实契约接BootReport/App显式notice（手机可读、保留世界、真实回滚计数不含跳过）。若仍旧仅{rooms,stillPending}且坏marker可炸/删除世界，本批不能修改core、不能靠catch声称修复数据：准备webwarning消费接口/展示及core交接契约，报告明确核心未完成项。可兼容新增warnings字段但不能编造已发生警告/回滚。
推荐BootReport.importRecoveryWarnings数组code/message/markerId(optional)，不回显原marker敏感内容；UI提示“导入恢复检查需要处理，已有世界保留”必须只在core保证保留时说，旧未知异常用中性可读说明。根因合同需marker全字段合法性、每marker隔离、无效跳过不删room、合法scope回滚、异常不阻断其他/已有世界。必须据实际实现记录。
测试warning传递和可读显示，bad marker世界留存测试依赖core安全契约，不伪造前提。

报告docs/superpowers/plans/2026-10-03-session-report.md，先写固定时序red/green和scope例外，A13分别标web完成/core待交接。pnpm --filter @dramatis/web test -- 指定文件 +typecheck。

2026-10-07用户最新策略：实施子任务不运行测试/typecheck/lint/build。先准备固定时序夹具与设计，root在多个功能完成后的集中窗口确认复现后通知版本实现；未收到root复现结论前不写版本算法、不宣称旧A覆盖B已复现。最终门禁由root集中运行。A13只按真实core接口消费，核心未改时不冒充数据安全已修。
