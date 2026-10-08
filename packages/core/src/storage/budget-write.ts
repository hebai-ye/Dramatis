import type { RoomId } from '../model/ids.js';
import type { Room } from '../model/room.js';
import type { BudgetLimits } from './budget.js';
import { createBudgetDraft, validateBudgetDraft } from './budget-editor.js';
import type { Repository } from './repository.js';

export interface BudgetWriteTarget {
  roomId: RoomId;
  /** Exact budget snapshot captured by the UI, not the display currency or wall clock. */
  expectedVersion: string;
}
export class BudgetWriteError extends Error {
  constructor(
    readonly code: 'invalid-budget' | 'room-missing' | 'budget-conflict',
    message: string,
  ) {
    super(message);
  }
}
function canonical(value: unknown): unknown {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array', value.map(canonical)];
  if (typeof value === 'object')
    return [
      'object',
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    ];
  return [typeof value, String(value)];
}
/** Type-preserving, key-order-independent CAS token; never persisted or logged. */
export function budgetWriteVersion(limits: BudgetLimits | null | undefined): string {
  return JSON.stringify(canonical(limits ?? null));
}
function assertShape(value: unknown): asserts value is BudgetLimits | null {
  if (value === null) return;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).some((key) => !['maxExtraCalls', 'maxCost', 'maxCostByCurrency'].includes(key))
  ) {
    throw new BudgetWriteError('invalid-budget', '预算含未知字段或结构无效，未修改；请先核验或升级客户端。');
  }
}
function assertWritable(limits: BudgetLimits | null): void {
  assertShape(limits);
  if (limits === null) return;
  for (const value of [limits.maxExtraCalls, limits.maxCost]) {
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
      throw new BudgetWriteError('invalid-budget', '上限必须是有限正数或留空，未修改预算。');
  }
  if (limits.maxExtraCalls != null && !Number.isSafeInteger(limits.maxExtraCalls))
    throw new BudgetWriteError('invalid-budget', '额外调用上限必须是正整数。');
  const map = limits.maxCostByCurrency;
  if (map != null) {
    if (
      typeof map !== 'object' ||
      Array.isArray(map) ||
      (Object.getPrototypeOf(map) !== Object.prototype && Object.getPrototypeOf(map) !== null) ||
      Object.values(map).some(
        (value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0),
      )
    )
      throw new BudgetWriteError('invalid-budget', '逐币种上限无效，未修改预算。');
  }
  const parsed = validateBudgetDraft(createBudgetDraft(limits));
  if (!parsed.ok) throw new BudgetWriteError('invalid-budget', parsed.errors.join('；'));
}

/** Compare and patch only budget inside one transaction; preserve all newer unrelated Room fields. */
export async function saveRoomBudget(
  repository: Repository,
  input: BudgetWriteTarget & { limits: BudgetLimits | null },
): Promise<Room> {
  const roomId = input.roomId,
    expectedVersion = input.expectedVersion;
  const limits = structuredClone(input.limits);
  assertWritable(limits);
  const desired = budgetWriteVersion(limits);
  return repository.atomic(async (scope) => {
    const current = await scope.getRoom(roomId);
    if (current === null) throw new BudgetWriteError('room-missing', '目标世界已删除或不存在，预算未保存。');
    assertShape(current.budget ?? null);
    const version = budgetWriteVersion(current.budget);
    if (version === desired) return current; // Confirmed persisted state, not an optimistic UI echo.
    if (version !== expectedVersion)
      throw new BudgetWriteError('budget-conflict', '预算已被其他操作修改，请保留草稿并重新核对后保存。');
    await scope.saveRoom({ ...current, budget: limits });
    const saved = await scope.getRoom(roomId);
    if (saved === null || budgetWriteVersion(saved.budget) !== desired)
      throw new BudgetWriteError('budget-conflict', '保存后的预算核验失败，事务已撤回。');
    return saved;
  });
}
