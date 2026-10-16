# D02 冻结夹具

`manifest.json` 保存十二个固定输入及 production builders 的真实输出：角色扮演、记忆抽取、情绪关系、管理员各三组。时间固定 `2026-10-03T00:00:00.000Z`，实体 ID 使用字面量 branded IDs；装配过程不调用 newId/nowIso creator。

重新生成 candidate：

```powershell
node tools/desktop/validation-freeze.mjs
```

基线固定为 `4c5169a23ecc901ab892bae182f8f4ac78c4b8b8`。生成器从 git blob 提取 admin/prompt.ts、admin/tools.ts，在系统临时目录改写相对 import 后由 Vite 实际执行，结束即删除临时模块。非 admin 的 production core 源码（排除测试/eval）逐文件与 git blob 比对规范化换行后的 SHA256；出现差异即拒绝冒称共同基线。输入、messages/tools/params 使用递归排序对象键、保持数组顺序的 canonical JSON，并分别记录 fixtureHash/requestHash、commit、源码 hash。candidate 明示 working-tree，commit 不代表工作区无改动。

Schema 2 完整冻结各 builder 的实际输入。初次开发的 schema 1 只记录共享实体；迁移时逐份核对原冻结 request canonical 相等后才补全输入元数据，没有替换任何 baseline prompt。最终 baseline canonical SHA256：`a490d9633ebf203737f87890b429b1181120cc1f6f9cd618a5b55f3d22820f3b`。后续生成器拒绝 baseline 漂移。

候选依赖枚举同时读取工作区完整 production core TS（含新增未跟踪文件，仍排除测试/eval）。旧 git tree 的 `dependencyHashes` 保持原有 baseline/candidate 对；新增 admin 源码规范化换行后的 SHA256 单独写入 `candidateOnlyDependencyHashes`，并合入 candidate 每份夹具的 `sourceHash`，因此新增 `admin/world-book.ts` 及其后续内容修改可追溯。新映射不进入 baseline 的 `sourceHash`，不假造不存在的旧 blob，也不改变上述完整冻结 baseline hash。新增非 admin production TS、缺失旧依赖、非 admin 源码变化均拒绝标记共享基线。此为 schema 2 的附加候选元数据；实际 manifest 由 root 在最终候选固定后重新生成。

初始冻结时十二组 baseline/candidate hash 相同；这是初始冻结证据，不代表当前候选。root 最新一次 `validation-freeze` 成功：共同九组相同，管理员三组不同；baselineHash 仍为 `a490d9633ebf203737f87890b429b1181120cc1f6f9cd618a5b55f3d22820f3b`，candidateOnly 映射包含 `world-book.ts`。当前矩阵最多42请求：共同九组每组两次=18，管理员三组的 baseline/candidate 两侧各两次、每轮最多两次=最多24。execute 只回摘要、明确“未写库”，不触达任何store。每轮HTTP独立经过总账；首轮没有工具调用则只发一轮，缺usage/失败即停。再为C05预留4次，总计46/48；剩余2次不是必须花掉的配额。失败或 abort 已消耗预算，不能重试。第二轮的实际wire独立canonical SHA256、messages/tools/参数、text/toolCalls/usage/error均保留，不能冒充首轮重复。

管理员baseline使用从4c5169a git blob实际编译的`admin/turn.ts`与`admin/tools.ts`（含parser），candidate使用工作区production实现。`validation-baseline.mjs`核对blob与shared依赖hash，仅在系统临时目录装配源码，构建到ignored质量bundle后删除临时源码；不把旧源码加入公开提交物。缺baseline engine时runner明确拒绝，不回退为candidate parser。Node测试已实际运行baseline两轮与raw tool解析；这仍是假transport功能证据，不是真质量评分。

参数固定 deepseek-flash / reasoning_effort low / thinking enabled / max_tokens 1200（含 reasoning）。Low 由验证 fetchImpl 注入，并非产品已有设置。temperature/top_p/presence_penalty/frequency_penalty 不作为实验变量。

页面对样本随机排序、隐藏 baseline/candidate；原始结果 JSONL、人工五项评分 JSONL、评分后揭盲映射分开下载。不要在评分前查看映射或原始请求。评分屏展示两侧共用的原卡性格、世界书、场景、相关历史、用户任务和约束，以及回复、工具、usage、parse/error；不显示侧别或侧别请求 prompt。共同背景取自冻结原始输入，不随 candidate prompt 或卡片改动而变化，原始和评分下载均保留该背景。切换样本清空旧回复；发送期间禁止切换。

原始下载的每轮 `wire` 保留完整实际请求 body（包括 `stream_options`、`reasoning_effort`）；`wireHash` 是脱敏前完整 body 的 canonical SHA256，`exportedWireHash` 可由导出的 `wire` 按递归排序对象键、保持数组顺序重建校验。正常无秘密 body 两值相等；若脱敏改变内容，`wireRedacted=true` 且明确保留两种 hash 的语义，不能用导出 body 假称重建原始 hash。reasoning/reasoning_content、Authorization、Key 不进入记录，reasoning_effort 配置保留，error body 不导出。管理员草稿 parser 按对应侧源码与夹具上下文执行，生成 ID/time 不参与语义比较。非角色五项不适用项记 N/A；另打任务正确性 0/1/2，逐项证据与判分人必填。两次重复仅提供探索性证据，不证明总体、长对话或400轮质量提升。

完整入口、限制和外部清单见 [本轮验证清单](../VALIDATION-2026-10-03.md)。
