# UI 真浏览器验收报告（2026-10-05 阶段）

状态：A11、B04、B05 阶段验收完成；D03 fixture 已准备并暂态运行，待管理员候选稳定后最终复跑。原 brief 的完整验收尚未完成。未提交、未推送。

## 环境与运行

- 命令：`node apps/web/tests/ui-run-browser.mjs`
- 结果：8 tests passed（review fix1 最终运行 11.3s）。系统 Microsoft Edge / Chromium `154.0.4258.53`，`@playwright/test` `1.63.0`；使用 `127.0.0.1:6287` strictPort 的专用 Vite 进程与专用 Playwright config（`ui-*.browser.ts`，trace/screenshot/video off）。
- 每项测试通过 `browser.newContext()` 新建非持久 context；A11 访问真实 `/` App 并通过 UI 创建一个空世界和首条对话。B04/B05 的测试页导入真实 Composer、MainChat、SideChat 与真实 `styles.css`，仅用固定 props 和回调记数。没有真实模型请求、Key、用户 profile 或模拟滚动状态机。桥接 fixture 将本机助手探测请求拦截失败，以免碰真实服务。
- runner 只结束自己启动的 Vite 子进程；测试关闭自己创建的 context。A11 的生产名称 IndexedDB 只存在于新 context 中，随 context 关闭释放。
- A11/B04/B05 阶段新测试文件的 Biome 检查 6 文件、0 errors、0 warnings。首次阶段 `pnpm --filter @dramatis/web typecheck` 通过；review fix1 当时被并行 `src/components/admin-session.test.tsx` 四处 TS2554 挡住，未记为通过。D03 准备时重新运行全 Web typecheck，已通过（见下方 D03 节）。

## 本阶段已验

| 项 | 真实浏览器结果 |
| --- | --- |
| A11 | 390px App 中右栏打开后切左栏、再切右栏，computed `display`/`visibility`/viewport 位置均只有目标栏可见；还验了实际用户通过遮罩收栏再开另一栏的路径。1100px 桌面双栏可同时显示；双开后缩到 390px，只剩左栏。直接切换通过对真实 App 按钮派发 click 测状态与 CSS；移动端展开的抽屉会遮住位移后的顶栏，因此物理点击路径经遮罩收起。 |
| B04 | 实际 Composer 在 disabled/busy/bridgeOpen 时不回调发送，草稿原文保留；禁用的 textarea 无法接收键盘事件，测试在禁用后按 Enter 检查无发送，busy/bridgeOpen 时直接对输入框按 Enter。正常桌面 Enter 发送；Shift+Enter 与 IME composing keydown 不发送；粗指针 context 中 Enter 换行、点击发送。实际 MainChat/SideChat 在待回填桥接期间输入草稿，Enter 不发送、按钮禁用、草稿仅允许保留原文及浏览器默认换行。 |
| B05 | 实际 MainChat + 两条各有 90 条固定历史的对话形成真实 `.chat-body` overflow。跳到旧原句后通过目标与滚动容器的实际矩形交集证明入视口；focus 消费清除后仍停留在旧位置；追加消息使 scrollHeight 增长、提示转成“有新消息”，目标仍在视口且 scrollTop 与追加前相差小于 2px。点击回底、手动滚到底后分别追加增高消息，仍贴底。相同 id 的新 seq 在先滚离目标后重新把目标带回视口；延迟节点先移除到 89 条，确认 focus 未消费，再加入后消费；跨对话 focus 在真实非空第二会话中不误消费。切到第二会话时旧离底提示清除、落底，追加独立消息后继续跟随，切回第一会话无第二会话新增消息。负向断言在可观察 DOM 提交与后续浏览器帧之后读取。 |

测试文件：`apps/web/tests/browser/ui-rail.browser.ts`、`ui-composer.browser.ts`、`ui-chat.browser.ts`；fixture 与专用 runner 位于 `apps/web/tests/ui/**`、`ui-run-browser.mjs`、`ui-playwright.config.ts`。

## 仍待完整验收

- B07/session 的固定时序回归依赖相应批次落定；本阶段的 UI fixture 没有用 fake repository 冒充跨标签 CAS 验证。
- D03 的 fixture 与暂态运行已覆盖 Modal portal、背景 inert、焦点 trap、关闭回焦和 SceneDialog 摘要提交；管理员/Modal 候选稳定后还需最终复跑，暂态结果不作为最终验收。
- B06/SW 的版本交错、离线 shell、旧 tab 懒模块和头像失败回退仍待 SW 批次落定；本阶段没有运行 `sw-*`。
- 本阶段没有发现需退回生产代码的失败。首次 B04 断言把“草稿保留”误写成“值完全相同”；浏览器在被拒发的 Enter 后正常插入换行，断言修正后通过，不是生产缺陷。

## Review fix1（浏览器证据补强）

- RED：先新增更严格的浏览器断言，在原 fixture 上运行 `node apps/web/tests/ui-run-browser.mjs` 得 6 passed、2 failed。失败分别是缺少供 DOM commit 观察的 `data-focus-seq` / `data-conversation` 标记、第二会话仍为空历史；都属 fixture 证据不足，并非生产失败。
- GREEN：fixture 增加第二会话独立 90 条固定消息和只向当前会话追加的消息，测试页只展示当前 props 的 commit 标记。实际滚动、focus 消费和跳底仍完全由真实 MainChat 执行。改动后补齐旧消息入视口/滚动保位、重复 seq 从远处重定位、延迟节点与跨会话负向消费的 DOM/effect 屏障、切会话落底及后续跟随、手动落底后的增高追加。B04 对禁用键盘路径和草稿内容的断言更精确。
- GREEN 命令结果：`node apps/web/tests/ui-run-browser.mjs` 8 passed（11.3s）；目标 Biome 检查 6 文件通过。`pnpm --filter @dramatis/web typecheck` 当前因上述并行文件 4 处 TS2554 失败，已通知主任务处理。

## D03 第二阶段准备（管理员候选稳定前）

- 新增 `apps/web/tests/browser/ui-modal.browser.ts`，在现有 `apps/web/tests/ui/main.tsx` 增加实际 `Modal` 与 `SceneDialog` fixture；导入实际 `styles.css`，只传固定场景 props 与记录回调，不复制 DialogShell 或草稿提交逻辑，不涉及 Settings/Account。仍用同一专用 runner、`127.0.0.1:6287`、fresh nonpersistent Edge context。
- 暂态 `node apps/web/tests/ui-run-browser.mjs ui-modal.browser.ts`：3 passed（3.2s）。实际 DOM 中单个 `role=dialog`、单个标题栏与标题栏关闭按钮、header 可编辑输入、portal 直接挂 `body`、背景 `#root` inert；初始焦点落关闭按钮，首尾经 Shift+Tab/Tab 环绕；Esc、遮罩、标题栏按钮每条只调用一次同一 `onClose`，关闭后触发按钮恢复焦点并移除 inert。
- 实际 SceneDialog 用固定场景编辑 `summary`。在关闭前断言回调尚未收到新摘要，再分别经 Esc、遮罩、标题栏关闭、保存当前场景、切换场景关闭；每条路径仅收到一次摘要 patch，且 `onClose` 在最后。Esc 在 textarea 仍聚焦时发生，覆盖未失焦草稿的 flush。相关回调只计数和记录 patch，不写数据库。
- `pnpm --filter @dramatis/web typecheck` 通过；Biome 对新增/变更的两个 UI 测试文件检查通过。管理员/Modal 实施候选尚未正式落定，本节浏览器运行是准备检查，不升级为 D03 最终验收；root 通知稳定后再复跑并更新最终结果。

## 2026-10-08 B05 跟随竞争路径最终验收

- 完整 Edge 运行记录：`logs/ui-browser-final-fixed.log`，12/12 passed。它覆盖本报告已有 A11、B04、B05 与 D03 的 12 个浏览器用例。
- 新增用例位于 `apps/web/tests/browser/ui-chat.browser.ts:178`。它先通过真实页面把当前对话切到有 90 条固定消息的会话，再追加到 91 条；观察真实 `.chat-body` 的 DOM 数量、`scrollHeight`、`clientHeight`、`scrollTop` 和 sentinel 的 `scrollIntoView` 调用。修复前红日志 `logs/ui-early-scroll-red.log` 记录 gap 145px（跟随阈值为 80px）且最终断言失败。
- MainChat 的消息跟随 effect 已从被动 `useEffect` 移至 `useLayoutEffect`。新用例的 MutationObserver 在观察到 91 条真实 DOM 消息后，只在 gap > 80px 且 sentinel 尚未调用时派发合成 `scroll`，以覆盖 post-commit、passive effect 前的竞争窗口；若 layout effect 已先滚动 sentinel，则不注入事件。最终断言 gap < 80px，并确认 sentinel 确实调用。
- 合成事件仅用于稳定触发竞争时序；消息节点、几何测量和滚动结果是实际 Edge DOM 行为。该固定用例验证了竞争路径，但不能据此断言首轮完整 suite 的 10/11 失败历史根因已证明，也不将其定性为 flaky。
- 这组浏览器 fixture 使用固定 props 与消息，不涉及真实模型请求、用户 profile 或 Key。
