/**
 * 实体存储（设计文档 §7.3，ROADMAP P0-1）。
 *
 * 这是平台能力适配层的第一组接口。Web 用 IndexedDB 实现，将来桌面壳换成
 * 本地 SQLite —— 只要这层接口不变，仓储层与 UI 都不需要改动。
 *
 * 故意保持极小的表面积：只有「按 id 读写」和「带条件的列表查询」两种能力。
 * 复杂的检索需求属于记忆系统，应该建在这一层之上，而不是让存储层长成一个
 * 查询语言。
 */
export interface EntityQuery {
  /** 顶层字段的精确匹配。 */
  where?: Record<string, unknown>;
  /** 排序字段，缺省时保持插入顺序。 */
  orderBy?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface EntityStore {
  /** 实现标识，用于诊断，例如 'memory' / 'indexeddb' / 'sqlite'。 */
  readonly kind: string;
  get<T>(collection: string, id: string): Promise<T | null>;
  put<T extends { id: string }>(collection: string, value: T): Promise<void>;
  bulkPut<T extends { id: string }>(collection: string, values: readonly T[]): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
  list<T>(collection: string, query?: EntityQuery): Promise<T[]>;
  count(collection: string, where?: Record<string, unknown>): Promise<number>;
  /**
   * 可选：只要 `updatedAt`（缺省**严格大于**）`since` 的那些（顺序 62 / 68）。
   *
   * 同步每 20 秒跑一次增量拉推，在此之前它只能把 12 个集合**整表读出来**再逐条比时间戳——
   * 600 条消息的对话就是每 20 秒白读 600 条。有这个口子之后，带索引的实现可以直接
   * 从 `updatedAt` 索引上取那几条。
   *
   * 不实现它也能跑：调用方会退回整表 + 逐条过滤（语义完全一致，只是慢）。
   *
   * `options.inclusive` 是顺序 68 加的：账单的 `since` 语义是「这个时刻（**含**）之后」，
   * 而同步的水位线必须**不含**等于（水位线是「这一毫秒推过了」，含等于会把同毫秒的记录
   * 反复推）。两者都要，所以做成一个可选开关，而不是把默认语义改掉——
   * 改默认值等于悄悄改同步协议。
   */
  listSince?<T>(collection: string, updatedAt: string, options?: { inclusive?: boolean }): Promise<T[]>;
  clear(collection: string): Promise<void>;
}

/** 顶层字段的浅比较匹配，null 与 undefined 视为等价。 */
export function matchesWhere(item: unknown, where?: Record<string, unknown>): boolean {
  if (!where) return true;
  if (typeof item !== 'object' || item === null) return false;

  const record = item as Record<string, unknown>;
  for (const [key, expected] of Object.entries(where)) {
    const actual = record[key];
    if (expected === null || expected === undefined) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function toComparable(value: unknown): string | number | null {
  if (typeof value === 'number' || typeof value === 'string') return value;
  return null;
}

/** 供各实现复用的排序与分页，保证不同后端的语义完全一致。 */
export function applyQuery<T>(items: T[], query?: EntityQuery): T[] {
  let result = items;

  if (query?.orderBy !== undefined) {
    const field = query.orderBy;
    const factor = query.direction === 'desc' ? -1 : 1;
    result = [...result].sort((a, b) => {
      const left = toComparable((a as Record<string, unknown>)[field]);
      const right = toComparable((b as Record<string, unknown>)[field]);
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      if (left < right) return -1 * factor;
      return 1 * factor;
    });
  } else if (query?.direction === 'desc') {
    result = [...result].reverse();
  }

  const offset = query?.offset ?? 0;
  const limit = query?.limit;
  if (offset > 0 || limit !== undefined) {
    result = limit === undefined ? result.slice(offset) : result.slice(offset, offset + limit);
  }

  return result;
}
