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
  /**
   * 可选：**原子的**读-改-写（审计 B3 / B14）。
   *
   * `mutate` 拿到当前值（没有则 null），返回新值就写入，返回 `undefined` 表示不写。
   * 实现必须保证读与写在**同一个事务**里（IndexedDB 的一个 readwrite 事务会把同一仓库上的
   * 其他 readwrite 事务——包括别的标签页的——排在它后面），所以 `mutate` 必须是**同步**的。
   *
   * 返回写入后的值（没写就返回读到的值）。不实现也能跑：调用方退回 get + put（非原子）。
   */
  update?<T extends { id: string }>(
    collection: string,
    id: string,
    mutate: (current: T | null) => T | undefined,
  ): Promise<T | null>;
  clear(collection: string): Promise<void>;
}

/**
 * `update` 的统一入口：后端实现了就走原子路径，否则退回 get + put。
 *
 * 退回路径在单个 JS 线程里仍然是「读完立刻写」，只是跨标签页不再原子——语义不变，保证变弱。
 */
export async function updateEntity<T extends { id: string }>(
  store: EntityStore,
  collection: string,
  id: string,
  mutate: (current: T | null) => T | undefined,
): Promise<T | null> {
  if (store.update !== undefined) return store.update<T>(collection, id, mutate);
  const current = await store.get<T>(collection, id);
  const next = mutate(current);
  if (next === undefined) return current;
  await store.put(collection, next);
  return next;
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
