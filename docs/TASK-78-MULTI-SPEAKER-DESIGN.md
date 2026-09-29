# 顺序 78：一轮内按意图选择多名角色接话

> 状态：已实施的设计基线。本文不包含实现代码。依据：docs/TASKS.md 第 78 项及 2026-09-28 仓库现状；实施时补齐了桥接恢复与每位角色的动作约束。

## 方案摘要与关键取舍

玩家一次输入仍是一轮、一个 turnId；这一轮可有 1～N 条角色消息。N 是对话级上限，默认 2，硬上限 3。导演在生成前只调用一次，给出有序的参与名单及每人的意图；有效名单有几人，就为几人各做一次完整生成。规则调度只负责可解释的保底排序，不能把未被导演选中的人补到 N 人。

最终选择优先级为：**当前场景与角色资格 > 人数上限 > 玩家明确直接称呼 > 导演有效计划 > 规则保底**。直接称呼者必须参与，但句中被提到者不因此获得发言权。直接称呼人数超过上限时，发送前明确拒绝，不能悄悄漏掉其中一人。导演失败、超时、返回空或无效名单时仍由规则保证至少一位。已提交玩家消息后若首位生成失败或被停止，落一条透明的角色动作保底，并显示错误；不能留下只有玩家消息的回合。

选择默认 2 而非“所有在场者”：第二位有机会形成真实互动，常规回合仍可只有一位，最多只增加一次完整生成。选择硬上限 3 而非动态追加：一次额外发言就是一次完整模型调用，固定上限使成本与等待时间可预期。直接称呼使用句首称呼或 @显示名 的窄规则，而非“文本里出现过这个名字”：仓库已记录句首 A、句中 B 被误判为 B 接话的真实事故。

网页版桥接必须逐人展示、逐人贴回提示词。第一份回复贴回前，玩家输入处于“待提交”，不建立只有玩家消息的半轮。多角色消息沿用现有 Message、turnId、localSeq、deviceId 和 deletedAt，不增加存储字段或迁移。

本文的“至少一条角色消息落盘”是对**已成功提交的玩家回合**的产品不变量。若 IndexedDB 本身不可写，程序无法物理制造落盘记录，必须报告存储错误并阻止继续；网页版桥接尚未收到第一份贴回的输入尚未提交为回合。已核对 apps/web/src/lib/db.ts 的 bulkPut：整批消息在同一个 IndexedDB readwrite 事务中提交；packages/core/src/storage/repository.ts 的 appendMessages 将首次桥接的玩家与角色消息作为同一批交给它。计数器号段的预留在另一事务中，写入失败可能留下序号空洞，但不会留下半批消息。

## 1. 谁开口、几个人

### 1.1 合格名单

每轮先取 scene.cast 中的实例，再同时要求 presence === 'onstage'、deletedAt === null、角色卡存在。muted 虽可在 cast 里，但不能作为生成者；世界其他场景的 onstage 角色绝不进入名单。把同一份合格名单传给导演与最终选择器，不能各算一遍造成不一致。

对话设置 maxSpeakers 只允许 1、2、3；缺省 2，硬上限 3。它是**上限，不是目标人数**。导演通过 speakers 数组建议人数，程序不另做加权平均，也不按性格或情绪阈值自动追加。情绪可作为导演的背景资料，不成为第二套隐蔽人数规则。

### 1.2 直接称呼

以下两种形式算直接称呼，按文本出现次序去重：

1. 文中任意位置的 @显示名；显示名必须与当前合格名单中唯一实例完全一致，@ 后须是空白、句读或文本结束。
2. 去掉开头空白后，以一名或多名完整显示名开头；多名之间只接受“、”，最后一名后必须是空白、逗号、冒号、叹号、问号或文本结束。例如“小满，我和陈九进院子”只称呼小满；“小满、陈九，你们看”称呼两人。

识别时先按显示名长度降序尝试，避免短名吞掉长名；同名实例不能凭名字强制选择，应在 UI 提示使用不同的显示名。别名和普通的子串 mentions 继续用于现有规则打分，但**不用于强制称呼**，以免误把背景人物叫上台。

直接称呼人数超过本对话上限时，handleSend 在落玩家消息前报错：“你直接叫到了 X 位角色，本轮上限为 N 位；请减少点名或调高上限。”不截断强制名单。场外姓名不是合格角色，不会被调度；输入中看似 @ 但不对应合格角色时，显示“该角色不在当前场景或不能发言”，发送前拒绝，避免用户以为已经成功点名。

### 1.3 合成

1. scheduleSpeakers 沿用原规则计算完整 scores，但 useTurnRunner.handleSend 固定传 maxSpeakers: 1。现有 MIN_SCORE、冷却、句首加分及兜底保持；scores 用于解释与导演不可用时的首选，不是多人填额来源。
2. 导演计划先校验临时编号与姓名是否对应同一个合格实例，去重并过滤无效项。hold_back 是**入选但只做动作**，也占一次完整生成；未入选者本轮没有角色消息，可由入选者所见的公开动作自然提及，但不能代写其私有内心。
3. 直接称呼者排最前，顺序按玩家文本；其后接导演的有效计划，cut_in 排在其他模式前，同模式保持导演数组相对顺序；最终截至 N。导演把直接称呼者设为 hold_back 时，通常改为 reply 并清掉相矛盾的计划意图。显式静默/只许动作模式例外，仍生成 hold_back 动作。
4. 导演只选一位，就只生成一位，不以规则分数补第二人。导演无可用人选时，先取直接称呼者，再取规则首选补到至少一人，仍不超过 N。若无直接称呼，规则保底恰好选一位。
5. 只许动作时，名单选择与顺序不变，所有入选模式统一为 hold_back。现有 unlimited 对 silent、playerFirst 的优先关系不改。

因此“你们觉得呢”是问全场而非要求全场回答：导演可选最有理由的一人，也可选两人；导演不可用时规则只选一人。

## 2. 顺序与时机

直接称呼者优先，即使导演把另一人标成 cut_in，也不能让被玩家明确提问者失去第一响应。非直接称呼者中，cut_in 靠前，同类按导演给出的叙事顺序。抢话仍可写进角色内容，而不必物理插到被直接称呼者之前。

packages/core/src/prompt/assemble.ts 的生成指令块加入以下**完整、不可丢弃**正文；每次生成替换全部占位符：

~~~text
本回合由你扮演「{{当前角色名}}」，你是本回合第 {{序号}} 位、共 {{总人数}} 位被选中的回应者。
只写「{{当前角色名}}」能说的台词和能做的动作。历史中其他角色本回合刚说过的话，是你可听见的现场经过；不要复述他们已经回答的内容。若没有新的信息、立场或动作，用简短反应推进这一拍。
不要替其他角色说话、决定动作或写出其内心。不要把其他角色的经历、私有记忆、道具或身份写成自己的。历史里的【名字】仅用于标明说话者，你的正文仍按现有格式写，不加姓名前缀。
~~~

第一人沿用完整旧 history 与 playerInput；后续人沿用 continuedHistory（含玩家消息和本轮前人已落盘消息）、playerInput: ''、mentionText: 玩家原文。召回仍逐人调用 recallFor，observerId 必须等于当前 speaker.id；不得复用前人的 memories、召回结果或私有感知。后发言者通过既有按 audience 裁剪的历史看见本轮公开消息即可，无需为避免重复而隐藏前人的话。必须用提示词约束“不复述、只增量回应”，并用测试证明视角隔离。

## 3. 导演提示词

修改 packages/core/src/director/intent-plan.ts。输入只含当前对话最近 8 条消息，按仓储现有稳定顺序，带说话人、正文；另带当前合格名单、每人的上一条意图及 affect.arousal、玩家原文、玩家是否仅做动作、当前是否只许动作、地点和人数上限。不带任何角色的私有记忆。临时编号按合格名单次序给 C1、C2、C3，模型只负责照抄；解析时仍按原名单映射，编号不落库。

system 提示词全文：

~~~text
你是多角色互动故事的一轮发言导演。你的工作是在当前场景中选出这一轮真正参与回应的角色，并按戏剧发生顺序安排他们；你不写台词，也不平均分配发言机会。

只可选输入名单中的角色。角色的 presence 与场景名单都已由程序检查，但你仍必须照抄名单里的临时编号和显示名。玩家在句首以称呼叫到的人，或用 @显示名 直接叫到的人，必须在本轮参与；句中作为事件人物被提到，不等于被叫到。玩家问全场时，挑最有理由回应的一至数人，不必让全场轮流说话。玩家只做动作而没有台词时，判断谁会对动作作出有意义的反应。不要为了凑满人数而选人。

mode 只能是 reply、cut_in、hold_back、initiate。reply 是正常接话；cut_in 是抢话；hold_back 是只用动作或神态回应、不说台词；initiate 是主动开启新的话头。hold_back 也占一个回应名额，因为程序仍会为他生成一条动作消息。输入要求只许动作时，所有入选者都必须用 hold_back。

speakers 至少给一项、最多给输入指定的上限；每个角色最多出现一次。按建议的剧情顺序排列，同等条件下把 cut_in 排在普通接话之前。每项 intent 用一句中文写此刻想做什么，不写台词、不写其他角色的私有想法。只输出符合格式的 JSON 对象，不要代码围栏、注释或解释。即使你输出空项或错误项，程序也会独立执行保底选择。
~~~

user 提示词全文。双花括号是 buildIntentPlanMessages 必须替换的输入槽位，不保留在发送给模型的内容中：

~~~text
地点：{{场景地点；空值写“未指定”}}
玩家扮演：{{玩家名}}
本轮最多参与人数：{{1、2或3}}
本轮回复形式：{{“允许台词与动作”或“只许动作”}}
玩家这次是否只有动作：{{“是”或“否”}}

当前场景可发言名单（临时编号、显示名、上一条意图、情绪激动程度）：
{{逐人一行，格式为 C1｜秦娘｜上一条意图：等待回答｜激动程度：0.45；没有意图写“无”}}

最近 8 条对话，按发生顺序：
{{逐条一行，格式为 玩家：做了什么 或 秦娘：说了什么；没有历史写“无”}}

玩家本次输入：
{{玩家输入原文；空串写“（无台词，仅有动作）”}}

请选出本轮真正参与回应的角色。直接称呼的人必须在名单中；句中被提到的人无需因此发言。没有合适的第二人就只选一人。输出必须严格采用以下 JSON 形状，key 和 name 必须与上方同一人对应：
{"speakers":[{"key":"C1","name":"秦娘","intent":"想确认玩家刚才所指的那件事","mode":"reply"}]}
~~~

严格输出是单个 JSON 对象，只有 speakers 数组；每项 key、name、intent、mode 均为字符串。解析器为兼容历史仍可宽松接受旧 name 单字段、裸数组和代码围栏，但新 key 优先；key/name 不对应时整项丢弃，没有 key 时仅接受名单里唯一的精确显示名。提示词要求至少一项只是减少无效输出，真正的至少一人由 core 选择器及 web 提交流程保证。

## 4. 保底与边界

- 导演关闭、熔断、无 Key、异常、8 秒超时、空数组、全部不在 cast、全部重复或错配：统一退回规则保底。只尝试一次导演调用，不重试；用户主动停止必须单独识别，不能吞成普通导演失败后继续生成。
- 仅一名合格角色时总是选他，冷却为负也不沉默；其余 N-1 个名额不填。
- scene 不存在、cast 为空、cast 中无人满足资格或找不到角色卡：发送前拒绝并显示具体原因，不借世界里的其他 onstage 人补位，也不落玩家消息。
- 已提交玩家消息后，首位的生成若返回空、超时、断网、报错或被停止，丢弃未落盘的半条流，给该位落以下**完整动作保底**，并在错误区注明“第 1 位、角色名、失败阶段、可重抽”：

~~~text
# {{角色显示名}}看向你，暂时没有开口。
~~~

- 若已有至少一条角色消息落盘，后续人失败或被停止时保留已落盘消息，停止余下生成，显示失败发生在第几位及角色名，不额外制造保底消息。finally 清 busy、结束当前流并请求同步。
- 网页版桥接打开第一份提示词时尚未提交回合；第一份有效贴回时把玩家消息与首位角色消息按顺序批量落盘。跳过第一份则取消待提交输入。若已贴回首位，跳过后续位只结束余下桥接，首位消息保留。sessionStorage 里的桥接状态必须带足以在刷新后继续的信息；若场景、对话或待提交名单已不再匹配，明确提示重新发送，不能写到新场景。

存储介质失败不能满足落盘保证；必须报错而不能标成功。首次桥接使用上述同一 IndexedDB 事务，已验证整批写入的原子边界。若未来更换存储适配器，必须重新验证 bulkPut 的批次原子性。

## 5. 数据结构与接口

以下签名是目标接口，放置位置及调用方均已指定。TypeScript import 从现有同目录模块按仓库风格补齐；不添加依赖。

packages/core/src/model/conversation.ts：

~~~ts
export const DEFAULT_MAX_SPEAKERS = 2;
export const HARD_MAX_SPEAKERS = 3;

export interface ConversationModes {
  playerFirst: boolean;
  silent: boolean;
  intentFirst?: boolean;
  maxSpeakers?: 1 | 2 | 3;
  historyMode?: HistoryMode;
  historyNearWindow?: number;
  replyLength?: ReplyLength;
  unlimited?: boolean;
  advancedSystemPrompt?: string;
}

export function speakerLimitOf(
  modes: ConversationModes | undefined,
): 1 | 2 | 3;
~~~

defaultConversationModes() 写入 maxSpeakers: 2；老记录缺字段、运行时脏值均由 speakerLimitOf 返回 2，无需数据库迁移。若用户显式设 1，则为严格单人上限，多人直接称呼触发送前拒绝。

packages/core/src/director/scheduler.ts 的 ScheduleInput.maxSpeakers?: number、默认 1、ScheduleResult 和 turnsSinceLastSpoke 均保持现有接口；**不扩展 minSpeakers**，因为本轮至少一人的最终约束属于合成器而非打分器。useTurnRunner 调用规则打分器时仍传 maxSpeakers: 1。

packages/core/src/director/intent-plan.ts：

~~~ts
import type { InstanceId } from '../model/ids.js';

export type IntentMode = 'reply' | 'cut_in' | 'hold_back' | 'initiate';

export interface IntentPlanEntry {
  key?: string;
  name: string;
  intent: string;
  mode: IntentMode;
}

export interface IntentPlanInput {
  scene: Scene | null;
  cast: readonly CharacterInstance[];
  playerName: string;
  playerInput: string;
  recentMessages: readonly Message[];
  lastIntentByInstance: ReadonlyMap<InstanceId, string>;
  playerActionOnly: boolean;
  actionsOnly: boolean;
  maxSpeakers?: number;
}

export interface PlannedSpeaker {
  instance: CharacterInstance;
  intent: string;
  mode: IntentMode;
}

export interface PlannedSpeakerPick {
  speakers: PlannedSpeaker[];
  rejectedEntries: number;
}

export function buildIntentPlanMessages(input: IntentPlanInput): ChatMessage[];
export function parseIntentPlan(raw: string): IntentPlanEntry[];
export function pickPlannedSpeakers(
  plan: readonly IntentPlanEntry[],
  eligibleCast: readonly CharacterInstance[],
  maxSpeakers: 1 | 2 | 3,
): PlannedSpeakerPick;
~~~

pickPlannedSpeakers 校验编号/姓名、资格、去重，保持原计划相对顺序；直接称呼强制与 cut_in 排序只在下列合成函数中做，避免两处顺序算法不一致。旧 pickPlannedSpeaker 可在调用点及测试迁移期间暂留，最终删除前搜索全仓引用。

新增 packages/core/src/director/turn-speakers.ts，从 packages/core/src/index.ts 导出：

~~~ts
import type { InstanceId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { IntentMode, IntentPlanEntry } from './intent-plan.js';
import type { ScheduleResult } from './scheduler.js';

export type TurnSpeakerSource = 'addressed' | 'planned' | 'rule';

export interface SelectedTurnSpeaker {
  instance: CharacterInstance;
  intent: string | null;
  mode: IntentMode;
  source: TurnSpeakerSource;
}

export type TurnSpeakerSelection =
  | {
      kind: 'ready';
      speakers: SelectedTurnSpeaker[];
      rejectedPlanEntries: number;
    }
  | {
      kind: 'no-eligible-speaker';
      speakers: [];
      rejectedPlanEntries: number;
    }
  | {
      kind: 'too-many-addressed';
      speakers: [];
      addressed: InstanceId[];
      rejectedPlanEntries: number;
    };

export function directAddressees(
  playerInput: string,
  eligibleCast: readonly CharacterInstance[],
): InstanceId[];

export function selectTurnSpeakers(input: {
  playerInput: string;
  eligibleCast: readonly CharacterInstance[];
  schedule: ScheduleResult;
  plan: readonly IntentPlanEntry[] | null;
  maxSpeakers: 1 | 2 | 3;
  actionsOnly: boolean;
}): TurnSpeakerSelection;
~~~

selectTurnSpeakers 在无合格者时返回 no-eligible-speaker；有合格者且直接称呼人数不超限时必返回长度 1～N 的 ready。directAddressees 的溢出检查在玩家消息提交**之前**完成；selectTurnSpeakers 再作防御性检查。有效计划的人数不由 schedule.speakers 补满。hold_back 可被选中。直接称呼者原计划为 hold_back 且非 actionsOnly 时，改 reply、intent 置 null，避免“要说话”与“欲言又止”冲突。

apps/web/src/hooks/useTurnRunner.ts 的具体改点：

1. handleSend 起点约 444 行，先预检 scene、合格名单、角色卡、直接称呼与人数，再决定是否提交玩家消息；不可在失败分支静默 return。
2. scheduleSpeakers 约 513–526 行仍只传 maxSpeakers: 1，保留 scores。runIntentPlan 约 318–383 行改接上限、上一条意图、动作条件，并设置一次调用的 8 秒超时。
3. 约 542–545 行的 pickPlannedSpeaker 与单元素数组换为 selectTurnSpeakers；约 548 行的 for 直接遍历 SelectedTurnSpeaker[]，移除找不到实例/角色卡就 continue 的静默分支。生成阶段使用已经预检的实例与角色卡。
4. 约 567–578 行保持每人独立 recallFor、第一人和后续人的 history/playerInput/mentionText 口径。runGeneration.intent.mode 从 string 收紧为 IntentMode，传 assemble.ts 时去掉 as 'reply' 断言。
5. 每人生成成功后单独记 category: 'generation'、单独 appendMessages，保留同一 turnId；约 656 行每人的 handoffStreamState('main', line.id) 必须等自己的渲染确认后再开始下一人的流。
6. 循环后的 usage.reload、enqueueSceneSummary、enqueueMemoryConsolidation、enqueueTurnAnalysis 仍每轮至多一次。单条重抽（约 750–840 行）只重抽目标消息，沿用其已保存意图；改归属（约 899 行）不运行多人选择器。

Message 不加字段：本轮所有角色消息沿用 turnId，存储层照旧分配 localSeq/deviceId；同步合并、排序和 deletedAt 墓碑语义不改。

## 6. UI/UX

apps/web/src/components/MainChat.tsx 的 MODE_OPTIONS 是布尔项，不把数字硬塞进去；在同一个“＋／对话模式”面板新增“本轮最多回应人数”三档：**1 人／2 人（默认）／3 人**。辅助文案：“这是上限；导演只挑该接话的人，多一人会多一次完整生成。”输入区可显示“本轮最多 2 人”，但导演尚未运行前不能预告确切人数。

聊天流维持现有连续气泡和动作段，不增加持久化回合容器、不人为节流播放。生成中显示“正在由秦娘回应（第 2/2 位）”；停止按钮中止当前及未开始的角色。未被选中者无消息；被选为 hold_back 者只显示动作段。

本次不加“让大家都说一句”覆盖，它与按意图选择及成本上限相冲突；也不加单独的“只让 X 回”开关，玩家用句首称呼或 @显示名 临时指定。超上限时必须给出可操作的提示，不能自动忽略称呼。

连续流的顺序 91 交接需要增加按 messageId 的确认屏障。第 N 位 appendMessages 后保留其文本和 handoffId；apps/web/src/components/StreamingBubble.tsx 确认同一 ID 已进入已提交列表后，才清第 N 位并允许第 N+1 位 setStreamState。旧 ID 的延迟 effect 不能清掉新 ID 的流。切换对话或组件卸载时解除等待并结束该通道，避免 busy 卡死。apps/web/src/lib/stream-store.ts 新增接口如下：

~~~ts
export function waitForStreamHandoff(
  scope: StreamScope,
  messageId: MessageId,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<void>;

export function acknowledgeStreamHandoff(
  scope: StreamScope,
  messageId: MessageId,
): void;
~~~

acknowledge 只在当前 handoffId 与 messageId 相等时清旧流并结算等待；不相等时无操作。timeoutMs 缺省 2000；超时须报出“消息已保存但显示确认超时”，停止后续角色生成、重载当前消息列表并在 finally 释放 busy，不能无限等待。等待因 abort 或组件卸载解除时不得清理别人的新流。当前 StreamingBubble 的无条件延迟 reset 效果须换成该按 ID 确认。

网页版桥接沿用 apps/web/src/lib/bridge-store.ts 的 sessionStorage；扩展 apps/web/src/components/WebBridgePanel.tsx 的 WebBridgeState，旧状态缺 pendingTurn 时按既有单人流程读取：

~~~ts
export interface PendingBridgeTurn {
  roomId: RoomId;
  conversationId: ConversationId;
  sceneId: SceneId;
  turnId: string;
  playerText: string;
  speakerIds: InstanceId[];
  nextIndex: number;
  speakerPlans?: { intent: string | null; mode: IntentMode }[];
  actionsOnly?: boolean;
}

export interface WebBridgeState {
  stage: 'reply' | 'analysis' | 'admin';
  turnId?: string;
  speakerInstanceId?: string;
  speakerName?: string;
  prompt: string;
  pendingTurn?: PendingBridgeTurn;
}
~~~

新桥接先显示“第 1/N 位”的第一份提示词；首份有效贴回时才批量提交玩家和首位角色，并让两条消息共用 createdAt，由 localSeq 保证玩家在前。接下来用已落盘消息和对应 speakerPlans 装配第二人的提示词，逐份推进；hold_back 和全轮只许动作都拒绝贴回台词。最后一位贴回后才进入原有一轮分析。apps/web/src/App.tsx 的 handleBridgeReply、handleBridgeSkip 按 pendingTurn.nextIndex 处理。刷新恢复时核对 roomId、conversationId、sceneId、已贴回的角色前缀；若 sessionStorage 的 nextIndex 落后于 IndexedDB，按已落盘前缀重建下一份提示词或分析提示词，不能重复收下同一位回复；身份或场景错配仍拒绝写入。

## 7. 成本与记账

一次自动回合最多 1 次 intent 调用，实际选择 K 人就做 K 次 generation；不按上限 N 预记，也不自动重试。每次 generation 沿用 apps/web/src/lib/turn-bookkeeping.ts 的 recordModelCall，category、turnId、speaker 分别正确填写；导演仍记 category: 'intent'。usage.reload 在本轮结束后刷新一次，导演完成时现有的提前刷新可保留。网页桥接没有供应商调用，不记虚假的零元记录。

现有 packages/core/src/storage/budget.ts 的 maxExtraCalls 只管生成之外的调用，不能因多人功能改成总生成次数阈值；maxCost 仍以账单已知价格判定是否熔断后续额外调用，角色生成照既有政策不拦。多人费用用 1～3 的对话上限控制。导演因熔断跳过时，规则只选一位；有多个直接称呼时仍遵守已设置的上限。

每位成功完成的调用各记实际返回 usage；未返回 usage 时沿用现有记录零 token 的口径，但 UI 不能把未返回的费用说成“确知免费”。模型异常或中止且没有终态 usage 时，显示“用量未知／服务商可能已计费”，不得编造 token 或金额。

apps/web/src/components/UsagePanel.tsx 增加“最近一轮”明细，使用现有 ledger.summary({ roomId, conversationId, turnId }) 聚合导演次数、生成次数、已知 token 与费用；单价缺失或部分调用有价时沿用当前标注。Message.usage 仍只表示生成**这条消息**的一次调用，不把整轮费用复制进每个气泡。

## 8. 测试清单

| 测试文件 | 数据构造与断言 |
| --- | --- |
| packages/core/src/director/scheduler.test.ts | A、B 均 onstage，但 scene.cast 只有 A：B 被排除。历史同一 turnId 有 A、B 两条角色消息：下轮二人的冷却都为 0，不能因多消息重复扣回合。 |
| packages/core/src/director/intent-plan.test.ts | C1/C2 两人计划均保留；重复 key、key/name 错配、场外角色、offscreen 分别被过滤；hold_back 可作为动作参与者；新提示词含人数上限、上一条意图、动作条件与严格 JSON；旧 name 单字段仅在唯一姓名时有效。 |
| packages/core/src/director/turn-speakers.test.ts（新增） | “小满，我和陈九……”只强制小满；导演建议陈九也说时小满第一。多人句首称呼超上限返回 too-many-addressed。全场提问导演只选一人时最终一人。空/错导演退规则恰好一人；cut_in、去重、三人上限、单人负分兜底、静默动作均断言具体有序 ID 与 mode。 |
| packages/core/src/prompt/assemble.test.ts | 第二人可见第一人本轮可见消息；仅收到自身视角的召回记忆，第一人的私有条目不出现在提示词；新增反重复与不代写指令不可丢弃。 |
| apps/web/src/lib/stream-store.test.ts 及 StreamingBubble 组件测试 | A 交接给消息 a、列表尚未呈现 a 时仍显示 A；列表呈现后才收。B 开流之后，A 的延迟确认不能清 B；B 交接给 b 时也无空窗、无重影。 |
| apps/web/src/hooks/useTurnRunner.test.tsx（新增） | 导演两人只调用一次；两次 generation 各自记账、同 turnId 顺序落盘；第二人历史含第一人，召回 observerId 各异。首人报错、空回复或停止落动作保底且释放 busy；第二人失败保留第一人并报角色名；导演超时、熔断、关闭各保底一人。 |
| apps/web/src/App.tsx 桥接流程测试 | 两人桥接先显示第一份；首份未贴回时无已提交半轮；首份贴回后玩家和第一人同轮落盘、第二份含第一人的公开消息；跳过第二份保留首人；旧单人 sessionStorage 状态可继续。 |

第 III.8 条四个事故必须逐项有回归证据：**场景外 onstage 上台**由 scheduler/selector 测试；**句首 A 与句中 B 混淆**由直接称呼及合成测试；**同回合多人重复冷却**由 turnsSinceLastSpoke 测试；**流副本空窗/重影**由逐 ID 交接及组件测试。

## 9. 实施计划

每一步单独提交，提交信息与新增注释、文案均中文。每步都运行固定门禁：pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:sync-server。注释说明事故与决策原因，不逐句复述代码。

| 步骤 | 改动文件 | 验证与主要风险 |
| --- | --- | --- |
| 1. 纯选择器 | packages/core/src/director/turn-speakers.ts、turn-speakers.test.ts、packages/core/src/index.ts | 类型、lint、core 测试及全门禁；风险是句中提及误判为直接称呼。 |
| 2. 导演契约与设置类型 | packages/core/src/director/intent-plan.ts、intent-plan.test.ts、packages/core/src/model/conversation.ts 及对应测试 | 新旧 JSON、旧数据缺省 2、非法值不放大上限；风险是模型错配编号与显示名。 |
| 3. 自动生成接线 | apps/web/src/hooks/useTurnRunner.ts、对应编排测试、packages/core/src/prompt/assemble.ts 与测试 | 同轮多条、每人独立召回/记账、失败与停止保底；风险是半条流或静默 continue。 |
| 4. 流交接与 UI | apps/web/src/lib/stream-store.ts、stream-store.test.ts、apps/web/src/components/StreamingBubble.tsx、MainChat.tsx 及组件测试 | A 的确认不能清 B，等待可解除；风险是交接等待卡住 busy。 |
| 5. 网页桥接与用量 | apps/web/src/components/WebBridgePanel.tsx、apps/web/src/App.tsx、apps/web/src/lib/bridge-store.ts、apps/web/src/components/UsagePanel.tsx 及流程测试 | 逐份贴回、刷新恢复、首份取消无半轮、最近一轮账单；风险是待提交状态与已落盘消息错位。 |

第 1～2 步合入后运行时仍可保持单人；第 3 步启用多人后，第 4～5 步完成前不宣称顺序 78 已交付。单条重抽、改归属、Web Worker 后台任务、可选同步纳入完整回归，不以本功能为由改其存储结构。

## 10. 风险、观测与回滚

最高风险是直接称呼错判、第二人混入第一人的私有视角、连续流交接时清掉下一人、网页版桥接留下只有玩家消息的半轮。观测记录本轮选择来源、SpeakerScore.reasons、导演项的过滤数量、实际 generation 次数、失败的序号与角色名；不记录 API Key 或私有记忆正文。按 turnId 检查“导演调用不超过一次、generation 次数等于实际已尝试人数、已提交玩家回合至少一条非墓碑角色消息”；账单与消息的差异要能看见而不能静默吞掉。

将所有对话的 maxSpeakers 设为 1，可立即退回**每轮最多一人生成**的成本与展示形态，但**不等于旧代码逐字行为**：新直接称呼保护、空计划保底、失败动作保底、桥接待提交边界仍有效；同时点名两人会在发送前被明确拒绝。若需完全恢复旧选择行为，须另行关闭新选择器入口并回到旧单人接线，不能声称“上限改 1 就完全回滚”。任何回滚都不删除已经落盘的多人消息，不改 turnId、localSeq/deviceId 或 deletedAt。
