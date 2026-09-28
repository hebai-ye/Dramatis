# 顺序 78 多角色接话实施计划

> 按 superpowers:executing-plans 在当前会话逐项执行；每项测试先红后绿，按项提交。

**Goal:** 按当前轮意图选出一至三名合格角色并顺序生成，保证已提交回合至少一条角色消息。
**Architecture:** core 纯函数合成资格、直接称呼、导演计划和规则保底；web 负责编排、流交接、桥接、记账与 UI。
**Tech Stack:** TypeScript、React、Vitest、pnpm。
**Spec:** docs/TASK-78-MULTI-SPEAKER-DESIGN.md。

## Global Constraints

- 不改 Message 存储结构，不加依赖；同一回合共用 turnId，维持 localSeq/deviceId 和墓碑语义。
- 注释、文档、UI、提交信息用中文。
- 每项独立过 pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:sync-server。
- 不 push、不部署、不改其他用户工作。

## Review Focus

1. 句首称呼与句中提及分离，直接称呼不会被导演漏掉。
2. 场外 onstage、muted、无角色卡者不能进入计划。
3. 同轮两位角色不重复计冷却，不串用私有记忆。
4. 连续流交接不会由前一条的迟到确认清掉下一条。
5. 桥接刷新或跳过不能留下已提交的玩家半轮。

---

### Task 1: Core 多人选择器

**Files:** 新建 packages/core/src/director/turn-speakers.ts、turn-speakers.test.ts；修改 packages/core/src/index.ts。
**Interfaces:** 实现 spec §5 的 directAddressees、selectTurnSpeakers、TurnSpeakerSelection。
- [ ] 写最小失败测试：A 句首、B 句中且导演只荐 B，最终 A 先；再覆盖空计划、cast 与上限。
- [ ] 运行定向测试并确认因选择器缺失失败。
- [ ] 实现纯函数；保留 scheduler.maxSpeakers 默认 1。
- [ ] 运行定向与完整门禁并读结果。
- [ ] 中文提交本项。

### Task 2: 导演契约与设置

**Files:** packages/core/src/director/intent-plan.ts、intent-plan.test.ts、packages/core/src/model/conversation.ts 及相应测试。
**Interfaces:** 实现 spec §3、§5 的 Prompt、pickPlannedSpeakers、speakerLimitOf；Task 3 消费。
- [ ] 写失败测试：两人 key/name 校验、老记录缺字段读默认 2、动作条件进入提示词。
- [ ] 运行定向测试确认预期失败。
- [ ] 修改解析、选择、提示词和模式类型。
- [ ] 运行定向与完整门禁并读结果。
- [ ] 中文提交本项。

### Task 3: 自动生成与保底

**Files:** apps/web/src/hooks/useTurnRunner.ts、相关测试、packages/core/src/prompt/assemble.ts、assemble.test.ts。
**Interfaces:** 消费 Task 1/2 的选择结果；保持每人独立 recallFor、generation 账、同轮落盘。
- [ ] 写失败测试：导演两人产生两条同轮消息且召回隔离；首人生成错误有动作保底。
- [ ] 运行定向测试确认预期失败。
- [ ] 接线预检、一次导演调用、顺序循环和生成失败处理。
- [ ] 运行定向与完整门禁并读结果。
- [ ] 中文提交本项。

### Task 4: 流交接与 UI

**Files:** apps/web/src/lib/stream-store.ts、stream-store.test.ts、apps/web/src/components/StreamingBubble.tsx、MainChat.tsx 及相关测试。
**Interfaces:** 实现 spec §6 的 waitForStreamHandoff、acknowledgeStreamHandoff；Task 3 的循环等待确认。
- [ ] 写失败测试：A 交接后 B 开流，A 迟到确认不能清 B；上限选择器显示默认 2。
- [ ] 运行定向测试确认预期失败。
- [ ] 实现按 ID 交接、超时清理、UI 数字设置和阶段文案。
- [ ] 运行定向与完整门禁并读结果。
- [ ] 中文提交本项。

### Task 5: 网页桥接、用量与端到端回归

**Files:** apps/web/src/App.tsx、components/WebBridgePanel.tsx、lib/bridge-store.ts、components/UsagePanel.tsx 及测试；docs/TASKS.md。
**Interfaces:** 实现 spec §6 的 PendingBridgeTurn 与逐人桥接；最近一轮按 turnId 汇总。
- [ ] 写失败测试：首份贴回前无已提交半轮、两人依次贴回、跳过第二人保留首人。
- [ ] 运行定向测试确认预期失败。
- [ ] 实现逐人桥接、兼容旧单人状态、用量展示并标记顺序 78。
- [ ] 运行定向与完整门禁并读结果。
- [ ] 中文提交本项。
