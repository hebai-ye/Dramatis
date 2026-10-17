import {
  type CharacterInstance,
  COLLECTIONS,
  createBackgroundRunner,
  createBlankCard,
  createConversation,
  createInstanceFor,
  createMemoryEntityStore,
  createSceneFor,
  createUsageLedger,
  type EntityStore,
  IMPORT_PENDING_KEY_PREFIX,
  Repository,
  type Room,
  roomId,
} from '@dramatis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSceneEffect } from './admin-scene-effect';
import type { DramatisDb } from './db';
import { useDatabase, useSession } from './session';
import { createTaskQueueExtras } from './task-queue';

// Dependency-aware hook host; real session/repository/memory transactions, no DOM or native IDB.
const host = vi.hoisted(() => {
  type Slot = { value: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  let slots: Slot[] = [];
  let cursor = 0;
  let pending: (() => void)[] = [];
  const writes: unknown[] = [];
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const state = (initial: unknown) => {
    const index = cursor++;
    slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    const cell = slots[index];
    if (!cell) throw new Error('missing hook cell');
    return [
      cell.value,
      (next: unknown) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next;
        writes.push(cell.value);
      },
    ];
  };
  const memo = <T>(run: () => T, deps?: readonly unknown[]): T => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index]?.deps, deps)) slots[index] = { value: run(), deps };
    return slots[index]?.value as T;
  };
  const effect = (run: () => (() => void) | undefined, deps?: readonly unknown[]) => {
    const index = cursor++;
    const previous = slots[index];
    if (previous && same(previous.deps, deps)) return;
    pending.push(() => {
      previous?.cleanup?.();
      slots[index] = { value: null, deps, cleanup: run() };
    });
  };
  return {
    writes,
    state,
    memo,
    effect,
    ref(initial: unknown) {
      return state(() => ({ current: initial }))[0];
    },
    callback: <T>(callback: T, deps?: readonly unknown[]) => memo(() => callback, deps),
    begin() {
      cursor = 0;
    },
    flush() {
      const effects = pending;
      pending = [];
      for (const run of effects) run();
    },
    unmount() {
      for (const slot of slots) slot.cleanup?.();
      slots = [];
      pending = [];
    },
    reset() {
      this.unmount();
      writes.length = 0;
    },
  };
});
const opened = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: host.ref,
  useMemo: host.memo,
  useCallback: host.callback,
  useEffect: host.effect,
  useLayoutEffect: host.effect,
}));
vi.mock('./db', () => ({
  openDramatisDb: async () => opened.db,
  pendingAccountDeletionCount: () => 0,
}));
beforeEach(() => host.reset());
afterEach(() => {
  host.unmount();
  vi.restoreAllMocks();
});

function render<T>(run: () => T): T {
  host.begin();
  const value = run();
  host.flush();
  return value;
}
async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const store = createMemoryEntityStore();
  const repository = new Repository(store);
  const id = roomId('feedback-world-a');
  const card = createBlankCard({ name: 'Synthetic' });
  const instance = createInstanceFor(card, id);
  const affected: CharacterInstance = {
    ...instance,
    affect: {
      ...instance.affect,
      valence: 0.3,
      arousal: 0.2,
      history: [
        {
          id: 'change-a',
          at: '2026-01-01T00:00:00.000Z',
          turnId: 'turn-a',
          beforeValence: 0,
          afterValence: 0.3,
          beforeArousal: 0,
          afterArousal: 0.2,
          deltaValence: 0.3,
          deltaArousal: 0.2,
          reason: 'Synthetic effect',
          sourceMemoryIds: [],
          reversionOf: null,
        },
      ],
    },
  };
  const room: Room = {
    id,
    title: 'Synthetic world',
    personaId: null,
    playerName: 'Player',
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [instance.id],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  };
  await repository.saveCard(card);
  await repository.saveInstance(affected);
  await repository.saveRoom(room);
  const db: DramatisDb = {
    backendKind: store.kind,
    store,
    repository,
    queue: createBackgroundRunner(store),
    ledger: createUsageLedger(store),
    tasks: createTaskQueueExtras(store),
  };
  return { db, repository, store, room, instance: affected };
}
async function sessionFixture() {
  const h = await fixture();
  const api = render(() => useSession(h.db));
  await drain();
  await api.openWorld(h.room.id);
  return { ...h, api: render(() => useSession(h.db)) };
}

it('管理员场景已写而主对话关联失败时返回分段证据', async () => {
  const h = await sessionFixture();
  const main = createConversation({ roomId: h.room.id, title: '主对话' });
  await h.repository.saveConversation(main);
  const currentRoom = await h.repository.getRoom(h.room.id);
  if (!currentRoom) throw new Error('missing room');
  await h.repository.saveRoom({ ...currentRoom, activeConversationId: main.id });
  await h.api.reloadWorld();
  const effects: AdminSceneEffect[] = [];
  vi.spyOn(h.repository, 'saveConversation').mockRejectedValueOnce(new Error('关联失败'));
  await expect(
    render(() => useSession(h.db)).setWorldScene({ location: '露台' }, main.id, h.room.id, (e) => effects.push(e)),
  ).rejects.toThrow('关联失败');
  expect(effects).toHaveLength(1);
  expect(effects[0]).toMatchObject({ sceneWritten: true, activeLinked: false, target: { conversationId: main.id } });
  const effect = effects[0];
  if (!effect) throw new Error('missing scene effect');
  expect(await h.repository.getScene(effect.target.sceneId)).not.toBeNull();
  expect((await h.repository.getConversation(main.id))?.activeSceneId).toBeNull();
});

it('管理员场景保存迟到不恢复旧对话快照', async () => {
  const h = await conversationSwitchFixture();
  const started = gate(),
    release = gate();
  const original = h.repository.saveScene.bind(h.repository);
  vi.spyOn(h.repository, 'saveScene').mockImplementation(async (scene) => {
    started.resolve();
    await release.promise;
    return original(scene);
  });
  const pending = h.api.setWorldScene({ location: '露台' }, h.a.id, h.room.id);
  await started.promise;
  await h.api.openConversation(h.b.id);
  release.resolve();
  await pending;
  expect(render(() => useSession(h.db)).conversation?.id).toBe(h.b.id);
  expect((await h.repository.getScene(h.sceneA.id))?.location).toBe('露台');
});
function delayAtomic(repository: Repository, after = false) {
  const original = repository.atomic.bind(repository);
  const started = gate(),
    release = gate();
  let first = true;
  vi.spyOn(repository, 'atomic').mockImplementation(
    async <T>(run: (scope: Repository, store: EntityStore) => Promise<T>) => {
      if (!first) return original(run);
      first = false;
      if (!after) {
        started.resolve();
        await release.promise;
      }
      const result = await original(run);
      if (after) {
        started.resolve();
        await release.promise;
      }
      return result;
    },
  );
  return { started, release };
}

describe('boot import recovery feedback', () => {
  it('exposes an always-present empty warning array on clean boot', async () => {
    opened.db = (await fixture()).db;
    render(useDatabase);
    await drain();
    expect(render(useDatabase).boot?.importRecoveryWarnings).toEqual([]);
  });
  it('preserves warnings when recovery clears a malformed marker without deleting a world', async () => {
    const h = await fixture();
    opened.db = h.db;
    await h.repository.setMeta(`${IMPORT_PENDING_KEY_PREFIX}broken`, '{');
    render(useDatabase);
    await drain();
    const boot = render(useDatabase).boot;
    expect(boot?.recoveredImports).toBe(0);
    expect(boot?.importRecoveryWarnings).toEqual([
      expect.objectContaining({ message: expect.stringContaining('未删除世界或素材') }),
    ]);
    expect(await h.repository.getRoom(h.room.id)).not.toBeNull();
  });
  it('exposes partial-deletion warnings even when no recovery counts as complete', async () => {
    const h = await fixture();
    opened.db = h.db;
    await h.repository.migrate();
    const migrated = await h.repository.getRoom(h.room.id);
    if (!migrated) throw new Error('migrated room missing');
    await h.repository.setMeta(`${IMPORT_PENDING_KEY_PREFIX}partial`, {
      roomId: h.room.id,
      cardIds: migrated.cardIds,
      worldBookIds: migrated.worldBookIds,
      personaId: migrated.personaId,
      startedAt: '2020-01-01T00:00:00.000Z',
    });
    vi.spyOn(h.repository, 'deleteCard').mockRejectedValue(new Error('Synthetic disk failure'));
    render(useDatabase);
    await drain();
    expect(render(useDatabase).boot?.importRecoveryWarnings).toEqual([
      expect.objectContaining({ message: expect.stringContaining('可能已有部分删除') }),
    ]);
  });
});

async function conversationSwitchFixture(initialPresence: 'onstage' | 'offscreen' = 'onstage') {
  const h = await fixture();
  const outsideCard = createBlankCard({ name: 'Outside' });
  const absentCard = createBlankCard({ name: 'Absent' });
  const outside = { ...createInstanceFor(outsideCard, h.room.id), presence: 'offscreen' as const };
  const absent = { ...createInstanceFor(absentCard, h.room.id), presence: 'absent' as const };
  const active = { ...h.instance, presence: initialPresence };
  const a = createConversation({ roomId: h.room.id, title: 'Main A' });
  const b = createConversation({ roomId: h.room.id, title: 'Main B' });
  const sceneA = createSceneFor(h.room.id, a.id, [active.id, absent.id], { title: 'Scene A' });
  const sceneB = createSceneFor(h.room.id, b.id, [], { title: 'Scene B' });
  const room = {
    ...h.room,
    activeConversationId: a.id,
    instanceIds: [active.id, outside.id, absent.id],
    cardIds: [active.cardId, outside.cardId, absent.cardId],
  };
  await h.repository.saveCard(outsideCard);
  await h.repository.saveCard(absentCard);
  await h.repository.saveSnapshot({
    room,
    conversations: [
      { ...a, activeSceneId: sceneA.id },
      { ...b, activeSceneId: sceneB.id },
    ],
    scenes: [sceneA, sceneB],
    instances: [active, outside, absent],
  });
  const api = render(() => useSession(h.db));
  await drain();
  await api.openWorld(room.id);
  return { ...h, room, a, b, sceneA, sceneB, active, outside, absent, api: render(() => useSession(h.db)) };
}

describe('conversation navigation preserves the complete instance snapshot', () => {
  it.each(['onstage', 'offscreen'] as const)(
    'keeps all instances across A with cast -> empty B -> A, initial presence=%s',
    async (initialPresence) => {
      const h = await conversationSwitchFixture(initialPresence);
      const before = h.api.instances;
      Object.freeze(before);
      for (const instance of before) Object.freeze(instance);
      const expectedB = { [h.active.id]: 'offscreen', [h.outside.id]: 'offscreen', [h.absent.id]: 'absent' };
      await h.api.openConversation(h.b.id);
      const inB = render(() => useSession(h.db));
      expect(inB.conversation?.id).toBe(h.b.id);
      expect(inB.scene?.cast).toEqual([]);
      expect(Object.fromEntries(inB.instances.map((instance) => [instance.id, instance.presence]))).toEqual(expectedB);
      expect(Object.fromEntries(before.map((instance) => [instance.id, instance.presence]))).toEqual({
        ...expectedB,
        [h.active.id]: initialPresence,
      });
      await inB.openConversation(h.a.id);
      const backInA = render(() => useSession(h.db));
      const expectedA = { ...expectedB, [h.active.id]: 'onstage' };
      expect(backInA.scene?.cast).toEqual([h.active.id, h.absent.id]);
      expect(Object.fromEntries(backInA.instances.map((instance) => [instance.id, instance.presence]))).toEqual(
        expectedA,
      );
      expect(backInA.instances.find((instance) => instance.id === h.active.id)?.affect.valence).toBe(0.3);
      expect(
        Object.fromEntries(
          (await h.repository.listInstances(h.room.id)).map((instance) => [instance.id, instance.presence]),
        ),
      ).toEqual(expectedA);
    },
  );

  it('merges presence into a newer snapshot without dropping its unrelated fields', async () => {
    const h = await conversationSwitchFixture();
    const delay = delayAtomic(h.repository, true);
    const pending = h.api.openConversation(h.b.id);
    await delay.started.promise;
    const persisted = await h.store.get<CharacterInstance>(COLLECTIONS.instances, h.active.id);
    if (!persisted) throw new Error('Target instance missing');
    await h.repository.saveInstance({
      ...persisted,
      displayName: 'Latest rename',
      affect: { ...persisted.affect, valence: 0.8 },
    });
    await h.api.reloadWorld();
    const newer = render(() => useSession(h.db));
    expect(newer.instances.find((instance) => instance.id === h.active.id)?.displayName).toBe('Latest rename');
    delay.release.resolve();
    await pending;
    const visible = render(() => useSession(h.db));
    expect(visible.instances).toHaveLength(3);
    expect(visible.instances.find((instance) => instance.id === h.active.id)).toMatchObject({
      displayName: 'Latest rename',
      presence: 'offscreen',
      affect: { valence: 0.8 },
    });
    expect(visible.instances.find((instance) => instance.id === h.outside.id)).toEqual(
      newer.instances.find((instance) => instance.id === h.outside.id),
    );
  });

  it('does not publish the old instance snapshot after the account owner changes', async () => {
    const h = await conversationSwitchFixture();
    const delay = delayAtomic(h.repository, true);
    const pending = h.api.openConversation(h.b.id);
    await delay.started.promise;
    render(() => useSession(null));
    const writes = host.writes.length;
    delay.release.resolve();
    await pending;
    expect(host.writes).toHaveLength(writes);
    expect(render(() => useSession(null)).instances).toEqual([]);
  });
});
describe('persisted single-affect reversion', () => {
  it('reverts current persisted state while preserving newer unrelated fields', async () => {
    const h = await sessionFixture();
    await h.repository.saveInstance({
      ...h.instance,
      displayName: 'External rename',
      affect: { ...h.instance.affect, valence: 0.8 },
    });
    await h.api.revertAffectChange(h.instance.id, 'change-a');
    const saved = await h.store.get<CharacterInstance>(COLLECTIONS.instances, h.instance.id);
    expect(saved?.displayName).toBe('External rename');
    expect(saved?.affect.valence).toBeCloseTo(0.5);
    expect(render(() => useSession(h.db)).instances[0]?.affect.valence).toBeCloseTo(0.5);
  });
  it('never resurrects a deleted instance', async () => {
    const h = await sessionFixture();
    await h.repository.deleteInstance(h.instance.id);
    await expect(h.api.revertAffectChange(h.instance.id, 'change-a')).rejects.toThrow('角色');
    expect(await h.repository.listInstances(h.room.id)).toEqual([]);
  });
  it('rejects a moved instance instead of overwriting its new ownership', async () => {
    const h = await sessionFixture();
    await h.repository.saveInstance({ ...h.instance, roomId: roomId('other-world') });
    await expect(h.api.revertAffectChange(h.instance.id, 'change-a')).rejects.toThrow('角色');
    expect((await h.store.get<CharacterInstance>(COLLECTIONS.instances, h.instance.id))?.roomId).toBe('other-world');
  });
  it('rejects an absent change rather than claiming it was reverted', async () => {
    const h = await sessionFixture();
    await expect(h.api.revertAffectChange(h.instance.id, 'missing')).rejects.toThrow('影响记录');
  });
  it('rolls back failed writes and leaves the visible state untouched', async () => {
    const h = await sessionFixture();
    const before = render(() => useSession(h.db)).instances;
    const original = h.store.transaction?.bind(h.store);
    if (!original) throw new Error('transaction missing');
    vi.spyOn(h.store, 'transaction').mockImplementation((run) =>
      original(async (scope) => {
        const put = scope.put.bind(scope);
        scope.put = async (collection, value) => {
          if (collection === COLLECTIONS.instances) throw new Error('Synthetic write refusal');
          await put(collection, value);
        };
        return run(scope);
      }),
    );
    await expect(h.api.revertAffectChange(h.instance.id, 'change-a')).rejects.toThrow('Synthetic write refusal');
    expect(render(() => useSession(h.db)).instances).toBe(before);
    expect((await h.store.get<CharacterInstance>(COLLECTIONS.instances, h.instance.id))?.affect.valence).toBe(0.3);
  });
  it('uses a fresh persisted read after transaction completion and preserves latest snapshot fields', async () => {
    const h = await sessionFixture();
    const delay = delayAtomic(h.repository, true);
    const pending = h.api.revertAffectChange(h.instance.id, 'change-a');
    await delay.started.promise;
    const saved = await h.store.get<CharacterInstance>(COLLECTIONS.instances, h.instance.id);
    if (!saved) throw new Error('instance missing');
    await h.repository.saveInstance({ ...saved, affect: { ...saved.affect, valence: 0.4 } });
    await h.repository.saveRoom({ ...h.room, title: 'Late world title' });
    await h.api.reloadWorld();
    expect((await h.repository.getRoom(h.room.id))?.title).toBe('Late world title');
    expect(render(() => useSession(h.db)).world?.title).toBe('Late world title');
    delay.release.resolve();
    await pending;
    const visible = render(() => useSession(h.db));
    expect(visible.world?.title).toBe('Late world title');
    expect(visible.instances[0]?.affect.valence).toBe(0.4);
  });
  it('does not republish the old world after navigation', async () => {
    const h = await sessionFixture();
    const delay = delayAtomic(h.repository, true);
    const pending = h.api.revertAffectChange(h.instance.id, 'change-a');
    await delay.started.promise;
    const other = { ...h.room, id: roomId('feedback-world-b'), title: 'Other', instanceIds: [], cardIds: [] };
    await h.repository.saveRoom(other);
    await h.api.openWorld(other.id);
    delay.release.resolve();
    await pending;
    expect(render(() => useSession(h.db)).world?.id).toBe(other.id);
  });
  it('does not publish after the session unmounts', async () => {
    const h = await sessionFixture();
    const delay = delayAtomic(h.repository, true);
    const pending = h.api.revertAffectChange(h.instance.id, 'change-a');
    await delay.started.promise;
    host.unmount();
    const writes = host.writes.length;
    delay.release.resolve();
    await pending;
    expect(host.writes).toHaveLength(writes);
  });
  it('rejects a queued old-account write after the owner changes', async () => {
    const h = await sessionFixture();
    const delay = delayAtomic(h.repository);
    const pending = h.api.revertAffectChange(h.instance.id, 'change-a');
    await delay.started.promise;
    render(() => useSession(null));
    delay.release.resolve();
    await expect(pending).rejects.toThrow('账户');
    expect((await h.store.get<CharacterInstance>(COLLECTIONS.instances, h.instance.id))?.affect.valence).toBe(0.3);
  });
  it('serializes concurrent retries and appends only one reversal for the same original change', async () => {
    const h = await sessionFixture();
    await Promise.all([
      h.api.revertAffectChange(h.instance.id, 'change-a'),
      h.api.revertAffectChange(h.instance.id, 'change-a'),
    ]);
    const saved = await h.store.get<CharacterInstance>(COLLECTIONS.instances, h.instance.id);
    expect(saved?.affect.valence).toBe(0);
    expect(saved?.affect.history.filter((change) => change.reversionOf === 'change-a')).toHaveLength(1);
  });
  it('preserves both concurrent reversals rather than saving two stale instance replacements', async () => {
    const h = await sessionFixture();
    const first = h.instance.affect.history[0];
    if (!first) throw new Error('original history missing');
    await h.repository.saveInstance({
      ...h.instance,
      affect: {
        ...h.instance.affect,
        valence: 0.6,
        history: [
          first,
          {
            ...first,
            id: 'change-b',
            beforeValence: 0.3,
            afterValence: 0.6,
          },
        ],
      },
    });
    await h.api.reloadWorld();
    await Promise.all([
      h.api.revertAffectChange(h.instance.id, 'change-a'),
      h.api.revertAffectChange(h.instance.id, 'change-b'),
    ]);
    const saved = await h.store.get<CharacterInstance>(COLLECTIONS.instances, h.instance.id);
    expect(saved?.affect.valence).toBeCloseTo(0);
    expect(saved?.affect.history.flatMap((change) => (change.reversionOf ? [change.reversionOf] : [])).sort()).toEqual([
      'change-a',
      'change-b',
    ]);
  });
  it('rejects deletion discovered during post-commit verification without restoring a stale visible instance', async () => {
    const h = await sessionFixture(),
      delay = delayAtomic(h.repository, true);
    const pending = h.api.revertAffectChange(h.instance.id, 'change-a');
    await delay.started.promise;
    await h.repository.deleteInstance(h.instance.id);
    await h.api.reloadWorld();
    delay.release.resolve();
    await expect(pending).rejects.toThrow('角色');
    expect(render(() => useSession(h.db)).instances).toEqual([]);
  });
  it('merges the persisted reversion into the latest conversation without restoring its old conversation', async () => {
    const h = await sessionFixture();
    const conversation = createConversation({
      roomId: h.room.id,
      title: 'New conversation',
      persona: { personaId: null, name: 'Player', description: '' },
    });
    await h.repository.saveConversation(conversation);
    const delay = delayAtomic(h.repository, true);
    const pending = h.api.revertAffectChange(h.instance.id, 'change-a');
    await delay.started.promise;
    await h.api.openConversation(conversation.id);
    delay.release.resolve();
    await pending;
    const visible = render(() => useSession(h.db));
    expect(visible.conversation?.id).toBe(conversation.id);
    expect(visible.instances[0]?.affect.history.some((change) => change.reversionOf === 'change-a')).toBe(true);
  });
});
