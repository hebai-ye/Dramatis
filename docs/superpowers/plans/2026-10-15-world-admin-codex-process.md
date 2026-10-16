# 世界管理员 Codex 风格过程与结果 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将世界管理员副对话做成回复前一条可展开过程行，真实思考、工具动作及二级详情在同一区域展示，草稿与已执行结果独立可用，并准确处理保存、中断与待核对状态。

**Architecture:** 保持 core 的 text/tool/done 事件和既有正文拼接，附加可选观测回调；web 使用独立、按来源绑定的内存过程 store，保留现有 stream-store 的正文与 handoff。SideChat 复用过程组件、只读预览及异步结果操作；桥接维持原来源指纹与事务，只改善状态、互斥及助手返回后的明确应用。

**Tech Stack:** 现有 React 19、TypeScript、Vitest、pnpm、内存 Repository 和 DialogShell；不增加依赖。

**Spec:** [WORLD-ADMIN-INTERACTION-DESIGN-2026-10-14.md](../../WORLD-ADMIN-INTERACTION-DESIGN-2026-10-14.md)，包含用户明确要求“思考以及详情都类似于 Codex”的最后修订。合成演示位于 `C:/Users/35350/.codex/visualizations/2026/10/14/01a13934-dbe7-7282-b65e-4208613d5449/world-admin-states.html`，仅作交互参照，不复制其中模拟状态逻辑为产品事实。

## Global Constraints

- 实施起点为 `C:/Users/35350/.codex/worktrees/ui-optimization-20261012/another life` 的**未提交候选全文**，基底 `427dcf056149f499312f385e8652207371234d7a`；桌面项目是较旧版本，不作产品源码起点。
- 本计划保存于桌面项目；原候选继续只读，执行时创建本聊天独立工作区并复制候选项目文件和删除状态。不得只检出基底而丢掉未提交修复。
- 不提交、推送、部署，不调用付费模型，不使用真实账户、存档、凭据、生产同步或管理服务。任务末以 diff 与证据检查代替 commit。
- 保持既有账户隔离、源绑定、事务及草稿/已执行语义；不调整 B08/B09/B10/B11/A08 的语义裁定，也不启用或改变 B12 生产去重策略。
- 不迁移 Message、数据库、同步和封存；过程/参数/推理只驻所属来源内存，不补造旧历史、不增模型调用。跨刷新完整动作历史是设计第三批，本计划不实施。
- 过程行放在回复之前，默认收起；思考与工具合并详情，工具参数/返回值二级展开。用户打开的状态不因分块、阶段变化、保存交接或卡片操作而重置。
- 当前仅实际 reasoning 返回才显示“思考中”；其余使用“等待回复”等真实阶段。正文仍是正文，不改称思考、不让模型额外生成进度解说。
- “已保存”只指已确认的本机保存，不等同远端同步。“已生效”要求实际场景已写入且主对话关联已确认。
- 采纳只进当前账户素材库，不自动入场或启用；世界书按同 ID 整本替换；pending 场景不使用通用采纳。卡/书撤回删除当前目标，身份按 previousPayload 分支恢复或删除；删除身份、已应用场景不提供撤回。
- API 场景和采纳/撤回保留原多段写入语义；桥接场景和管理员消息保留原同事务提交。UI 不新增事务或改变这些数据策略。
- 不确定写入仅提供只读核对；已提交后读取失败仅重新读取。禁止自动重放模型、工具、桥接 raw 或“全部重试”。
- 保留桌面 Enter、Shift+Enter、IME 与粗指针换行规则、下一句 revision 保稿、scope 隔离及主对话既有行为。
- 沿用现有主题与 CSS token；过程详情桌面上限约 360px，窄屏不超过可见区域一半；320px 无横向溢出，触摸目标至少 44px，减少动效时无循环/闪烁。
- 与另一轮首次体验工作独立：不实现 Key 首配、不重写全站文案；本模块必须使用“应用回复”和“等待回复”等与真实效果相符的短文案，不能用“解析草稿”掩盖场景立即写入。

## Review Focus

1. 不同模型请求重复返回 `call_0`，仍应形成不同工具项且保存独立展开状态；Task 2、3 以 requestIndex + toolIndex 验证。
2. 点击停止时工具已进入不可取消写入，工具返回后应保留效果并阻止下一工具和下一请求；Task 2、4 验证，不能把点击停止视作立即回滚。
3. 新 Scene 已写但 saveConversation 失败、实体采纳成功但消息状态写入失败，必须保留待核对而不能重放；Task 4、6 注入实际 Repository 写入断点。
4. A 的迟到 onDelta/catch/finally 或素材操作返回，不能清 B 的状态或用旧 snapshot 覆盖新消息；Task 3、4、6 使用相同名称、不同 ID/owner 的交错用例。
5. 手动粘贴新内容后助手迟到、改用手动后助手 finally、桥接来源变化后剪贴板返回，都不能覆盖输入或自动应用；Task 7 使用 deferred 返回及同 tick 点击验证。

## 文件与执行顺序

后续完整路径均相对于**执行工作区**。文件列表中的 `components/`、`lib/`、`hooks/` 分别明确缩写为 `apps/web/src/components/`、`apps/web/src/lib/`、`apps/web/src/hooks/`；裸组件文件名沿用该任务列出的 components 目录，`App.tsx` 与 `styles.css` 均位于 `apps/web/src/`。以下是新增边界，不把这些功能继续堆进 SideChat 或 App。

| 文件 | 责任 |
| --- | --- |
| `packages/core/src/provider/collect.ts` | 透传实际 reasoning 的可选观测，不改变收集结果 |
| `packages/core/src/admin/turn.ts` | 请求与工具观测、执行开始确认、停止边界 |
| 新 `apps/web/src/lib/admin-process-store.ts` | 来源隔离的内存过程、保存证据、消息关联、展开状态 |
| 新 `apps/web/src/hooks/useAdminProcess.ts` | 局部订阅过程 store，不订阅 App 根树 |
| 新 `apps/web/src/lib/admin-scene-effect.ts` | 场景真实目标及分段写入证据类型 |
| `lib/admin.ts`、`lib/session.ts`、`lib/admin-source.ts` | 既有写入路径上的状态接线和来源守卫 |
| 新 `components/AdminProcessDisclosure.tsx` | 一级过程、思考/工具顺序、二级工具详情及局部耗时 |
| 新 `components/AdminArtifactCard.tsx`、`components/AdminDraftPreview.tsx` | 结果、完整只读预览及局部操作反馈 |
| 新 `lib/admin-artifact-actions.ts` | 异步操作返回类型及只读结果核对 |
| `components/SideChat.tsx`、`components/Composer.tsx`、`App.tsx` | 组合组件、await 接线及真实可停止状态 |
| `components/WebBridgePanel.tsx` | 管理员桥接与助手互斥、填入后确认、复制失败反馈 |
| `styles.css` | 局部过程/结果布局、窄屏、focus 与减少动效 |

Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8。推荐同一实施者顺序执行，末尾独立复核；core、session、过程和 UI 相互依赖较强，避免多名实施者同时修改 App/session/SideChat。

## Task 1: 建立完整候选副本并记录基线

**Files:** 原候选项目文件只读；执行工作区由本聊天原生 worktree 工具返回。执行证据写执行工作区的 ignored `build/world-admin-process/`。

**Interfaces:** 产出确定的执行根目录、候选文件/删除清单、SHA256 清单和基线结果，后续任务只能在该执行根目录写产品代码。

- [ ] **Step 1:** 重新检查候选 HEAD、未提交状态、目录及祖先 AGENTS.md，并用 list_artifacts 检查本聊天是否已有可复用工作区。2026-10-15 计划审查时本聊天附件为空；候选是另一个聊天的 linked worktree，不能直接作为本聊天可写附件使用。
- [ ] **Step 2:** 原生 create_worktree 使用 `allowAsync: true`、`ref: 427dcf056149f499312f385e8652207371234d7a`、名称 `world-admin-process`；等待其真正完成，后续使用返回路径。若执行前候选 HEAD 变化，先重新生成基线记录，不混合两个来源。
- [ ] **Step 3:** 用 `git ls-files --cached --others --exclude-standard` 和删除清单建立来源 manifest；只复制项目文件及已知删除状态，不复制 `.git`、node_modules、build/out、用户库、凭据或私密目录。疑似凭据文件只记录路径并排除。复制前后核对来源未变化、目标 manifest 内容一致；PowerShell 文件操作逐项使用 LiteralPath，并检查目标绝对路径位于返回的工作区内。
- [ ] **Step 4:** 保存继承的未提交 diff 和 manifest，不提交它们；另将桌面项目中本计划和已确认的 WORLD-ADMIN-INTERACTION-DESIGN 文档复制到执行工作区同名 docs 路径，使计划的相对 Spec 链接随交付可用。这两份是本聊天新增文档，单列来源，不冒称原候选已有。检查 Node 符合项目 `^22.13.0 || ^24.0.0`；依赖使用 lockfile，已有依赖有效则不重装，不升级版本。
- [ ] **Step 5:** 在执行根运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`，保存命令、退出码、真实项数和原有警告。基线失败先定位到已有问题或环境，不能以定向通过冒充全量通过，也不能在原候选修复。当前计划阶段**未运行这些测试**。
- [ ] **Step 6:** 检查候选及桌面产品源码未被复制过程修改；通过后进入 Task 2。

## Task 2: 在真实请求与执行边界提供可选观测

**Files:** 修改 `packages/core/src/provider/collect.ts`、`packages/core/src/admin/turn.ts`；新增 `packages/core/src/provider/collect.test.ts`，扩展 `packages/core/src/admin/turn.test.ts`。`src/index.ts` 已 export * 这些模块，核对新类型可导出即可，不另增 runtime 桶依赖。

**Interfaces:** 保留 collect 第五参 onDelta、CompletionResult 及 AdminTurnEvent。第六参和 AdminTurnOptions 增加可选观测：

```ts
export type CompletionObservation = { type: 'reasoning'; delta: string };
// collectCompletionWithTools(provider, messages, params?, signal?, onDelta?, onObservation?)
// 第六参：(event: CompletionObservation) => void

export interface AdminExecutionObservation {
  requestIndex: number;
  toolIndex: number;
  call: ChatToolCall;
  markStarted(): void;
}
export type AdminTurnObservation =
  | { type: 'request-start'; requestIndex: number }
  | { type: 'reasoning'; requestIndex: number; delta: string }
  | { type: 'request-end'; requestIndex: number; outcome: 'completed' | 'failed' | 'stopped' }
  | { type: 'tool-received'; requestIndex: number; toolIndex: number; call: ChatToolCall }
  | { type: 'tool-start'; requestIndex: number; toolIndex: number; callId: string }
  | { type: 'tool-end'; requestIndex: number; toolIndex: number; execution: AdminToolExecution };
// AdminTurnOptions.onObservation?: (event: AdminTurnObservation) => void
// execute: (draft: AdminDraft, observation?: AdminExecutionObservation) => Promise<string>
```

- [ ] **Step 1: 先写失败测试。** `collect.test.ts` 添加“reasoning 只通知实际分块，不进入正文，省略观测时结果相同”；以同一合成 provider 断言 `text === '正文'`、reasoning 增量顺序 `['先','后']`、toolCalls/usage 不变、每次调用 provider.chat 恰好 1 次。
- [ ] **Step 2:** `turn.test.ts` 添加“两次请求重复 call_0 仍按 requestIndex 分开”和“解析失败及来源拒绝不 markStarted”。用已有合成 provider，断言 requestIndex 从 0 开始、toolIndex 为当前请求数组位置；现有 text/tool/done 序列、onDelta 正文及用量完全保留。最后 toolChoice=none 轮即使收到 toolCalls 也无 tool-received/start。
- [ ] **Step 3:** 添加“工具已进入写入时 abort，完成结果保留且后续工具和请求不开始”。用 deferred execute 和忽略 signal 的合成 provider，resolve 已进入的工具后断言该 tool-end 存在，下一工具 start 为 0，provider 调用数不增加。另断言观测回调抛错不会改变执行次数或正常结果。
- [ ] **Step 4:** 运行 `pnpm --filter @dramatis/core exec vitest run src/provider/collect.test.ts src/admin/turn.test.ts`，确认新断言因缺少观测/边界而失败。
- [ ] **Step 5:** 按以上签名实现。collect 仅透传真实 reasoning，不加到 text/上下文。每次真实进入 provider 前发 request-start；按实际结束发 request-end；工具队列在有效可执行轮收集结束后按序发布。markStarted 幂等且只由执行者在来源/abort 守卫通过后调用；core 不在 await execute 前自行假定开始。观测同步、非 await，异常隔离；每次后续工具/请求前检查 abort，已开始写入先返回事实再停止后续。
- [ ] **Step 6:** 重跑上述命令并运行 `pnpm --filter @dramatis/core exec vitest run src/provider/openai-compatible.test.ts src/provider/tools.test.ts`、`pnpm --filter @dramatis/core typecheck`。通过后检查 diff：未增加供应商请求或改变 usage、maxRounds、最后轮策略；非流式 reasoning 仍沿当前不提取的能力边界，不由正文补造。

首个测试的关键断言（reasoning/provider/result 由该测试的合成输入和实际 collect 调用产生）：

```ts
expect(reasoning).toEqual(['先', '后']);
expect(result.text).toBe('正文');
expect(provider.chat).toHaveBeenCalledTimes(1);
expect(result).toEqual(withoutObservation);
```

## Task 3: 独立内存过程 store 与稳定的展开状态

**Files:** 新增 `apps/web/src/lib/admin-process-store.ts`、`apps/web/src/lib/admin-process-store.test.ts`、`apps/web/src/hooks/useAdminProcess.ts`。不扩张主副共用的 StreamPhase。

**Interfaces:** 导出工厂 `createAdminProcessStore(): AdminProcessStore` 和产品单例 `adminProcessStore`。scope 的 db 使用对象身份比较，不序列化；runId 只作 UI 关联，不作幂等票据。

```ts
export interface AdminProcessScope {
  db: object;
  accountKey: string;
  roomId: RoomId;
  conversationId: ConversationId;
}
export type AdminRunPhase = 'saving-input' | 'preparing' | 'waiting-model'
  | 'receiving-reasoning' | 'writing' | 'executing' | 'waiting-next-model'
  | 'saving-output' | 'saved' | 'stopping' | 'stopped' | 'failed'
  | 'partial' | 'uncertain' | 'saved-read-failed' | 'saved-accounting-failed';
export type AdminRunIssue = { kind: 'error' | 'uncertain' | 'read' | 'accounting'; text: string };
export type AdminRunPatch = {
  phase?: AdminRunPhase;
  endedAt?: number;
  unsaved?: { text: string; artifacts: readonly AdminArtifact[] } | null;
  issue?: AdminRunIssue | null;
};
export interface AdminRunSnapshot {
  scope: AdminProcessScope; runId: string;
  messageId: MessageId | null; phase: AdminRunPhase;
  startedAt: number; endedAt: number | null;
  entries: readonly { key: string; sequence: number; receivedAt: number; event: AdminTurnObservation }[];
  unsaved: NonNullable<AdminRunPatch['unsaved']> | null; issue: AdminRunIssue | null;
  expanded: Readonly<Record<string, boolean>>;
}
// AdminProcessStore 方法：
// begin(scope, runId, at: number): void
// observe(scope, runId, event: AdminTurnObservation, at: number): void
// update(scope, runId, patch: AdminRunPatch): void
// bindMessage(scope, runId, messageId: MessageId): void
// setExpanded(scope, runId, key: string, open: boolean): void
// get(scope, lookup: { runId: string } | { messageId: MessageId }): AdminRunSnapshot | null
// subscribe(scope, listener: () => void): () => void
// leave(scope): void  // 清理该来源推理正文，不伪造可恢复历史
// clearAccount(db: object, accountKey: string): void
// useAdminProcess(scope, lookup): AdminRunSnapshot | null，使用 useSyncExternalStore
```

- [ ] **Step 1:** 新测试“同名不同 ID、不同 db/账户拒绝迟到事件”：A/B 同名来源，向 A 注入旧事件，断言 B 快照引用和订阅通知数不变。运行测试确认新增接口缺失导致失败。
- [ ] **Step 2:** 新测试“重复 callId 不合并，按真实请求/工具位置产生稳定 key”：key 使用 `requestIndex:toolIndex`；两个 call_0 有两个独立项，sequence 单调递增。同工具 markStarted 重复不会追加两次开始事实。
- [ ] **Step 3:** 新测试“消息交接和正文 reset 不清过程或展开”：一级 key=`process`、二级 key=`tool:requestIndex:toolIndex`；bindMessage 前后 get 同一 run，expanded 不变；旧消息 acknowledge 不能清新 run；不通知主 stream 通道。
- [ ] **Step 4:** 实现 scope 比较、不可变快照、局部订阅、原始事实列表及独立 UI 展开。只保存 tool call 中用于详情的纯文本参数，禁止保存 headers/Key/完整请求。phase 由真实观测和明确写入步骤推进，不用 busy 猜成功。leave 清 reasoning 增量；账户/db 切换清该账户过程，不串回新账户。
- [ ] **Step 5:** 增加清理测试：leave 后无原 reasoning，已确认结果关联仍可供当前会话按权限查看；clearAccount 后查不到其过程。无 reasoning 事件无空思考条目。
- [ ] **Step 6:** 运行 `pnpm --filter @dramatis/web exec vitest run src/lib/admin-process-store.test.ts src/lib/stream-store.test.ts` 和 Web typecheck；检查 store 没有 sessionStorage/localStorage/Repository 写入及计时器根刷新。

来源反例的关键断言（beforeB 与 afterB 分别是向 A 注入事件前后的真实 B 快照）：

```ts
expect(afterB).toBe(beforeB);
expect(notifyB).not.toHaveBeenCalled();
expect(afterHandoff.expanded['process']).toBe(true);
expect(afterHandoff.expanded['tool:0:0']).toBe(true);
```

## Task 4: 接入管理员生命周期并保留真实保存证据

**Files:** 修改 `apps/web/src/lib/admin.ts`、`apps/web/src/lib/session.ts`、`apps/web/src/lib/admin-source.ts`；新增 `lib/admin-scene-effect.ts`、`lib/admin-run.test.ts`、`lib/session-admin.test.ts`，扩展 `lib/admin-bridge.test.ts`。

**Interfaces:** Task 3 的 store 使用 runId；`AdminChatApi` 新增 `processScope: AdminProcessScope | null`、`activeRunId: string | null`、`canStop: boolean`。保留 send 的接受回调和 SubmitOutcome。场景观测放在现有选取和写入分支：

```ts
export interface AdminSceneTarget {
  roomId: RoomId; worldTitle: string;
  conversationId: ConversationId; conversationTitle: string;
  sceneId: SceneId; sceneTitle: string;
}
export interface AdminSceneEffect {
  target: AdminSceneTarget;
  scene: Scene;
  sceneWritten: true;
  activeLinked: boolean;
}
// SessionApi.setWorldScene(patch: Partial<Scene>,
//   onEffect?: (effect: AdminSceneEffect) => void): Promise<Scene | null>
// AdminRunSnapshot 增加 sceneEffects: readonly AdminSceneEffect[]；
// store 增加 sceneEffect(scope, runId, effect: AdminSceneEffect): void。

export interface AdminSourceCommitResult {
  message: Message;
  sceneTargets: readonly { artifactId: string; target: AdminSceneTarget }[];
  notes: readonly string[];
}
// commitAdminSource 原输入不变，返回 Promise<AdminSourceCommitResult>。
```

- [ ] **Step 1:** 用 `session-feedback.test.ts` 同类依赖感知 hook host、真实内存 Repository 写失败用例：“saveScene 已成功、创建场景的 saveConversation 失败”。断言 onEffect 收到 sceneWritten=true/activeLinked=false，Scene 可重读而目标主对话尚未关联；UI 不可显示已生效。运行定向确认当前接口缺失而失败。
- [ ] **Step 2:** 实现可选 onEffect，在 saveScene 返回后通知真实目标；已有活跃关联则 activeLinked=true，新建关联待 saveConversation 返回才发 true。观测异常隔离。保留 API 原选取规则，包含 active main 优先分支当前不检查 archivedAt 的事实；仅返回元数据，不改变规则、不补事务。写入后向 UI 合并场景/关联时核对 captured owner/db/room/conversation，只更新最新 snapshot 的目标项，不能让迟到场景保存把新世界快照换回去；加 A 保存期间切 B 的反例。
- [ ] **Step 3:** `admin-run.test.ts` 写交错反例：A onDelta/catch/finally 迟到不能清 B 的 stream、abortRef、busy 或 inFlight；成功写消息后 ledger 抛错，消息仍已保存且不追加第二条；输出保存失败时保留未保存正文/草稿和场景证据，无额外 provider/execute 调用。
- [ ] **Step 4:** useAdminChat 开始时创建绑定来源的 run；busy/error/inFlight/controller 的所有权显式绑定 scope + runId。切来源立即对外隐藏旧状态并 abort 旧请求；旧 finally 只清理自己，既不能清新 run，也不能因全部跳过清理而留下永久 busy。所有 onDelta、观测、catch、finally、补记、onChanged 均检查 operation 与来源再发布。execute 先按原规则检查来源/abort，再 `observation?.markStarted()`，再 executeDraft。停止期间允许已进入写入返回的效果被记录为原 run 事实，不能用 signal.aborted 丢掉它；换来源后的效果只关联原 run，不发布到当前界面，也不重建已清理账户的过程。
- [ ] **Step 5:** 明确设置 saving-input/preparing/provider 活动/saving-output 与 canStop。输入保存和输出保存均不可停止；onAcceptance 仍只清原 revision。正常 append 返回后 bindMessage 并保持 handoff；补记失败不吞成“无改动”，存 issue/unsaved。ledger 单独捕获为 saved-accounting-failed，不降级内容、重复补记或估算费用。
- [ ] **Step 6:** 桥接保持事务内源复核、场景和消息同事务，仅收集 AdminSourceCommitResult。事务成功返回后再发布已保存/目标；事务失败不发布内部 saveScene 成功。测试两个同名 main 且 active 与最近更新不同，分别断言 API/桥接命中各自原规则；桥接 append 失败回滚、成功后 reload 失败仅读取。
- [ ] **Step 7:** 运行 `pnpm --filter @dramatis/web exec vitest run src/lib/admin-run.test.ts src/lib/session-admin.test.ts src/lib/admin-bridge.test.ts src/lib/stream-store.test.ts src/App.bridge.test.tsx` 和 Core/Web typecheck。检查未给旧 artifact 造 targetId、未向 Message 加 trace；旧历史显示“当时的主对话”且不猜跳转。

实际写入断点的关键断言（effects 为可选回调捕获的真实确认）：

```ts
expect(effects.at(-1)).toMatchObject({ sceneWritten: true, activeLinked: false });
expect(await repository.getScene(sceneId)).not.toBeNull();
expect((await repository.getConversation(mainId))?.activeSceneId).not.toBe(sceneId);
expect(execute).toHaveBeenCalledTimes(1); // 核对没有再次执行
```

## Task 5: Codex 风格过程行、真实详情与稳定阅读

**Files:** 新增 `components/AdminProcessDisclosure.tsx`、`components/AdminProcessDisclosure.test.tsx`、`components/SideChat-focus.test.tsx`；修改 `components/SideChat.tsx`、`components/SideChat.test.tsx`、`App.tsx`、`styles.css`。新组件使用 Task 3 store/hook，不增加 App 每 token 订阅。

**Interfaces:** `AdminProcessDisclosure({scope, runId}: {scope: AdminProcessScope; runId: string}): ReactElement | null`。SideChat 增加 `processScope?: AdminProcessScope | null`、`activeRunId?: string | null`、`canStop?: boolean`，App 透传 Task 4 返回值。持续使用原 stream text/handoffId；历史消息通过 store 的 messageId 关联到同一 runId。

- [ ] **Step 1:** 先写“过程位于正文之前、默认收起、无 reasoning 不出现思考内容”测试。断言有 reasoning 后标题“思考中”，无 reasoning 的 provider 请求标题“等待回复”；真实工具开始后标题动作原位更新。既有 SSR 断言只调整展示文案，保留正文出现次数=1 的 handoff 验证。
- [ ] **Step 2:** 写“用户一级/二级展开跨工具事件、消息交接、卡片操作保持”：通过项目现有受控 hook host 调用真实元素 onToggle；expanded 保存在 store 而非易卸载组件局部。文本分块不能重置；若列表由流式行切换为消息行，行 key 使用关联 runId，旧历史没有 run 则用 message.id。另覆盖 handoff 消息后又到一条同步消息，仍只画一次正文；交接检查应在列表查找实际 handoffId，不能只比较最后一条。
- [ ] **Step 3:** 实现原生 details/summary 的一级过程；内部按真实事件序号组合思考段、紧凑工具行及业务结果。单工具展开再显示对象、参数纯文本、返回值/错误；失败摘要不藏进正常完成。tool-end ok=false 必须失败；ok=true 但 draft 未保存则“草稿待保存”，不冒称保存完成。
- [ ] **Step 4:** 在局部组件测量 elapsed，运行时每秒更新该组件；总时长以本地实际 begin/end 为准，12 秒无新事件“暂未收到新内容”，45 秒给等待/停止建议；无百分比/ETA。播报节点仅在阶段或错误变化时更新，elapsed 和分块不放 live region。完成标题“已完成 · N 个动作 · T 秒”仅显示已知数值；结果摘要/卡在详情之外。
- [ ] **Step 5:** 写“上滚查看历史期间新工具、展开高度和保存交接不拉回；回最新恢复”测试。沿用可见性/nearBottom 的意图，加入新卡片/展开高度变化的 ResizeObserver 处理，避免全历史按 token 求和。手动展开历史项保持锚点；选择文本不抢滚动。过程内部滚动不触发外层回底。
- [ ] **Step 6:** 运行 `pnpm --filter @dramatis/web exec vitest run src/components/AdminProcessDisclosure.test.tsx src/components/SideChat.test.tsx src/components/SideChat-focus.test.tsx src/components/chat-submission.test.tsx src/components/MainChat-focus.test.tsx`；真实浏览器的折叠/滚动留 Task 8，SSR 不冒称证明布局。

交接反例的关键断言：

```ts
expect(html.match(/唯一的流式正文/gu)).toHaveLength(1);
expect(snapshot.expanded['process']).toBe(true);
expect(snapshot.expanded['tool:0:0']).toBe(true);
```

## Task 6: 完整草稿预览与可等待、可核对的结果操作

**Files:** 新增 `components/AdminArtifactCard.tsx`、`components/AdminDraftPreview.tsx`、`components/AdminArtifactCard.test.tsx`、`lib/admin-artifact-actions.ts`；修改 `SideChat.tsx`、`App.tsx`、`lib/session.ts`、Task 4 的 `session-admin.test.ts`、`styles.css`。不修改 Repository 的事务/采纳/撤回语义。

**Interfaces:** 在 admin-artifact-actions.ts 导出：

```ts
export type ArtifactAction = 'adopt' | 'discard' | 'revoke';
export type ArtifactActionResult =
  | { status: 'confirmed'; message: Message; artifact: AdminArtifact }
  | { status: 'blocked'; message: Message; artifact: AdminArtifact; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'saved-read-failed'; message: Message; artifact: AdminArtifact; reason: string }
  | { status: 'uncertain'; reason: string };
// inspectAdminArtifactAction(repository: Repository, messageId: MessageId,
//   artifactId: string, action: ArtifactAction): Promise<ArtifactActionResult>
// SessionApi 的 adoptArtifact/discardArtifact/revokeArtifact 原参数不变，
// 返回 Promise<ArtifactActionResult>；新增 inspectArtifact(messageId, artifactId, action)。
// SideChat 的 onAdopt/onDiscard/onRevoke 返回同类型 Promise，不再 void。
```

AdminArtifactCard 使用 SideChat 当前对应卡片的 artifact、messageId、disabled/exists 及上述异步回调；局部操作 key 为 scope + messageId + artifactId，不按名称。AdminDraftPreview 输入 `{artifact, sourceLabel, onClose, returnFocus}`，复用 DialogShell，只读不新增素材编辑器。

- [ ] **Step 1:** 先写“同卡同 tick 两次采纳只调用一次；冲突正常 resolve 不算采纳成功；迟到结果不串 scope”。另一个卡片不因局部 pending 无故禁读；全局生成/归档仍沿原禁写规则。
- [ ] **Step 2:** 在 session-admin 中注入实体写成功、消息状态写失败及刷新失败；断言 uncertain、saved-read-failed 区别。等待中追加新消息/切世界，原 current 不得整份回写；只有 captured owner/db/room/conversation 匹配才向**最新** snapshot 合并返回消息。
- [ ] **Step 3:** 改 session 返回结果，App 直接 return Promise。判断期望状态 adopt→adopted、discard→discarded、revoke→pending；conflict→blocked，缺消息/缺 artifact→missing。Repository 已成功而 refresh 失败→saved-read-failed。只读 inspect 按消息/目标 ID 核对，不能调用写方法，不能仅凭同名或相同内容证明本次执行；证据不足保留 uncertain。inspect 前也检查该消息属于捕获的 world/side，不能越界读另一个来源。
- [ ] **Step 4:** 结果卡设置同步 ref 互斥和局部等待/错误；uncertain 锁写，只能核对/复制；重新读取不重放操作。完整只读预览角色设定、世界书全条目/关键词和身份；不恢复已删除的开场白字段，不把当前素材对比当生成时旧值。
- [ ] **Step 5:** 测试并实现三类必要说明：同 ID 世界书整本替换；pending scene 无通用采纳；卡/书撤回明确删除当前目标（含后续修改），身份有 previousPayload 才恢复旧内容、没有则删除，删除身份/applied scene 无撤回。危险确认使用 DialogShell 和具体目标；Esc 取消、关闭回焦，预览不中断生成。
- [ ] **Step 6:** 运行 `pnpm --filter @dramatis/web exec vitest run src/components/AdminArtifactCard.test.tsx src/components/modal-behavior.test.tsx src/lib/session-admin.test.ts src/lib/session-library.test.ts src/components/chat-submission.test.tsx`，以及 `pnpm --filter @dramatis/core exec vitest run src/storage/artifact.test.ts src/storage/artifact-conflict.test.ts src/storage/artifact-revoke.test.ts`。确认只改展示及返回/守卫，没有“恢复旧卡书版本”的新语义。

冲突与不确定写入的关键断言：

```ts
expect(adopt).toHaveBeenCalledTimes(1);
expect(conflictResult.status).toBe('blocked');
expect(conflictResult.artifact.status).toBe('pending');
expect(partialWriteResult.status).toBe('uncertain');
expect(writeAfterInspect).toBe(writeBeforeInspect);
```

## Task 7: 管理员桥接与助手互斥，忙碌不等于可停止

**Files:** 修改 `components/WebBridgePanel.tsx`、`components/Composer.tsx`、`components/SideChat.tsx`、`App.tsx`、`lib/admin.ts`；新增 `components/WebBridgePanel.test.tsx`，扩展 `Composer-send.test.tsx`、`lib/admin-bridge.test.ts`、`App.bridge.test.tsx`。不得无意改变 MainChat 的 reply/analysis 提交行为。

**Interfaces:**

```ts
export type BridgeCommitOutcome =
  | { status: 'confirmed'; messageId: MessageId }
  | { status: 'saved-read-failed'; messageId: MessageId; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'uncertain'; reason: string };
// AdminChatApi.commitBridge(raw: string): Promise<BridgeCommitOutcome>
// SideChat.onBridgeCommit、WebBridgePanel.onAdmin 返回同一 Promise。
// Composer.canStop?: boolean，缺省保持 MainChat 现有行为；
// SideChat 显式传入 Task 4 的 canStop。
```

- [ ] **Step 1:** 先写助手 deferred 测试：同 tick 启动两次只一个 ask；返回后 onAdmin 调用数=0，仅填入；用户明确应用后=1；helper 等待期间应用/放弃不能竞争。“改用手动”后旧返回/错误/finally 不得覆盖新 paste；用户已手动输入的新文字也不能被迟到助手替换。
- [ ] **Step 2:** 为管理员分支实现 bridgeStep + generation 的同步锁。助手等待时仅提供“改用手动贴回”，使当前回调失效；不声称网页取消。助手返回先供核对，应用时冻结 raw 并 await onAdmin；来源更换/卸载让旧回调失效。保留主对话原自动路径，使用 isAdmin 分支，不增加 helper 服务协议或真实自动化请求。
- [ ] **Step 3:** 增加复制失败可手动复制；剪贴板仅空框填入、有明确提示、不自动应用。未提交粘贴只驻对应来源内存，不新增 sessionStorage 粘贴全文；原 binding 恢复与源指纹继续保留。桥接放入当前轮次，手机下一句输入收为可展开草稿入口；来源/阶段变化不把 A 粘贴带去 B。
- [ ] **Step 4:** commitBridge 依 Task 4 的事务返回分类，事务已确认而 reload 失败→saved-read-failed；确定源过期/校验拒绝→rejected；未能确认提交状态→uncertain。普通正文或畸形 JSON 按现解析真实结果显示，不能保证总是解析异常。按钮叫“应用回复”，旁边说明场景立即设置、素材仍需采纳。source-invalid 禁重复提交旧来源，保留可复制文本。
- [ ] **Step 5:** canStop 将 busy 与可取消分开：仅真实活跃 API 生成阶段允许停止；saving-input、saving-output、桥接事务、记账无停止。保留输入编辑与 busy/bridgeOpen 发送守卫。测试所有不可取消阶段无 stop，桌面 Enter/Shift/IME/粗指针规则及主对话默认行为不变。
- [ ] **Step 6:** 运行 `pnpm --filter @dramatis/web exec vitest run src/components/WebBridgePanel.test.tsx src/components/Composer-send.test.tsx src/components/chat-submission.test.tsx src/lib/admin-bridge.test.ts src/App.bridge.test.tsx src/lib/bridge-analysis.test.ts`。检查所有“核对/重新读取”路径无 provider、execute、commitAdminSource 或 askLocalBridge 重放。

助手只填入的关键断言（beforeApply 在助手返回、用户未点应用时捕获）：

```ts
expect(beforeApply.onAdminCalls).toBe(0);
expect(beforeApply.paste).toBe('合成助手回复');
expect(afterExplicitApply.onAdminCalls).toBe(1);
expect(afterLateHelper.paste).toBe('后来手动输入');
```

## Task 8: 真实组件浏览器验收、全量检查与交付

**Files:** 新增本批实施记录 `docs/WORLD-ADMIN-IMPLEMENTATION-2026-10-15.md`（执行日变化则使用实际日期）；浏览器夹具如需新增，限定 `apps/web/tools/admin-ui-fixture.mjs`，仅本机合成 SSE/工具响应和可丢弃导入包，不进入产品入口。证据写 ignored `build/world-admin-process/`，截图写当前聊天可写目录。

**Interfaces:** 夹具只监听 loopback，打印实际选择的地址；不向外 fetch，不使用真实 Key。复用现有合成封存导入正常 UI，使用独立 origin 和合成 provider，不能打开正式账户/存档。任何 Key 字符串仅为夹具本机无效测试值，不代表连接真实服务。

- [ ] **Step 1:** 浏览器实际走无 reasoning、仅 reasoning、连续三工具、解析拒绝、长等待、工具后停止、部分保存/读取失败、手动桥接及助手迟到夹具；按设计 WA01–WA20 逐项记录已验与未验，不用原型切换代替产品事件。仅为仍未被定向测试覆盖的行为加测试，不为纯文案重复镜像测试。
- [ ] **Step 2:** 在 320/360/390、容器 560/650、桌面 1280 和 200% 缩放检查折叠层级、完整预览、触摸按钮、长名/JSON 换行；真实确认横向宽度不溢出。查看历史期间流式工具、结果卡与 handoff 不抢位置；回最新恢复；过程和二级展开跨完成保持。
- [ ] **Step 3:** 检查键盘 Tab/Shift+Tab/Esc、焦点回原操作、减少动效、阶段播报去重；读屏、真实 IME、手机软键盘和壳生命周期只有具备实际设备/证据才标通过，其他明确待验。截图只证明相应布局，不证明时序或真机能力。
- [ ] **Step 4:** 运行且保存 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 和 `git diff --check` 的最新输出。全部通过前不宣称通过；新增 bundle/缓存字节与原候选失败预算单列，不提高阈值、不声称解决原性能预算问题。
- [ ] **Step 5:** 按选择的执行方法完成全批独立代码复核，关注 source/abort/多段写入/桥接事务/卡片未知结果；对实际发现的问题写必要反例并修复，相关测试通过后仅按新风险决定是否重跑全量。核对新 diff 只含本批变化，继承候选未提交内容仍完整，原候选和桌面产品源码只读。
- [ ] **Step 6:** 交付执行工作区、具体变更、验证证据、未验设备及已知限制。仍不 commit/push/部署；不把全部原候选继承修改作为本批自有改动宣称完成。

## 需求覆盖与本计划自审

| 设计要求 | 负责位置 |
| --- | --- |
| Codex 风格过程、真实思考、工具二级详情、连续工具 | Task 2、3、5 |
| 发送等待/流式/保存/停止/失败/取消/部分成功 | Task 2、4、5、7 |
| 结果已保存与已生效、真实对象/世界目标 | Task 4、6 |
| 草稿预览、采纳/丢弃、危险撤回、版本冲突 | Task 6 |
| 桥接复制/粘贴/等待/应用、源过期、助手迟到 | Task 4、7 |
| 历史阅读、跟随/返回最新、展开与 handoff | Task 3、5、8 |
| 防重复、只读核对、多段写断点 | Task 4、6、7 |
| 桌面/窄屏/键盘/减少动效 | Task 5、6、7、8 |
| 旧数据/账户隔离、无持久推理/trace | Task 1、3、4、8 |
| 持久完整动作历史 | 明确排除：设计第三批需另立数据方案 |

已核对本计划后续使用的类型/接口均在对应前置任务定义；新增 session 场景第二参保持旧一参调用兼容。新回调观测不是写入成功证明，runId 不是幂等键；unknown 保存没有直接重试。测试使用已有 SSR/受控 hook host/内存 Repository 的能力边界，浏览器另验折叠和位置，未用不存在的 DOM 测试依赖。任务末检查替代 commit，符合本聊天边界。

## 评审与执行交接

2026-10-15 用户“请推进”视为认可最后一版设计，进入本书面实施计划。此时计划已具体可评审，尚未在候选或桌面产品源码实施、未建立新工作区、未运行项目测试。

推荐 **Native（本聊天由我连续实施，末尾独立复核）**：八个任务的 core→store→session→UI 接口依赖紧密，由同一实施者顺序接线可降低重复上下文和集成成本。也可选择 **Subagent-driven（逐任务独立实施与复核）**，审查粒度更细、上下文开销更高。

在用户评审本计划并选择执行方法后，使用相应执行技能推进。产品实施前的这一步来自 writing-plans 的明确交接要求，不新增发布/付费/生产账户授权。
