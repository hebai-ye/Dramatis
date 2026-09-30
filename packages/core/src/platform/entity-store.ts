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
  /**
   * 可选：把一组写入放进**同一个**存储事务（顺序 77）。
   *
   * `run` 拿到的是一个「作用域里的 store」：它读写的都是同一个事务，外面在事务
   * 结束前看不到其中任何一条。`run` 抛异常 = 整批回滚；正常返回 = 一起提交。
   *
   * 为什么需要它：重抽成功后的收拾是「改这条消息 + 清这一轮的任务键 + 撤这一轮的
   * 记忆与情绪」三步跨三个集合的写。以前每一步各自一个事务，中间断电/写失败就会
   * 留下「回复换新了、记忆还挂着旧的」这种对不上的状态。所有集合都落在同一张
   * 对象仓库里，所以物理上一次事务就能覆盖它们。
   *
   * 两条硬约束（实现侧与调用侧都要守）：
   * 1. `run` 里**只能 await 存储操作**。IndexedDB 的事务在「没有请求在飞」时会自动
   *    提交，中间插一个定时器或网络请求，后面的写入就落到事务外面去了——那比不做
   *    更糟：看起来是原子的，其实不是。
   * 2. 网络调用、账目流水（钱花了不能因为回滚就不记账）、唤醒后台（`kick`）都必须
   *    留在事务外。
   *
   * 不实现也能跑：调用方走 `withStoreTransaction`，退回「直接跑、不保证原子」——
   * 语义不变，保证变弱（与 `updateEntity` 同一套话术）。
   */
  transaction?<T>(run: (scope: EntityStore) => Promise<T>): Promise<T>;
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

/**
 * `transaction` 的统一入口：后端实现了就真事务，否则把同一个 store 直接交回去。
 *
 * 退回路径上每一步仍然各自成事务，批量写入中途失败会留下**部分状态**。调用方不该
 * 依赖「一定有原子性」，但可以依赖「一定跑得通」——这条与 `updateEntity` 一致。
 */
export async function withStoreTransaction<T>(store: EntityStore, run: (scope: EntityStore) => Promise<T>): Promise<T> {
  if (store.transaction !== undefined) return store.transaction(run);
  return run(store);
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
