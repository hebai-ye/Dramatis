import { describe, expect, it } from 'vitest';
import { cardId, instanceId, newId, nowIso, PLAYER, roomId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import {
  AFFECT_DECAY_PER_TURN,
  type AffectUpdate,
  applyAffectUpdate,
  applyAffectUpdates,
  decayAffect,
  MAX_DELTA_PER_TURN,
  parseAffectUpdates,
  revertAffectForTurn,
} from './affect.js';

function actor(name: string): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: cardId(newId()),
    displayName: name,
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [
      { target: PLAYER, trust: 0, affinity: 0, fear: 0, respect: 0, tension: 0, updatedAt: now, history: [] },
    ],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

const meta = { at: '2026-01-01T00:00:00.000Z', turnId: 'turn-1' };

function update(overrides: Partial<AffectUpdate> = {}): AffectUpdate {
  return {
    observer: 'Alice',
    deltaValence: 0.1,
    deltaArousal: 0.05,
    reason: '对方说了句好话',
    relationship: [],
    ...overrides,
  };
}

describe('parseAffectUpdates', () => {
  it('解析完整结果', () => {
    const raw = JSON.stringify({
      updates: [
        {
          observer: 'Alice',
          deltaValence: -0.2,
          deltaArousal: 0.15,
          reason: '被问到了不愿提的事',
          relationship: [{ field: 'trust', delta: -0.1 }],
        },
      ],
    });

    const parsed = parseAffectUpdates(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.observer).toBe('Alice');
    expect(parsed[0]?.relationship).toEqual([{ field: 'trust', delta: -0.1 }]);
  });

  it('没有情绪的回合返回空数组，而不是抛错', () => {
    expect(parseAffectUpdates('{"updates":[]}')).toEqual([]);
    expect(parseAffectUpdates('{}')).toEqual([]);
  });

  it('超出上限的变化量被夹到上限', () => {
    const parsed = parseAffectUpdates('{"updates":[{"observer":"A","deltaValence":5}]}');
    expect(parsed[0]?.deltaValence).toBe(MAX_DELTA_PER_TURN);
  });

  it('丢弃不认识的维度', () => {
    const raw =
      '{"updates":[{"observer":"A","relationship":[{"field":"crush","delta":0.5},{"field":"trust","delta":0.1}]}]}';
    expect(parseAffectUpdates(raw)[0]?.relationship).toEqual([{ field: 'trust', delta: 0.1 }]);
  });

  it('丢掉没有名字的条目', () => {
    expect(parseAffectUpdates('{"updates":[{"deltaValence":0.5}]}')).toEqual([]);
  });

  it('容忍模型加代码块', () => {
    const raw = '好的：\n```json\n{"updates":[{"observer":"Bob","deltaValence":0.2}]}\n```';
    expect(parseAffectUpdates(raw)).toHaveLength(1);
  });
});

describe('decayAffect', () => {
  it('情绪向中性回归', () => {
    const alice = actor('Alice');
    const happy: CharacterInstance = { ...alice, affect: { ...alice.affect, valence: 0.8, arousal: 0.6 } };

    const decayed = decayAffect(happy, meta);

    expect(decayed.affect.valence).toBeCloseTo(0.8 * (1 - AFFECT_DECAY_PER_TURN), 6);
    expect(decayed.affect.arousal).toBeLessThan(0.6);
  });

  it('负向情绪同样向中性回归', () => {
    const alice = actor('Alice');
    const sad: CharacterInstance = { ...alice, affect: { ...alice.affect, valence: -0.8 } };
    expect(decayAffect(sad, meta).affect.valence).toBeGreaterThan(-0.8);
  });
});

describe('applyAffectUpdate', () => {
  it('先褪色再叠加，并记录变化理由', () => {
    const alice = actor('Alice');
    const next = applyAffectUpdate(alice, update({ deltaValence: 0.2 }), meta);

    expect(next.affect.valence).toBeCloseTo(0.2, 6);
    expect(next.affect.history).toHaveLength(1);
    expect(next.affect.history[0]?.reason).toBe('对方说了句好话');
  });

  it('关系维度按方向夹紧', () => {
    const alice = actor('Alice');
    let next = alice;

    for (let index = 0; index < 20; index += 1) {
      next = applyAffectUpdate(next, update({ relationship: [{ field: 'affinity', delta: 0.3 }] }), meta);
    }
    expect(next.relationships[0]?.affinity).toBe(1);

    for (let index = 0; index < 20; index += 1) {
      next = applyAffectUpdate(next, update({ relationship: [{ field: 'tension', delta: -0.3 }] }), meta);
    }
    expect(next.relationships[0]?.tension).toBe(0);
  });

  it('情绪值域始终在 -1 到 1、0 到 1 之内', () => {
    let alice = actor('Alice');
    for (let index = 0; index < 30; index += 1) {
      alice = applyAffectUpdate(alice, update({ deltaValence: 0.3, deltaArousal: 0.3 }), meta);
    }
    expect(alice.affect.valence).toBeLessThanOrEqual(1);
    expect(alice.affect.arousal).toBeLessThanOrEqual(1);
  });

  it('单轮上限让一句话无法翻转关系', () => {
    const alice = actor('Alice');
    const next = applyAffectUpdate(
      alice,
      update({ relationship: [{ field: 'affinity', delta: MAX_DELTA_PER_TURN }] }),
      meta,
    );
    expect(next.relationships[0]?.affinity).toBeLessThanOrEqual(MAX_DELTA_PER_TURN);
  });

  it('没有变化时不写历史', () => {
    const alice = actor('Alice');
    const next = applyAffectUpdate(alice, update({ deltaValence: 0, deltaArousal: 0 }), meta);
    expect(next.affect.history).toHaveLength(0);
  });

  it('抗漂移：反复触动后停止，情绪会退回中性', () => {
    let alice = actor('Alice');
    for (let index = 0; index < 10; index += 1) {
      alice = applyAffectUpdate(alice, update({ deltaValence: 0.3 }), meta);
    }
    const peak = alice.affect.valence;
    expect(peak).toBeGreaterThan(0.5);

    // 之后不再有任何情绪事件
    for (let index = 0; index < 40; index += 1) {
      alice = decayAffect(alice, meta);
    }

    expect(alice.affect.valence).toBeLessThan(peak * 0.1);
  });
});

describe('applyAffectUpdates', () => {
  it('按名字匹配到角色并应用', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');

    const result = applyAffectUpdates([alice, bob], [update({ observer: 'alice', deltaValence: 0.2 })], meta);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.instanceId).toBe(alice.id);
    expect(result.unmatched).toEqual([]);
  });

  it('匹配不到的名字被记录下来', () => {
    const result = applyAffectUpdates([actor('Alice')], [update({ observer: 'Carol' })], meta);
    expect(result.unmatched).toEqual(['Carol']);
  });
});

describe('revertAffectForTurn', () => {
  it('撤销该回合的情绪与关系变化', () => {
    const alice = actor('Alice');
    const applied = applyAffectUpdate(
      alice,
      update({ deltaValence: 0.2, relationship: [{ field: 'affinity', delta: 0.15 }] }),
      meta,
    );

    const reverted = revertAffectForTurn(applied, meta.turnId);

    expect(reverted.affect.valence).toBeCloseTo(0, 6);
    expect(reverted.relationships[0]?.affinity).toBeCloseTo(0, 6);
    expect(reverted.affect.history).toHaveLength(0);
    expect(reverted.relationships[0]?.history).toHaveLength(0);
  });

  it('只撤掉指定回合，其它回合的变化保留', () => {
    const alice = actor('Alice');
    const first = applyAffectUpdate(alice, update({ deltaValence: 0.2 }), meta);
    const second = applyAffectUpdate(first, update({ deltaValence: 0.2 }), { at: meta.at, turnId: 'turn-2' });

    const reverted = revertAffectForTurn(second, 'turn-2');

    expect(reverted.affect.history).toHaveLength(1);
    expect(reverted.affect.history[0]?.turnId).toBe('turn-1');
    expect(reverted.affect.valence).toBeCloseTo(first.affect.valence, 6);
  });

  it('没有该回合记录时原样返回', () => {
    const alice = actor('Alice');
    expect(revertAffectForTurn(alice, 'turn-unknown')).toBe(alice);
  });

  it('反复重抽不会把关系越叠越高', () => {
    const alice = actor('Alice');
    let current = alice;

    for (let index = 0; index < 5; index += 1) {
      current = revertAffectForTurn(
        applyAffectUpdate(current, update({ relationship: [{ field: 'affinity', delta: 0.3 }] }), meta),
        meta.turnId,
      );
    }

    expect(current.relationships[0]?.affinity).toBeCloseTo(0, 6);
  });
});
