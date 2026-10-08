import { applyQuery, type EntityQuery, type EntityStore, matchesWhere } from './entity-store.js';

/**
 * 内存实现。
 *
 * 两个用途：给 `core` 的测试提供确定性后端（无需浏览器环境），
 * 以及在没有可用持久化后端时作为降级方案，让应用至少能跑起来。
 */
export function createMemoryEntityStore(): EntityStore {
  const collections = new Map<string, Map<string, unknown>>();

  const table = (collection: string): Map<string, unknown> => {
    let existing = collections.get(collection);
    if (!existing) {
      existing = new Map();
      collections.set(collection, existing);
    }
    return existing;
  };

  const store: EntityStore = {
    kind: 'memory',

    async get<T>(collection: string, id: string): Promise<T | null> {
      const value = table(collection).get(id);
      return value === undefined ? null : structuredClone(value as T);
    },

    async put<T extends { id: string }>(collection: string, value: T): Promise<void> {
      table(collection).set(value.id, structuredClone(value));
    },

    async bulkPut<T extends { id: string }>(collection: string, values: readonly T[]): Promise<void> {
      const target = table(collection);
      for (const value of values) {
        target.set(value.id, structuredClone(value));
      }
    },

    async remove(collection: string, id: string): Promise<void> {
      table(collection).delete(id);
    },

    async list<T>(collection: string, query?: EntityQuery): Promise<T[]> {
      const all = [...table(collection).values()].filter((item) => matchesWhere(item, query?.where));
      return structuredClone(applyQuery(all, query)) as T[];
    },

    async count(collection: string, where?: Record<string, unknown>): Promise<number> {
      let total = 0;
      for (const item of table(collection).values()) {
        if (matchesWhere(item, where)) total += 1;
      }
      return total;
    },

    /**
     * 增量读口（顺序 62 / 68）：内存实现直接过滤，语义与带索引的实现必须一致。
     *
     * `inclusive` 只影响边界上那一条（`>=` 还是 `>`）：账单要含等于，同步水位线不能含。
     */
    async listSince<T>(collection: string, updatedAt: string, options?: { inclusive?: boolean }): Promise<T[]> {
      const inclusive = options?.inclusive ?? false;
      const rows = [...table(collection).values()].filter((item) => {
        const stamp = (item as { updatedAt?: unknown }).updatedAt;
        if (typeof stamp !== 'string') return false;
        return inclusive ? stamp >= updatedAt : stamp > updatedAt;
      });
      return structuredClone(rows) as T[];
    },

    /** 原子读-改-写：内存实现里读和写之间没有 await，天然原子。 */
    async update<T extends { id: string }>(
      collection: string,
      id: string,
      mutate: (current: T | null) => T | undefined,
    ): Promise<T | null> {
      const target = table(collection);
      const raw = target.get(id);
      const current = raw === undefined ? null : (structuredClone(raw) as T);
      const next = mutate(current);
      if (next === undefined) return current;
      target.set(id, structuredClone({ ...next, id }));
      return structuredClone(next);
    },

    async clear(collection: string): Promise<void> {
      table(collection).clear();
    },

    /**
     * 顺序 77：整批提交或整批回滚。
     *
     * 内存实现的每次写都是「克隆后整条替换」，**从不原地修改已存对象**，所以各集合
     * Map 的浅拷贝就是一份正确的快照——回滚时把 Map 换回快照即可，不需要深拷值。
     *
     * 事务与普通操作共用串行队列，作用域直达数据，不开嵌套事务。
     * 外部操作等提交/回滚后才运行，失败事务不会回滚另一调用方的写入。
     */
    async transaction<T>(run: (scope: EntityStore) => Promise<T>): Promise<T> {
      const snapshot = new Map<string, Map<string, unknown>>();
      for (const [collection, rows] of collections) snapshot.set(collection, new Map(rows));
      try {
        return await run({ ...store, transaction: undefined });
      } catch (error) {
        collections.clear();
        for (const [collection, rows] of snapshot) collections.set(collection, rows);
        throw error;
      }
    },
  };

  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  function serial<T>(run: () => Promise<T>): Promise<T> {
    queued++;
    const next = tail.then(run, run);
    tail = next.then(
      () => {
        queued--;
      },
      () => {
        queued--;
      },
    );
    return next;
  }
  function operation<T>(run: () => Promise<T>): Promise<T> {
    // Ordinary raw operations perform their work synchronously before returning a Promise.
    // Preserve that fast path when idle; only queue behind an active/pending transaction.
    return queued === 0 ? run() : serial(run);
  }
  // Generic signatures stay intact; the scope passed by transaction never calls these wrappers.
  return {
    kind: store.kind,
    get: <T>(collection: string, id: string) => operation(() => store.get<T>(collection, id)),
    put: <T extends { id: string }>(collection: string, value: T) => operation(() => store.put(collection, value)),
    bulkPut: <T extends { id: string }>(collection: string, values: readonly T[]) =>
      operation(() => store.bulkPut(collection, values)),
    remove: (collection, id) => operation(() => store.remove(collection, id)),
    list: <T>(collection: string, query?: EntityQuery) => operation(() => store.list<T>(collection, query)),
    count: (collection, where) => operation(() => store.count(collection, where)),
    listSince: <T>(collection: string, at: string, options?: { inclusive?: boolean }) =>
      operation(() => {
        if (!store.listSince) throw new Error('内存增量读口缺失。');
        return store.listSince<T>(collection, at, options);
      }),
    update: <T extends { id: string }>(collection: string, id: string, mutate: (row: T | null) => T | undefined) =>
      operation(() => {
        if (!store.update) throw new Error('内存原子写口缺失。');
        return store.update<T>(collection, id, mutate);
      }),
    clear: (collection) => operation(() => store.clear(collection)),
    transaction: <T>(run: (scope: EntityStore) => Promise<T>) =>
      serial(() => {
        if (!store.transaction) throw new Error('内存事务缺失。');
        return store.transaction(run);
      }),
  };
}
