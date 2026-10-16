# 2026-10-03 文档批次增量阅读台账

基线：`4c5169a`；范围：C02、C04、C01、C03、D09、D10。本文只记录**本轮实际读取**的文件和范围，不继承或推定 2026-09-26 审计的逐文件覆盖。该旧审计共 379 行、§0–7，没有 §49；其主题结论仍保留在 [原报告](./AUDIT-2026-09-26.md)。

结论链接指向[本轮实施报告](./superpowers/plans/2026-10-03-docs-report.md)。下表“全篇”指本轮读取了整个当时文件，“部分”不表示其它行已审过。行号是读取时约数，后续编辑会使行号漂移。

| 主题 | 文件（基线均为 `4c5169a`） | 本轮已读范围 / 状态 | 验证类型 | 结论 |
| --- | --- | --- | --- | --- |
| C02/C01/C04/D09 | `README.md` | 全篇，230 行 | 文案对照与当前代码抽样 | [C02](./superpowers/plans/2026-10-03-docs-report.md#c02)、[C04](./superpowers/plans/2026-10-03-docs-report.md#c04)、[C01](./superpowers/plans/2026-10-03-docs-report.md#c01)、[D09](./superpowers/plans/2026-10-03-docs-report.md#d09) |
| C01/D09 | `docs/DESIGN.md` | 全篇，原 325 行；重点 §2.3、§4.4、§8.3 | 文案与源码对照 | [C01](./superpowers/plans/2026-10-03-docs-report.md#c01)、[D09](./superpowers/plans/2026-10-03-docs-report.md#d09) |
| C01 | `docs/SYNC.md` | 部分：约 16–29、131–179、446–466、606–619 行；全文关键词定位 | 加密数据流对照 | [C01](./superpowers/plans/2026-10-03-docs-report.md#c01) |
| C03/C04 | `docs/SYNC-DEPLOY.md` | 全篇，原约 212 行，分段读取 | 历史/现行步骤对照 | [C03](./superpowers/plans/2026-10-03-docs-report.md#c03)、[C04](./superpowers/plans/2026-10-03-docs-report.md#c04) |
| C03/C04 | `deploy/README.md` | 全篇，原约 76 行 | Linux 模板与当前宿主对照 | [C03](./superpowers/plans/2026-10-03-docs-report.md#c03) |
| C02/C03 | `docs/STATUS.md` | 部分：主机命中 7 行、开头文档地图、最新部署记录检索、约 1168–1182、1225–1242 行 | 历史与当前部署对照 | [C02](./superpowers/plans/2026-10-03-docs-report.md#c02)、[C03](./superpowers/plans/2026-10-03-docs-report.md#c03) |
| C02 | `docs/EVAL.md` | 部分：目标主机命中 15 行；未通读 4777 行评测 | 精确字串计数/差异 | [C02](./superpowers/plans/2026-10-03-docs-report.md#c02) |
| C02 | `docs/TASKS.md` | 部分：目标主机命中 1 行；未通读 1654 行任务表 | 精确字串计数/差异 | [C02](./superpowers/plans/2026-10-03-docs-report.md#c02) |
| C02 | `deploy/nginx-80-redirect.conf.example` | 部分：目标主机命中 3 行 | 精确字串计数/差异 | [C02](./superpowers/plans/2026-10-03-docs-report.md#c02) |
| C02 | `tools/local-bridge/README.md` | 部分：第 16 行及目标主机定位 | 隐私目标提取/计数，不公开值 | [C02](./superpowers/plans/2026-10-03-docs-report.md#c02) |
| D09 | `docs/MEMORY.md` | 部分：约 1–29、85–109、207–221 行；全文关键词定位 | 当前能力与历史方案区分 | [D09](./superpowers/plans/2026-10-03-docs-report.md#d09) |
| D09 | `docs/ROADMAP.md` | 部分：约 221–252、366–391 行；全文关键词定位 | P1-3/P1-11 当前与目标对照 | [D09](./superpowers/plans/2026-10-03-docs-report.md#d09) |
| D10 | `docs/AUDIT-2026-09-26.md` | 部分：前 12 行、章节标题及总行数 | 旧审计形态核对 | [D10](./superpowers/plans/2026-10-03-docs-report.md#d10) |
| C04 | `package.json`、`pnpm-lock.yaml` | 部分：根声明前 20 行、Rolldown engines 命中行 | 版本约束只读对照 | [C04](./superpowers/plans/2026-10-03-docs-report.md#c04) |
| C01 | `apps/web/src/lib/providers.ts`、`apps/web/src/lib/sync.ts` | 部分：约 339–369、419–456、536–571 行 | 封存/恢复源码只读对照 | [C01](./superpowers/plans/2026-10-03-docs-report.md#c01) |
| C01 | `packages/core/src/sync/loop.ts`、`packages/core/src/sync/types.ts` | 部分：约 191–209、30–43 行 | 整条加密/同步集合只读对照 | [C01](./superpowers/plans/2026-10-03-docs-report.md#c01) |
| C03 | `tools/sync-server/backup.mjs`、`tools/sync-admin/src/backup.ts` | 两文件全篇，分别 63、28 行 | 一致性快照/保留策略源码只读对照 | [C03](./superpowers/plans/2026-10-03-docs-report.md#c03) |
| D09 | `packages/core/src/memory/recall.ts` | 部分：约 15–36、161–199 行 | 评分与视角过滤源码只读对照 | [D09](./superpowers/plans/2026-10-03-docs-report.md#d09) |
| D09 | `packages/core/src/director/scheduler.ts`、`packages/core/src/session/presence.ts` | 部分：约 121–140、191–211、36–51 行 | offscreen 调度/切换源码只读对照 | [D09](./superpowers/plans/2026-10-03-docs-report.md#d09) |

**未覆盖：** 本轮没有重读全仓源码、EVAL/STATUS/TASKS 全篇，也没有逐文件复核旧审计全部结论。真实宿主、生产数据库与恢复流程没有连接或演练；Node 22.12 最低版本的实跑由有相应环境的批次负责。

## 2026-10-05 root局部增量

| 主题 | 文件 | 实际读取范围 | 结论/验证 |
| --- | --- | --- | --- |
| B03 | tools/desktop/build-inputs.mjs | 部分：末125行，输入哈希尾段、validateOutput/outputFingerprint与构建/复用入口 | 复审通过；真实构建待最终 |
| B02 | tools/local-bridge/process-socket.mjs、ws-worker.mjs | 两文件全篇，当前版本 | 默认原生child loopback运行探针退出0；不代替真站DOM |
| C05 | tools/desktop/validation-bootstrap.js、validation-host.mjs | bootstrap全篇；host仅bootstrap/fake/CSP/ledger关键词命中行 | 外部fetch默认阻止；不能将loopback代理结果当自定义HTTPS直连已验 |
| D03 | DialogShell.tsx、Modal.tsx | 仅focus/inert/Tab/Escape与接口关键词命中行 | 未当作完整代码复审；等本批完成和真实浏览器验证 |
| 各批实施证据 | desktop/ui-browser/quality-csp/bridge报告、VALIDATION文档 | 报告完整或尾140–150行及台账末段（实际读取范围按工具记录） | 阶段范围与真实未验项持续记入执行台账，不继承全仓阅读结论 |

## 2026-10-08 root局部增量

| 主题 | 文件 | 实际读取范围 | 结论/验证 |
| --- | --- | --- | --- |
| A09/A10 | admin-fix1.diff及当前world-book.ts | 当前fix1逐文件diff与已审阅补丁完整比较；world-book.ts全篇 | 补丁完全一致；静态复审通过，当前运行门禁仍待集中验证 |
| B06 | apps/web/public/sw.js、apps/web/src/pwa/sw-policy.test.ts | 两文件全篇及后续lock/runtime/staging增量 | 发现旧mock冲突后获用户限定授权，仅最后两例/必要mock对齐；root VM44/44、策略11/11、真实Edge6/6，静态复审通过 |
| A13 | packages/core/src/storage/archive.ts | 第1～360行，包含完整旧recoverInterruptedImports | 仍仅rooms/stillPending；坏marker可先删除room再抛错，web不能冒称世界留存已修 |
| D02协议 | quality/protocol-response.ts、protocol.ts、runner.ts | 三文件全篇；protocol.test.ts末180行、provider.test.ts末190行 | 原始身份/显式空链静态复核；无真实请求，补充运行待总测 |
| 集中验证准备 | package.json、apps/web/tests/package.json、quality/tsconfig.json、csp-run-browser.mjs、csp/fixtures.ts、csp-playwright.config.ts、ui-run-browser.mjs | 上述文件全篇；build-inputs.mjs末100行、validation-host.mjs末90行、VALIDATION文档末90行 | 只读核对入口与隔离清理，不计作测试已执行 |
| 最终session/UI增量 | session报告末60行、UI报告；独立Sol最终reader站点及九fixture复审 | root读取报告及集中27例/328项运行输出；完整reader静态复审归独立reviewer，不冒称root重读整文件 | 两类Important已修且独立两遍PASS；UI真实12项通过，存储CAS边界保留 |
| 隔离入口最终烟测 | tools/desktop/validation-smoke.mjs、logs/production-build-final.mjs | 两脚本全篇；host末33行、VALIDATION前145行 | root补cleanup canonical temp直接子目录守卫；最终产物/盲评与预算fake smoke通过，不计真质量 |
| C05首次运行诊断 | tests/csp/fake.ts、browser/csp-app.browser.ts、csp-playwright.config.ts | helper前175行、矩阵前160行、配置全篇；首个固定dummy失败context | 真实可访问名与exact Key选择器漂移，矩阵尚未green；没有读取真实Key/profile |
