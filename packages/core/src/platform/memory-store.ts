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
     * 已知边界（写在这里免得被当成真事务）：这个实现**不隔离并发事务**。两个事务
     * 交错跑时，后失败的那个会把先提交的那批一起带回快照。它服务的是测试与
     * 「IndexedDB 不可用」时的降级运行，不是并发正确性模型。
     */
    async transaction<T>(run: (scope: EntityStore) => Promise<T>): Promise<T> {
      const snapshot = new Map<string, Map<string, unknown>>();
      for (const [collection, rows] of collections) snapshot.set(collection, new Map(rows));
      try {
        return await run(store);
      } catch (error) {
        collections.clear();
        for (const [collection, rows] of snapshot) collections.set(collection, rows);
        throw error;
      }
    },
  };

  return store;
}
