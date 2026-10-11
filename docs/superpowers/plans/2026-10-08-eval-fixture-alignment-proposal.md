# 旧真实回答解析夹具的最小对齐提案

状态：2026-10-08 用户已限定授权；root 按此范围实施，集中重验待完成。

集中 `pnpm test` 在 core 的 878 项中有 1 项失败：`packages/core/src/eval/prompt-samples.test.ts` 第 331 行。历史回答指定修改 `book-0003`，而测试调用 `parseAdminToolCall` 没有传入原书。A09 新规则拒绝无完整原书的修改是预期行为，不能为这条旧测试放宽生产校验。

拟仅改上述一个测试文件：

1. 将现有管理员取样器内的完整原书种子提取为该文件内的 `sampleWorldBook(id)`，保持名字、条目所有字段和时间生成方式；补必要的 WorldBook 类型/ID import。取样默认仍生成新 ID，历史解析显式使用回答中的 `book-0003`。
2. 提示词取样器继续使用 `worldBooks: [sampleWorldBook()]`，保证原有样本语义不变。
3. 历史回答解析测试先生成同一原书，解析调用改为 `parseAdminToolCall(call, { worldBooks: [originalBook] })`。
4. 对世界书草稿额外断言：原条目及 ID 完整保留，历史回答中不带 entryId 的三项作为新增条目，且没有隐式删除。这记录历史整书形态在新条目级契约下的实际含义，不假称旧回答具备新版 entryId。

不修改 `real-model-responses.ts`、真实模型预算、生产 core/admin 校验、其余 core 文件或根依赖。获授权后纳入 root 总测试，不派子任务单独测试。
