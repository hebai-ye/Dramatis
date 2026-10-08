import { describe, expect, it } from 'vitest';
import { cardId, eventId, instanceId, PLAYER, roomId } from '../model/ids.js';
import {
  type AffectChange,
  type CharacterInstance,
  neutralTraits,
  type Relationship,
  type RelationshipChange,
} from '../model/instance.js';
import {
  type AffectUpdate,
  applyAffectUpdate,
  RELATIONSHIP_FIELDS,
  type RelationshipField,
  revertAffectChange,
  revertAffectForTurn,
} from './affect.js';

const AT = '2026-01-01T00:00:00.000Z';
const TURN = 'reroll-turn';
const OTHER_TURN = 'keep-turn';
const OTHER_TARGET = instanceId('other-character');
const UNTOUCHED_TARGET = instanceId('untouched-character');
const meta = { at: AT, turnId: TURN };

function relationship(target: Relationship['target'] = PLAYER): Relationship {
  return { target, trust: 0, affinity: 0, fear: 0, respect: 0, tension: 0, updatedAt: AT, history: [] };
}

function actor(): CharacterInstance {
  return {
    id: instanceId('alice'),
    roomId: roomId('room'),
    cardId: cardId('card'),
    displayName: 'Alice',
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: AT, history: [] },
    relationships: [relationship()],
    traitsLocked: false,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
  };
}

function update(overrides: Partial<AffectUpdate> = {}): AffectUpdate {
  return {
    observer: 'Alice',
    deltaValence: 0,
    deltaArousal: 0,
    reason: '回归测试中的影响',
    relationship: [],
    ...overrides,
  };
}

function affectChange(
  id: string,
  beforeValence: number,
  afterValence: number,
  beforeArousal: number,
  afterArousal: number,
  overrides: Partial<AffectChange> = {},
): AffectChange {
  return {
    id,
    at: AT,
    turnId: TURN,
    beforeValence,
    afterValence,
    beforeArousal,
    afterArousal,
    deltaValence: afterValence - beforeValence,
    deltaArousal: afterArousal - beforeArousal,
    reason: id,
    sourceMemoryIds: [eventId(`memory:${id}`)],
    reversionOf: null,
    ...overrides,
  };
}

function relationshipChange(
  id: string,
  field: RelationshipField,
  before: number,
  after: number,
  overrides: Partial<RelationshipChange> = {},
): RelationshipChange {
  return {
    id,
    at: AT,
    turnId: TURN,
    field,
    before,
    after,
    delta: after - before,
    reason: id,
    sourceMemoryIds: [eventId(`memory:${id}`)],
    reversionOf: null,
    ...overrides,
  };
}

function edge(instance: CharacterInstance, target: Relationship['target'] = PLAYER): Relationship {
  const found = instance.relationships.find((item) => item.target === target);
  if (!found) throw new Error(`Missing relationship: ${target}`);
  return found;
}

function minimum(field: RelationshipField): number {
  return field === 'fear' || field === 'tension' ? 0 : -1;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectBounded(value: number, min: number, max = 1): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(min);
  expect(value).toBeLessThanOrEqual(max);
}

function expectAppendOnly<T extends { id: string; turnId: string; reversionOf: string | null }>(
  before: readonly T[],
  after: readonly T[],
): T[] {
  const pending = before.filter(
    (original) =>
      original.turnId === TURN &&
      original.reversionOf === null &&
      !before.some((record) => record.reversionOf === original.id),
  );
  expect(after.slice(0, before.length)).toEqual(before);
  before.forEach((original, index) => {
    expect(after[index]).toBe(original);
  });
  const appended = after.slice(before.length);
  expect(appended).toHaveLength(pending.length);
  expect(new Set(after.map((record) => record.id)).size).toBe(after.length);
  expect(appended.map((record) => record.reversionOf).sort()).toEqual(pending.map((record) => record.id).sort());
  for (const original of before.filter((record) => record.turnId === TURN && record.reversionOf === null)) {
    expect(after.filter((record) => record.reversionOf === original.id)).toHaveLength(1);
  }
  return appended;
}

/** 批次只核对补偿实际量的总和；允许首条结算净变化、其余条目仅关联原 id。 */
function expectTurnAudit(before: CharacterInstance, after: CharacterInstance): void {
  const affectReversals = expectAppendOnly(before.affect.history, after.affect.history);
  expectBounded(after.affect.valence, -1);
  expectBounded(after.affect.arousal, 0);
  for (const change of affectReversals) {
    expectBounded(change.beforeValence, -1);
    expectBounded(change.afterValence, -1);
    expectBounded(change.beforeArousal, 0);
    expectBounded(change.afterArousal, 0);
    expect(change.deltaValence).toBeCloseTo(change.afterValence - change.beforeValence, 12);
    expect(change.deltaArousal).toBeCloseTo(change.afterArousal - change.beforeArousal, 12);
    expect(change.reason.trim().length).toBeGreaterThan(0);
  }
  expect(affectReversals.reduce((sum, change) => sum + change.afterValence - change.beforeValence, 0)).toBeCloseTo(
    after.affect.valence - before.affect.valence,
    12,
  );
  expect(affectReversals.reduce((sum, change) => sum + change.afterArousal - change.beforeArousal, 0)).toBeCloseTo(
    after.affect.arousal - before.affect.arousal,
    12,
  );
  expect(after.relationships.map((item) => item.target)).toEqual(before.relationships.map((item) => item.target));
  for (const originalEdge of before.relationships) {
    const nextEdge = edge(after, originalEdge.target);
    const reversals = expectAppendOnly(originalEdge.history, nextEdge.history);
    for (const change of reversals) {
      expectBounded(change.before, minimum(change.field));
      expectBounded(change.after, minimum(change.field));
      expect(change.delta).toBeCloseTo(change.after - change.before, 12);
      expect(change.reason.trim().length).toBeGreaterThan(0);
    }
    for (const field of RELATIONSHIP_FIELDS) {
      expectBounded(nextEdge[field], minimum(field));
      expect(
        reversals
          .filter((change) => change.field === field)
          .reduce((sum, change) => sum + change.after - change.before, 0),
      ).toBeCloseTo(nextEdge[field] - originalEdge[field], 12);
    }
  }
  const snapshot = structuredClone(after);
  freeze(after);
  expect(revertAffectForTurn(after, TURN)).toBe(after);
  for (const original of before.affect.history.filter((change) => change.turnId === TURN)) {
    expect(revertAffectChange(after, original.id, { at: AT })).toBe(after);
  }
  for (const originalEdge of before.relationships) {
    for (const original of originalEdge.history.filter((change) => change.turnId === TURN)) {
      expect(revertAffectChange(after, original.id, { at: AT })).toBe(after);
    }
  }
  expect(after).toEqual(snapshot);
}

function revertTurn(input: CharacterInstance): CharacterInstance {
  const snapshot = structuredClone(input);
  const reverted = revertAffectForTurn(freeze(input), TURN);
  expect(input).toEqual(snapshot);
  expectTurnAudit(input, reverted);
  return reverted;
}

const orders = ['forward', 'reverse', 'shuffled'] as const;
type Order = (typeof orders)[number];
function reorder<T>(items: readonly T[], order: Order): T[] {
  if (order === 'reverse') return [...items].reverse();
  if (order === 'shuffled')
    return [...items.filter((_, index) => index % 2 === 1), ...items.filter((_, index) => index % 2 === 0)];
  return [...items];
}

function mixedAffect(order: Order = 'forward'): CharacterInstance {
  const input = actor();
  input.affect = {
    ...input.affect,
    valence: 1,
    arousal: 0,
    history: reorder(
      [
        affectChange('affect-positive', 0.7, 1, 0, 0.3),
        affectChange('affect-negative', 1, 0.9, 0.3, 0.2),
        affectChange('affect-other-turn', 0.9, 1, 0.2, 0, { turnId: OTHER_TURN }),
      ],
      order,
    ),
  };
  return input;
}

function mixedRelationships(order: Order = 'forward'): CharacterInstance {
  const input = actor();
  const player = relationship();
  const other = relationship(OTHER_TARGET);
  for (const field of RELATIONSHIP_FIELDS) {
    const min = minimum(field);
    player[field] = 1;
    player.history.push(
      relationshipChange(`player:${field}:positive`, field, 0.7, 1),
      relationshipChange(`player:${field}:negative`, field, 1, 0.9),
      relationshipChange(`player:${field}:keep`, field, 0.9, 1, { turnId: OTHER_TURN }),
    );
    other[field] = min;
    other.history.push(
      relationshipChange(`other:${field}:positive`, field, min + 0.3, min + 0.4),
      relationshipChange(`other:${field}:negative`, field, min + 0.4, min + 0.1),
      relationshipChange(`other:${field}:keep`, field, min + 0.1, min, { turnId: OTHER_TURN }),
    );
  }
  player.history = reorder(player.history, order);
  other.history = reorder(other.history, order);
  const untouched = relationship(UNTOUCHED_TARGET);
  untouched.trust = 0.4;
  untouched.history = [relationshipChange('untouched', 'trust', 0.1, 0.4, { turnId: OTHER_TURN })];
  input.relationships = [player, other, untouched];
  return input;
}

const saturationCases = [
  { name: 'upper', valence: 0.98, arousal: 0.98, delta: 0.3, afterValence: 1, afterArousal: 1 },
  { name: 'lower', valence: -0.98, arousal: 0.02, delta: -0.3, afterValence: -1, afterArousal: 0 },
];

describe('A04：夹紧后的实际变化与单条撤销', () => {
  it.each(saturationCases)('apply 情绪 $name 饱和时记录 after-before 而非请求 delta', (testCase) => {
    const input = actor();
    input.affect.valence = testCase.valence;
    input.affect.arousal = testCase.arousal;
    const next = applyAffectUpdate(
      freeze(input),
      update({ deltaValence: testCase.delta, deltaArousal: testCase.delta }),
      meta,
    );
    expect(next.affect.valence).toBe(testCase.afterValence);
    expect(next.affect.arousal).toBe(testCase.afterArousal);
    const applied = next.affect.history.at(-1);
    expect(applied).toBeDefined();
    if (!applied) throw new Error('Missing applied affect history');
    expect(applied.afterValence).toBe(next.affect.valence);
    expect(applied.afterArousal).toBe(next.affect.arousal);
    for (const change of next.affect.history) {
      expect(change.deltaValence).toBeCloseTo(change.afterValence - change.beforeValence, 12);
      expect(change.deltaArousal).toBeCloseTo(change.afterArousal - change.beforeArousal, 12);
    }
    const reverted = revertAffectChange(freeze(next), applied.id, { at: AT });
    expect(reverted.affect.valence).toBeCloseTo(applied.beforeValence, 12);
    expect(reverted.affect.arousal).toBeCloseTo(applied.beforeArousal, 12);
    expect(reverted.affect.history.slice(0, next.affect.history.length)).toEqual(next.affect.history);
    expect(revertAffectChange(reverted, applied.id, { at: AT })).toBe(reverted);
  });

  const relationshipSaturationCases = RELATIONSHIP_FIELDS.flatMap((field) =>
    ['upper', 'lower'].map((bound) => ({ field, bound })),
  );
  it.each(relationshipSaturationCases)('apply $field 在 $bound 边界饱和，包括已饱和的零变化', ({ field, bound }) => {
    const input = actor();
    const upper = bound === 'upper';
    const limit = upper ? 1 : minimum(field);
    const start = limit + (upper ? -0.02 : 0.02);
    edge(input)[field] = start;
    const change = { field, delta: upper ? 0.3 : -0.3 };
    const next = applyAffectUpdate(freeze(input), update({ relationship: [change, change] }), meta);
    expect(edge(next)[field]).toBe(limit);
    const [first, second] = edge(next).history;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error('Missing relationship history');
    expect(first.before).toBe(start);
    expect(first.after).toBe(limit);
    expect(first.delta).toBeCloseTo(limit - start, 12);
    expect(second.before).toBe(limit);
    expect(second.after).toBe(limit);
    expect(second.delta).toBe(0);
    const reverted = revertAffectChange(freeze(next), first.id, { at: AT });
    expect(edge(reverted)[field]).toBeCloseTo(start, 12);
    expect(edge(reverted).history.at(-1)?.reversionOf).toBe(first.id);
    expect(revertAffectChange(reverted, first.id, { at: AT })).toBe(reverted);
  });

  it.each([1, -1])('旧情绪 delta 故意不一致（方向 %i），单条只抵消 before/after', (direction) => {
    const input = actor();
    const original = affectChange('legacy-affect', 0.95, 0.95 + direction * 0.04, 0.05, 0.05 + direction * 0.04, {
      deltaValence: direction * 0.3,
      deltaArousal: direction * 0.3,
    });
    input.affect = { ...input.affect, valence: 0.4, arousal: 0.4, history: [original] };
    const reverted = revertAffectChange(freeze(input), original.id, { at: AT });
    expect(reverted.affect.valence).toBeCloseTo(0.4 - direction * 0.04, 12);
    expect(reverted.affect.arousal).toBeCloseTo(0.4 - direction * 0.04, 12);
    expectTurnAudit(input, reverted);
  });

  it.each(RELATIONSHIP_FIELDS)('旧关系 %s 的 delta 不可信，单条撤销保留之后的独立影响', (field) => {
    const input = actor();
    const original = relationshipChange(`legacy:${field}`, field, 0.95, 1, { delta: 0.3 });
    edge(input)[field] = 0.6;
    edge(input).history = [original, relationshipChange(`later:${field}`, field, 1, 0.6, { turnId: OTHER_TURN })];
    const reverted = revertAffectChange(freeze(input), original.id, { at: AT });
    expect(edge(reverted)[field]).toBeCloseTo(0.55, 12);
    expectTurnAudit(input, reverted);
  });

  it.each(['upper', 'lower'])('单条撤销自身在 %s 夹紧，补偿历史记录实际值且不二次写入', (bound) => {
    const input = actor();
    const upper = bound === 'upper';
    input.affect = {
      ...input.affect,
      valence: upper ? 0.95 : -0.95,
      arousal: upper ? 0.95 : 0.05,
      history: [affectChange('single-clamp', 0.5, upper ? 0.2 : 0.8, 0.5, upper ? 0.2 : 0.8)],
    };
    const reverted = revertAffectChange(freeze(input), 'single-clamp', { at: AT });
    expect(reverted.affect.valence).toBe(upper ? 1 : -1);
    expect(reverted.affect.arousal).toBe(upper ? 1 : 0);
    expectTurnAudit(input, reverted);
  });
});

describe('A05：整轮实际净变化只夹紧一次，追加补偿且可重复重抽', () => {
  it.each(orders)('同时间戳情绪正负混合，%s 历史均得到同一净值并保留其他回合', (order) => {
    const reverted = revertTurn(mixedAffect(order));
    expect(reverted.affect.valence).toBeCloseTo(0.8, 12);
    // 当前 arousal 已被其他回合降至 0；整批 -0.2 只夹紧一次，不留下逐条夹紧产生的 +0.1。
    expect(reverted.affect.arousal).toBe(0);
  });

  it.each(orders)('多目标五字段分别合计，%s 同时间戳历史不串目标或字段', (order) => {
    const input = mixedRelationships(order);
    const reverted = revertTurn(input);
    for (const field of RELATIONSHIP_FIELDS) {
      expect(edge(reverted)[field]).toBeCloseTo(0.8, 12);
      expect(edge(reverted, OTHER_TARGET)[field]).toBeCloseTo(minimum(field) + 0.2, 12);
    }
    expect(edge(reverted, UNTOUCHED_TARGET)).toEqual(edge(input, UNTOUCHED_TARGET));
    expect(reverted.affect).toEqual(input.affect);
  });

  it.each(saturationCases)('同轮自然衰减 + $name 饱和增量必须完整抵消，无残留漂移', (testCase) => {
    const input = actor();
    input.affect.valence = testCase.valence;
    input.affect.arousal = testCase.arousal;
    const applied = applyAffectUpdate(
      freeze(input),
      update({ deltaValence: testCase.delta, deltaArousal: testCase.delta }),
      meta,
    );
    expect(applied.affect.history).toHaveLength(2);
    expect(applied.affect.history.every((change) => change.turnId === TURN)).toBe(true);
    const reverted = revertTurn(applied);
    expect(reverted.affect.valence).toBeCloseTo(input.affect.valence, 12);
    expect(reverted.affect.arousal).toBeCloseTo(input.affect.arousal, 12);
  });

  it('已有单条撤销后整轮仅撤剩余；同 turnId 的补偿记录也不能作为原始影响再撤', () => {
    const input = mixedAffect();
    input.relationships = mixedRelationships().relationships;
    let partiallyReverted = revertAffectChange(freeze(input), 'affect-negative', meta);
    partiallyReverted = revertAffectChange(freeze(partiallyReverted), 'player:trust:negative', meta);
    partiallyReverted = revertAffectChange(freeze(partiallyReverted), 'other:fear:positive', meta);
    const reverted = revertTurn(partiallyReverted);
    expect(reverted.affect.valence).toBeCloseTo(0.7, 12);
    expect(reverted.affect.arousal).toBe(0);
    for (const field of RELATIONSHIP_FIELDS) {
      expect(edge(reverted)[field]).toBeCloseTo(field === 'trust' ? 0.7 : 0.8, 12);
      expect(edge(reverted, OTHER_TARGET)[field]).toBeCloseTo(minimum(field) + (field === 'fear' ? 0.3 : 0.2), 12);
    }
  });

  it('整轮合计仍以原始 before/after 为准，不受旧 delta 错误放大或错向影响', () => {
    const input = actor();
    input.affect = {
      ...input.affect,
      valence: 0.4,
      arousal: 0.4,
      history: [
        affectChange('legacy-batch-1', 0.95, 1, 0.95, 1, { deltaValence: 0.3, deltaArousal: -0.3 }),
        affectChange('legacy-batch-2', 1, 0.98, 1, 0.98, { deltaValence: 0.3, deltaArousal: -0.3 }),
      ],
    };
    for (const field of RELATIONSHIP_FIELDS) {
      edge(input)[field] = 0.4;
      edge(input).history.push(
        relationshipChange(`legacy-batch:${field}:1`, field, 0.95, 1, { delta: 0.3 }),
        relationshipChange(`legacy-batch:${field}:2`, field, 1, 0.98, { delta: 0.3 }),
      );
    }
    const reverted = revertTurn(input);
    expect(reverted.affect.valence).toBeCloseTo(0.37, 12);
    expect(reverted.affect.arousal).toBeCloseTo(0.37, 12);
    for (const field of RELATIONSHIP_FIELDS) expect(edge(reverted)[field]).toBeCloseTo(0.37, 12);
  });

  it.each(['upper', 'lower'])('批量补偿抵达 %s 边界时，状态及所有新增 before/after 始终合法', (bound) => {
    const input = actor();
    const upper = bound === 'upper';
    const direction = upper ? -1 : 1;
    input.affect = {
      ...input.affect,
      valence: upper ? 0.95 : -0.95,
      arousal: upper ? 0.95 : 0.05,
      history: [
        affectChange('clamp-1', 0.5, 0.5 + direction * 0.2, 0.5, 0.5 + direction * 0.2),
        affectChange(
          'clamp-2',
          0.5 + direction * 0.2,
          0.5 + direction * 0.3,
          0.5 + direction * 0.2,
          0.5 + direction * 0.3,
        ),
      ],
    };
    for (const field of RELATIONSHIP_FIELDS) {
      edge(input)[field] = upper ? 0.95 : minimum(field) + 0.05;
      edge(input).history.push(
        relationshipChange(`clamp:${field}:1`, field, 0.5, 0.5 + direction * 0.2),
        relationshipChange(`clamp:${field}:2`, field, 0.5 + direction * 0.2, 0.5 + direction * 0.3),
      );
    }
    const reverted = revertTurn(input);
    expect(reverted.affect.valence).toBe(upper ? 1 : -1);
    expect(reverted.affect.arousal).toBe(upper ? 1 : 0);
    for (const field of RELATIONSHIP_FIELDS) expect(edge(reverted)[field]).toBe(upper ? 1 : minimum(field));
  });

  it('同回合反复重抽二十次不漂移，旧补偿不重撤，每个新原 id 只有一条补偿', () => {
    const initial = actor();
    initial.affect.valence = 0.98;
    initial.affect.arousal = 0.98;
    for (const field of RELATIONSHIP_FIELDS) edge(initial)[field] = 0.98;
    let current = initial;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const delta = attempt % 2 === 0 ? 0.3 : -0.3;
      const applied = applyAffectUpdate(
        freeze(current),
        update({
          deltaValence: delta,
          deltaArousal: delta,
          relationship: RELATIONSHIP_FIELDS.map((field) => ({ field, delta })),
        }),
        meta,
      );
      current = revertTurn(applied);
      expect(current.affect.valence).toBeCloseTo(initial.affect.valence, 12);
      expect(current.affect.arousal).toBeCloseTo(initial.affect.arousal, 12);
      for (const field of RELATIONSHIP_FIELDS) expect(edge(current)[field]).toBeCloseTo(edge(initial)[field], 12);
      expect(current.affect.history).toHaveLength((attempt + 1) * 4);
      expect(edge(current).history).toHaveLength((attempt + 1) * RELATIONSHIP_FIELDS.length * 2);
    }
  });

  it('没有该回合原始记录时返回同一对象且不写入任何历史', () => {
    const input = mixedAffect();
    input.relationships = mixedRelationships().relationships;
    const snapshot = structuredClone(input);
    expect(revertAffectForTurn(freeze(input), 'unknown-turn')).toBe(input);
    expect(input).toEqual(snapshot);
  });
});
