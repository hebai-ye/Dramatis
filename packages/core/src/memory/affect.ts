import { type EventId, type InstanceId, newId, PLAYER } from '../model/ids.js';
import {
  type AffectChange,
  type CharacterInstance,
  INITIAL_PLAYER_AFFINITY,
  type Relationship,
  type RelationshipChange,
} from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { ChatMessage } from '../prompt/types.js';
import { toFinite } from '../util/json.js';
import { extractJsonObject } from './extract.js';
import { MemoryExtractionError } from './types.js';

/**
 * 情绪与关系推演（ROADMAP P1-7）与抗漂移（P1-8）。
 *
 * 三个防漂移机制都在这里：
 * - **单轮上限**：一次对话最多把某个维度推动 0.3，情绪不会因为一句话翻转
 * - **自然褪色**：每轮先把情绪往中性拉一点，只有被反复触动才留得住
 * - **值域夹紧**：所有数值始终落在合法区间，长期运行不会跑飞
 */
export const MAX_DELTA_PER_TURN = 0.3;
/** 每轮情绪向中性回归的比例。 */
export const AFFECT_DECAY_PER_TURN = 0.08;

export type RelationshipField = 'trust' | 'affinity' | 'fear' | 'respect' | 'tension';

export const RELATIONSHIP_FIELDS: readonly RelationshipField[] = ['trust', 'affinity', 'fear', 'respect', 'tension'];

export interface RelationshipDelta {
  field: RelationshipField;
  delta: number;
}

export interface AffectUpdate {
  observer: string;
  deltaValence: number;
  deltaArousal: number;
  reason: string;
  relationship: RelationshipDelta[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 单轮变化量一律夹到上限，这是抗漂移的第一道闸。 */
function clampDelta(value: number): number {
  return clamp(value, -MAX_DELTA_PER_TURN, MAX_DELTA_PER_TURN);
}

function describeRelationship(relationship: Relationship | undefined): string {
  if (!relationship) return '尚无记录';
  return RELATIONSHIP_FIELDS.map((field) => `${field} ${relationship[field].toFixed(2)}`).join(' ');
}

export interface AffectPromptInput {
  cast: readonly CharacterInstance[];
  playerName: string;
  messages: readonly Message[];
}

export function buildAffectMessages(input: AffectPromptInput): ChatMessage[] {
  const roster = input.cast
    .map((member) => {
      const towardPlayer = member.relationships.find((edge) => edge.target === PLAYER);
      const affect = member.affect;
      return `- ${member.displayName}：愉悦度 ${affect.valence.toFixed(2)} / 激动度 ${affect.arousal.toFixed(2)}；对玩家 ${describeRelationship(towardPlayer)}`;
    })
    .join('\n');

  const conversation = input.messages
    .map((message) => `${message.speakerName}：${message.content.replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');

  return [
    {
      role: 'system',
      content: '你在推演一段角色扮演对话之后的状态变化。只输出一个 JSON 对象，不要写解释。',
    },
    {
      role: 'user',
      content: [
        `玩家扮演：${input.playerName}`,
        '角色当前状态：',
        roster,
        '',
        '对话：',
        conversation,
        '',
        '要求：',
        '- 只为真的被触动的角色输出一条；没有变化的角色不要出现。',
        `- deltaValence 与 deltaArousal 在 ${-MAX_DELTA_PER_TURN} 到 ${MAX_DELTA_PER_TURN} 之间，没有变化就填 0。`,
        '- relationship 只写发生变化的维度，field 取值：trust / affinity / fear / respect / tension。',
        `- 每个 delta 同样在 ${-MAX_DELTA_PER_TURN} 到 ${MAX_DELTA_PER_TURN} 之间。`,
        '- reason 用一句话说明变化的原因，会被记录进角色状态史。',
        '',
        '输出格式：',
        '{"updates":[{"observer":"角色名","deltaValence":0.1,"deltaArousal":0.05,"reason":"为什么","relationship":[{"field":"affinity","delta":0.1}]}]}',
      ].join('\n'),
    },
  ];
}

function parseRelationship(raw: unknown): RelationshipDelta[] {
  if (!Array.isArray(raw)) return [];

  const deltas: RelationshipDelta[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.field !== 'string') continue;
    if (!RELATIONSHIP_FIELDS.includes(record.field as RelationshipField)) continue;

    deltas.push({ field: record.field as RelationshipField, delta: clampDelta(toFinite(record.delta)) });
  }
  return deltas;
}

/**
 * 解析推演结果。
 *
 * 与抽取不同，这里不要求必须有内容：一轮对话没有任何情绪波动是完全正常的，
 * 返回空数组比抛错更诚实。
 */
export function parseAffectUpdates(raw: string): AffectUpdate[] {
  const root = extractJsonObject(raw);
  if (typeof root !== 'object' || root === null) {
    throw new MemoryExtractionError('推演结果不是 JSON 对象');
  }

  const list = (root as Record<string, unknown>).updates;
  if (!Array.isArray(list)) return [];

  const updates: AffectUpdate[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;

    const observer = typeof record.observer === 'string' ? record.observer.trim() : '';
    if (observer === '') continue;

    updates.push({
      observer,
      deltaValence: clampDelta(toFinite(record.deltaValence)),
      deltaArousal: clampDelta(toFinite(record.deltaArousal)),
      reason: typeof record.reason === 'string' ? record.reason.trim() : '',
      relationship: parseRelationship(record.relationship),
    });
  }
  return updates;
}

/**
 * 情绪自然褪色。
 *
 * 每轮先褪一点，再叠加本轮的变化——高兴的事会被慢慢忘掉，
 * 只有反复被触动的事情才留得住。这是抗漂移的第二道闸。
 */
export function decayAffect(instance: CharacterInstance, meta: { at: string; turnId: string }): CharacterInstance {
  const deltaValence = instance.affect.valence * -AFFECT_DECAY_PER_TURN;
  const deltaArousal = instance.affect.arousal * -AFFECT_DECAY_PER_TURN;
  const changed = Math.abs(deltaValence) > 1e-6 || Math.abs(deltaArousal) > 1e-6;

  return {
    ...instance,
    affect: {
      ...instance.affect,
      valence: instance.affect.valence + deltaValence,
      arousal: instance.affect.arousal + deltaArousal,
      updatedAt: meta.at,
      // 褪色也要进历史：它同样是一次变化，不记录就无法被重抽撤销，
      // 反复重抽会让情绪单向漂移
      history: changed
        ? [
            ...instance.affect.history,
            {
              id: newId(),
              at: meta.at,
              turnId: meta.turnId,
              beforeValence: instance.affect.valence,
              afterValence: instance.affect.valence + deltaValence,
              beforeArousal: instance.affect.arousal,
              afterArousal: instance.affect.arousal + deltaArousal,
              deltaValence,
              deltaArousal,
              reason: '情绪随时间自然褪色',
              sourceMemoryIds: [],
              reversionOf: null,
            },
          ]
        : instance.affect.history,
    },
  };
}

function ensureRelationship(instance: CharacterInstance, target: Relationship['target'], at: string): Relationship {
  const existing = instance.relationships.find((edge) => edge.target === target);
  if (existing) return existing;

  return {
    target,
    trust: 0,
    // 补一条「对玩家」的关系边时和新建实例同一口径（顺序 89）：起点是 40% 好感，不是敌对
    affinity: target === PLAYER ? INITIAL_PLAYER_AFFINITY : 0,
    fear: 0,
    respect: 0,
    tension: 0,
    updatedAt: at,
    history: [],
  };
}

/**
 * 手动调整一段关系的某一维（用户 2026-09-26 点名：好感要能自己改）。
 *
 * 与 `applyAffectUpdate` 共用同一套值域与历史约定：夹紧之后写一条 `history`，
 * 撤销仍然按记录走（所以界面上的「撤销这条影响」对人工调整同样有效）。
 *
 * 两处刻意的不同：
 * - 这里**不受 `MAX_DELTA_PER_TURN` 约束**——那是给模型推演用的抗漂移闸，用户拖到哪就是哪；
 * - `reason` 记成「手动调整」，这样回看历史时能分清哪一步是模型推的、哪一步是人拖的。
 *
 * 值没变时**原样返回同一个对象**，调用方据此跳过写库。
 */
export function setRelationshipField(
  instance: CharacterInstance,
  field: RelationshipField,
  value: number,
  meta: { at: string; target?: Relationship['target']; reason?: string },
): CharacterInstance {
  const target = meta.target ?? PLAYER;
  const base = ensureRelationship(instance, target, meta.at);
  const before = base[field];
  const bounded = field === 'tension' || field === 'fear' ? [0, 1] : [-1, 1];
  const after = clamp(Number.isFinite(value) ? value : before, bounded[0] ?? 0, bounded[1] ?? 1);
  if (after === before) return instance;

  const updated: Relationship = { ...base, history: [...base.history] };
  updated[field] = after;
  updated.updatedAt = meta.at;
  updated.history.push({
    id: newId(),
    at: meta.at,
    turnId: '',
    field,
    before,
    after,
    delta: after - before,
    reason: meta.reason ?? '手动调整',
    sourceMemoryIds: [],
    reversionOf: null,
  });

  const relationships = instance.relationships.some((edge) => edge.target === target)
    ? instance.relationships.map((edge) => (edge.target === target ? updated : edge))
    : [...instance.relationships, updated];

  return { ...instance, relationships, updatedAt: meta.at };
}

export interface ApplyMeta {
  at: string;
  turnId: string;
  /** 关系变化默认算在玩家头上。 */
  target?: Relationship['target'];
  /** 直接指定这次影响的来源记忆（单角色调用时用）。 */
  sourceMemoryIds?: readonly EventId[];
  /** 多角色共用一次分析时，按实例分别关联各自的视角记忆。 */
  sourceMemoryIdsByObserver?: ReadonlyMap<InstanceId, readonly EventId[]>;
}

/**
 * 应用一条推演结果。
 *
 * 先褪色再叠加，然后夹紧值域，最后把变化与理由写进历史——
 * 状态必须可回溯，否则调试时会变成猜谜。
 */
export function applyAffectUpdate(
  instance: CharacterInstance,
  update: AffectUpdate,
  meta: ApplyMeta,
): CharacterInstance {
  const target = meta.target ?? PLAYER;
  const decayed = decayAffect(instance, meta);
  const sourceMemoryIds = [
    ...new Set([...(meta.sourceMemoryIds ?? []), ...(meta.sourceMemoryIdsByObserver?.get(instance.id) ?? [])]),
  ];

  const afterValence = clamp(decayed.affect.valence + update.deltaValence, -1, 1);
  const afterArousal = clamp(decayed.affect.arousal + update.deltaArousal, 0, 1);
  const nextAffect = {
    valence: afterValence,
    arousal: afterArousal,
    updatedAt: meta.at,
    history:
      update.deltaValence !== 0 || update.deltaArousal !== 0
        ? [
            ...decayed.affect.history,
            {
              id: newId(),
              at: meta.at,
              turnId: meta.turnId,
              beforeValence: decayed.affect.valence,
              afterValence,
              beforeArousal: decayed.affect.arousal,
              afterArousal,
              deltaValence: afterValence - decayed.affect.valence,
              deltaArousal: afterArousal - decayed.affect.arousal,
              reason: update.reason,
              sourceMemoryIds,
              reversionOf: null,
            },
          ]
        : decayed.affect.history,
  };

  const base = ensureRelationship(decayed, target, meta.at);
  const updated: Relationship = { ...base, history: [...base.history] };

  for (const delta of update.relationship) {
    const current = updated[delta.field];
    const bounded = delta.field === 'tension' || delta.field === 'fear' ? [0, 1] : [-1, 1];
    const after = clamp(current + delta.delta, bounded[0] ?? 0, bounded[1] ?? 1);
    updated[delta.field] = after;
    updated.history.push({
      id: newId(),
      at: meta.at,
      turnId: meta.turnId,
      field: delta.field,
      before: current,
      after,
      delta: after - current,
      reason: update.reason,
      sourceMemoryIds,
      reversionOf: null,
    });
  }
  updated.updatedAt = meta.at;

  const relationships = decayed.relationships.some((edge) => edge.target === target)
    ? decayed.relationships.map((edge) => (edge.target === target ? updated : edge))
    : [...decayed.relationships, updated];

  return { ...decayed, affect: nextAffect, relationships, updatedAt: meta.at };
}

/** 按角色名找到实例；命中不到就返回 null，由调用方决定怎么记录。 */
export function resolveObserver(cast: readonly CharacterInstance[], name: string): CharacterInstance | null {
  const needle = name.trim().toLowerCase();
  return cast.find((member) => member.displayName.trim().toLowerCase() === needle) ?? null;
}

export interface AffectTarget {
  instanceId: InstanceId;
  next: CharacterInstance;
}

export interface RevertChangeMeta {
  at?: string;
  /** 撤销记录自己的 turnId；默认用 `undo:<原记录 id>`，不会被回合回滚再捡回来。 */
  turnId?: string;
}

/**
 * 按条目撤销一次情绪或关系影响（顺序 27d）。
 *
 * **append-only**：原始记录一个字段都不改，只在同一个历史数组末尾追加一条
 * `reversionOf = 原 id` 的反向记录。这样用户能看到「什么影响过、什么时候撤了」，
 * 也不会因为撤销而抹掉审计线索。
 *
 * 反向量用原记录的实际 delta（夹紧后的 before → after），因此撤销只抵消
 * 这次影响本身；之后发生的其它变化会原样保留。
 */
export function revertAffectChange(
  instance: CharacterInstance,
  changeId: string,
  meta: RevertChangeMeta = {},
): CharacterInstance {
  const at = meta.at ?? new Date().toISOString();
  const turnId = meta.turnId ?? `undo:${changeId}`;

  const affectChange = instance.affect.history.find((change) => change.id === changeId);
  if (affectChange !== undefined) {
    if (
      affectChange.reversionOf !== null ||
      instance.affect.history.some((change) => change.reversionOf === changeId)
    ) {
      return instance;
    }

    const beforeValence = instance.affect.valence;
    const beforeArousal = instance.affect.arousal;
    const afterValence = clamp(
      beforeValence - actualChange(affectChange.beforeValence, affectChange.afterValence),
      -1,
      1,
    );
    const afterArousal = clamp(
      beforeArousal - actualChange(affectChange.beforeArousal, affectChange.afterArousal),
      0,
      1,
    );
    const reversal = {
      id: newId(),
      at,
      turnId,
      beforeValence,
      afterValence,
      beforeArousal,
      afterArousal,
      deltaValence: afterValence - beforeValence,
      deltaArousal: afterArousal - beforeArousal,
      reason: `撤销影响：${affectChange.reason || '未记录原因'}`,
      sourceMemoryIds: [...affectChange.sourceMemoryIds],
      reversionOf: affectChange.id,
    };

    return {
      ...instance,
      affect: {
        ...instance.affect,
        valence: afterValence,
        arousal: afterArousal,
        updatedAt: at,
        history: [...instance.affect.history, reversal],
      },
      updatedAt: at,
    };
  }

  for (const edge of instance.relationships) {
    const change = edge.history.find((item) => item.id === changeId);
    if (change === undefined) continue;
    if (change.reversionOf !== null || edge.history.some((item) => item.reversionOf === changeId)) {
      return instance;
    }

    const before = edge[change.field];
    const bounded = change.field === 'tension' || change.field === 'fear' ? [0, 1] : [-1, 1];
    const after = clamp(before - actualChange(change.before, change.after), bounded[0] ?? 0, bounded[1] ?? 1);
    const updatedEdge: Relationship = {
      ...edge,
      [change.field]: after,
      updatedAt: at,
      history: [
        ...edge.history,
        {
          id: newId(),
          at,
          turnId,
          field: change.field,
          before,
          after,
          delta: after - before,
          reason: `撤销影响：${change.reason || '未记录原因'}`,
          sourceMemoryIds: [...change.sourceMemoryIds],
          reversionOf: change.id,
        },
      ],
    };

    return {
      ...instance,
      relationships: instance.relationships.map((item) => (item.target === edge.target ? updatedEdge : item)),
      updatedAt: at,
    };
  }

  return instance;
}

/** before/after is authoritative; historical requested deltas may predate clamping fixes. */
function actualChange(before: number, after: number): number {
  const delta = after - before;
  if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(delta)) {
    throw new Error('影响历史的 before/after 无效，未执行撤销；请先保留快照并核验历史。');
  }
  return delta;
}

function undoableForTurn<T extends { id: string; turnId: string; reversionOf: string | null }>(
  history: readonly T[],
  turnId: string,
): T[] {
  const reverted = new Set(history.map((change) => change.reversionOf).filter((id) => id !== null));
  const seen = new Set<string>();
  return history.filter((change) => {
    if (change.turnId !== turnId || change.reversionOf !== null || reverted.has(change.id) || seen.has(change.id))
      return false;
    seen.add(change.id);
    return true;
  });
}

/** Stable summation order makes array reversal/permutation irrelevant even for floating-point input. */
function netChange<T extends { id: string }>(changes: readonly T[], delta: (change: T) => number): number {
  return [...changes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .reduce((sum, change) => sum + delta(change), 0);
}

function undoNet(before: number, delta: number, min: number, max: number): number {
  if (!Number.isFinite(before) || !Number.isFinite(delta))
    throw new Error('影响记录的当前值或净变化无效，未执行撤销。');
  return clamp(before - delta, min, max);
}

/**
 * 整轮按未撤销原始记录的实际净变化结算，每个维度只夹紧一次；不依赖历史数组正/逆序。
 * 原历史不变，每个原id仍有一个reversionOf，兼容旧客户端的已撤销判断。
 * 同一维度的首条反向记录承载整批实际净变化，其余是零变化关联标记；理由明确为合并结算。
 * 这不是逐条撤销的伪造回放：不存在中间夹紧，也不回滚后续回合或改变自然衰减规则。
 */
export function revertAffectForTurn(instance: CharacterInstance, turnId: string): CharacterInstance {
  const affectChanges = undoableForTurn(instance.affect.history, turnId);
  const edgeChanges = instance.relationships.map((edge) => undoableForTurn(edge.history, turnId));
  if (affectChanges.length === 0 && edgeChanges.every((changes) => changes.length === 0)) return instance;
  const at = new Date().toISOString();
  const undoTurn = `undo:${turnId}`;
  let affect = instance.affect;
  if (affectChanges.length > 0) {
    const valence = undoNet(
      affect.valence,
      netChange(affectChanges, (change) => actualChange(change.beforeValence, change.afterValence)),
      -1,
      1,
    );
    const arousal = undoNet(
      affect.arousal,
      netChange(affectChanges, (change) => actualChange(change.beforeArousal, change.afterArousal)),
      0,
      1,
    );
    const sourceMemoryIds = [...new Set(affectChanges.flatMap((change) => change.sourceMemoryIds))];
    const reversals: AffectChange[] = affectChanges.map((change, index) => {
      const first = index === 0;
      const beforeValence = first ? affect.valence : valence;
      const beforeArousal = first ? affect.arousal : arousal;
      return {
        id: newId(),
        at,
        turnId: undoTurn,
        beforeValence,
        afterValence: valence,
        beforeArousal,
        afterArousal: arousal,
        deltaValence: valence - beforeValence,
        deltaArousal: arousal - beforeArousal,
        reason:
          affectChanges.length === 1
            ? `撤销影响：${change.reason || '未记录原因'}`
            : (first ? `整轮撤销（合并${affectChanges.length}项的净变化）：` : '整轮撤销（已合并结算的关联标记）：') +
              (change.reason || '未记录原因'),
        sourceMemoryIds: first ? sourceMemoryIds : [...change.sourceMemoryIds],
        reversionOf: change.id,
      };
    });
    affect = { ...affect, valence, arousal, updatedAt: at, history: [...affect.history, ...reversals] };
  }
  const relationships = instance.relationships.map((edge, index) => {
    const changes = edgeChanges[index] ?? [];
    if (changes.length === 0) return edge;
    const next = { ...edge };
    const settled = new Set<RelationshipField>();
    const grouped = new Map(
      RELATIONSHIP_FIELDS.map((field) => [field, changes.filter((change) => change.field === field)]),
    );
    const reversals: RelationshipChange[] = changes.map((change) => {
      const group = grouped.get(change.field) ?? [];
      const first = !settled.has(change.field);
      const before = next[change.field];
      const minimum = change.field === 'fear' || change.field === 'tension' ? 0 : -1;
      const after = first
        ? undoNet(
            before,
            netChange(group, (item) => actualChange(item.before, item.after)),
            minimum,
            1,
          )
        : before;
      next[change.field] = after;
      settled.add(change.field);
      return {
        id: newId(),
        at,
        turnId: undoTurn,
        field: change.field,
        before,
        after,
        delta: after - before,
        reason:
          group.length === 1
            ? `撤销影响：${change.reason || '未记录原因'}`
            : (first ? `整轮撤销（合并${group.length}项的净变化）：` : '整轮撤销（已合并结算的关联标记）：') +
              (change.reason || '未记录原因'),
        sourceMemoryIds: first
          ? [...new Set(group.flatMap((item) => item.sourceMemoryIds))]
          : [...change.sourceMemoryIds],
        reversionOf: change.id,
      };
    });
    return { ...next, updatedAt: at, history: [...edge.history, ...reversals] };
  });
  return { ...instance, affect, relationships, updatedAt: at };
}

/** 批量应用推演结果，返回需要落盘的实例。 */
export function applyAffectUpdates(
  cast: readonly CharacterInstance[],
  updates: readonly AffectUpdate[],
  meta: ApplyMeta,
): { applied: AffectTarget[]; unmatched: string[] } {
  const applied: AffectTarget[] = [];
  const unmatched: string[] = [];
  const working = new Map(cast.map((member) => [member.id, member]));

  for (const update of updates) {
    const observer = resolveObserver([...working.values()], update.observer);
    if (!observer) {
      unmatched.push(update.observer);
      continue;
    }
    const next = applyAffectUpdate(observer, update, meta);
    working.set(observer.id, next);
    applied.push({ instanceId: observer.id, next });
  }

  return { applied, unmatched };
}
