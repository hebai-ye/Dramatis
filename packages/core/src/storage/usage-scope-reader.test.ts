import { describe, expect, it, vi } from 'vitest';
import { conversationId, roomId } from '../model/ids.js';
import type { UsageLedger, UsageScope, UsageScopeSummary, UsageSummary } from './usage.js';
import { createUsageScopeOwner, createUsageScopeReader, readUsageScope } from './usage-scope.js';

// Pure scheduler/adapter tests: these do not mount React or establish effect/StrictMode correctness.
// Distinct object identities are sentinels, not aggregation or billing-value expectations.
const A: UsageScope = { roomId: roomId('world-a'), conversationId: conversationId('conversation-a'), turnId: 'turn-a' };
const B: UsageScope = { roomId: roomId('world-b'), conversationId: conversationId('conversation-b'), turnId: 'turn-b' };
const EMPTY: UsageScopeSummary = { world: null, conversation: null, latestTurn: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

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

function legacyLedger() {
  const read = vi.fn<UsageLedger['summary']>();
  const ledger: UsageLedger = {
    summary: read,
    async record() {
      throw new Error('scheduler must not record usage');
    },
    async list() {
      throw new Error('scheduler must not read raw rows');
    },
    async removeByRoom() {
      throw new Error('scheduler must not delete usage');
    },
  };
  return { ledger, summary: read };
}

function batchLedger() {
  const legacy = legacyLedger();
  const scopeSummary = vi.fn<NonNullable<UsageLedger['scopeSummary']>>();
  const ledger: UsageLedger = { ...legacy.ledger, scopeSummary };
  return { ledger, summary: legacy.summary, scopeSummary };
}

const transitions: { name: string; scope: UsageScope; ledger?: 'replace' | 'null' }[] = [
  { name: 'world', scope: { ...A, roomId: B.roomId } },
  { name: 'conversation', scope: { ...A, conversationId: B.conversationId } },
  { name: 'turn', scope: { ...A, turnId: B.turnId } },
  { name: 'null conversation', scope: { ...A, conversationId: null } },
  { name: 'null turn', scope: { ...A, turnId: null } },
  { name: 'omitted turn', scope: { roomId: A.roomId, conversationId: A.conversationId } },
  { name: 'null room', scope: { ...A, roomId: null } },
  { name: 'replacement ledger with identical scope', scope: A, ledger: 'replace' },
  { name: 'null ledger with identical scope', scope: A, ledger: 'null' },
];

describe('usage scope reader ownership and last-started request fencing', () => {
  it.each(transitions)('discards an old read after changing $name', async (change) => {
    const reader = createUsageScopeReader();
    const first = batchLedger();
    const second = batchLedger();
    const old = deferred<UsageScopeSummary>();
    const next = deferred<UsageScopeSummary>();
    first.scopeSummary.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    second.scopeSummary.mockReturnValueOnce(next.promise);
    const oldOwner = reader.select(first.ledger, A);
    const oldRead = reader.read(oldOwner);
    const ledger = change.ledger === 'null' ? null : change.ledger === 'replace' ? second.ledger : first.ledger;
    const owner = reader.select(ledger, change.scope);
    expect(owner).not.toBe(oldOwner);
    const currentRead = reader.read(owner);
    const value = snapshot();
    next.resolve(value);
    const result = await currentRead;
    expect(result).not.toBeNull();
    expect(result?.owner).toBe(owner);
    expect(result?.error).toBeNull();
    if (ledger === null || change.scope.roomId === null) {
      expect(result?.value).toEqual(EMPTY);
      expect(first.scopeSummary).toHaveBeenCalledTimes(1);
      expect(second.scopeSummary).not.toHaveBeenCalled();
    } else {
      expect(result?.value).toBe(value);
      const called = ledger === first.ledger ? first.scopeSummary : second.scopeSummary;
      expect(called).toHaveBeenLastCalledWith(owner.scope);
    }
    old.resolve(snapshot());
    await expect(oldRead).resolves.toBeNull();
    if (!result) throw new Error('missing current read result');
    expect(reader.isLatest(result)).toBe(true);
  });

  it('does not resurrect the first A owner after A -> B -> A', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const oldA = deferred<UsageScopeSummary>();
    const oldB = deferred<UsageScopeSummary>();
    const newA = deferred<UsageScopeSummary>();
    h.scopeSummary
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(oldB.promise)
      .mockReturnValueOnce(newA.promise);
    const ownerA = reader.select(h.ledger, A);
    const readA = reader.read(ownerA);
    const ownerB = reader.select(h.ledger, B);
    const readB = reader.read(ownerB);
    const ownerAgain = reader.select(h.ledger, { ...A });
    expect(ownerAgain.key).toBe(ownerA.key);
    expect(ownerAgain).not.toBe(ownerA);
    const readAgain = reader.read(ownerAgain);
    // A retained callback and cleanup from the first A must not affect the new A epoch.
    await expect(reader.read(ownerA)).resolves.toBeNull();
    reader.cancel(ownerA);
    reader.cancel(ownerB);
    expect(h.scopeSummary).toHaveBeenCalledTimes(3);
    const value = snapshot();
    newA.resolve(value);
    const result = await readAgain;
    expect(result?.value).toBe(value);
    oldB.resolve(snapshot());
    oldA.resolve(snapshot());
    await expect(readA).resolves.toBeNull();
    await expect(readB).resolves.toBeNull();
    if (!result) throw new Error('missing new A result');
    expect(reader.isLatest(result)).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps the newer same-scope read when the older read later %s(s)',
    async (finish) => {
      const reader = createUsageScopeReader();
      const h = batchLedger();
      const older = deferred<UsageScopeSummary>();
      const newer = deferred<UsageScopeSummary>();
      h.scopeSummary.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const owner = reader.select(h.ledger, A);
      const first = reader.read(owner);
      const second = reader.read(owner);
      const value = snapshot();
      newer.resolve(value);
      const result = await second;
      expect(result?.value).toBe(value);
      if (finish === 'resolve') older.resolve(snapshot());
      else older.reject(new Error('stale same-scope failure'));
      await expect(first).resolves.toBeNull();
      if (!result) throw new Error('missing newer result');
      expect(reader.isLatest(result)).toBe(true);
    },
  );

  it('ignores an old owner read invoked only after the new scope has started reading', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(next.promise);
    const oldOwner = reader.select(h.ledger, A);
    const owner = reader.select(h.ledger, B);
    const pending = reader.read(owner);
    await expect(reader.read(oldOwner)).resolves.toBeNull();
    expect(h.scopeSummary).toHaveBeenCalledTimes(1);
    expect(h.scopeSummary).toHaveBeenCalledWith(owner.scope);
    const value = snapshot();
    next.resolve(value);
    const result = await pending;
    expect(result?.value).toBe(value);
    if (!result) throw new Error('old callback invalidated the new request');
    expect(reader.isLatest(result)).toBe(true);
  });

  it.each(['select', 'cancel'] as const)('discards a late rejection after %s invalidation', async (invalidate) => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const failed = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(failed.promise);
    const owner = reader.select(h.ledger, A);
    const pending = reader.read(owner);
    if (invalidate === 'select') reader.select(h.ledger, B);
    else reader.cancel(owner);
    failed.reject(new Error('obsolete read must not surface as active error'));
    await expect(pending).resolves.toBeNull();
  });

  it.each([new Error('active ledger failed'), 'adapter rejected a string', null])(
    'returns a locatable active error for %s',
    async (failure) => {
      const reader = createUsageScopeReader();
      const h = batchLedger();
      const failed = deferred<UsageScopeSummary>();
      h.scopeSummary.mockReturnValueOnce(failed.promise);
      const owner = reader.select(h.ledger, A);
      const pending = reader.read(owner);
      failed.reject(failure);
      const result = await pending;
      expect(result?.owner).toBe(owner);
      expect(result?.value).toBeNull();
      expect(result?.error).toBeInstanceOf(Error);
      expect(result?.error?.message).toBe(failure instanceof Error ? failure.message : String(failure));
      if (failure instanceof Error) expect(result?.error).toBe(failure);
      if (!result) throw new Error('active failure was discarded');
      expect(reader.isLatest(result)).toBe(true);
      expect(result.request).toEqual(expect.any(Number));
      reader.cancel(owner);
      expect(reader.isLatest(result)).toBe(false);
    },
  );

  it('captures synchronous adapter errors and can recover on the same owner', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const error = new Error('adapter threw before returning a Promise');
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockReturnValueOnce(next.promise);
    const owner = reader.select(h.ledger, A);
    const failed = await reader.read(owner);
    expect(failed?.error).toBe(error);
    if (!failed) throw new Error('missing synchronous failure');
    const pending = reader.read(owner);
    expect(reader.isLatest(failed)).toBe(false);
    const value = snapshot();
    next.resolve(value);
    const result = await pending;
    expect(result?.value).toBe(value);
    expect(result?.error).toBeNull();
  });

  it('invalidates an already-returned success as soon as a new read starts, before that read settles', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const first = deferred<UsageScopeSummary>();
    const second = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const owner = reader.select(h.ledger, A);
    const pending = reader.read(owner);
    const firstValue = snapshot();
    first.resolve(firstValue);
    const completed = await pending;
    expect(completed?.value).toBe(firstValue);
    if (!completed) throw new Error('missing first result');
    expect(reader.isLatest(completed)).toBe(true);
    const fresh = reader.read(owner);
    expect(reader.isLatest(completed)).toBe(false);
    const secondValue = snapshot();
    second.resolve(secondValue);
    const result = await fresh;
    expect(result?.value).toBe(secondValue);
    if (!result) throw new Error('missing second result');
    expect(result.request).toBeGreaterThan(completed.request);
    expect(reader.isLatest(result)).toBe(true);
    reader.select(h.ledger, B);
    expect(reader.isLatest(result)).toBe(false);
  });

  it('old-owner cleanup cannot cancel a new scope request', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(next.promise);
    const oldOwner = reader.select(h.ledger, A);
    const owner = reader.select(h.ledger, B);
    const pending = reader.read(owner);
    reader.cancel(oldOwner);
    reader.cancel(oldOwner);
    const value = snapshot();
    next.resolve(value);
    const result = await pending;
    expect(result?.value).toBe(value);
    if (!result) throw new Error('old cleanup cancelled the new request');
    expect(reader.isLatest(result)).toBe(true);
  });

  it('current-owner cleanup fences pending and completed results, but permits a fresh read', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const old = deferred<UsageScopeSummary>();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const owner = reader.select(h.ledger, A);
    const pending = reader.read(owner);
    reader.cancel(owner);
    expect(reader.select(h.ledger, { ...A })).toBe(owner);
    const fresh = reader.read(owner);
    old.resolve(snapshot());
    await expect(pending).resolves.toBeNull();
    const value = snapshot();
    next.resolve(value);
    const result = await fresh;
    expect(result?.value).toBe(value);
    if (!result) throw new Error('missing fresh read');
    expect(reader.isLatest(result)).toBe(true);
    reader.cancel(owner);
    expect(reader.isLatest(result)).toBe(false);
  });

  it('repeated equivalent selection preserves identity and an in-flight request', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(next.promise);
    const input: UsageScope = { roomId: A.roomId, conversationId: A.conversationId };
    const owner = reader.select(h.ledger, input);
    const pending = reader.read(owner);
    expect(reader.select(h.ledger, { ...input, turnId: null })).toBe(owner);
    expect(reader.select(h.ledger, { ...input, turnId: undefined })).toBe(owner);
    expect(reader.select(h.ledger, { ...input })).toBe(owner);
    expect(h.scopeSummary).toHaveBeenCalledTimes(1);
    expect(owner.scope.turnId).toBeNull();
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(owner.scope)).toBe(true);
    input.roomId = B.roomId;
    expect(owner.scope.roomId).toBe(A.roomId);
    const value = snapshot();
    next.resolve(value);
    const result = await pending;
    expect(result?.value).toBe(value);
    if (!result) throw new Error('equivalent select invalidated the request');
    expect(reader.select(h.ledger, { ...owner.scope })).toBe(owner);
    expect(reader.isLatest(result)).toBe(true);
    reader.select(h.ledger, { ...owner.scope, turnId: '' });
    expect(reader.isLatest(result)).toBe(false);
  });

  it.each(['ledger', 'room'] as const)(
    'restores a live scope after a null %s without resurrecting its old owner',
    async (missing) => {
      const reader = createUsageScopeReader();
      const h = batchLedger();
      const first = reader.select(h.ledger, A);
      const ledger = missing === 'ledger' ? null : h.ledger;
      const scope = missing === 'room' ? { ...A, roomId: null } : A;
      const emptyOwner = reader.select(ledger, scope);
      expect(reader.select(ledger, { ...scope })).toBe(emptyOwner);
      const empty = await reader.read(emptyOwner);
      expect(empty?.value).toEqual(EMPTY);
      if (!empty) throw new Error('missing empty scope result');
      expect(reader.isLatest(empty)).toBe(true);
      const owner = reader.select(h.ledger, A);
      expect(owner).not.toBe(first);
      expect(reader.isLatest(empty)).toBe(false);
      const next = deferred<UsageScopeSummary>();
      h.scopeSummary.mockReturnValueOnce(next.promise);
      const pending = reader.read(owner);
      await expect(reader.read(first)).resolves.toBeNull();
      reader.cancel(emptyOwner);
      const value = snapshot();
      next.resolve(value);
      expect((await pending)?.value).toBe(value);
    },
  );
});

// Commit lifecycle is modeled explicitly; no React renderer, interrupted render, or layout effect runs here.
describe('usage scope reader explicit activation and deactivation', () => {
  it('constructing an uncommitted owner does not invalidate the active owner or start a read', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(next.promise);
    const active = createUsageScopeOwner(h.ledger, A);
    reader.activate(active);
    const pending = reader.read(active);
    const uncommitted = createUsageScopeOwner(h.ledger, B);
    await expect(reader.read(uncommitted)).resolves.toBeNull();
    expect(h.scopeSummary).toHaveBeenCalledTimes(1);
    expect(h.scopeSummary).toHaveBeenCalledWith(active.scope);
    const value = snapshot();
    next.resolve(value);
    const result = await pending;
    expect(result?.owner).toBe(active);
    expect(result?.value).toBe(value);
    if (!result) throw new Error('pure owner construction invalidated the active read');
    expect(reader.isLatest(result)).toBe(true);
    createUsageScopeOwner(h.ledger, { ...A });
    expect(reader.isLatest(result)).toBe(true);
  });

  it('deactivation invalidates an already-returned result and prevents retained callbacks from reading', async () => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(next.promise);
    const owner = createUsageScopeOwner(h.ledger, A);
    reader.activate(owner);
    const pending = reader.read(owner);
    const value = snapshot();
    next.resolve(value);
    const result = await pending;
    expect(result?.value).toBe(value);
    if (!result) throw new Error('missing active result');
    expect(reader.isLatest(result)).toBe(true);
    reader.deactivate(owner);
    expect(reader.isLatest(result)).toBe(false);
    await expect(reader.read(owner)).resolves.toBeNull();
    await expect(reader.read(owner)).resolves.toBeNull();
    expect(h.scopeSummary).toHaveBeenCalledTimes(1);
    expect(h.summary).not.toHaveBeenCalled();
    expect(reader.isLatest(result)).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)(
    'deactivation prevents a pending read from committing when it later %s(s)',
    async (finish) => {
      const reader = createUsageScopeReader();
      const h = batchLedger();
      const old = deferred<UsageScopeSummary>();
      h.scopeSummary.mockReturnValueOnce(old.promise);
      const owner = createUsageScopeOwner(h.ledger, A);
      reader.activate(owner);
      const pending = reader.read(owner);
      reader.deactivate(owner);
      await expect(reader.read(owner)).resolves.toBeNull();
      expect(h.scopeSummary).toHaveBeenCalledTimes(1);
      if (finish === 'resolve') old.resolve(snapshot());
      else old.reject(new Error('deactivated request failed'));
      await expect(pending).resolves.toBeNull();
      await expect(reader.read(owner)).resolves.toBeNull();
      expect(h.scopeSummary).toHaveBeenCalledTimes(1);
      expect(h.summary).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: 'different scope', scope: B },
    { name: 'same scope, distinct owner', scope: A },
  ])('old-owner deactivation cannot cancel the new owner: $name', async ({ scope }) => {
    const reader = createUsageScopeReader();
    const h = batchLedger();
    const old = deferred<UsageScopeSummary>();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const oldOwner = createUsageScopeOwner(h.ledger, A);
    reader.activate(oldOwner);
    const oldRead = reader.read(oldOwner);
    const owner = createUsageScopeOwner(h.ledger, scope);
    expect(owner).not.toBe(oldOwner);
    reader.activate(owner);
    const pending = reader.read(owner);
    reader.deactivate(oldOwner);
    reader.deactivate(oldOwner);
    await expect(reader.read(oldOwner)).resolves.toBeNull();
    expect(h.scopeSummary).toHaveBeenCalledTimes(2);
    const value = snapshot();
    next.resolve(value);
    const result = await pending;
    expect(result?.owner).toBe(owner);
    expect(result?.value).toBe(value);
    if (!result) throw new Error('old-owner deactivation cancelled the new read');
    expect(reader.isLatest(result)).toBe(true);
    old.reject(new Error('old owner failed after replacement'));
    await expect(oldRead).resolves.toBeNull();
    reader.deactivate(oldOwner);
    expect(reader.isLatest(result)).toBe(true);
  });

  it.each(['before', 'after'] as const)(
    'explicitly reactivates the same owner without reviving its old read, which finishes %s the fresh read starts',
    async (finish) => {
      const reader = createUsageScopeReader();
      const h = batchLedger();
      const old = deferred<UsageScopeSummary>();
      const next = deferred<UsageScopeSummary>();
      h.scopeSummary.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      const owner = createUsageScopeOwner(h.ledger, A);
      reader.activate(owner);
      const oldRead = reader.read(owner);
      reader.deactivate(owner);
      await expect(reader.read(owner)).resolves.toBeNull();
      expect(h.scopeSummary).toHaveBeenCalledTimes(1);
      reader.activate(owner);
      if (finish === 'before') {
        // Reactivation alone must not make an earlier activation's request current again.
        old.resolve(snapshot());
        await expect(oldRead).resolves.toBeNull();
      }
      const fresh = reader.read(owner);
      expect(h.scopeSummary).toHaveBeenCalledTimes(2);
      const value = snapshot();
      next.resolve(value);
      const result = await fresh;
      expect(result?.owner).toBe(owner);
      expect(result?.value).toBe(value);
      expect(result?.error).toBeNull();
      if (!result) throw new Error('explicit reactivation did not permit a fresh read');
      if (finish === 'after') {
        old.resolve(snapshot());
        await expect(oldRead).resolves.toBeNull();
      }
      expect(reader.isLatest(result)).toBe(true);
    },
  );
});

describe('readUsageScope legacy and optional batch capability compatibility', () => {
  it.each(['legacy', 'batch'] as const)('short-circuits null ledger/room before calling a %s adapter', async (kind) => {
    const h = batchLedger();
    const ledger = kind === 'batch' ? h.ledger : { ...h.ledger, scopeSummary: undefined };
    await expect(readUsageScope(null, A)).resolves.toEqual(EMPTY);
    await expect(readUsageScope(ledger, { ...A, roomId: null })).resolves.toEqual(EMPTY);
    expect(h.summary).not.toHaveBeenCalled();
    expect(h.scopeSummary).not.toHaveBeenCalled();
  });

  const legacyCases: { name: string; scope: UsageScope; filters: object[] }[] = [
    { name: 'world only even with a turn', scope: { ...A, conversationId: null }, filters: [{ roomId: A.roomId }] },
    {
      name: 'omitted turn',
      scope: { roomId: A.roomId, conversationId: A.conversationId },
      filters: [{ roomId: A.roomId }, { roomId: A.roomId, conversationId: A.conversationId }],
    },
    {
      name: 'null turn',
      scope: { ...A, turnId: null },
      filters: [{ roomId: A.roomId }, { roomId: A.roomId, conversationId: A.conversationId }],
    },
    {
      name: 'full scope',
      scope: A,
      filters: [{ roomId: A.roomId }, { roomId: A.roomId, conversationId: A.conversationId }, A],
    },
    {
      name: 'empty-string turn is not null',
      scope: { ...A, turnId: '' },
      filters: [{ roomId: A.roomId }, { roomId: A.roomId, conversationId: A.conversationId }, { ...A, turnId: '' }],
    },
  ];
  it.each(legacyCases)('requests only the applicable legacy summaries: $name', async ({ scope, filters }) => {
    const h = legacyLedger();
    const gates = filters.map(() => deferred<UsageSummary>());
    const values = filters.map(() => summary());
    for (const gate of gates) h.summary.mockReturnValueOnce(gate.promise);
    const pending = readUsageScope(h.ledger, scope);
    expect(h.summary.mock.calls).toEqual(filters.map((filter) => [filter]));
    gates.forEach((gate, index) => {
      const value = values[index];
      if (value) gate.resolve(value);
    });
    const result = await pending;
    expect(result.world).toBe(values[0]);
    expect(result.conversation).toBe(values[1] ?? null);
    expect(result.latestTurn).toBe(values[2] ?? null);
  });

  it('publishes one legacy result only after all three out-of-order reads finish', async () => {
    const h = legacyLedger();
    const world = deferred<UsageSummary>();
    const conversation = deferred<UsageSummary>();
    const turn = deferred<UsageSummary>();
    h.summary
      .mockReturnValueOnce(world.promise)
      .mockReturnValueOnce(conversation.promise)
      .mockReturnValueOnce(turn.promise);
    const settled = vi.fn();
    const pending = readUsageScope(h.ledger, A);
    const observed = pending.then(settled);
    expect(h.summary).toHaveBeenCalledTimes(3);
    const worldValue = summary();
    const conversationValue = summary();
    const turnValue = summary();
    turn.resolve(turnValue);
    world.resolve(worldValue);
    await Promise.all([turn.promise, world.promise]);
    expect(settled).not.toHaveBeenCalled();
    conversation.resolve(conversationValue);
    const result = await pending;
    await observed;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(result.world).toBe(worldValue);
    expect(result.conversation).toBe(conversationValue);
    expect(result.latestTurn).toBe(turnValue);
  });

  it('prefers the batch capability exactly once, preserving its receiver and snapshot identity', async () => {
    const h = batchLedger();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockImplementationOnce(function (this: UsageLedger, scope) {
      expect(this).toBe(h.ledger);
      expect(scope).toBe(A);
      return next.promise;
    });
    const pending = readUsageScope(h.ledger, A);
    expect(h.scopeSummary).toHaveBeenCalledTimes(1);
    expect(h.summary).not.toHaveBeenCalled();
    const value = snapshot();
    next.resolve(value);
    await expect(pending).resolves.toBe(value);
  });

  it('does not silently retry legacy reads after the batch capability fails', async () => {
    const h = batchLedger();
    const next = deferred<UsageScopeSummary>();
    h.scopeSummary.mockReturnValueOnce(next.promise);
    const pending = readUsageScope(h.ledger, A);
    const failure = new Error('batch read failed');
    next.reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(h.scopeSummary).toHaveBeenCalledTimes(1);
    expect(h.summary).not.toHaveBeenCalled();
  });

  it('locates legacy failures on the active owner and handles later sibling rejections', async () => {
    const reader = createUsageScopeReader();
    const h = legacyLedger();
    const world = deferred<UsageSummary>();
    const conversation = deferred<UsageSummary>();
    const turn = deferred<UsageSummary>();
    h.summary
      .mockReturnValueOnce(world.promise)
      .mockReturnValueOnce(conversation.promise)
      .mockReturnValueOnce(turn.promise);
    const owner = reader.select(h.ledger, A);
    const pending = reader.read(owner);
    const failure = new Error('conversation summary failed');
    conversation.reject(failure);
    const result = await pending;
    expect(result?.owner).toBe(owner);
    expect(result?.error).toBe(failure);
    expect(result?.value).toBeNull();
    if (!result) throw new Error('legacy failure was discarded');
    expect(reader.isLatest(result)).toBe(true);
    // Promise.all must already observe every sibling; these must not become unhandled rejections.
    world.reject(new Error('world failed later'));
    turn.reject(new Error('turn failed later'));
    await Promise.resolve();
  });
});
