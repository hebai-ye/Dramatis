import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUsage } from '../../../../apps/web/src/lib/usage.js';
import { conversationId, roomId } from '../model/ids.js';
import type { UsageLedger, UsageScope, UsageScopeSummary, UsageSummary } from './usage.js';

// Actual web hook + actual core reader; only React is replaced. This host does NOT establish
// native React scheduling, StrictMode, DOM, or browser correctness. One publication below means
// one state-setter invocation, not a measured React render/commit count.
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
afterEach(() => host.unmount());

const A: UsageScope = {
  roomId: roomId('hook-world-a'),
  conversationId: conversationId('hook-conversation-a'),
  turnId: 'turn-a',
};
const B: UsageScope = {
  roomId: roomId('hook-world-b'),
  conversationId: conversationId('hook-conversation-b'),
  turnId: 'turn-b',
};
const EMPTY = { world: null, conversation: null, latestTurn: null, error: null };
type Api = ReturnType<typeof useUsage>;
type Db = NonNullable<Parameters<typeof useUsage>[0]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Opaque identity sentinels only. No aggregation algorithm or billing-value assertion is duplicated.
function summary(): UsageSummary {
  return {
    total: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
      cost: null,
      pricedCalls: 0,
      currency: null,
      costs: [],
      calibration: { calls: 0, estimated: 0, actual: 0 },
    },
    byCategory: [],
    bySpeaker: [],
    byModel: [],
    firstAt: null,
    lastAt: null,
  };
}
function snapshot(): UsageScopeSummary {
  return { world: summary(), conversation: summary(), latestTurn: summary() };
}
function fixture() {
  const requests: { scope: UsageScope; gate: ReturnType<typeof deferred<UsageScopeSummary>> }[] = [];
  const scopeSummary = vi.fn((scope: UsageScope) => {
    const gate = deferred<UsageScopeSummary>();
    requests.push({ scope, gate });
    return gate.promise;
  });
  const legacySummary = vi.fn<UsageLedger['summary']>(() => {
    throw new Error('unexpected legacy summary read');
  });
  const ledger: UsageLedger = {
    scopeSummary,
    summary: legacySummary,
    async record() {
      throw new Error('hook must not record usage');
    },
    async list() {
      throw new Error('hook must not read raw usage');
    },
    async removeByRoom() {
      throw new Error('hook must not delete usage');
    },
  };
  return {
    db: { ledger } as Db,
    requests,
    scopeSummary,
    legacySummary,
    request(index: number) {
      const request = requests[index];
      if (!request) throw new Error(`request ${index} was not started`);
      return request.gate;
    },
  };
}

function render(db: Db | null, scope: UsageScope) {
  host.begin();
  return useUsage(db, scope);
}
function commit() {
  host.commitLayouts();
  host.flushPassive();
}
function rerender(db: Db | null, scope: UsageScope) {
  const api = render(db, scope);
  commit();
  return api;
}
async function drainMicrotasks() {
  // Drive only the bounded readUsageScope -> reader.read -> reload -> catch Promise chain; no timers.
  for (let step = 0; step < 8; step++) await Promise.resolve();
}
function expectVisible(api: Api, value: UsageScopeSummary) {
  expect(api.world).toBe(value.world);
  expect(api.conversation).toBe(value.conversation);
  expect(api.latestTurn).toBe(value.latestTurn);
}
async function loaded() {
  const h = fixture();
  rerender(h.db, A);
  const value = snapshot();
  h.request(0).resolve(value);
  await drainMicrotasks();
  const api = rerender(h.db, A);
  expectVisible(api, value);
  expect(host.writes).toHaveLength(1);
  expect(h.requests).toHaveLength(1);
  return { ...h, api, value };
}

describe('actual useUsage wiring through a controlled React hook host', () => {
  it('activates in layout, reads in passive effect, and publishes all three views in one state update', async () => {
    const h = fixture();
    const initial = render(h.db, A);
    expect(initial).toMatchObject(EMPTY);
    expect(h.requests).toHaveLength(0);
    expect(host.trace).toEqual([]);
    host.commitLayouts();
    expect(host.trace).toEqual(['layout:setup']);
    expect(h.requests).toHaveLength(0);
    host.flushPassive();
    expect(host.trace).toEqual(['layout:setup', 'passive:setup']);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.scope).toEqual(A);
    const value = snapshot();
    h.request(0).resolve(value);
    await drainMicrotasks();
    expect(host.writes).toHaveLength(1);
    expect(host.writes[0]?.value).toMatchObject({ value, error: null });
    const api = rerender(h.db, { ...A });
    expectVisible(api, value);
    expect(api.error).toBeNull();
    expect(api.reload).toBe(initial.reload);
    const equivalent = rerender({ ledger: h.db.ledger } as Db, { ...A });
    expect(equivalent).toBe(api);
    expect(equivalent.reload).toBe(api.reload);
    expect(host.trace).toEqual(['layout:setup', 'passive:setup']);
    expect(h.requests).toHaveLength(1);
    expect(h.legacySummary).not.toHaveBeenCalled();
  });

  const changes: { name: string; scope: UsageScope; db?: 'replace' | 'null' }[] = [
    { name: 'world', scope: { ...A, roomId: B.roomId } },
    { name: 'conversation', scope: { ...A, conversationId: B.conversationId } },
    { name: 'turn', scope: { ...A, turnId: B.turnId } },
    { name: 'ledger identity', scope: A, db: 'replace' },
    { name: 'null ledger', scope: A, db: 'null' },
    { name: 'null room', scope: { ...A, roomId: null } },
  ];
  it.each(changes)('hides old values during render, before committing changed $name', async (change) => {
    const h = await loaded();
    const other = fixture();
    const db = change.db === 'null' ? null : change.db === 'replace' ? other.db : h.db;
    const visible = render(db, change.scope);
    expect(visible).toMatchObject(EMPTY);
    expect(visible.reload).not.toBe(h.api.reload);
    expect(host.writes).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(other.requests).toHaveLength(0);
    host.commitLayouts();
    expect(host.trace.slice(-2)).toEqual(['layout:cleanup', 'layout:setup']);
    expect(h.requests).toHaveLength(1);
    expect(other.requests).toHaveLength(0);
    host.flushPassive();
    const empty = db === null || change.scope.roomId === null;
    const value = snapshot();
    if (!empty) {
      const target = db === other.db ? other : h;
      expect(target.requests.at(-1)?.scope).toEqual(change.scope);
      target.request(db === other.db ? 0 : 1).resolve(value);
    }
    await drainMicrotasks();
    expect(host.writes).toHaveLength(2);
    const api = rerender(db, change.scope);
    if (empty) expect(api).toMatchObject(EMPTY);
    else expectVisible(api, value);
    expect(api.error).toBeNull();
    expect(h.requests.length + other.requests.length).toBe(empty ? 1 : 2);
  });

  it.each(['resolve', 'reject'] as const)(
    'old reload and stale %s do not invalidate or overwrite the new scope',
    async (finish) => {
      const h = fixture();
      const old = rerender(h.db, A);
      rerender(h.db, B);
      expect(h.requests).toHaveLength(2);
      await expect(old.reload()).resolves.toBeUndefined();
      expect(h.requests).toHaveLength(2);
      const value = snapshot();
      h.request(1).resolve(value);
      await drainMicrotasks();
      expect(host.writes).toHaveLength(1);
      if (finish === 'resolve') h.request(0).resolve(snapshot());
      else h.request(0).reject(new Error('old scope failed'));
      await drainMicrotasks();
      const api = rerender(h.db, B);
      expectVisible(api, value);
      expect(api.error).toBeNull();
      expect(host.writes).toHaveLength(1);
      expect(h.requests).toHaveLength(2);
    },
  );

  it('newer parallel reload wins without a second stale state publication', async () => {
    const h = await loaded();
    const older = h.api.reload();
    const newer = h.api.reload();
    expect(h.requests).toHaveLength(3);
    const value = snapshot();
    h.request(2).resolve(value);
    await newer;
    expectVisible(rerender(h.db, A), value);
    expect(host.writes).toHaveLength(2);
    h.request(1).resolve(snapshot());
    await older;
    expectVisible(rerender(h.db, A), value);
    expect(host.writes).toHaveLength(2);
    expect(h.requests).toHaveLength(3);
  });

  it.each(['resolve', 'reject'] as const)(
    'unmount cleanup prevents old callbacks from reading or publishing a late %s',
    async (finish) => {
      const h = await loaded();
      const pending = h.api.reload();
      expect(h.requests).toHaveLength(2);
      host.unmount();
      expect(host.trace.at(-1)).toBe('layout:cleanup');
      await expect(h.api.reload()).resolves.toBeUndefined();
      expect(h.requests).toHaveLength(2);
      const observed = expect(pending).resolves.toBeUndefined();
      if (finish === 'resolve') h.request(1).resolve(snapshot());
      else h.request(1).reject(new Error('unmounted read failed'));
      await observed;
      await drainMicrotasks();
      expect(host.writes).toHaveLength(1);
      await expect(h.api.reload()).resolves.toBeUndefined();
      expect(h.requests).toHaveLength(2);
    },
  );

  it('explicit reload rejects an active failure while keeping same-scope data, then clears the error on recovery', async () => {
    const h = await loaded();
    const pending = h.api.reload();
    const error = new Error('active ledger unavailable');
    const observed = expect(pending).rejects.toBe(error);
    h.request(1).reject(error);
    await observed;
    const failed = rerender(h.db, A);
    expectVisible(failed, h.value);
    expect(failed.error).toBe(error.message);
    expect(failed.reload).toBe(h.api.reload);
    expect(host.writes).toHaveLength(2);
    const recovery = failed.reload();
    const value = snapshot();
    h.request(2).resolve(value);
    await recovery;
    const recovered = rerender(h.db, A);
    expectVisible(recovered, value);
    expect(recovered.error).toBeNull();
    expect(host.writes).toHaveLength(3);
  });

  it('automatic read failures are caught and exposed without leaking an unhandled rejection', async () => {
    const h = fixture();
    rerender(h.db, A);
    h.request(0).reject(new Error('initial read failed'));
    await drainMicrotasks();
    const api = rerender(h.db, A);
    expect(api).toMatchObject({ ...EMPTY, error: 'initial read failed' });
    expect(host.writes).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
  });

  it('discarding a speculative scope render preserves the committed owner, memo identity, and pending reload', async () => {
    const h = await loaded();
    const refresh = h.api.reload();
    const trace = host.trace.slice();
    const speculative = render(h.db, B);
    expect(speculative).toMatchObject(EMPTY);
    expect(host.trace).toEqual(trace);
    await expect(speculative.reload()).resolves.toBeUndefined();
    expect(h.requests).toHaveLength(2);
    host.discard();
    const value = snapshot();
    h.request(1).resolve(value);
    await refresh;
    const committed = rerender(h.db, A);
    expectVisible(committed, value);
    expect(committed.reload).toBe(h.api.reload);
    expect(host.trace).toEqual(trace);
    expect(host.writes).toHaveLength(2);
    expect(h.requests).toHaveLength(2);
  });
});
