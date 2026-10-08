import { describe, expect, it } from 'vitest';
import { revertTurnWrites } from '../../../../apps/web/src/lib/turn-write.js';
import { createBlankCard } from '../model/card.js';
import { createPersona } from '../model/persona.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createWorldFromCard } from '../session/setup.js';
import { COLLECTIONS, Repository } from '../storage/repository.js';
import { applyAffectUpdate } from './affect.js';
import { readAnalysisGeneration } from './analysis-revision.js';

async function fixture() {
  const store = createMemoryEntityStore();
  const repository = new Repository(store);
  const world = createWorldFromCard(
    createBlankCard({ name: 'fixture-observer' }),
    createPersona({ name: 'fixture-player' }),
  );
  const initial = {
    ...world.instance,
    affect: { ...world.instance.affect, valence: 0.95, arousal: 0.9 },
    relationships: world.instance.relationships.map((edge) => ({ ...edge, trust: 0.95 })),
  };
  const meta = { at: '2026-10-08T00:00:00.000Z', turnId: 'fixture-turn' };
  let changed = applyAffectUpdate(
    initial,
    {
      observer: initial.displayName,
      deltaValence: 0.3,
      deltaArousal: 0.3,
      reason: 'fixture-positive',
      relationship: [{ field: 'trust', delta: 0.3 }],
    },
    meta,
  );
  changed = applyAffectUpdate(
    changed,
    {
      observer: initial.displayName,
      deltaValence: -0.3,
      deltaArousal: 0.3,
      reason: 'fixture-negative',
      relationship: [{ field: 'trust', delta: -0.3 }],
    },
    meta,
  );
  await repository.saveInstance(changed);
  await store.put(COLLECTIONS.memories, {
    id: 'fixture-memory',
    roomId: world.room.id,
    sourceTurnIds: [meta.turnId],
    summary: 'fixture',
    createdAt: meta.at,
    updatedAt: meta.at,
    deletedAt: null,
  });
  return { store, repository, world, initial, meta };
}

describe('顺序117：生产整轮撤销入口', () => {
  it('饱和夹紧/衰减/正负变化由真实turn-write入口撤销，并在同一事务作废分析世代', async () => {
    const f = await fixture();
    const beforeGeneration = await readAnalysisGeneration(f.repository, f.world.room.id, f.meta.turnId);
    const result = await revertTurnWrites(f.store, f.world.room.id, f.meta.turnId);
    const restored = (await f.repository.listInstances(f.world.room.id))[0];
    expect(result.removedMemories).toBe(1);
    expect(restored?.affect.valence).toBeCloseTo(f.initial.affect.valence, 12);
    expect(restored?.affect.arousal).toBeCloseTo(f.initial.affect.arousal, 12);
    expect(restored?.relationships[0]?.trust).toBeCloseTo(f.initial.relationships[0]?.trust ?? 0, 12);
    expect(await readAnalysisGeneration(f.repository, f.world.room.id, f.meta.turnId)).not.toBe(beforeGeneration);
    expect(await f.repository.listMemories(f.world.room.id)).toEqual([]);
    expect((await revertTurnWrites(f.store, f.world.room.id, f.meta.turnId)).revertedInstances).toEqual([]);
  });
  it('坏before/after不会猜请求delta；记忆删除和世代更新随事务一起回滚', async () => {
    const f = await fixture();
    const current = (await f.repository.listInstances(f.world.room.id))[0];
    if (!current) throw new Error('missing fixture');
    await f.repository.saveInstance({
      ...current,
      affect: {
        ...current.affect,
        history: current.affect.history.map((change, index) =>
          index === 0 ? { ...change, beforeValence: Number.NaN } : change,
        ),
      },
    });
    const before = await f.repository.listInstances(f.world.room.id);
    const generation = await readAnalysisGeneration(f.repository, f.world.room.id, f.meta.turnId);
    await expect(revertTurnWrites(f.store, f.world.room.id, f.meta.turnId)).rejects.toThrow('before/after');
    expect(await f.repository.listInstances(f.world.room.id)).toEqual(before);
    expect(await f.repository.listMemories(f.world.room.id)).toHaveLength(1);
    expect(await readAnalysisGeneration(f.repository, f.world.room.id, f.meta.turnId)).toBe(generation);
  });
});
