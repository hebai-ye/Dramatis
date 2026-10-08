/**
 * Task 120 / B12: synthetic, evaluation-only comparison. Never imported by production.
 * The candidate composes existing recall functions; it does NOT enable deduplication.
 * Supplement/source reservation has no public insertion hook and is deliberately out of scope.
 */
import {
  DEFAULT_DEDUPE_THRESHOLD,
  DEFAULT_FALLBACK_LIMIT,
  dedupeRecalled,
  isSuperseded,
  limitFallbackItems,
  recallForPrompt,
  recallMemories,
  selectWithinBudget,
  textSimilarity,
} from '../memory/recall.js';
import type { RecalledMemory, RecallQuery } from '../memory/types.js';
import {
  type ConversationId,
  conversationId,
  eventId,
  instanceId,
  type RoomId,
  roomId,
  sceneId,
} from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { COLLECTIONS, Repository } from '../storage/repository.js';
import { heuristicTokenCounter } from '../token/estimate.js';

export const AUDIT_NOW = '2026-10-01T12:00:00.000Z';
const ROOM = roomId('b12-synthetic-room');
const CONVERSATION = conversationId('b12-synthetic-conversation');
const ALICE = instanceId('b12-observer-a');
const BOB = instanceId('b12-observer-b');
const BASE = '灯塔管理员确认红色钥匙存放在石墙第三个暗格，傍晚交给守夜人，领取时必须登记姓名。';

export interface LabeledAuditMemory {
  event: MemoryEvent;
  /** Human-authored fixture facts, not an inferred semantic ground truth. */
  factIds: string[];
}

export interface RecallDedupeScenario {
  id: string;
  label: string;
  roomId: RoomId;
  conversationId: ConversationId;
  query: RecallQuery;
  budgetTokens: number;
  memories: LabeledAuditMemory[];
}

export interface AuditDuplicateGroup {
  representativeId: string;
  memberIds: string[];
  removableIds: string[];
  removableEstimatedTokens: number;
}

export interface AuditSelectionMetrics {
  selectedIds: string[];
  selectedCount: number;
  estimatedTokens: number;
  duplicateGroups: AuditDuplicateGroup[];
  duplicateGroupMemberCount: number;
  /** Includes the retained representative; denominator is THIS arm's selected count. */
  duplicateGroupItemShare: number | null;
  algorithmRemovableCount: number;
  /** Algorithm-flagged removals, NOT semantically safe savings or actual net savings. */
  algorithmRemovableEstimatedTokens: number;
  algorithmRemovableTokenShare: number | null;
  retainedFactIds: string[];
  missingFactIds: string[];
  labeledFactRetention: number | null;
  retainedUniqueFactIds: string[];
  missingUniqueFactIds: string[];
  uniqueFactRetention: number | null;
}

export interface RecallDedupeScenarioResult {
  input: RecallDedupeScenario;
  repositoryPoolIds: string[];
  observerVisibleIds: string[];
  availableFactIds: string[];
  /** A label supported by exactly one observer-visible, live record in this fixture. */
  availableUniqueFactIds: string[];
  beforeBudget: { baselineIds: string[]; candidateIds: string[]; removedIds: string[] };
  productionCandidates: { recall: number; mention: number; source: number };
  baselineMatchesUndedupedRegularPath: true;
  baseline: AuditSelectionMetrics;
  candidate: AuditSelectionMetrics;
  delta: {
    estimatedTokens: number;
    gainedFactIds: string[];
    lostFactIds: string[];
    gainedUniqueFactIds: string[];
    lostUniqueFactIds: string[];
  };
}

export interface RecallDedupeAuditReport {
  schemaVersion: 1;
  method: {
    baseline: string;
    candidate: string;
    counter: string;
    dedupeThreshold: number;
    fallbackLimit: number;
    scope: string;
  };
  limitations: string[];
  results: RecallDedupeScenarioResult[];
}

function fixtureMemory(
  id: string,
  summary: string,
  factIds: string[],
  overrides: Partial<MemoryEvent> = {},
): LabeledAuditMemory {
  return {
    event: {
      id: eventId(`b12-${id}`),
      roomId: ROOM,
      conversationId: CONVERSATION,
      sceneId: sceneId('b12-synthetic-scene'),
      timeline: { worldTime: '合成世界第1日', sequence: 1 },
      location: '北岸',
      participants: [ALICE],
      summary,
      observerId: ALICE,
      perception: '',
      importance: 0.8,
      pinned: false,
      importanceLocked: false,
      affects: [],
      sourceTurnIds: [],
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-01T08:00:00.000Z',
      lastRecalledAt: null,
      recallCount: 0,
      deletedAt: null,
      ...overrides,
    },
    factIds,
  };
}

function scenario(
  id: string,
  label: string,
  memories: LabeledAuditMemory[],
  budgetTokens = 800,
  observerId: string = ALICE,
): RecallDedupeScenario {
  return {
    id,
    label,
    roomId: ROOM,
    conversationId: CONVERSATION,
    query: { observerId, text: '灯塔', participantIds: [ALICE], location: '北岸', now: AUDIT_NOW },
    budgetTokens,
    memories,
  };
}

/** Same two public counter calls used by recall.ts's private memoryCost; no alternate tokenizer. */
export function auditMemoryTokens(event: MemoryEvent): number {
  return heuristicTokenCounter.count(event.summary) + heuristicTokenCounter.count(event.perception);
}

export function createRecallDedupeAuditScenarios(): RecallDedupeScenario[] {
  const rare = () => [
    fixtureMemory('rare-ferry', '灯塔旁的渡船只在星期二开航。', ['ferry-tuesday'], { importance: 0.2 }),
    fixtureMemory('rare-medicine', '灯塔急救箱内的药瓶需要冷藏。', ['medicine-cold'], { importance: 0.1 }),
  ];
  const exact = () => [
    ...Array.from({ length: 10 }, (_, index) =>
      fixtureMemory(`exact-${index}`, BASE, ['key-location'], { importance: 0.95 - index * 0.01 }),
    ),
    ...rare(),
  ];
  const nearTexts = [
    BASE,
    BASE.replace('确认', '再次确认'),
    BASE.replace('存放', '仍然存放'),
    BASE.replace('傍晚', '今天傍晚'),
    BASE.replace('交给', '亲手交给'),
    BASE.replace('领取时', '前来领取时'),
    BASE.replace('登记姓名', '登记领取人的姓名'),
    `他记得，${BASE}`,
    `据管理员说，${BASE}`,
    `${BASE}紧急开锁口令是青鹭七号。`,
  ];
  // Higher-scoring B appears first on purpose: dedupe must never run before observer filtering.
  const boundary = [
    fixtureMemory('b-shared', BASE, ['b-private-location'], { observerId: BOB, importance: 1 }),
    fixtureMemory('a-shared-1', BASE, ['a-private-location']),
    fixtureMemory('a-shared-2', BASE, ['a-private-location'], { importance: 0.7 }),
    fixtureMemory('a-secret', '灯塔中甲的暗号是杉木。', ['a-private-code'], { importance: 0.6 }),
    fixtureMemory('b-secret', '灯塔中乙的暗号是白鹭。', ['b-private-code'], { observerId: BOB }),
    fixtureMemory('objective', '灯塔的客观记录不得当作角色私有记忆。', ['objective-only'], { observerId: null }),
    fixtureMemory('foreign-room', '灯塔另一世界的私密记录。', ['foreign-room'], { roomId: roomId('b12-other-room') }),
    fixtureMemory('foreign-conversation', '灯塔另一对话的私密记录。', ['foreign-conversation'], {
      conversationId: conversationId('b12-other-conversation'),
    }),
    fixtureMemory('tombstone', '灯塔已删除的私密记录。', ['deleted-only'], { deletedAt: AUDIT_NOW }),
  ];
  const uniqueTexts = [
    '灯塔入口需要出示蓝色通行证。',
    '灯塔厨房在星期五供应南瓜汤。',
    '灯塔屋顶使用太阳能给电池充电。',
    '灯塔地下室禁止携带明火和烟花。',
    '灯塔图书馆保存鲸鱼迁徙的地图。',
    '灯塔医务室的负责人名叫小岚。',
  ];
  return [
    scenario(
      'all-unique',
      '全唯一',
      uniqueTexts.map((text, index) => fixtureMemory(`unique-${index}`, text, [`unique-${index}`])),
    ),
    scenario('exact-duplicates', '10精确重复＋2独有', exact()),
    scenario('near-with-key-fact', '10近重复含关键事实＋2独有', [
      ...nearTexts.map((text, index) =>
        fixtureMemory(`near-${index}`, text, index === 9 ? ['key-location', 'emergency-code'] : ['key-location'], {
          importance: 0.95 - index * 0.01,
        }),
      ),
      ...rare(),
    ]),
    scenario('scope-a', '跨观察者/私密边界：甲', structuredClone(boundary)),
    scenario('scope-b', '跨观察者/私密边界：乙', structuredClone(boundary), 800, BOB),
    scenario(
      'scarce-budget',
      '低预算稀缺事实',
      exact(),
      3 * auditMemoryTokens(fixtureMemory('budget-size', BASE, []).event),
    ),
    scenario('empty', '空池分母对照', []),
    scenario('zero-budget', '零预算分母对照', exact(), 0),
  ];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const excluded = new Set(right);
  return left.filter((id) => !excluded.has(id));
}

/** Explain the ACTUAL greedy function's retained set, not a new clustering or dedupe algorithm. */
function explainDuplicateGroups(items: readonly RecalledMemory[]): AuditDuplicateGroup[] {
  const kept = dedupeRecalled(items);
  const keptIds = new Set(kept.map((item) => item.event.id));
  const positions = new Map(items.map((item, index) => [item.event.id, index]));
  const groups = kept.map((item) => ({
    representativeId: String(item.event.id),
    memberIds: [String(item.event.id)],
    removableIds: [] as string[],
    removableEstimatedTokens: 0,
  }));
  for (const [index, item] of items.entries()) {
    if (keptIds.has(item.event.id)) continue;
    const witness = kept.findIndex(
      (representative) =>
        (positions.get(representative.event.id) ?? Number.POSITIVE_INFINITY) < index &&
        textSimilarity(
          `${representative.event.summary} ${representative.event.perception}`,
          `${item.event.summary} ${item.event.perception}`,
        ) >= DEFAULT_DEDUPE_THRESHOLD,
    );
    const group = groups[witness];
    if (group === undefined) throw new Error('Cannot explain the existing dedupe result; no earlier retained witness.');
    group.memberIds.push(item.event.id);
    group.removableIds.push(item.event.id);
    group.removableEstimatedTokens += auditMemoryTokens(item.event);
  }
  return groups.filter((group) => group.removableIds.length > 0);
}

function measureSelection(
  items: readonly RecalledMemory[],
  labels: ReadonlyMap<string, readonly string[]>,
  visibleIds: ReadonlySet<string>,
  facts: readonly string[],
  uniqueFacts: readonly string[],
): AuditSelectionMetrics {
  if (items.some((item) => !visibleIds.has(item.event.id))) throw new Error('Observer/scope boundary violated.');
  const selectedIds = items.map((item) => String(item.event.id));
  const estimatedTokens = items.reduce((sum, item) => sum + auditMemoryTokens(item.event), 0);
  const retainedFactIds = [...new Set(selectedIds.flatMap((id) => labels.get(id) ?? []))].sort();
  const retainedUniqueFactIds = uniqueFacts.filter((id) => retainedFactIds.includes(id));
  const duplicateGroups = explainDuplicateGroups(items);
  const duplicateGroupMemberCount = duplicateGroups.reduce((sum, group) => sum + group.memberIds.length, 0);
  const algorithmRemovableCount = duplicateGroups.reduce((sum, group) => sum + group.removableIds.length, 0);
  const algorithmRemovableEstimatedTokens = duplicateGroups.reduce(
    (sum, group) => sum + group.removableEstimatedTokens,
    0,
  );
  return {
    selectedIds,
    selectedCount: selectedIds.length,
    estimatedTokens,
    duplicateGroups,
    duplicateGroupMemberCount,
    duplicateGroupItemShare: ratio(duplicateGroupMemberCount, selectedIds.length),
    algorithmRemovableCount,
    algorithmRemovableEstimatedTokens,
    algorithmRemovableTokenShare: ratio(algorithmRemovableEstimatedTokens, estimatedTokens),
    retainedFactIds,
    missingFactIds: difference(facts, retainedFactIds),
    labeledFactRetention: ratio(retainedFactIds.length, facts.length),
    retainedUniqueFactIds,
    missingUniqueFactIds: difference(uniqueFacts, retainedUniqueFactIds),
    uniqueFactRetention: ratio(retainedUniqueFactIds.length, uniqueFacts.length),
  };
}

export async function evaluateRecallDedupeScenario(
  scenarioInput: RecallDedupeScenario,
): Promise<RecallDedupeScenarioResult> {
  // Snapshot inputs before the first await; both arms receive the exact same pool/query/budget.
  const input = structuredClone(scenarioInput);
  if (!Number.isSafeInteger(input.budgetTokens) || input.budgetTokens < 0)
    throw new Error('Audit budget must be a nonnegative safe integer.');
  if (!Number.isFinite(Date.parse(input.query.now))) throw new Error('Audit requires a fixed valid query.now.');
  const ids = input.memories.map((item) => item.event.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate fixture record ID.');
  for (const item of input.memories) {
    if (item.factIds.some((id) => id.trim() === '') || new Set(item.factIds).size !== item.factIds.length)
      throw new Error('Fixture fact labels must be nonempty and unique within one record.');
  }
  const store = createMemoryEntityStore();
  await store.bulkPut(
    COLLECTIONS.memories,
    input.memories.map((item) => item.event),
  );
  const pool = await new Repository(store).listMemories(input.roomId, { conversationId: input.conversationId });
  const visible = pool.filter((event) => event.observerId === input.query.observerId);
  if (visible.some((event) => isSuperseded(event) || (event.supersedes?.length ?? 0) > 0)) {
    throw new Error('Supplement/source chains are outside this regular-recall-only audit.');
  }
  const production = recallForPrompt(pool, input.query, {
    budgetTokens: input.budgetTokens,
    counter: heuristicTokenCounter,
    mentionText: input.query.text,
  });
  const ranked = limitFallbackItems(recallMemories(pool, input.query));
  const undeDuped = selectWithinBudget(ranked, input.budgetTokens, heuristicTokenCounter);
  if (
    production.candidates.mention !== 0 ||
    production.candidates.source !== 0 ||
    production.candidates.recall !== ranked.length ||
    JSON.stringify(production.selected) !== JSON.stringify(undeDuped.map((item) => ({ ...item, origin: 'recall' })))
  ) {
    throw new Error('Production baseline differs from the undeduped regular path; comparison is not fair.');
  }
  const candidateRanked = dedupeRecalled(ranked);
  const candidateSelected = selectWithinBudget(candidateRanked, input.budgetTokens, heuristicTokenCounter);
  const labels = new Map(input.memories.map((item) => [String(item.event.id), item.factIds]));
  const factCounts = new Map<string, number>();
  for (const event of visible) {
    for (const id of labels.get(event.id) ?? []) factCounts.set(id, (factCounts.get(id) ?? 0) + 1);
  }
  const availableFactIds = [...factCounts.keys()].sort();
  const availableUniqueFactIds = availableFactIds.filter((id) => factCounts.get(id) === 1);
  const visibleIds = new Set(visible.map((event) => String(event.id)));
  const baseline = measureSelection(production.selected, labels, visibleIds, availableFactIds, availableUniqueFactIds);
  const candidate = measureSelection(candidateSelected, labels, visibleIds, availableFactIds, availableUniqueFactIds);
  const baselineIds = ranked.map((item) => String(item.event.id));
  const candidateIds = candidateRanked.map((item) => String(item.event.id));
  return {
    input,
    repositoryPoolIds: pool.map((event) => event.id),
    observerVisibleIds: [...visibleIds],
    availableFactIds,
    availableUniqueFactIds,
    beforeBudget: { baselineIds, candidateIds, removedIds: difference(baselineIds, candidateIds) },
    productionCandidates: production.candidates,
    baselineMatchesUndedupedRegularPath: true,
    baseline,
    candidate,
    delta: {
      estimatedTokens: candidate.estimatedTokens - baseline.estimatedTokens,
      gainedFactIds: difference(candidate.retainedFactIds, baseline.retainedFactIds),
      lostFactIds: difference(baseline.retainedFactIds, candidate.retainedFactIds),
      gainedUniqueFactIds: difference(candidate.retainedUniqueFactIds, baseline.retainedUniqueFactIds),
      lostUniqueFactIds: difference(baseline.retainedUniqueFactIds, candidate.retainedUniqueFactIds),
    },
  };
}

export async function runRecallDedupeAudit(): Promise<RecallDedupeAuditReport> {
  return {
    schemaVersion: 1,
    method: {
      baseline: 'Repository.listMemories -> recallForPrompt (unchanged production)',
      candidate:
        'same pool/query -> recallMemories -> limitFallbackItems -> dedupeRecalled -> selectWithinBudget (offline only)',
      counter: heuristicTokenCounter.name,
      dedupeThreshold: DEFAULT_DEDUPE_THRESHOLD,
      fallbackLimit: DEFAULT_FALLBACK_LIMIT,
      scope:
        'Live same-room/conversation memory; production observer filter; regular recall only, no supplement/source chains.',
    },
    limitations: [
      '全部为人工合成资料及标签；不是用户数据、真实语义评判、模型质量或生产收益证据。',
      '独有事实标签指本场景当前观察者可见池内仅一条记录支持的人工标签；不是自动识别的完整事实集合。',
      '重复组来自现有贪心函数的实际保留集；组成员占比包含代表项，分母是各自入选数，不做传递闭包。',
      '可移除token是现有算法判重后的估算值，不等于安全回收；实际净变化另列，补入条目会重新使用预算。',
      'token沿用summary与perception分别估算再相加，不含提示包装、其他prompt块或真实服务商tokenizer。',
      '同一场景两臂的原始输入、池、query.now、观察者、预算、默认权重/兜底限额完全相同；只有离线去重插入不同。',
      '不覆盖合并来源/提到旧原文的独立预留预算、完整App场记/章节/audience隐私语义、原生IDB或浏览器。',
      '800和低/零预算均是声明的合成夹具预算；未修改任何生产常量、去重阈值、默认权重或语义政策。',
      '零分母为null；不将各场景平均或合成总收益外推为真实用户收益；没有计时性能断言。',
    ],
    results: await Promise.all(createRecallDedupeAuditScenarios().map(evaluateRecallDedupeScenario)),
  };
}

export function formatRecallDedupeAudit(report: RecallDedupeAuditReport): string {
  const percent = (value: number | null) => (value === null ? '不适用' : `${(value * 100).toFixed(1)}%`);
  const lines = [
    '# Task 120 / B12：仅离线合成量化，未实施生产去重',
    '',
    `算法：${report.method.baseline}`,
    `候选：${report.method.candidate}`,
    `估算器：${report.method.counter}；沿用默认去重阈值${report.method.dedupeThreshold}、兜底上限${report.method.fallbackLimit}。`,
    '',
    '| 场景 | 原始/仓储池/观察者池 | 预算 | 入选 基线→候选 | 估算token 基线→候选 | 算法重复组成员占比 基线→候选 | 算法可移除token 基线→候选 | 独有标签保留/分母 基线→候选 | 新增保留/损失独有标签 |',
    '| --- | --- | ---: | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of report.results) {
    const { baseline: a, candidate: b } = row;
    const denominator = row.availableUniqueFactIds.length;
    const retained = (arm: AuditSelectionMetrics) =>
      denominator === 0 ? '不适用(0/0)' : `${arm.retainedUniqueFactIds.length}/${denominator}`;
    lines.push(
      `| ${row.input.label} | ${row.input.memories.length}/${row.repositoryPoolIds.length}/${row.observerVisibleIds.length} | ${row.input.budgetTokens} | ${a.selectedCount}→${b.selectedCount} | ${a.estimatedTokens}→${b.estimatedTokens} | ${percent(a.duplicateGroupItemShare)}→${percent(b.duplicateGroupItemShare)} | ${a.algorithmRemovableEstimatedTokens}→${b.algorithmRemovableEstimatedTokens} | ${retained(a)}→${retained(b)} | +${row.delta.gainedUniqueFactIds.length}/-${row.delta.lostUniqueFactIds.length} |`,
    );
  }
  lines.push(
    '',
    '## 口径与限制',
    ...report.limitations.map((line) => `- ${line}`),
    '',
    '## 待用户拍板（本评测不实施）',
    '- 保持现状并扩大离线样本，尤其先审查候选丢失的独有标签，不凭回收token上线。',
    '- 若继续研究，只授权离线验证更保守的适用边界/排除规则；另测合并来源、时间变化和矛盾认识，当前不修改阈值。',
    '- 若要接生产，另行明确作用域、置顶/关键事实/来源链保留政策、开关与回滚，并授权真实质量及浏览器验收。',
    '',
  );
  return lines.join('\n');
}
