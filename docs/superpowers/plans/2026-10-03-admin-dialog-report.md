# A09 / A10 / D03 实施报告

状态：实现候选已完成，待 root 独立规格/质量审查与集中验证。未提交、推送或部署。2026-10-07 用户更新验证策略后，本实施者只读检查和编辑，没有继续执行测试、typecheck、lint 或 build。下列通过记录均为此前实跑证据，不代表最后收尾差异已经验证。

## 文件与接口

- `packages/core/src/admin/tools.ts`：`upsert_world_book.entries` 改为按 `entryId` 的条目增改；未提及条目和字段保留，改名保 ID，删除只认 `deleteEntryIds`。拒绝未知、重复、同 ID 删改和不完整原书。`WorldBookDraft.previous` 保存完整原书，新建为 null；合成完整 `book` 与 `baseUpdatedAt`。
- `packages/core/src/admin/world-book.ts`：完整实体校验、具体字段 diff、待采纳冲突判断、修改类识别与 `reverseWorldBookDraft`。通过既有 `tools.ts` 出口导出，未修改 core index/model/repository。
- `packages/core/src/admin/prompt.ts`、`bridge.ts`：提示库列稳定 entryId，说明字段合并及显式删除；`AdminPromptInput` 新增可选 `targetConversationId`/`targetName`，展示选定目标和实际场景，区分素材草稿与场景即时生效。
- `apps/web/src/lib/admin.ts`：`send(text, targetConversationId?)` 捕获目标；单一有效主对话可自动选择，多条不 fallback。API 与桥接共用绑定 scope 的执行函数。桥接 sessionStorage 状态含 `roomId`、`conversationId`、`targetConversationId`、`targetName`、prompt；回填核对原世界和副对话，不读取回填时选择。场景成功 artifact 写目标名与 scene ID，失败不标为已生效；世界书 artifact 使用既有 `previousPayload`。
- `apps/web/src/lib/session.ts`：`setWorldScene(patch, targetConversationId, expectedRoomId?)` 重新读目标与场景，校验同世界/main/非归档/未删除；无目标或目标失效返回 null。新场景沿用已有 repository save 操作，并保留传入 castPolicy。写后只合并相同世界的最新 UI 快照。`adoptArtifact` 增加完整 before/base 与 fresh book 的前置检查；`revokeArtifact` API 层阻止修改类删整本撤回。新增 `reverseArtifact(messageId, artifactId)`，fresh 读当前书，生成 pending 反向 artifact，通过现有消息串行追加队列落到原副对话，避免复制原模型 usage 或恢复旧世界 UI。
- `apps/web/src/components/SideChat.tsx`、`WorldBookDiff.tsx`、`App.tsx`：目标选择器及零主对话说明，新增可选 `conversations`、`worldBooks`、`onReverse`；App 传递目标与反向操作。pending 显示可展开书名/条目字段原值与新值、明确增删；基版本缺失或变化禁采纳。修改类已采纳项显示“起草反向修改”，新建书保留撤回。保留前批 bridgeOpen 与 focus 接口。
- `apps/web/src/components/Modal.tsx`、`DialogShell.tsx`、`SceneDialog.tsx`、`styles.css`：Modal 接 DialogShell 并捕获触发元素；Shell 增加可选 head/footer/closeLabel/modal，旧设置/账户默认保持。单层 dialog，头部头像/可编辑内容保留；Modal 560px 布局、页脚保留。Esc/遮罩/关闭共用 onClose，SceneDialog 仍先 flush。SceneDialog 仅更新注释，未重做设置/账户内容。
- 测试新增：core/admin 的 `world-book-delta.test.ts`、`world-book.test.ts`；web/components 的 `admin-session.test.tsx`、`admin-target.test.tsx`、`admin-review.test.tsx`、`Modal.test.tsx`、`Modal-callbacks.test.tsx`。原 tools/bridge 测试按 entryId 与 content 仅新建必填的新契约调整。

## 反向草稿与边界

反向操作比较可信 before/after，只逆原变更字段。未涉及的条目、同条目未涉及字段及当前顺序保留；原新增条目若被后改、原删除条目若被重建、受影响字段或书名若已后改，拒绝生成。恢复删除条目时放在原后继附近，不重排当前已有条目；原草稿若重排存续条目，拒绝按安全反向处理。反向草稿使用 fresh current 作为 previous 与 baseUpdatedAt，再经普通 diff 和采纳版本检查。

旧修改草稿缺可信 previous 或基版本时阻止采纳并提示重新起草。新草稿显式 null before/base 不误判；旧版仅缺 before、但 base=null 且摘要为旧生成器的“新建世界书”仍按新建识别。缺完整来源、无法区分的旧草稿按修改类保守阻止；不会因原书已删除而把旧修改草稿当新建复活。

## 已有 RED / GREEN 证据（最新策略之前）

| 命令/范围 | RED | 后续 GREEN |
| --- | --- | --- |
| `pnpm --filter @dramatis/core test -- src/admin/world-book-delta.test.ts` | 首次 8/8 失败：省略书名/字段不支持、重复未知操作未拒绝、没有完整 base 仍生成。补完整高级字段用例后曾 1/9 失败。 | 先 8/8，再纳入 admin 65 项通过。 |
| `pnpm --filter @dramatis/core test -- src/admin/world-book.test.ts` | 新接口未实现时 3 项失败；4 个 `toThrow` 用例当时也会因缺接口通过，因此不把这 4 项算有效 RED。 | 7/7 通过；后续真实实现下覆盖受影响字段、增删、书名冲突。 |
| `pnpm --filter @dramatis/web test -- src/components/admin-session.test.tsx src/components/Modal.test.tsx` | 6/6 行为失败：隐式目标、未检查归档/世界、修改书 revoke 删除实体、Modal 缺 aria-modal。 | 6/6；后续 session 增加旧草稿直接采纳、反向草稿/再次过期、延迟写后跨世界 UI，共 8 项通过。 |
| `pnpm --filter @dramatis/web test -- src/components/admin-target.test.tsx` | 4/4 失败：API/bridge 未绑定目标、多个 main fallback、跨世界回填执行。 | 4/4 通过。 |
| `pnpm --filter @dramatis/web test -- src/components/admin-review.test.tsx` | 4/4 失败：无展开 diff、仍提供修改撤回、缺 before 可采纳、无目标选择提示。 | 4/4 通过。 |

最后一次历史集中小范围回归：

- `pnpm --filter @dramatis/core test -- src/admin`：5 文件，65 项通过。中间出现的 3 个旧断言失败已处理：缺触发字段的错误保留可读理由；旧同名改条目 fixture 改传 entryId；bridge 描述断言改为新建 content 必填与新参数。
- `pnpm --filter @dramatis/web test -- src/components/admin-session.test.tsx src/components/admin-target.test.tsx src/components/admin-review.test.tsx src/components/Modal.test.tsx src/components/Modal-callbacks.test.tsx src/components/admin-bridge-guard.test.tsx src/components/SideChat.test.tsx src/components/chat-navigation.test.tsx src/components/Composer.test.tsx src/components/App.rail.test.tsx src/components/settings-panels.test.tsx src/components/account-panels.test.tsx`：12 文件，76 项通过。
- `pnpm --filter @dramatis/web typecheck`：通过。
- 仓库内 Biome 对本批涉及的 24 个 admin/web 文件执行 `check --write`：最后返回 0 errors / 0 warnings（5 文件格式修正）；此前 3 errors、22 warnings 已修正。未运行全仓测试或新增依赖。

## 2026-10-07 收尾差异与待中央验证

最后收尾仅编辑，未执行任何门禁：拒绝非字符串 bookId；细化旧草稿身份判断，避免缺 before/base 的旧修改在原书不存在时被误当新建；补对应静态测试用例；prompt 场景读取额外核对目标归属；用户消息追加失败时释放 busy 并显示错误，追加后切世界不再开启旧请求。上述差异使 core 测试数预计增加 1，准确数量和通过状态以 root 下一次集中运行结果为准。

待 root 集中验证：上述完整针对命令、web typecheck、对应 Biome，以及独立规格/质量审查。实际浏览器的焦点、Tab/ShiftTab、Esc、inert、portal、关闭还焦点、视觉布局由 D01 后置验收；现有 SSR 与回调 harness 只能证明结构和回调/flush 顺序，不构成真实浏览器验收。

存储边界仍属部分一：repository 的“读版本→写入”不具备跨标签原子 CAS，本批前置 fresh read 和 stale check 未消除 TOCTOU。反向草稿也可能在 fresh read 到采纳间与其它标签竞争，需要原子条件写入契约。场景目标读取与 saveScene/saveConversation 之间同样没有原子检查；本批保证明确目标、不 fallback、作用域守卫，不宣称解决跨标签归档/删除与写入竞态。更广泛 session 选择 epoch、提交版本与跨世界异步状态由后续 B07 收口。

## Review fix1（2026-10-07，待中央验证）

- Important：只读核对 `git show f5065ba^:apps/web/src/lib/admin.ts` 与同期 tools 后确认，真实早期生成器的新建和修改 artifact 均省略 `previousPayload`、`baseUpdatedAt`，但摘要区分“新建世界书”与“修改世界书”。此前仅兼容 base=null 的识别仍会误拦早期新建。现修改 `world-book.ts`：before/base 均 nullish 且明确历史新建摘要可识别为 creation；现代显式双 null 标记继续兼容。创建冲突分支同时兼容 undefined，当前已有同 ID 世界书仍拒绝创建；旧修改与来源不明的缺标记 artifact 仍保守拒绝，原书不存在也不复活。补早期真实省略两个字段的 pending/adopted 新建、修改及未知来源形状用例。
- Minor：`lib/admin.ts` 的 getConversation/getScene 异常 catch 仅在当前 world ID 仍等于捕获 room ID 时写 error，始终释放 busy，和消息追加失败分支一致。补两种读取的受控 Promise 交错用例：开始读取 → 切世界 → 拒绝读取，断言当前世界无旧错误、busy 已释放且无消息/场景/桥接写入。
- 本轮仅编辑 `world-book.ts`、`world-book.test.ts`、`admin.ts`、`admin-target.test.tsx` 和本报告。遵从最新策略，没有运行任何测试、typecheck、lint 或 build，也未提交。fix1 不引用此前通过结果作为修复后的验证；全部等待 root 集中运行及 reviewer 复核。
