# 顺序110：VIP套餐与精确托管扣费实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 按本计划逐项执行；用户要求整批一个提交，子任务不提交。

**Goal:** 管理员可确认四档套餐购买／同档付费续期，服务器发放整期50% API额度；独立回环DeepSeek网关按真实usage持久扣费，管理台可查余额、预留和待核对流水。

**Architecture:** 运营表与sync.db共库，购买、资格、发放同事务。独立回环8789网关固定官方DeepSeek Flash；网络期间不持SQLite事务，发送前预留、收到完整usage后结算。管理台8788保持SSH访问，公网路由及客户端选择托管服务保留独立后续批次，不宣称本批已向最终用户开放调用。

**Tech Stack:** Node ≥22.5、node:sqlite WAL、TypeScript、node:test、原生HTTP／Fetch／SSE。

**Spec:** ../specs/2026-10-01-vip-deepseek-billing-design.md；最新用户要求在本批继续实现回环托管扣费。

## Global Constraints

- 下一编号经本机所有refs、Desktop文档及远端主线核对为110，基线769aa84（109）。
- 四档：30天256MiB/10元/5元；90天512MiB/30元/15元；365天1GiB/68元/34元；365天5GiB/98元/49元。
- 金额整数纳元（1元=10^9）；余额由追加事件汇总；同一请求不能重复发放或扣款。
- 付费资格到期保留余额，免费延期不恢复付费资格；固定存储配额含0优先。
- 管理购买沿用预览、2分钟单次票据、人工完整句柄确认、前置备份、意图审计、事务版本及epoch复查。
- 网络正文只经网关内存转发；库、管理接口和日志不得存储／输出正文、凭证、Key、sealed或钥匙封装。
- 管理台与网关只监听回环；未配置受保护运营Key不启用；真实账户只读验收。
- 保留旧库／会员／手工调整兼容；回滚只恢复程序配置，不覆盖生产库/WAL。

## Review Focus

- 重复票据／同请求ID不能双发或双扣，另建购买操作仍算新购买且不假称支付平台去重。
- 并发、断流、未知usage、重启中的请求保留预留且可查询；不能退款为0或重新调用上游。
- epoch变更与凭证轮换后不能用旧鉴权启动调用；历史余额不跟随重建空间。
- 价格时段跨界、未知年度或usage计数不一致时保留待核对，不冒充供应商逐笔实扣。
- 旧schema拒绝购买，旧赠送会员不猜套餐／历史价；有效会员跨档拒绝。

## Task 1：套餐、运营schema及账本

**Files:** 新增 tools/sync-admin/src/{vip-plans,api-accounting}.ts；修改 tools/sync-server/src/storage-policy.ts；新增 tools/sync-admin/accounting.test.mjs。
**Interfaces:** initializeApiAccounting(db)，API_PLANS/getVipPlan(id)，recordPurchase(db,{operationId,spaceHandle,spaceEpoch,plan,eventAt})；createApiLedger(db,now)返回 summary/reserve/markSent/settle/markPending/releaseUnsent/recover。
这些小型纯后端共享模块放在管理工具src以保留现有编译／启动入口兼容，同步宿主及网关导入它们，无管理HTTP/UI依赖。

- [x] 先写并运行失败测试：四档精确金额、购买幂等、事务回滚、余额/预留、同请求结算幂等、到期与新epoch、重启待核对。
- [x] 实现表和唯一来源事件、同档身份可空迁移、整数范围及短事务。
- [x] 运行专项，报告实际红绿结果；不提交。

## Task 2：管理购买与账单UI

**Files:** 修改 tools/sync-admin/src/{operations,membership,store,http}.ts、web/{app.js,style.css}；新增 vip-purchases.test.mjs。
**Interfaces:** prepare输入 membership={action:'purchase',planId}；preview返回purchase快照/API资格变化；detail返回apiBilling（余额字符串、预留、资格、购买和调用最近50条、安全元数据）；catalog仅服务端常量。

- [x] 先验证购买不存在时测试失败；覆盖免费操作0发放、同档／跨档、旧库、备份/审计失败、固定0配额和重建空间。
- [x] 在既有受控写中同事务记购买、会员、资格及credit，版本包含付费资格修订；旧人工调整保持兼容。
- [x] UI明确“套餐购买／付费续期（管理员确认）”及赠送，显示价格、整期额度、独立API资格、服务状态及流水，不自动填写确认句柄。
- [x] 隔离浏览器实际购买／续期／免费调整／拒绝跨档，核对备份和账本；不提交。

## Task 3：DeepSeek回环网关

**Files:** 新增 tools/sync-server/src/{deepseek-billing,hosted-api,gateway-main}.ts、gateway.mjs、网关说明及专项测试。
**Interfaces:** createHostedApiHandler({db,apiKey,fetch?,now?})；请求路径 /v1/spaces/<handle>/chat/completions，Bearer为用户同步凭证，X-Request-Id为幂等ID；GET对应 /account 只返回自己的安全摘要。

- [x] 先写失败测试：鉴权和轮换重检、固定model/base/max_tokens、SSE两种usage形态、cache拆分、同ID不重发、并发不透支、客户端断开后仍消费至usage、上游错误及缺usage待核对。
- [x] 使用官方1M上下文上限全按高峰未命中＋限定输出高峰价保守预留，不能用UTF8字节当精确token；限制单账户1个未决调用。
- [x] 纳元计价保存版本/时段；2026节假日版本化，未知年度拒绝；跨价时段进入待核对。网络请求不自动重试。
- [x] 独立监听127.0.0.1:8789，运营Key只读受保护env；上游错误正文不回显/写日志。先隔离验证，真实调用仅有Key和隔离账户时进行。

## Task 4：整批验证、文档、提交及发布

**Files:** docs/{STATUS,TASKS,EVAL,FILE-LOG,ADMIN-CONSOLE}.md、工具README/env示例、设计状态；仅忽略LOCAL-NOTES记录真实运维信息。

- [x] 独立审查范围及资金/权限/重启风险，处理重要问题。
- [x] 五门禁真跑：typecheck/lint/test/build/build:sync-server，记录数字。
- [x] 正式Node22隔离专项通过；生产一致性备份、暂存和旧程序保留；只部署程序及幂等schema，真实账户不改权益或余额。
- [x] 对公网管理未暴露、回环监听、未授权401、安全元数据及审计核验；网关缺Key保持关闭并如实记录。
- [x] 四文档记录实际结果；回滚程序不恢复生产库。
- 交付步骤：本批仅一个带顺序110提交，普通快进push；实际SHA以远端工具结果及忽略LOCAL-NOTES记录，不把未发生推送当作通过证据。

## 范围说明与后续

本批完成可验证的托管后端与管理运营流程，不包含支付平台收款、自动续订扣款、跨档补差、公网模型入口或客户端托管选择。保守预留约2元多意味着低余额可能不足以发起新调用，即使短请求实际费用很低；明确展示所需预留，不伪称余额可全部立即消费。供应商跨时段归价及逐请求补查尚无公开可验证契约，因此保留待核对而不猜价。
