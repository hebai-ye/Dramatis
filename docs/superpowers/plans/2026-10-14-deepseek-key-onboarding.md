# DeepSeek Key 首次配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 首次打开或确认未配置 Key 时，先显示只有 DeepSeek API Key 一个输入框的弹窗，保存后继续，其他配置使用默认值。

**Architecture:** 在现有 provider hook 中增加绑定目标的 DeepSeek Key 保存入口，复用现有密钥存储和凭据同步逻辑。独立 hook 管理自动提醒与本次访问内的稍后配置状态，独立弹窗复用 DialogShell 的焦点、busy 和放弃守卫；App 负责排队和手动入口。

**Tech Stack:** React 19、TypeScript、现有 Repository / KeyStore、Vitest、pnpm；不增加依赖。

**Spec:** `C:/Users/35350/Desktop/another life/docs/FIRST-USE-AND-COPY-DESIGN-2026-10-14.md` v2，重点为 §3 的极简 Key 弹窗、§4.1 K0–K5、§4.4、§4.5 及相关文案与验收。

## Global Constraints

- 本批范围为用户最后确认的 DeepSeek Key 前置配置及相邻聊天提示；示例角色、统一文件导入、其余逐页文案另作独立实现批次，不以本批完成宣称整份设计已实施。
- 审查与复制起点为 `C:/Users/35350/.codex/worktrees/ui-optimization-20261012/another life` 的最新未提交候选，基底提交 `427dcf0`。
- 使用当前聊天新建的隔离工作区，从该基底开始完整复制候选非忽略文件及已删除状态；保留原候选、桌面项目和原 UI 优化未提交改动。禁止用桌面旧源码作为起点。
- 不提交、推送、部署，不调用付费模型，不连接真实账户、生产同步或管理服务。
- 不改 B08/B09/B10/B11/A08 或 B12 生产策略；不做性能、数据库迁移、背景任务或资金语义重构。
- 新用户沿用 `DEFAULT_PROFILE`：`https://api.deepseek.com`、`deepseek-flash`、`main`。现有配置参数不重置；这些参数不展示为首次弹窗输入项。
- 唯一输入为 DeepSeek API Key；无服务商、地址、模型、口令、保存模式、价格或高级选择器，无测试连接按钮。
- 保留“申请 API Key”“保存并继续”和低强调“稍后配置”；申请地址为候选已有的 `https://platform.deepseek.com/api_keys`。
- 全新用户仍默认本机明文保存，邻近显示事实；已有会话 / 加密方式沿用，不在首配窗切换。
- 已有可用 Key 不重复提示；读取中、读取失败、未解锁不当作确认缺 Key。自动弹窗不叠加现有弹窗、未完成桥接或恢复码守卫。
- 保存失败保留输入；部分完成先核对，不能重复创建配置。保存及目标 Key 可读取确认后关闭，不自动发送用户草稿，不声称连接验证成功。
- 维持既有桌面 Enter / 粗指针换行、桥接进度、来源校验、删除、恢复码与费用提示。

## Review Focus

1. 初始 `active=null`、`keyLoading=false`、`apiKey=''` 不能提前弹缺 Key 表单；慢读取、失败及锁定必须区分。
2. 从其他服务商缺 Key 配置进入首次设置时，只向独立 DeepSeek 配置写 Key，不覆盖原配置、原 Key 或保存模式。
3. Key 已写入但凭据同步 / 配置选择后段失败时，重试使用同一个目标，不重复建立配置，不把未完成当保存成功。
4. 加密库解锁后只更新 Key，不再次索取口令、不降级为明文；保存中的账户 / 配置变化不能使迟到结果串入新页面。
5. 主动稍后配置仅在本次访问内抑制自动提醒；重开缺 Key 再提醒，现有编辑、桥接和恢复码流程优先。

## Task 1: 隔离候选与基线

**Files:** 原候选全部非忽略文件只读；执行工作区由 Codex 原生 worktree 工具返回。

**Interfaces:** 后续任务使用这个复制后的工作区，文件路径均相对于该工作区，不在原候选写代码。

- [x] 记录候选文件列表、删除状态及 SHA256；检查 AGENTS.md 和现有管理工作区。
- [x] 原生创建隔离工作区，指定 `ref: 427dcf0`，复制候选已跟踪及非忽略新增文件；不复制 `.git`、依赖目录、构建缓存或用户库。
- [x] 核对复制后候选文件一致；依赖按现有 lockfile 准备，不升级包。
- [x] 运行原项目基线：`pnpm typecheck`、`pnpm lint`、`pnpm test`。记录真实结果；原有警告单列，失败先定位，不能将定向通过当全量通过。

## Task 2: 目标绑定的 DeepSeek Key 保存

**Files:** 修改 `apps/web/src/lib/providers.ts`；新增 `apps/web/src/lib/deepseek-setup.ts`；扩展 `apps/web/src/lib/provider-key-readiness.test.ts`，新增 `apps/web/src/lib/deepseek-setup.test.ts`。

**Interfaces:**
- `ProvidersApi.setupOwner: DeepSeekSetupOwner | null`：弹窗打开时捕获账户库、存储方式、解锁上下文、配置 ID / Key 引用 / 地址的归属标记。
- `ProvidersApi.saveDeepSeekKey(apiKey: string, expectedOwner: DeepSeekSetupOwner): Promise<DeepSeekSetupReceipt>`：核验弹窗打开时的归属及持久化配置；返回已完成保存与选择的目标 `profileId / keyRef / baseUrl`，供界面确认同一目标读取。拒绝时不清输入。
- `deepseekSetupState(input: { active: ProviderProfile | null; apiKey: string; keyLoading: boolean; keyError: string | null; vaultLocked: boolean }): 'waiting' | 'configured' | 'missing' | 'read-error' | 'locked'`：只描述界面状态，不把非空 Key 宣称已通过模型验证。
- `isDeepSeekProfile(profile: ProviderProfile): boolean`：仅识别官方 HTTPS 主机与已支持路径，不按配置名称猜测，拒绝相似域名或自定义中转地址。

- [x] 先写行为测试：初始空 active 为 waiting；读取中 waiting；失败 read-error；锁定 locked；正常空值 missing；可读非空值 configured；合法官方配置与相似域名分开。
- [x] 写真实 Repository / KeyStore 保存测试：DeepSeek 已有参数保持不变；其他服务商配置与 Key 保持原值；目标默认值正确且只建立一次；device / session / 已解锁 encrypted 都能保存。
- [x] 加入延迟与后段失败反例：配置切换时旧操作不能发布为新 active Key；写 Key 后凭据步骤失败保留目标，下次重试不新增第二份配置；读取失败 / 未解锁 / 空输入均不写库。
- [x] 运行上述测试，确认因缺少生产入口或错误分支而失败，再实现最小入口；复用现有 `requireKeyReady`、`providerKeyStore`、`syncCredential`、选择与读取机制，不改变完整 `commitConfig` 的语义。
- [x] 定向命令：`pnpm --filter @dramatis/web test src/lib/deepseek-setup.test.ts src/lib/provider-key-readiness.test.ts src/lib/providers.test.ts`；确认全部通过并无新增未处理拒绝。

## Task 3: 单字段弹窗与提示时机

**Files:** 新增 `apps/web/src/components/DeepSeekKeyDialog.tsx`、`apps/web/src/components/DeepSeekKeyDialog.test.tsx`、`apps/web/src/hooks/useDeepSeekSetup.ts`、`apps/web/src/hooks/useDeepSeekSetup.test.tsx`；必要时仅在 `apps/web/src/styles.css` 增加本弹窗窄屏样式。

**Interfaces:**
- `useDeepSeekSetup({ accountKey, providers, blocked }): { open: boolean; state: ReturnType<typeof deepseekSetupState>; requestOpen: () => void; dismiss: () => void }`。`blocked` 由 App 提供现有交互占用状态，禁止叠窗；dismiss 只记录内存中的账户 / 配置提醒，不将 Key 或草稿持久化。
- `DeepSeekKeyDialog({ providers, onClose, onRecover, returnFocus })`。`onRecover` 进入现有模型设置恢复入口；表单只含一个可输入的 Key 字段；使用 DialogShell / Modal 的实际守卫，不自行实现第二套焦点陷阱。

- [x] 先写真实组件与 hook 的行为测试：确认 missing 后自动打开；blocked 时排队；稍后配置后同一 owner 不反复打开；新访问再次提示；已有可读 Key 不提示；读取失败 / 锁定不呈现空缺 Key 表单。
- [x] 表单测试只断言一个可编辑配置输入，空值禁提交，申请链接正确；首次保存等待 Promise 与目标 Key 就绪，不能提前关窗或自动发送。
- [x] 覆盖双击提交、保存失败保稿、后段失败核对、保存忙碌关闭守卫、dirty 放弃守卫、切目标后的迟到保存结果。
- [x] 看见测试失败后实现弹窗，文案使用“配置 DeepSeek API Key”“建议先配置 API Key，直接发送消息。”“保存并继续”“稍后配置”；保存范围提示按真实 keyMode 显示。
- [x] 定向命令：`pnpm --filter @dramatis/web test src/components/DeepSeekKeyDialog.test.tsx src/hooks/useDeepSeekSetup.test.tsx src/components/modal-behavior.test.tsx`。

## Task 4: 应用接线与完整验证

**Files:** 修改 `apps/web/src/App.tsx`、`apps/web/src/components/MainChat.tsx`、`apps/web/src/components/LibraryWorkspace.tsx`；扩展已有 `apps/web/src/App.bridge.test.tsx`；按实际接线扩展现有组件测试夹具，保留旧断言；交付独立实施记录。

**Interfaces:** App 将账户归属、provider 状态及现有弹窗 / 生成 / 桥接 / 库导航占用传给 setup hook。MainChat 新增可选 `onConfigureDeepSeekKey?: () => void`，点击后保持聊天草稿，打开同一极简窗。

- [x] 先写 App 集成反例：首次空库弹窗、已有对话缺 Key 弹窗后回原页、已有其他服务商可读 Key 不强制替换、主副聊天保稿、恢复码 / 现有弹窗 / 桥接优先、手动入口可重新打开。
- [x] 将无 Key 常驻长文替换为短状态“尚未配置 Key · 配置 DeepSeek Key”；主动稍后配置后的原转接按钮和协议保持可用。不要把现有完整模型设置塞进新弹窗。
- [x] 运行定向 App / 聊天 / 桥接 / provider / modal 回归，再运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 与 `git diff --check`。
- [x] 使用执行工作区构建、全新本机 origin 做浏览器检查：桌面及窄屏首弹、一个输入、申请链接目标、空值禁提交、稍后配置及手动重开。保存路径只用测试夹具 / 合成 Key，禁止向服务商发送验证请求或读取真实剪贴板 / 凭据。
- [x] 检查原候选 SHA256 未变，记录新增工作区、文件、测试数量、浏览器证据与未验范围，保留全部未提交改动；不提交或发布。

## 执行方式建议

建议当前对话直接执行（Native），provider 保存与弹窗时机共享紧密的状态接口；用独立代理只读审查最终差异。先评审本计划，再实施。具体工作区路径由原生工具返回后写入交付记录。
