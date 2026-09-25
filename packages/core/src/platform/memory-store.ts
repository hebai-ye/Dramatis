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

  return {
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

    async clear(collection: string): Promise<void> {
      table(collection).clear();
    },
  };
}
