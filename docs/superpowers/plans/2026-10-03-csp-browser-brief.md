# C05 实际 App 强制 CSP 的零成本浏览器准备

本阶段只准备 fake 验收，真实 BYOK 仍由 root 在用户输入 Key 后执行，并共用48请求/5元账本。不能把 fake 判为真实上游通过，不能切正式 CSP。正式仍 Report-Only，待验证（归 Codex）。

独占 apps/web/tests/csp/**、browser/csp-*.browser.ts、csp-playwright.config.ts/csp-run-browser.mjs 及自己的 csp-browser-report.md。不改 D01 package/lock/shared config、tests/ui/quality、validation-*、任何产品源码/worker、根锁、正式部署文件。使用已经获准的隔离Playwright与系统Edge，不新增依赖、不提交、不派子代理。

准备阶段管理员/Modal 与后续SW/session仍在实施，不把旧dist当最终候选；root通知稳定并重新生产构建后再运行完整App验收。可以写测试/运行器与准备素材，若执行旧dist调试必须明确标准备证据。实际 App 要由现有 createValidationHost 提供真实 enforced 响应头及测试 bootstrap；root与quality入口可能后续占6285，因此你使用单独loopback端口6289及只在本次临时目录的账本（不同于真实账本，最后关闭自己host/context）。不得连接用户profile、既有db或读取/输入真实Key，trace/HAR/video关闭。

验收须 import/加载真实候选 App，不是独立 provider 页。只用 dummy Key、确定无真实网络的fake回复。所有外部请求先在全新context路由中拒绝，允许本次loopback与唯一测试HTTPS源；未匹配外部一律abort。桥接8791也拦截，以免碰实际助手。

## 要准备的用例

1. App通过UI建立测试世界/角色及BYOK（必要时测试专用seed页面用真实Repository写新context里的固定测试数据，但不要直接伪造App状态）。真实主对话SSE、JSON回退、副对话发送/场景目标相关路径可观察到回复与合法存储。fake主模型若会自动拆出后台/意图请求，均记fake请求计数，别把它们叫单请求；只真实阶段才用预算。
2. App stop/errors：停止时不把未完成text当完整回复，错误可读且不含dummy Key；使用 fake slow/error，事件条件同步，不靠长sleep。
3. 自定义HTTPS直连：目标只能 `https://csp-validation.invalid/v1/chat/completions`，通过 context.route 在浏览器请求层本地 fulfill + CORS，不做DNS/真实网络。现有 isolation bootstrap 默认拒绝全部外部fetch；可只在本测试路由 `/validation-bootstrap.js` 的响应中调整其隔离守卫，**只给上述精确URL且Authorization严格等于本次dummy Key的fake请求放行**。保留相同真实 enforced CSP头、原违例收集和其它外部拒绝。这个修改只针对测试隔离脚本，不替换App/provider/CSP；清楚记录它为验证浏览器HTTPS策略而解除的最小fake例外。禁止通配放行/真实Key/第三方平台/真实host模式。不以loopback代理成功代替HTTPS策略已验。
4. loopback模型源许可；PNG/JSON导入固定非秘密素材；允许的data/blob背景图片实际可见；设置/模型/外观懒加载及实际worker初始化。按真实App现有UI可达路径核对，有无法达到的矩阵写明原因，不编造完成。
5. 非预期securitypolicyviolation为空；另用明确禁止的inline script证实enforced策略真的执行，记录directive/disposition，不记录URL正文凭据。不要把预期inline违例算产品回归。

B06 PWA离线/同字节更新由独立SW浏览器阶段负责，本准备先不重复；最终C05完整结论须结合该阶段在enforced候选下的相关验证及真实BYOK。若只能证明普通worker初始化，不写成SW已验。

所有runner与host只结束本次持有的进程/资源，await关闭/端口释放，失败也finally关闭context。临时账本/素材仅ignored .local。测试失败如果是product defect先通知root，不越界修实现。准备好向root报告文件、素材、端口、确切未验矩阵；root通知候选稳定后再跑必要green/本任务Biome与隔离类型检查。报告 docs/superpowers/plans/2026-10-03-csp-browser-report.md。
