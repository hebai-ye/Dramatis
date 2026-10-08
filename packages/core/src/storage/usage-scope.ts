import type { UsageLedger, UsageScope, UsageScopeSummary } from './usage.js';

export async function readUsageScope(ledger: UsageLedger | null, scope: UsageScope): Promise<UsageScopeSummary> {
  if (ledger === null || scope.roomId === null) return { world: null, conversation: null, latestTurn: null };
  if (ledger.scopeSummary) return ledger.scopeSummary(scope);
  // Compatibility only: old adapters may issue more than one read. Commit their result as one UI update.
  const room = { roomId: scope.roomId };
  const conversation = scope.conversationId === null ? null : { ...room, conversationId: scope.conversationId };
  const turn = scope.turnId ?? null;
  const [world, conversationSummary, latestTurn] = await Promise.all([
    ledger.summary(room),
    conversation === null ? Promise.resolve(null) : ledger.summary(conversation),
    conversation === null || turn === null ? Promise.resolve(null) : ledger.summary({ ...conversation, turnId: turn }),
  ]);
  return { world, conversation: conversationSummary, latestTurn };
}

export interface UsageScopeOwner {
  readonly ledger: UsageLedger | null;
  readonly scope: Readonly<UsageScope>;
  readonly key: string;
}
export type UsageScopeReadResult =
  | { owner: UsageScopeOwner; request: number; value: UsageScopeSummary; error: null }
  | { owner: UsageScopeOwner; request: number; value: null; error: Error };

/** Pure identity allocation: React may call this in a render that never commits. */
export function createUsageScopeOwner(ledger: UsageLedger | null, scope: UsageScope): UsageScopeOwner {
  const normalized = { roomId: scope.roomId, conversationId: scope.conversationId, turnId: scope.turnId ?? null };
  return Object.freeze({
    ledger,
    scope: Object.freeze(normalized),
    key: JSON.stringify([normalized.roomId, normalized.conversationId, normalized.turnId]),
  });
}

/** Ownership/last-started-request fencing only. No ledger values or row cache is retained here. */
export function createUsageScopeReader() {
  let current: UsageScopeOwner | null = null;
  let request = 0;
  return {
    select(ledger: UsageLedger | null, scope: UsageScope): UsageScopeOwner {
      const candidate = createUsageScopeOwner(ledger, scope);
      const key = candidate.key;
      if (current === null || current.ledger !== ledger || current.key !== key) {
        request++;
        current = candidate;
      }
      return current;
    },
    activate(owner: UsageScopeOwner): void {
      if (owner !== current) {
        request++;
        current = owner;
      }
    },
    deactivate(owner: UsageScopeOwner): void {
      if (owner === current) {
        request++;
        current = null;
      }
    },
    isLatest(result: UsageScopeReadResult): boolean {
      return result.owner === current && result.request === request;
    },
    cancel(owner: UsageScopeOwner): void {
      if (owner === current) request++;
    },
    async read(owner: UsageScopeOwner): Promise<UsageScopeReadResult | null> {
      if (owner !== current) return null; // An old retained reload callback cannot cancel the new scope's request.
      const started = ++request;
      try {
        const value = await readUsageScope(owner.ledger, owner.scope);
        return owner === current && request === started ? { owner, request: started, value, error: null } : null;
      } catch (error) {
        return owner === current && request === started
          ? { owner, request: started, value: null, error: error instanceof Error ? error : new Error(String(error)) }
          : null;
      }
    },
  };
}
