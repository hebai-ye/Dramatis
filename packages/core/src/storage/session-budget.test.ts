import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramatisDb } from '../../../../apps/web/src/lib/db.js';
import { useSession } from '../../../../apps/web/src/lib/session.js';
import { createTaskQueueExtras } from '../../../../apps/web/src/lib/task-queue.js';
import { createBlankCard, createBlankWorldBook } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
import { conversationId, roomId } from '../model/ids.js';
import { createPersona } from '../model/persona.js';
import type { Room } from '../model/room.js';
import { createBackgroundRunner } from '../platform/background-runner.js';
import type { EntityStore } from '../platform/entity-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createPlayerMessage } from '../session/turn.js';
import type { BudgetLimits } from './budget.js';
import { type BudgetWriteTarget, budgetWriteVersion } from './budget-write.js';
import { Repository, type RoomSnapshot } from './repository.js';
import { createUsageLedger } from './usage.js';

// Real useSession + real CAS/repository, synthetic memory stores only. The dependency-aware
// host is modeled after usage-hook.test.ts, not a native React/IndexedDB/browser acceptance test.
const host = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  type Cleanup = (() => void) | undefined;
  type Run = () => Cleanup;
  type Phase = 'layout' | 'passive';
  type Effect = { kind: 'effect'; phase: Phase; deps: Deps; run: Run; cleanup?: Cleanup };
  type StateCell = { value: unknown; set: (next: unknown) => void };
  type Slot =
    | { kind: 'state'; cell: StateCell }
    | { kind: 'ref'; value: { current: unknown } }
    | { kind: 'memo'; deps: Deps; value: unknown }
    | Effect;
  type Change = { previous?: Effect; next: Effect };
  let committed: Slot[] = [];
  let draft: Slot[] | null = null;
  let cursor = 0;
  let draftLayouts: Change[] = [];
  let draftPassive: Change[] = [];
  let pendingPassive: Change[] = [];
  const writes: { slot: number; value: unknown }[] = [];
  const trace: string[] = [];
  const equalDeps = (left: Deps, right: Deps) =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, i) => Object.is(value, right[i]));
  const frame = () => {
    if (draft === null) throw new Error('hook called outside the controlled render');
    return draft;
  };
  const memo = <T>(create: () => T, deps?: readonly unknown[]): T => {
    const slots = frame();
    const index = cursor++;
    const previous = slots[index];
    if (previous && previous.kind !== 'memo') throw new Error('memo hook order changed');
    if (previous && equalDeps(previous.deps, deps)) return previous.value as T;
    const value = create();
    slots[index] = { kind: 'memo', value, deps: deps?.slice() };
    return value;
  };
  const effect = (phase: Phase, run: Run, deps?: readonly unknown[]) => {
    const slots = frame();
    const index = cursor++;
    const previous = slots[index];
    if (previous && (previous.kind !== 'effect' || previous.phase !== phase))
      throw new Error('effect hook order changed');
    if (previous && equalDeps(previous.deps, deps)) return;
    const next: Effect = { kind: 'effect', phase, deps: deps?.slice(), run };
    slots[index] = next;
    (phase === 'layout' ? draftLayouts : draftPassive).push({ previous, next });
  };
  const apply = (changes: Change[]) => {
    // Model the cleanup-before-setup ordering separately for layout and passive effects.
    for (const { previous } of changes) {
      if (previous?.cleanup) {
        trace.push(`${previous.phase}:cleanup`);
        previous.cleanup();
      }
    }
    for (const { next } of changes) {
      trace.push(`${next.phase}:setup`);
      next.cleanup = next.run() ?? undefined;
    }
  };
  const discard = () => {
    draft = null;
    draftLayouts = [];
    draftPassive = [];
    cursor = 0;
  };
  const unmount = () => {
    discard();
    pendingPassive = [];
    for (const phase of ['layout', 'passive'] as const) {
      for (const slot of committed) {
        if (slot.kind === 'effect' && slot.phase === phase && slot.cleanup) {
          trace.push(`${phase}:cleanup`);
          slot.cleanup();
        }
      }
    }
    committed = [];
  };
  return {
    writes,
    trace,
    begin() {
      if (draft !== null || pendingPassive.length > 0)
        throw new Error('finish the previous controlled render/effects first');
      draft = committed.slice();
      cursor = 0;
      draftLayouts = [];
      draftPassive = [];
    },
    commitLayouts() {
      committed = frame();
      draft = null;
      const changes = draftLayouts;
      pendingPassive = draftPassive;
      draftLayouts = [];
      draftPassive = [];
      apply(changes);
    },
    flushPassive() {
      const changes = pendingPassive;
      pendingPassive = [];
      apply(changes);
    },
    discard,
    unmount,
    reset() {
      unmount();
      writes.length = 0;
      trace.length = 0;
    },
    state(initial: unknown) {
      const slots = frame();
      const index = cursor++;
      let slot = slots[index];
      if (slot && slot.kind !== 'state') throw new Error('state hook order changed');
      if (!slot) {
        const cell: StateCell = {
          value: typeof initial === 'function' ? initial() : initial,
          set(next: unknown) {
            cell.value = typeof next === 'function' ? next(cell.value) : next;
            // Deliberately record even after unmount: do not mask illegal late publications.
            writes.push({ slot: index, value: cell.value });
          },
        };
        slot = { kind: 'state', cell };
        slots[index] = slot;
      }
      return [slot.cell.value, slot.cell.set];
    },
    ref(initial: unknown) {
      const slots = frame();
      const index = cursor++;
      let slot = slots[index];
      if (slot && slot.kind !== 'ref') throw new Error('ref hook order changed');
      if (!slot) {
        slot = { kind: 'ref', value: { current: initial } };
        slots[index] = slot;
      }
      return slot.value;
    },
    memo,
    callback: <T>(callback: T, deps?: readonly unknown[]) => memo(() => callback, deps),
    layout: (run: Run, deps?: readonly unknown[]) => effect('layout', run, deps),
    passive: (run: Run, deps?: readonly unknown[]) => effect('passive', run, deps),
  };
});

// Core has no React package of its own. Mock the exact installed module resolved by usage.ts,
// rather than adding a core dependency or alias. Vitest resolves this web symlink to the same ID.
vi.mock('../../../../apps/web/node_modules/react/index.js', () => ({
  useState: host.state,
  useRef: host.ref,
  useMemo: host.memo,
  useCallback: host.callback,
  useLayoutEffect: host.layout,
  useEffect: host.passive,
}));

beforeEach(() => host.reset());
afterEach(() => {
  host.unmount();
  vi.restoreAllMocks();
});

const A = roomId('session-budget-a');
const B = roomId('session-budget-b');
const C1 = conversationId('session-budget-c1');
const C2 = conversationId('session-budget-c2');
const CB = conversationId('session-budget-cb');
const BASE: BudgetLimits = { maxExtraCalls: 5, maxCost: 2 };
const NEXT: BudgetLimits = { maxExtraCalls: 10, maxCostByCurrency: { CNY: 3, USD: 4 } };
const EXTERNAL: BudgetLimits = { maxExtraCalls: 77 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function target(limits: BudgetLimits | null = BASE, id = A): BudgetWriteTarget {
  return { roomId: id, expectedVersion: budgetWriteVersion(limits) };
}
function render(db: DramatisDb | null) {
  host.begin();
  const api = useSession(db);
  host.commitLayouts();
  host.flushPassive();
  return api;
}
async function drain() {
  for (let step = 0; step < 80; step++) await Promise.resolve();
}
async function boot(db: DramatisDb | null) {
  let api = render(db);
  for (let attempt = 0; attempt < 8; attempt++) {
    await drain();
    api = render(db);
    if (api.ready || db === null) break;
  }
  if (db !== null) expect(api.ready).toBe(true);
  await drain();
  return render(db);
}
async function fixture(label = 'first') {
  const store = createMemoryEntityStore();
  const repository = new Repository(store);
  const persona = createPersona({ name: `Player ${label}` });
  await repository.savePersona(persona);
  for (const [id, world] of [
    [C1, A],
    [C2, A],
    [CB, B],
  ] as const) {
    await repository.saveConversation(
      createConversation({
        id,
        roomId: world,
        title: `${label} ${id}`,
        persona: { personaId: persona.id, name: persona.name, description: '' },
      }),
    );
  }
  const makeRoom = (id: typeof A, activeConversationId: typeof C1): Room => ({
    id,
    title: `${label} ${id}`,
    personaId: persona.id,
    playerName: persona.name,
    playerPersona: '',
    cardIds: [],
    instanceIds: [],
    worldBookIds: [],
    activeConversationId,
    budget: structuredClone(BASE),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  await repository.saveRoom(makeRoom(A, C1));
  await repository.saveRoom(makeRoom(B, CB));
  const db: DramatisDb = {
    backendKind: store.kind,
    store,
    repository,
    queue: createBackgroundRunner(store),
    ledger: createUsageLedger(store),
    tasks: createTaskQueueExtras(store),
  };
  return { db, store, repository, label };
}
async function setup() {
  const h = await fixture();
  const api = await boot(h.db);
  await api.openWorld(A);
  return { ...h, api: render(h.db) };
}
function delayAtomic(repository: Repository, phase: 'before' | 'after' = 'before') {
  const original = repository.atomic.bind(repository);
  const started = deferred<void>();
  const release = deferred<void>();
  let first = true;
  vi.spyOn(repository, 'atomic').mockImplementation(
    async <T>(run: (repository: Repository, store: EntityStore) => Promise<T>): Promise<T> => {
      if (!first) return original(run);
      first = false;
      if (phase === 'before') {
        started.resolve();
        await release.promise;
        return original(run);
      }
      const result = await original(run);
      started.resolve();
      await release.promise;
      return result;
    },
  );
  return { started, release };
}
async function atomicStarted(pending: Promise<void>, delayed: { started: { promise: Promise<void> } }) {
  await Promise.race([
    delayed.started.promise,
    pending.then(() => {
      throw new Error('operation returned before entering the atomic transaction');
    }),
  ]);
}
async function roomSnapshot(repository: Repository, id = A) {
  const snapshot = await repository.loadRoom(id);
  if (!snapshot) throw new Error('fixture room snapshot missing');
  return snapshot;
}
function message(content: string, conversation = C1) {
  return createPlayerMessage({
    roomId: A,
    conversationId: conversation,
    sceneId: null,
    turnId: `turn-${content}`,
    speakerName: 'Fixture player',
    content,
  });
}

describe('actual session explicit-target budget saves', () => {
  it('saves and publishes the confirmed budget without rewriting unrelated UI fields', async () => {
    const h = await setup();
    const before = h.api.world;
    await expect(h.api.setBudget(NEXT, target())).resolves.toBeUndefined();
    const api = render(h.db);
    expect(api.world?.budget).toEqual(NEXT);
    expect(api.world?.id).toBe(A);
    expect(api.world?.title).toBe(before?.title);
    expect(api.conversation?.id).toBe(C1);
    expect((await h.repository.getRoom(A))?.budget).toEqual(NEXT);
  });

  it('saving A while navigating to B never restores A or writes B', async () => {
    const h = await setup();
    const delayed = delayAtomic(h.repository);
    const pending = h.api.setBudget(NEXT, target());
    await atomicStarted(pending, delayed);
    await h.api.openWorld(B);
    const before = render(h.db);
    delayed.release.resolve();
    await pending;
    const api = render(h.db);
    expect(api.world).toBe(before.world);
    expect(api.world?.id).toBe(B);
    expect(api.conversation?.id).toBe(CB);
    expect(api.world?.budget).toEqual(BASE);
    expect((await h.repository.getRoom(A))?.budget).toEqual(NEXT);
    expect((await h.repository.getRoom(B))?.budget).toEqual(BASE);
  });

  it('A -> B -> A during saving preserves the reloaded A title, conversation and messages', async () => {
    const h = await setup();
    const delayed = delayAtomic(h.repository);
    const pending = h.api.setBudget(NEXT, target());
    await atomicStarted(pending, delayed);
    await h.api.openWorld(B);
    const room = await h.repository.getRoom(A);
    if (!room) throw new Error('fixture missing');
    await h.repository.saveRoom({ ...room, title: 'A changed while away', activeConversationId: C2 });
    await h.repository.appendMessages(A, [message('arrived while away', C2)]);
    await h.api.openWorld(A);
    const before = render(h.db);
    delayed.release.resolve();
    await pending;
    const api = render(h.db);
    expect(api.world?.id).toBe(A);
    expect(api.world?.title).toBe('A changed while away');
    expect(api.conversation?.id).toBe(C2);
    expect(api.messages).toEqual(before.messages);
    expect(api.messages.map((item) => item.content)).toContain('arrived while away');
    expect((await h.repository.getRoom(A))?.budget).toEqual(NEXT);
  });

  it('preserves a same-world conversation switch and newly loaded message while merging budget only', async () => {
    const h = await setup();
    const delayed = delayAtomic(h.repository);
    const pending = h.api.setBudget(NEXT, target());
    await atomicStarted(pending, delayed);
    await h.api.openConversation(C2);
    await h.repository.appendMessages(A, [message('new conversation message', C2)]);
    await h.api.reloadWorld();
    const before = render(h.db);
    delayed.release.resolve();
    await pending;
    const api = render(h.db);
    expect(api.world?.budget).toEqual(NEXT);
    expect(api.conversation?.id).toBe(C2);
    expect(api.messages).toEqual(before.messages);
    expect(api.messages.map((item) => item.content)).toContain('new conversation message');
    expect(api.memories).toBe(before.memories);
    expect(api.instances).toBe(before.instances);
    expect((await h.repository.getRoom(A))?.activeConversationId).toBe(C2);
  });

  it.each(['snapshot', 'storage'] as const)(
    'a newer %s budget is not overwritten when an already-committed save returns late',
    async (change) => {
      const h = await setup();
      const delayed = delayAtomic(h.repository, 'after');
      const pending = h.api.setBudget(NEXT, target());
      await atomicStarted(pending, delayed);
      const current = await roomSnapshot(h.repository);
      if (change === 'storage')
        await h.repository.saveRoom({ ...current.room, title: 'external change', budget: EXTERNAL });
      else
        vi.spyOn(h.repository, 'loadRoom').mockResolvedValueOnce({
          ...current,
          room: { ...current.room, budget: EXTERNAL },
        });
      await h.api.reloadWorld();
      const before = render(h.db);
      expect(before.world?.budget).toEqual(EXTERNAL);
      delayed.release.resolve();
      await pending;
      const api = render(h.db);
      expect(api.world).toBe(before.world);
      expect(api.world?.budget).toEqual(EXTERNAL);
      expect((await h.repository.getRoom(A))?.budget).toEqual(change === 'storage' ? EXTERNAL : NEXT);
    },
  );

  it('rejects a conflicting external storage change made before the CAS executes', async () => {
    const h = await setup();
    const delayed = delayAtomic(h.repository);
    const pending = h.api.setBudget(NEXT, target());
    await atomicStarted(pending, delayed);
    const current = await h.repository.getRoom(A);
    if (!current) throw new Error('fixture missing');
    await h.repository.saveRoom({ ...current, budget: EXTERNAL });
    await h.api.reloadWorld();
    const before = render(h.db);
    delayed.release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'budget-conflict' });
    expect(render(h.db).world).toBe(before.world);
    expect((await h.repository.getRoom(A))?.budget).toEqual(EXTERNAL);
  });

  it('a pending save stays in its captured DB and never publishes into another DB with the same room ID', async () => {
    const h = await setup();
    const other = await fixture('second');
    const delayed = delayAtomic(h.repository);
    const pending = h.api.setBudget(NEXT, target());
    await atomicStarted(pending, delayed);
    const nextApi = await boot(other.db);
    await nextApi.openWorld(A);
    const before = render(other.db);
    delayed.release.resolve();
    await pending;
    const api = render(other.db);
    expect(api.world).toBe(before.world);
    expect(api.world?.title).toBe(`second ${A}`);
    expect(api.world?.budget).toEqual(BASE);
    expect((await h.repository.getRoom(A))?.budget).toEqual(NEXT);
    expect((await other.repository.getRoom(A))?.budget).toEqual(BASE);
  });

  it('a DB becoming null prevents a pending save from publishing and rejects new saves', async () => {
    const h = await setup();
    const delayed = delayAtomic(h.repository);
    const pending = h.api.setBudget(NEXT, target());
    await atomicStarted(pending, delayed);
    const empty = await boot(null);
    const before = empty.world;
    await expect(empty.setBudget(NEXT, target())).rejects.toThrow();
    delayed.release.resolve();
    await pending;
    expect(render(null).world).toBe(before);
    expect((await h.repository.getRoom(A))?.budget).toEqual(NEXT);
  });

  it('restoring the same DB after null does not reactivate old callbacks or the pending save owner', async () => {
    const h = await setup();
    const delayed = delayAtomic(h.repository);
    const pending = h.api.setBudget(NEXT, target());
    await atomicStarted(pending, delayed);
    await boot(null);
    const restored = await boot(h.db);
    await restored.openWorld(A);
    const before = render(h.db);
    expect(before.world?.budget).toEqual(BASE);
    const reads = vi.spyOn(h.repository, 'loadRoom');
    await expect(h.api.setBudget(EXTERNAL, target())).rejects.toThrow();
    await expect(h.api.reloadWorld()).resolves.toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    delayed.release.resolve();
    await pending;
    const api = render(h.db);
    expect(api.world).toBe(before.world);
    expect((await h.repository.getRoom(A))?.budget).toEqual(NEXT);
    // The current owner can explicitly observe the committed write; it is only the old owner that is fenced.
    await api.reloadWorld();
    expect(render(h.db).world?.budget).toEqual(NEXT);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('a retained setBudget from an old DB cannot start a write against the new same-ID world', async () => {
    const h = await setup();
    const other = await fixture('second');
    const api = await boot(other.db);
    await api.openWorld(A);
    const firstBefore = await h.repository.getRoom(A);
    const secondBefore = await other.repository.getRoom(A);
    await expect(h.api.setBudget(NEXT, target())).rejects.toThrow();
    expect(await h.repository.getRoom(A)).toEqual(firstBefore);
    expect(await other.repository.getRoom(A)).toEqual(secondBefore);
  });

  it('captures mutable target and limit inputs before awaiting and publishes the captured budget', async () => {
    const h = await setup();
    const delayed = delayAtomic(h.repository);
    const limits = structuredClone(NEXT);
    const destination = target();
    const pending = h.api.setBudget(limits, destination);
    await atomicStarted(pending, delayed);
    destination.roomId = B;
    destination.expectedVersion = 'changed during save';
    limits.maxExtraCalls = 999;
    if (limits.maxCostByCurrency) limits.maxCostByCurrency.CNY = 999;
    delayed.release.resolve();
    await pending;
    expect(render(h.db).world?.budget).toEqual(NEXT);
    expect((await h.repository.getRoom(A))?.budget).toEqual(NEXT);
    expect((await h.repository.getRoom(B))?.budget).toEqual(BASE);
  });

  it('propagates transaction failure without a success-shaped snapshot publication', async () => {
    const h = await setup();
    const before = h.api.world;
    const stored = await h.repository.getRoom(A);
    const failure = new Error('fixture transaction rejected');
    vi.spyOn(h.repository, 'atomic').mockRejectedValueOnce(failure);
    await expect(h.api.setBudget(NEXT, target())).rejects.toBe(failure);
    expect(render(h.db).world).toBe(before);
    expect(await h.repository.getRoom(A)).toEqual(stored);
  });

  it.each(['no-db', 'no-world', 'wrong-world', 'missing-target', 'stale-version'] as const)(
    'rejects %s instead of silently reporting success',
    async (missing) => {
      const h = await fixture();
      const db = missing === 'no-db' ? null : h.db;
      let api = await boot(db);
      if (db !== null && missing !== 'no-world') {
        await api.openWorld(A);
        api = render(db);
      }
      const destination =
        missing === 'missing-target'
          ? (undefined as unknown as BudgetWriteTarget)
          : missing === 'wrong-world'
            ? target(BASE, B)
            : missing === 'stale-version'
              ? target(EXTERNAL)
              : target();
      const before = await h.repository.getRoom(A);
      await expect(api.setBudget(NEXT, destination)).rejects.toThrow();
      expect(await h.repository.getRoom(A)).toEqual(before);
      expect((await h.repository.getRoom(B))?.budget).toEqual(BASE);
    },
  );
});

describe('targeted rename and pre-commit account isolation around budgets', () => {
  it.each(['before', 'after'] as const)(
    'rename held %s its transaction preserves a budget saved before rename completion',
    async (phase) => {
      const h = await setup();
      const delayed = delayAtomic(h.repository, phase);
      const pending = h.api.renameWorld('Renamed A');
      await atomicStarted(pending, delayed);
      await h.api.setBudget(NEXT, target());
      expect(render(h.db).world?.budget).toEqual(NEXT);
      delayed.release.resolve();
      await pending;
      const api = render(h.db);
      const stored = await h.repository.getRoom(A);
      expect(stored?.title).toBe('Renamed A');
      expect(stored?.budget).toEqual(NEXT);
      expect(api.world?.id).toBe(A);
      expect(api.world?.title).toBe('Renamed A');
      expect(api.world?.budget).toEqual(NEXT);
      expect(api.conversation?.id).toBe(C1);
    },
  );

  it('rename finishing after navigation changes only the target room and does not restore its snapshot', async () => {
    const h = await setup();
    const delayed = delayAtomic(h.repository);
    const pending = h.api.renameWorld('Renamed while away');
    await atomicStarted(pending, delayed);
    await h.api.openWorld(B);
    const before = render(h.db);
    const otherStored = await h.repository.getRoom(B);
    delayed.release.resolve();
    await pending;
    const api = render(h.db);
    expect(api.world).toBe(before.world);
    expect(api.world?.id).toBe(B);
    expect(api.conversation?.id).toBe(CB);
    expect(await h.repository.getRoom(B)).toEqual(otherStored);
    expect((await h.repository.getRoom(A))?.title).toBe('Renamed while away');
  });

  it('a same-room-ID DB switch hides old lists, library, personas, ready and error before effects commit', async () => {
    const h = await setup();
    const other = await fixture('second');
    await h.repository.saveCard(createBlankCard({ name: 'Account A private card' }));
    await h.repository.saveWorldBook(createBlankWorldBook('Account A private book'));
    await h.api.refreshAll();
    await h.api.openWorld(roomId('missing-only-in-account-a'));
    const old = render(h.db);
    expect(old.world?.id).toBe(A);
    expect(old.worlds).toHaveLength(2);
    expect(old.library.cards).toHaveLength(1);
    expect(old.library.worldBooks).toHaveLength(1);
    expect(old.personas).toHaveLength(1);
    expect(old.ready).toBe(true);
    expect(old.error).not.toBeNull();
    const trace = host.trace.slice();
    host.begin();
    const preview = useSession(other.db);
    // Inspect the actual hook result before either layout or passive effects have executed.
    expect(host.trace).toEqual(trace);
    expect(preview.world).toBeNull();
    expect(preview.worlds).toEqual([]);
    expect(preview.library).toEqual({ cards: [], worldBooks: [] });
    expect(preview.personas).toEqual([]);
    expect(preview.ready).toBe(false);
    expect(preview.error).toBeNull();
    host.commitLayouts();
    host.flushPassive();
    const active = await boot(other.db);
    await active.openWorld(A);
    const current = render(other.db);
    expect(current.world?.id).toBe(A);
    expect(current.world?.title).toBe(`second ${A}`);
    expect(current.worlds).toHaveLength(2);
    expect(current.worlds.every((world) => world.title.startsWith('second '))).toBe(true);
    expect(current.library).toEqual({ cards: [], worldBooks: [] });
    expect(current.personas.map((persona) => persona.name)).toEqual(['Player second']);
    expect(current.ready).toBe(true);
    expect(current.error).toBeNull();
  });
});

describe('conversation atomic updates interleaved with budget saves', () => {
  it.each(['before', 'after'] as const)(
    'a delayed conversation switch preserves a newer budget and messages when held %s its transaction',
    async (phase) => {
      const h = await setup();
      const delayed = delayAtomic(h.repository, phase);
      const navigation = h.api.openConversation(C2);
      await atomicStarted(navigation, delayed);
      await h.api.setBudget(NEXT, target());
      const late = message(`message during ${phase} conversation switch`, C2);
      await h.api.appendMessages([late]);
      const before = render(h.db);
      expect(before.world?.budget).toEqual(NEXT);
      delayed.release.resolve();
      await navigation;
      const api = render(h.db);
      expect(api.conversation?.id).toBe(C2);
      expect(api.world?.budget).toEqual(NEXT);
      expect(api.messages.some((item) => item.id === late.id)).toBe(true);
      expect(api.memories).toBe(before.memories);
      expect(api.instances).toBe(before.instances);
      const stored = await h.repository.getRoom(A);
      expect(stored?.activeConversationId).toBe(C2);
      expect(stored?.budget).toEqual(NEXT);
    },
  );
});

describe('actual session reload invalidation around budget and navigation', () => {
  it('late reload A cannot restore A after navigating to B', async () => {
    const h = await setup();
    const old = await roomSnapshot(h.repository);
    const gate = deferred<RoomSnapshot | null>();
    vi.spyOn(h.repository, 'loadRoom').mockReturnValueOnce(gate.promise);
    const pending = h.api.reloadWorld();
    await h.api.openWorld(B);
    const before = render(h.db);
    gate.resolve(old);
    await pending;
    expect(render(h.db).world).toBe(before.world);
    expect(render(h.db).conversation?.id).toBe(CB);
  });

  it('starting navigation fences old reload before the new world has even loaded', async () => {
    const h = await setup();
    const old = await roomSnapshot(h.repository);
    const other = await roomSnapshot(h.repository, B);
    const first = deferred<RoomSnapshot | null>();
    const second = deferred<RoomSnapshot | null>();
    vi.spyOn(h.repository, 'loadRoom').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const before = h.api.world;
    const reload = h.api.reloadWorld();
    const navigation = h.api.openWorld(B);
    first.resolve({ ...old, room: { ...old.room, title: 'obsolete reload' } });
    await reload;
    expect(render(h.db).world).toBe(before);
    second.resolve(other);
    await navigation;
    expect(render(h.db).world?.id).toBe(B);
  });

  it('A -> B -> A does not revive a reload from the first A epoch', async () => {
    const h = await setup();
    const old = await roomSnapshot(h.repository);
    const gate = deferred<RoomSnapshot | null>();
    vi.spyOn(h.repository, 'loadRoom').mockReturnValueOnce(gate.promise);
    const pending = h.api.reloadWorld();
    await h.api.openWorld(B);
    await h.repository.saveRoom({ ...old.room, title: 'new A epoch' });
    await h.api.openWorld(A);
    const before = render(h.db);
    gate.resolve(old);
    await pending;
    expect(render(h.db).world).toBe(before.world);
    expect(render(h.db).world?.title).toBe('new A epoch');
  });

  it('the last openWorld request wins even when an older selection loads later', async () => {
    const h = await setup();
    const a = await roomSnapshot(h.repository, A);
    const b = await roomSnapshot(h.repository, B);
    const first = deferred<RoomSnapshot | null>();
    const second = deferred<RoomSnapshot | null>();
    vi.spyOn(h.repository, 'loadRoom').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = h.api.openWorld(B);
    const newer = h.api.openWorld(A);
    second.resolve({ ...a, room: { ...a.room, title: 'last selected A' } });
    await newer;
    const before = render(h.db);
    expect(before.world?.title).toBe('last selected A');
    first.resolve(b);
    await older;
    const api = render(h.db);
    expect(api.world).toBe(before.world);
    expect(api.world?.id).toBe(A);
    expect(api.conversation?.id).toBe(C1);
  });

  it('newer parallel reload wins even if the older one returns last', async () => {
    const h = await setup();
    const snapshot = await roomSnapshot(h.repository);
    const first = deferred<RoomSnapshot | null>();
    const second = deferred<RoomSnapshot | null>();
    vi.spyOn(h.repository, 'loadRoom').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = h.api.reloadWorld();
    const newer = h.api.reloadWorld();
    second.resolve({ ...snapshot, room: { ...snapshot.room, title: 'newest reload' } });
    await newer;
    const before = render(h.db);
    first.resolve({ ...snapshot, room: { ...snapshot.room, title: 'older reload' } });
    await older;
    expect(render(h.db).world).toBe(before.world);
    expect(render(h.db).world?.title).toBe('newest reload');
  });

  it.each(['conversation', 'message', 'budget'] as const)(
    'reload cannot undo a newer %s snapshot publication',
    async (change) => {
      const h = await setup();
      const old = await roomSnapshot(h.repository);
      const gate = deferred<RoomSnapshot | null>();
      vi.spyOn(h.repository, 'loadRoom').mockReturnValueOnce(gate.promise);
      const pending = h.api.reloadWorld();
      if (change === 'conversation') await h.api.openConversation(C2);
      else if (change === 'message') await h.api.appendMessages([message('published after reload started')]);
      else await h.api.setBudget(NEXT, target());
      const before = render(h.db);
      gate.resolve(old);
      await pending;
      const api = render(h.db);
      expect(api.world).toBe(before.world);
      expect(api.messages).toEqual(before.messages);
      expect(api.conversation?.id).toBe(before.conversation?.id);
      if (change === 'message')
        expect(api.messages.map((item) => item.content)).toContain('published after reload started');
      if (change === 'budget') expect(api.world?.budget).toEqual(NEXT);
    },
  );

  it.each(['replace', 'null'] as const)('late reload cannot publish after DB %s', async (change) => {
    const h = await setup();
    const other = await fixture('second');
    const old = await roomSnapshot(h.repository);
    const gate = deferred<RoomSnapshot | null>();
    vi.spyOn(h.repository, 'loadRoom').mockReturnValueOnce(gate.promise);
    const pending = h.api.reloadWorld();
    const db = change === 'replace' ? other.db : null;
    const api = await boot(db);
    if (db !== null) await api.openWorld(A);
    const before = render(db);
    gate.resolve(old);
    await pending;
    expect(render(db).world).toBe(before.world);
    if (db !== null) expect(render(db).world?.title).toBe(`second ${A}`);
  });
});
