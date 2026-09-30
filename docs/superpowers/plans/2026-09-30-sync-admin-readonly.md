# 顺序 99：账户关联与只读服务器管理台实施计划

> **执行方式：** 在当前独立工作树内按 executing-plans / TDD 完成；用户已批准范围。全批一个提交，不推送、不部署。

**目标：** 用户明确同意并证明空间所有权后登记账户 ID / 显示名；管理员通过 SSH 访问独立回环网页查询账户、空间、存储、备份与健康。

**架构：** 同步库新增最小 `account_profiles` 表，一空间一账户，首次认领确定显示名，重复登录不覆盖。用户自助认领接口由同步宿主处理；管理台独立监听回环，数据库连接开启 query_only，不初始化或迁移同步 schema。

**技术：** Node ≥22.5、node:sqlite、TypeScript、原生 HTML/CSS/JS；不添加运行时依赖。

**规格：** `docs/ADMIN-CONSOLE.md` 与本对话已批准范围。本计划补充账户层，不加入配额写入、VIP 发放或服务网关。

## 全局约束

- 提交前复核主仓：96／97 已完成，98 已被其它工作登记；本批最终顺序 99。一次一个顺序号、一个提交。
- 管理 API 不挂 /sync，不映射公网。用户所有权认领接口通过现有同步通道传输。
- 管理查询禁止 SELECT *，禁止返回 sealed、钥匙封装、凭证、实体内容；禁止数据库下载。
- 只有用户勾选明确同意才发送账户 ID / 显示名；发送同步凭证验证所有权，不发送同步密码或恢复码。
- 所有管理写操作留待后续，要求二次确认和前置备份；本批无管理写接口。
- 所有真实部署值只允许留在忽略的 LOCAL-NOTES，不进入源文件和文档。
- 更新 STATUS / TASKS / EVAL / FILE-LOG 四处文档；只补管理台 Windows 接入说明，任务 73 全面漂移清理仍待办。

## 重点验证

- 错凭证、伪造账户 ID、缺少同意均不能认领；密码和恢复凭证都能验证。
- 同一空间的重复认领不能覆盖显示名；并发首次认领唯一且原子。
- 老服务器不支持新接口时，注册登录与恢复码保留，明确提示认领未完成。
- 老库缺少账户表或 heads 行时，只读管理台明确标注，不能自动迁移或伪造零用量。
- 名称中的 HTML、安全字段、错误 Host/Origin、越界分页和写请求不能突破边界。

## 任务 1：空间所有权与账户资料

文件：`tools/sync-server/src/accounts.ts`、`main.ts`；`tools/sync-admin/accounts.test.mjs`。

接口：`createAccountProfileHandler(db)` 返回异步 Request 处理器。`POST /accounts/claim` 接收 `spaceHandle/accountId/displayName/confirmed`，Bearer 为现有同步凭证；认证后核对账户 ID 派生句柄。新增表只保存最小运营资料。限流、4 KB 请求体限制、同源检查在宿主实施。

- [x] 写并实跑失败测试：越权认领、字段限制、原子幂等、恢复凭证、隐私字段排除。
- [x] 实现资料表与处理器，接入独立同步宿主。
- [x] 实跑测试并检查实际 SQLite 资料。

## 任务 2：独立只读管理台

文件：`tools/sync-admin/src/{store,http,audit,main,node.d}.ts`、`start.mjs`、`tsconfig.json`、`web/{index.html,app.js,style.css}`、`admin.test.mjs`、`README.md`、`.env.example`、通用 WinSW 模板；根脚本和 CI 接入。

接口：store 提供 overview/list/detail 的明确字段 DTO；http 仅提供 GET 静态资源和 `/api/overview`、分页 `/api/spaces`、空间详情。token 只进请求头及页面内存；严格 Host/Origin、CSP、no-store；服务无可配置的非回环监听。

- [x] 写并实跑失败测试：只读、字段泄漏、墓碑/整行字节口径、未认领、HTTP 认证与跨源拒绝、无下载和写接口。
- [x] 实现安全查询、回环宿主、追加审计和网页。
- [x] 将专属构建与测试接入原有五项门禁，避免 tools 测试游离。

## 任务 3：客户端认领接线

文件：`apps/web/src/lib/{account-profile,account-profile.test,account-auth}.ts`、`components/AccountPanel.tsx`。

接口：`claimAccountProfile` 仅在 consent 为 true 时请求；已认领返回服务端显示名；失败提示可重试，不破坏同步账户。注册和登录支持可选认领；登录可用恢复码验证。UI 加最小的隐私告知与勾选，不扩展本轮产品体验范围。

- [x] 写并实跑失败测试：不同意零请求、请求无密码/恢复码、旧服务兼容、服务端显示名保持。
- [x] 注册/登录接线并保留失败时的恢复码和本地账户。
- [x] Windows 真浏览器使用一次性假库，验证认领→列表→详情与登录退出，不接生产数据。

## 任务 4：审阅、门禁、记录与提交

- [x] 一次独立代码审阅，处理影响正确性和安全的发现。
- [x] 五项实跑并报数字；专项测试与 Windows 真浏览器结果如实写 EVAL。
- [x] 更新四份进度文档、管理设计和本批 Windows 接入说明。
- [x] 检查 diff、隐私值和编号，提交「顺序 99：账户关联与只读服务器管理台」。

## 回滚

停用管理服务即可撤回只读入口；回退同步宿主和客户端后 account_profiles 表可保留，旧版本忽略。用户同步记录、凭证和钥匙封装不修改。数据库恢复和删除不属于本批。上线和正式机 SSH 验证需另获部署授权。
