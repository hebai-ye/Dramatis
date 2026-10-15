# 文档批次实施brief

基线4c5169a。按C02→C04→C01→C03→D09→D10顺序实施；只改以下文档和C02指定模板/bridge README，不改产品代码、不提交、不push、不部署、不安装依赖。不派子代理。详细第一轮证据可读2026-10-03-ui-bridge-ops-review.md中这六项和D05/A01，但不要扩大其余任务。

1. C02：同5文件全部27行的同一部署主机字符串替换为app.example.com，协议/端口/路径/日期/历史结论不变。原字符串从tools/local-bridge/README.md第16行提取，禁止输出。唯一真实映射记录到被gitignore的deploy/LOCAL-NOTES.md：若文件已有内容，仅追加本组映射且不读取/打印其它凭据；没有就只创建主机映射。涉及5文件docs/STATUS、EVAL、TASKS、deploy/nginx-80-redirect.conf.example、tools/local-bridge/README。不要重写历史。
2. C04：README/docs当前构建最低Node22.12。根engines>=22.5的协调需求记录交部分一，不改根package或lock；历史实跑版本不抹去。
3. C01：README/DESIGN简述＋链接SYNC §4.11为唯一详细数据流。明文API Key不随同步上传；账户同步就绪时模型配置与Key密文随同步，本机缓存模式不决定密文存在；同步服务器不能读用户Key。封装和整条记录加密要说清，BYOK与托管另说明。不写服务端可见用户Key。
4. C03：当前记录Windows Caddy/WinSW宿主，旧Linux机承担入口/隧道。保留Linux模板但与现行手册分开。只运输VACUUM INTO等完成一致性快照，不直接复制运行中WAL主库；恢复需隔离或停全部持库服务。实体密文与可读登记/配额等元数据区分。当前周期30份与管理快照不自动清理如实写；用户已选目标每桶保留30个成功快照，由部分一改服务端；本组不能宣称已统一/恢复演练通过。
5. D09：README/DESIGN/MEMORY/ROADMAP当前能力校正：实际关键词/重要度/时效/参与者/地点/置顶/回想次数与视角过滤，无向量/BM25/主动search_memory、无持续自主幕后模拟/自动入场补记忆证据。愿景可以保留明确未实现标注。core不得改。
6. D10：主题报告＋逐文件本轮增量阅读证据，新docs/AUDIT-READING-2026-10-03.md记录实际已读范围、基线、结论链接、未覆盖范围；不要补造旧§49。

附带只复审口径：A01选B后续重新认证，crypto/sync交部分一不实施；D05账户/设置懒加载已完成，首屏649422B是静态3chunk之和，SW后台预缓存另计，不重复分包；D04仅现有分期方案。

文件允许README、docs/**、C02两个模板/bridge README、忽略的LOCAL-NOTES。不要改服务端README或脚本、根package/lock、.gitignore。

写报告到docs/superpowers/plans/2026-10-03-docs-report.md，返回DONE/CONCERNS、文件清单、校验数字。根控制器负责最终TASKS/STATUS/EVAL/FILE-LOG执行新节，可在报告中提供建议文字，不抢改其它行。C02历史字符串替换允许。

验证：当前目标主机27行全部替换、私有映射未跟踪；仅字符串替换先保存该阶段patch到本机忽略logs便于复审；文档无旧现状绝对断言、无真实地址；git diff --check；所有现状/目标/待验明确区分。纯文档无需新增测试。
