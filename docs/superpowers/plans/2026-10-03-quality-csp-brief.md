# D02 / C05 隔离验证入口及 C06 / D08 清单

先读本文件，再读同目录 validation-brief.md 的 C05、D02、C06、D08 部分；该文件的 D01 不归你。用户已批准实现与验证预算，Key 由用户在隔离测试页输入，禁止读取既有配置/环境/profile 的凭据。真实请求由 root 在页面准备好并交用户输入后执行，本任务不得发送真实模型请求。

## 文件独占

只写 apps/web/tests/quality/**、apps/web/tests/browser/quality-*.browser.ts（如需）、tools/desktop/validation-*、docs/quality-fixtures/**、本报告，以及新 docs/VALIDATION-2026-10-03.md。D01 代理独占 tests/package.json、workspace/lock/config、IDB harness/test；不要改这些或安装依赖。根 package/lock、core 非 admin、server/admin、生产 web src 和 public、deploy 当前 header 全部不得修改。需要测试脚本/依赖通过报告交 root；已有隔离 fake-indexeddb 与 Playwright 已安装。tools/desktop/launch.mjs/build-inputs.mjs 即将由 B03 批次独占，你只能写 validation-*。不提交/push，不派子代理。

## 产出

1. 冻结十二个真实 production builder 夹具、canonical hash、baseline/candidate 来源核对。尽早冻结 4c5169a admin baseline，因为后续 A09/A10 将修改其 prompt；若稍晚，按 validation-brief 从 git blob 实际装配，不拿 candidate 充 baseline。此时 core admin 尚未改。非 admin 未改只能评共同现状，不宣称改进。为后续重生成 candidate 提供命令。
2. 供用户输入 masked Key 的隔离页：仅内存保留、清除按钮、明示 deepseek-flash / Low、总请求/预算上限与余量。经 production provider 的 fetchImpl 注入 low，不能声称产品已有 Low 设置。真实调用默认不启动；逐次预算守卫、无自动重试、缺 usage 停止，下载结果不含 Key/Authorization/reasoning。所有质量与 CSP 调用共享预算账本；用户输入前 root 可用 fake endpoint 测真实 wire 和预算逻辑。页面刷新不能自动把已花预算清零后继续（保留仅非秘密预算账本或要求导入账本）。提供“准备完成”状态，便于 root 交用户使用。
3. C05 隔离 production dist host（prefix validation-*）：实际 enforced 候选 CSP，loopback 测试 endpoint；收集 securitypolicyviolation，只记录非秘密信息，默认拒绝出站模型请求直到显式开始。准备真实 BYOK 流/非流/停止/错误/自定义源/import/lazyworker/offline 清单；独立质量页仅证明 provider wire，不能替代真实 App BYOK 验收。不得改正式 Report-Only。说明如何将隔离 App 的用户显式 BYOK 配置与总预算守卫对接，不能偷偷访问既有用户数据。
4. C06 推荐 Windows 同卷 recovery-drills/<timestamp> 隔离恢复清单；未给服务器条件，不能实演。30 成功快照每桶策略交部分一，当前实现未修必须说明。D08 Android 由用户之后真机验收，本轮只列清单；桌面当前 PWA app-window 与原生壳区分。

按 validation-brief 的预算、原始证据、质量 rubric 和外部待验证要求执行。先写必要行为测试再实现；不为低影响 docs 写测试。输出真实已跑命令和结果，不跑模型。覆盖生产装配 hash 稳定、预算 48/5 边界、失败/缺 usage/中止、不泄漏凭据、流式 parser/low 注入、CSP host fake smoke。

报告 docs/superpowers/plans/2026-10-03-quality-csp-report.md。返回简短状态/测试/限制，完整说明放报告。需要接口时联系 root，不能扩大路径。
