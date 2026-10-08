import { describe, expect, it } from 'vitest';
import { conversationId, roomId } from '../model/ids.js';
import type { Room } from '../model/room.js';
import type { EntityStore } from '../platform/entity-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import type { BudgetLimits } from './budget.js';
import { budgetWriteVersion, saveRoomBudget } from './budget-write.js';
import { COLLECTIONS, Repository } from './repository.js';

// Synthetic, in-memory fixtures only: no user database, browser storage, or aggregation values.
const A = roomId('budget-write-a');
const B = roomId('budget-write-b');
const BASE: BudgetLimits = { maxExtraCalls: 5, maxCost: 2 };
const NEXT: BudgetLimits = { maxExtraCalls: 10, maxCostByCurrency: { CNY: 3, USD: 4 } };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function room(id = A, budget: BudgetLimits | null = BASE): Room {
  return {
    id,
    title: `World ${id}`,
    personaId: null,
    playerName: 'Player',
    playerPersona: '',
    cardIds: [],
    instanceIds: [],
    worldBookIds: [],
    activeConversationId: conversationId('initial-conversation'),
    budget: structuredClone(budget),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  };
}
async function setup() {
  const store = createMemoryEntityStore();
  const repository = new Repository(store);
  await repository.saveRoom(room());
  await repository.saveRoom(room(B));
  return { store, repository };
}
function input(limits: BudgetLimits | null = NEXT) {
  return { roomId: A, expectedVersion: budgetWriteVersion(BASE), limits };
}
function delayedRepository(store: EntityStore) {
  const started = gate();
  const release = gate();
  const transaction = store.transaction?.bind(store);
  if (!transaction) throw new Error('fixture needs transactions');
  const delayed: EntityStore = {
    ...store,
    async transaction<T>(run: (scope: EntityStore) => Promise<T>): Promise<T> {
      started.release();
      await release.promise;
      return transaction(run);
    },
  };
  return { repository: new Repository(delayed), started, release };
}

describe('budgetWriteVersion exact CAS identity', () => {
  it('ignores object key order recursively, without changing the supplied budget', () => {
    const left = { maxExtraCalls: 5, maxCost: 2, maxCostByCurrency: { USD: 4, CNY: 3 } };
    const right = { maxCostByCurrency: { CNY: 3, USD: 4 }, maxCost: 2, maxExtraCalls: 5 };
    const before = structuredClone(left);
    expect(budgetWriteVersion(left)).toBe(budgetWriteVersion(right));
    expect(left).toEqual(before);
  });
  it.each([
    [{ maxExtraCalls: 5 }, { maxExtraCalls: '5' }],
    [{ maxCost: null }, { maxCost: undefined }],
    [{}, { maxCost: undefined }],
    [{ maxExtraCalls: false }, { maxExtraCalls: 'false' }],
    [{ maxCost: Number.NaN }, { maxCost: 'NaN' }],
    [{ maxCostByCurrency: { USD: 4 } }, { maxCostByCurrency: { USD: '4' } }],
    [{ maxCostByCurrency: null }, { maxCostByCurrency: {} }],
    [{ maxCost: 2 }, { maxCost: 2, maxCostByCurrency: null }],
    [{ maxCostByCurrency: { CNY: 3 } }, { maxCostByCurrency: { 'CNY ': 3 } }],
    [{ maxCostByCurrency: [] }, { maxCostByCurrency: {} }],
  ])('does not conflate distinguishable stored snapshots: %j versus %j', (left, right) => {
    expect(budgetWriteVersion(left as BudgetLimits)).not.toBe(budgetWriteVersion(right as BudgetLimits));
  });
  it('treats a missing top-level budget as the same no-budget state as null', () => {
    expect(budgetWriteVersion(undefined)).toBe(budgetWriteVersion(null));
    expect(budgetWriteVersion({})).not.toBe(budgetWriteVersion(null));
  });
});

describe('saveRoomBudget transaction and compare-and-swap', () => {
  it('patches budget only, preserving fields changed before the transaction starts', async () => {
    const h = await setup();
    const delayed = delayedRepository(h.store);
    const pending = saveRoomBudget(delayed.repository, input());
    await delayed.started.promise;
    const original = await h.repository.getRoom(A);
    if (!original) throw new Error('missing fixture room');
    const newer = {
      ...original,
      title: 'Newer title',
      playerName: 'Newer player',
      activeConversationId: conversationId('new-conversation'),
    };
    await h.repository.saveRoom(newer);
    delayed.release.release();
    const saved = await pending;
    const stored = await h.repository.getRoom(A);
    expect(saved).toEqual(stored);
    expect(saved).toMatchObject({ ...newer, updatedAt: saved.updatedAt, budget: NEXT });
    expect((await h.repository.getRoom(B))?.budget).toEqual(BASE);
  });

  it('serializes two different targets from one base so the loser cannot overwrite the winner', async () => {
    const h = await setup();
    const transaction = h.store.transaction?.bind(h.store);
    if (!transaction) throw new Error('fixture needs transactions');
    const started = gate();
    const release = gate();
    let first = true;
    const controlled: EntityStore = {
      ...h.store,
      async transaction<T>(run: (scope: EntityStore) => Promise<T>): Promise<T> {
        return transaction(async (scope) => {
          if (first) {
            first = false;
            started.release();
            await release.promise;
          }
          return run(scope);
        });
      },
    };
    const repository = new Repository(controlled);
    const one = saveRoomBudget(repository, input({ maxExtraCalls: 11 }));
    await started.promise;
    const two = saveRoomBudget(repository, input({ maxExtraCalls: 12 }));
    const settled = Promise.allSettled([one, two]);
    release.release();
    const [winner, loser] = await settled;
    expect(winner?.status).toBe('fulfilled');
    expect(loser).toMatchObject({ status: 'rejected', reason: { code: 'budget-conflict' } });
    expect((await h.repository.getRoom(A))?.budget).toEqual({ maxExtraCalls: 11 });
  });

  it('returns an already-persisted identical target idempotently even with the old base', async () => {
    const h = await setup();
    const saved = await saveRoomBudget(h.repository, input());
    const retry = await saveRoomBudget(
      h.repository,
      input({ maxCostByCurrency: { USD: 4, CNY: 3 }, maxExtraCalls: 10 }),
    );
    expect(retry).toEqual(saved);
    expect(await h.repository.getRoom(A)).toEqual(saved);
    const again = await Promise.all([saveRoomBudget(h.repository, input()), saveRoomBudget(h.repository, input())]);
    expect(again).toEqual([saved, saved]);
  });

  it('rejects a stale expected budget without changing any stored Room field', async () => {
    const h = await setup();
    const current = await h.repository.getRoom(A);
    if (!current) throw new Error('missing fixture');
    await h.repository.saveRoom({ ...current, budget: { maxExtraCalls: 30 } });
    const before = await h.repository.getRoom(A);
    await expect(saveRoomBudget(h.repository, input())).rejects.toMatchObject({ code: 'budget-conflict' });
    expect(await h.repository.getRoom(A)).toEqual(before);
  });

  it('does not accept a string-valued stored budget as a number-valued expected snapshot', async () => {
    const h = await setup();
    const malformed = room(A, { maxExtraCalls: '5' } as unknown as BudgetLimits);
    await h.store.put(COLLECTIONS.rooms, malformed);
    await expect(
      saveRoomBudget(h.repository, { ...input(), expectedVersion: budgetWriteVersion({ maxExtraCalls: 5 }) }),
    ).rejects.toMatchObject({ code: 'budget-conflict' });
    expect(await h.repository.getRoom(A)).toEqual(malformed);
  });

  it.each(['missing', 'deleted'] as const)('rejects a %s room even when the desired budget matches', async (kind) => {
    const h = await setup();
    if (kind === 'missing') await h.store.remove(COLLECTIONS.rooms, A);
    else await h.store.put(COLLECTIONS.rooms, { ...room(), deletedAt: '2026-01-02T00:00:00.000Z' });
    const before = await h.store.get(COLLECTIONS.rooms, A);
    await expect(saveRoomBudget(h.repository, input(BASE))).rejects.toMatchObject({ code: 'room-missing' });
    expect(await h.store.get(COLLECTIONS.rooms, A)).toEqual(before);
  });

  it.each(['before', 'after'] as const)(
    'leaves storage unchanged when the transaction fails %s its work',
    async (phase) => {
      const h = await setup();
      const before = await h.repository.getRoom(A);
      const transaction = h.store.transaction?.bind(h.store);
      if (!transaction) throw new Error('fixture needs transactions');
      const failure = new Error(`transaction failed ${phase}`);
      let wrote = false;
      const failing: EntityStore = {
        ...h.store,
        async transaction<T>(run: (scope: EntityStore) => Promise<T>): Promise<T> {
          return transaction(async (scope) => {
            if (phase === 'before') throw failure;
            await run(scope);
            wrote =
              budgetWriteVersion((await scope.get<Room>(COLLECTIONS.rooms, A))?.budget) === budgetWriteVersion(NEXT);
            throw failure;
          });
        },
      };
      await expect(saveRoomBudget(new Repository(failing), input())).rejects.toBe(failure);
      expect(wrote).toBe(phase === 'after');
      expect(await h.repository.getRoom(A)).toEqual(before);
      expect((await h.repository.getRoom(B))?.budget).toEqual(BASE);
    },
  );

  it('rolls back the real transaction when the post-write budget readback does not match the target', async () => {
    const h = await setup();
    const before = await h.repository.getRoom(A);
    const transaction = h.store.transaction?.bind(h.store);
    if (!transaction) throw new Error('fixture needs transactions');
    let wrote = false;
    let corruptedReadback = false;
    const faulty: EntityStore = {
      ...h.store,
      async transaction<T>(run: (scope: EntityStore) => Promise<T>): Promise<T> {
        return transaction(async (scope) =>
          run({
            ...scope,
            async put<TRecord extends { id: string }>(collection: string, value: TRecord): Promise<void> {
              await scope.put(collection, value);
              if (collection === COLLECTIONS.rooms && value.id === A) wrote = true;
            },
            async get<TValue>(collection: string, id: string): Promise<TValue | null> {
              const value = await scope.get<TValue>(collection, id);
              if (wrote && collection === COLLECTIONS.rooms && id === A && value !== null) {
                corruptedReadback = true;
                // Simulate a faulty adapter readback, not a second concurrent writer or a thrown test error.
                return { ...(value as unknown as Room), budget: BASE } as unknown as TValue;
              }
              return value;
            },
          }),
        );
      },
    };
    await expect(saveRoomBudget(new Repository(faulty), input())).rejects.toMatchObject({ code: 'budget-conflict' });
    expect(wrote).toBe(true);
    expect(corruptedReadback).toBe(true);
    expect(await h.repository.getRoom(A)).toEqual(before);
    expect((await h.repository.getRoom(B))?.budget).toEqual(BASE);
  });

  it('refuses a backend with no transaction capability instead of writing non-atomically', async () => {
    const h = await setup();
    const before = await h.repository.getRoom(A);
    const noTransaction = new Repository({ ...h.store, transaction: undefined });
    await expect(saveRoomBudget(noTransaction, input())).rejects.toThrow('事务');
    expect(await h.repository.getRoom(A)).toEqual(before);
  });

  it('isolates identical room IDs in different databases', async () => {
    const first = await setup();
    const second = await setup();
    const delayed = delayedRepository(first.store);
    const pending = saveRoomBudget(delayed.repository, input());
    await delayed.started.promise;
    await saveRoomBudget(second.repository, input({ maxExtraCalls: 77 }));
    delayed.release.release();
    expect((await pending).budget).toEqual(NEXT);
    expect((await first.repository.getRoom(A))?.budget).toEqual(NEXT);
    expect((await second.repository.getRoom(A))?.budget).toEqual({ maxExtraCalls: 77 });
  });

  it('captures room, expected version, and a deep copy of limits before awaiting the transaction', async () => {
    const h = await setup();
    const delayed = delayedRepository(h.store);
    const original: BudgetLimits = { maxExtraCalls: 10, maxCostByCurrency: { CNY: 3 } };
    const request = input(structuredClone(original));
    const pending = saveRoomBudget(delayed.repository, request);
    await delayed.started.promise;
    request.roomId = B;
    request.expectedVersion = 'mutated expected version';
    if (!request.limits?.maxCostByCurrency) throw new Error('fixture map missing');
    request.limits.maxExtraCalls = 999;
    request.limits.maxCostByCurrency.CNY = 999;
    request.limits = null;
    delayed.release.release();
    const saved = await pending;
    expect(saved.id).toBe(A);
    expect(saved.budget).toEqual(original);
    expect((await h.repository.getRoom(A))?.budget).toEqual(original);
    expect((await h.repository.getRoom(B))?.budget).toEqual(BASE);
  });
});

describe('budget write input validation and lossless labels', () => {
  const valid: { name: string; limits: BudgetLimits | null }[] = [
    { name: 'clear entire budget', limits: null },
    { name: 'empty object', limits: {} },
    { name: 'null scalar limits', limits: { maxExtraCalls: null, maxCost: null } },
    { name: 'legacy scalar', limits: { maxExtraCalls: 10, maxCost: 1.25 } },
    { name: 'explicit null currency policy', limits: { maxCost: 2, maxCostByCurrency: null } },
    { name: 'explicit empty currency policy', limits: { maxCost: 2, maxCostByCurrency: {} } },
    {
      name: 'multiple original display labels',
      limits: { maxCostByCurrency: { CNY: 3, 'CNY ': 4, $: 5, '¥': null, R$: 1.5, ' USD': 2 } },
    },
    { name: 'currency with no limit', limits: { maxCostByCurrency: { USD: null } } },
  ];
  it.each(valid)('saves $name without normalizing labels or silently migrating policy', async ({ limits }) => {
    const h = await setup();
    const saved = await saveRoomBudget(h.repository, input(limits));
    expect(saved.budget).toEqual(limits);
    expect((await h.repository.getRoom(A))?.budget).toEqual(limits);
  });
  const invalid: { name: string; value: unknown }[] = [
    { name: 'undefined next', value: undefined },
    { name: 'array', value: [] },
    { name: 'unknown budget field', value: { maxExtraCalls: 5, futurePolicy: true } },
    { name: 'zero calls', value: { maxExtraCalls: 0 } },
    { name: 'negative calls', value: { maxExtraCalls: -1 } },
    { name: 'fractional calls', value: { maxExtraCalls: 1.5 } },
    { name: 'unsafe integer calls', value: { maxExtraCalls: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'string calls', value: { maxExtraCalls: '5' } },
    { name: 'NaN amount', value: { maxCost: Number.NaN } },
    { name: 'infinite amount', value: { maxCost: Number.POSITIVE_INFINITY } },
    { name: 'zero amount', value: { maxCost: 0 } },
    { name: 'array map', value: { maxCostByCurrency: [] } },
    { name: 'zero currency amount', value: { maxCostByCurrency: { USD: 0 } } },
    { name: 'undefined currency amount', value: { maxCostByCurrency: { USD: undefined } } },
    { name: 'string currency amount', value: { maxCostByCurrency: { USD: '2' } } },
    { name: 'blank label', value: { maxCostByCurrency: { ' ': 2 } } },
    { name: 'control character label', value: { maxCostByCurrency: { 'USD\n': 2 } } },
    { name: 'reserved label', value: { maxCostByCurrency: { constructor: 2 } } },
  ];
  it.each(invalid)('rejects $name without touching storage', async ({ value }) => {
    const h = await setup();
    const before = await h.repository.getRoom(A);
    await expect(saveRoomBudget(h.repository, { ...input(), limits: value as BudgetLimits })).rejects.toMatchObject({
      code: 'invalid-budget',
    });
    expect(await h.repository.getRoom(A)).toEqual(before);
  });
  it('rejects unknown stored policy fields rather than dropping them in a budget overwrite', async () => {
    const h = await setup();
    const current = room(A, { maxExtraCalls: 5, futurePolicy: true } as BudgetLimits);
    await h.store.put(COLLECTIONS.rooms, current);
    await expect(
      saveRoomBudget(h.repository, { ...input(), expectedVersion: budgetWriteVersion(current.budget) }),
    ).rejects.toMatchObject({ code: 'invalid-budget' });
    expect(await h.repository.getRoom(A)).toEqual(current);
  });
});
