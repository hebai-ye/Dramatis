import { type InstanceId, PLAYER } from '../model/ids.js';
import type { CharacterInstance, Relationship } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { ChatMessage } from '../prompt/types.js';
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

function toFinite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
              at: meta.at,
              turnId: meta.turnId,
              deltaValence,
              deltaArousal,
              reason: '情绪随时间自然褪色',
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
    affinity: 0,
    fear: 0,
    respect: 0,
    tension: 0,
    updatedAt: at,
    history: [],
  };
}

export interface ApplyMeta {
  at: string;
  turnId: string;
  /** 关系变化默认算在玩家头上。 */
  target?: Relationship['target'];
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

  const nextAffect = {
    valence: clamp(decayed.affect.valence + update.deltaValence, -1, 1),
    arousal: clamp(decayed.affect.arousal + update.deltaArousal, 0, 1),
    updatedAt: meta.at,
    history:
      update.deltaValence !== 0 || update.deltaArousal !== 0
        ? [
            ...decayed.affect.history,
            {
              at: meta.at,
              turnId: meta.turnId,
              deltaValence: update.deltaValence,
              deltaArousal: update.deltaArousal,
              reason: update.reason,
            },
          ]
        : decayed.affect.history,
  };

  const base = ensureRelationship(decayed, target, meta.at);
  const updated: Relationship = { ...base, history: [...base.history] };

  for (const delta of update.relationship) {
    const current = updated[delta.field];
    const bounded = delta.field === 'tension' || delta.field === 'fear' ? [0, 1] : [-1, 1];
    updated[delta.field] = clamp(current + delta.delta, bounded[0] ?? 0, bounded[1] ?? 1);
    updated.history.push({
      at: meta.at,
      turnId: meta.turnId,
      field: delta.field,
      delta: delta.delta,
      reason: update.reason,
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

/**
 * 撤销某个回合对情绪与关系造成的影响（P0-7 的回滚）。
 *
 * 按记录的历史反向减去当时的 delta，连同褪色一起还原——因为褪色本身
 * 也被记进了历史。唯一无法完全还原的是**夹紧**：长期顶到边界的维度，
 * 还原后会有轻微偏差，但反复重抽不会造成单向漂移。
 */
export function revertAffectForTurn(instance: CharacterInstance, turnId: string): CharacterInstance {
  const affectChanges = instance.affect.history.filter((change) => change.turnId === turnId);
  const relationshipChanges = instance.relationships.flatMap((edge) =>
    edge.history.filter((change) => change.turnId === turnId),
  );

  if (affectChanges.length === 0 && relationshipChanges.length === 0) return instance;

  const valenceDelta = affectChanges.reduce((total, change) => total + change.deltaValence, 0);
  const arousalDelta = affectChanges.reduce((total, change) => total + change.deltaArousal, 0);

  const relationships = instance.relationships.map((edge) => {
    const changes = edge.history.filter((change) => change.turnId === turnId);
    if (changes.length === 0) return edge;

    const next: Relationship = { ...edge, history: edge.history.filter((change) => change.turnId !== turnId) };
    for (const change of changes) {
      const current = next[change.field];
      const bounded = change.field === 'tension' || change.field === 'fear' ? [0, 1] : [-1, 1];
      next[change.field] = clamp(current - change.delta, bounded[0] ?? 0, bounded[1] ?? 1);
    }
    return next;
  });

  return {
    ...instance,
    affect: {
      valence: clamp(instance.affect.valence - valenceDelta, -1, 1),
      arousal: clamp(instance.affect.arousal - arousalDelta, 0, 1),
      updatedAt: instance.affect.updatedAt,
      history: instance.affect.history.filter((change) => change.turnId !== turnId),
    },
    relationships,
  };
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
