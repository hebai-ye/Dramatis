# A11 / B04 / B05 实施报告

状态：DONE（本批允许的代码与 mock 行为验证完成；真浏览器项留 D01）。未提交、未推送。

## 文件与接口

- `apps/web/src/App.tsx`：窄屏打开左栏时关闭右栏；桌面双开缩窄时保留左栏。`FocusRequest` 带对话 ID 和 seq；定位导航按请求顺序执行，过期请求不再启动。WorldTree 选对话、切世界、主副对话切换和打开 AI 创建入口会取消待定位请求；`onFocusConsumed(request)` 只清除当前 seq。
- `apps/web/src/components/MainChat.tsx`：定位只在当前对话的 `chat-body` 内找消息；节点未出现时随 `messages` 更新重试。成功定位后立即进入离底状态，显示“回到底部”；新消息保持位置并改显“有新消息”。点击按钮或手动滚到底会恢复普通消息与流式跟随。清除 focus 本身不再触发回底。新增可选接口 `onFocusConsumed(request)`。
- `apps/web/src/components/Composer.tsx`：Enter 与发送按钮共用 `canSend` 条件，覆盖 disabled、busy、bridgeOpen 和空白内容；Shift+Enter、IME 和粗指针继续换行。
- `apps/web/src/components/SideChat.tsx`、`MainChat.tsx`：桥接待回填时，直接调用 submit 也不会发送或清空草稿。
- `apps/web/src/lib/admin.ts`：`send` 在桥接待回填时提前返回，并把 `bridge` 纳入回调依赖，保留旧桥接。
- 新增 `components/App.rail.test.tsx`、`Composer.test.tsx`、`chat-navigation.test.tsx`、`admin-bridge-guard.test.tsx`：通过 React mock harness 调用真实 JSX 回调与效果；没有源码字符串断言。

## Red 证据

以下均在对应生产修复前运行，失败为期望行为未实现：

| 命令 | 结果与失败原因 |
| --- | --- |
| `pnpm --filter @dramatis/web test -- src/components/Composer.test.tsx` | 5 项中 4 失败；disabled、busy、bridgeOpen、空白内容按 Enter 均错误调用 `onSend`。 |
| `pnpm --filter @dramatis/web test -- src/components/chat-navigation.test.tsx` | 5 项全部失败；主/副对话桥接 submit 清空草稿；定位没有按当前对话消费，也没有成功后的离底反馈。测试 harness 先补齐无 DOM 的 `document` stub 后取得该行为失败记录。 |
| `pnpm --filter @dramatis/web test -- src/components/App.rail.test.tsx` | 初始 2 项全部失败；手机左栏打开后两栏同时显示，桌面双开缩窄后两栏同时显示。 |
| `pnpm --filter @dramatis/web test -- src/components/admin-bridge-guard.test.tsx` | 1 项失败；待回填桥接期间第二次 `admin.send` 仍调用 `appendMessages` 并重置流状态。 |
| `pnpm --filter @dramatis/web test -- src/components/App.rail.test.tsx` | 补固定 Promise 交错后，5 项中 1 失败；较旧对话切换先完成时，较新的 focus 被清空。补手动选择交错后，6 项中 1 失败；旧异步选择会覆盖手动选择的会话（底层 session 竞态）。 |

## Green 证据

- `pnpm --filter @dramatis/web test -- src/components/App.rail.test.tsx src/components/chat-navigation.test.tsx src/components/Composer.test.tsx src/components/admin-bridge-guard.test.tsx`：4 个文件、22 项通过。覆盖左/右栏手机与桌面状态、缩窄收敛、Enter 禁用和换行条件、桥接草稿/API 守卫、定位后立即回底提示、追加消息保位、回底恢复流式、同 ID 新 seq、延迟节点、对话范围、手动滚到底、旧请求与手动选择交错。
- `pnpm --filter @dramatis/web typecheck`：通过（`tsc --noEmit && tsc -p tsconfig.tools.json`）。
- 没有重跑全仓基线；本批未新增依赖。

## 验证边界与关注点

- 当前测试调用 React mock harness 的 JSX 回调、effect 和滚动节点替身；真实 DOM 的滚动距离、`scrollIntoView` 动画、CSS 位移与点击顺序尚未在浏览器验证，留给 D01。
- 手动选对话会立即取消旧 focus，定位请求自身串行且新 seq 获胜。底层 `session.openConversation` 的已发异步写入仍可能迟到并覆盖用户随后手动选的会话；B07 将处理 session 选择 epoch/提交版本，本批未建立额外恢复层，也不阻塞普通导航等待旧定位。
- 本机 `pnpm exec biome` 未找到命令；改用仓库内的 `node node_modules/@biomejs/biome/bin/biome`，目标文件检查通过。

## Review fix round1

- 独立 review 的规格检查通过；质量检查指出本批 9 个代码/测试文件有 21 个 Biome 错误。用仓库内 Biome 对这 9 个文件执行 `check --write`，再人工修复测试中的不安全可选链调用；`MainChat` 的 `messages` 依赖保留并注明用途，因为目标节点可能随消息更新才挂载。
- 复核：`pnpm --filter @dramatis/web test -- src/components/App.rail.test.tsx src/components/chat-navigation.test.tsx src/components/Composer.test.tsx src/components/admin-bridge-guard.test.tsx` 为 4 文件、22 项通过；`pnpm --filter @dramatis/web typecheck` 通过；`node node_modules/@biomejs/biome/bin/biome check apps/web/src/App.tsx apps/web/src/components/MainChat.tsx apps/web/src/components/Composer.tsx apps/web/src/components/SideChat.tsx apps/web/src/components/App.rail.test.tsx apps/web/src/components/chat-navigation.test.tsx apps/web/src/components/Composer.test.tsx apps/web/src/components/admin-bridge-guard.test.tsx apps/web/src/lib/admin.ts --max-diagnostics=50` 为 9 文件、0 errors、0 warnings（`No fixes applied`）。

## 2026-10-08 真浏览器收口

- B05 新增真实 DOM 竞争路径用例，记录于 `logs/ui-early-scroll-red.log`：真实 `.chat-body` 从 90 条变为 91 条时，DOM 测得底部 gap 为 145px，超过 80px 跟随阈值。修复前，若在被动跟随 effect 前发生 scroll 事件，该事件会按新增长后的 scrollHeight 把状态判为离底，等待期间 gap 仍为 145px，测试失败。
- 修复将 `MainChat` 的消息跟随 effect 从 `useEffect` 移到 `useLayoutEffect`，使其在 DOM commit 后、被动 effect 前的窗口内完成跟随判断和底部滚动。
- 本证据只说明新增固定用例验证了这条竞争路径；它没有证明首轮完整 suite 的 10/11 失败历史上由该根因造成，也不把那次失败归为 flaky。
- 真实 Edge 最终完整运行记录 `logs/ui-browser-final-fixed.log`：12/12 通过。具体竞争用例使用真实 91 条消息 DOM 和真实滚动高度；为稳定覆盖被动 effect 前的竞争窗口，fixture 的 MutationObserver 只在观察到 91 条消息、gap > 80px 且底部 sentinel 尚未被调用时派发合成 `scroll`。若 `useLayoutEffect` 已先调用 sentinel，则不注入该事件。随后断言 gap < 80px 且 sentinel 确实调用。合成的是竞争事件，DOM、布局测量和最终滚动均来自真实 Edge 页面。
- 浏览器 fixture 使用固定 props/消息；未调用真实模型，也未使用用户 profile 或 Key。
