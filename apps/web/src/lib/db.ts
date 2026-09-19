import {
  applyQuery,
  type BackgroundRunner,
  createBackgroundRunner,
  createMemoryEntityStore,
  createUsageLedger,
  type EntityQuery,
  type EntityStore,
  matchesWhere,
  Repository,
  type UsageLedger,
} from '@dramatis/core';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

const DB_NAME = 'dramatis';
const DB_VERSION = 1;
const STORE = 'entities';

interface EntityRecord {
  collection: string;
  id: string;
  value: unknown;
}

interface DramatisSchema extends DBSchema {
  entities: {
    key: [string, string];
    value: EntityRecord;
    indexes: { byCollection: string };
  };
}

/**
 * IndexedDB 实现（ROADMAP P0-1）。
 *
 * 用「单一对象仓库 + 集合字段」而不是每个集合一个仓库：集合是运行时概念，
 * 让存储层跟着领域模型长，会变成每加一个实体都要动 schema。
 *
 * 这里刻意不做排序与过滤的业务判断，全部复用 core 的 matchesWhere 与
 * applyQuery。测试跑在内存实现上、线上跑在这个实现上，两者行为必须一致，
 * 所以共用同一套语义实现。
 */
export async function createIndexedDbEntityStore(
  databaseName = DB_NAME,
): Promise<{ store: EntityStore; db: IDBPDatabase<DramatisSchema> }> {
  const db = await openDB<DramatisSchema>(databaseName, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: ['collection', 'id'] });
        store.createIndex('byCollection', 'collection');
      }
    },
  });

  const store: EntityStore = {
    kind: 'indexeddb',

    async get<T>(collection: string, id: string): Promise<T | null> {
      const record = await db.get(STORE, [collection, id]);
      return record === undefined ? null : (structuredClone(record.value) as T);
    },

    async put<T extends { id: string }>(collection: string, value: T): Promise<void> {
      await db.put(STORE, { collection, id: value.id, value: structuredClone(value) });
    },

    async bulkPut<T extends { id: string }>(collection: string, values: readonly T[]): Promise<void> {
      const tx = db.transaction(STORE, 'readwrite');
      for (const value of values) {
        void tx.store.put({ collection, id: value.id, value: structuredClone(value) });
      }
      await tx.done;
    },

    async remove(collection: string, id: string): Promise<void> {
      await db.delete(STORE, [collection, id]);
    },

    async list<T>(collection: string, query?: EntityQuery): Promise<T[]> {
      const records = await db.getAllFromIndex(STORE, 'byCollection', collection);
      const values = records.map((record) => record.value).filter((value) => matchesWhere(value, query?.where));
      return applyQuery(values, query) as T[];
    },

    async count(collection: string, where?: Record<string, unknown>): Promise<number> {
      const records = await db.getAllFromIndex(STORE, 'byCollection', collection);
      return records.filter((record) => matchesWhere(record.value, where)).length;
    },

    async clear(collection: string): Promise<void> {
      const tx = db.transaction(STORE, 'readwrite');
      const index = tx.store.index('byCollection');
      let cursor = await index.openCursor(collection);
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    },
  };

  return { store, db };
}

export interface DramatisDb {
  backendKind: string;
  repository: Repository;
  queue: BackgroundRunner;
  /**
   * 用量账单（P3-7 / T7）。
   *
   * 与仓储共用同一个 EntityStore，因此也在这里一起建好：账单是只增不改的流水，
   * 不参与剧情数据的级联语义（归档不回滚它，删世界才清）。
   */
  ledger: UsageLedger;
}

/**
 * 打开数据库并挂上仓储与后台队列。
 *
 * 两者共用同一个 EntityStore 实例，因此必须在一起创建——
 * 分成两个连接会让事务与缓存语义变得难以推理。
 */
export async function openDramatisDb(): Promise<DramatisDb> {
  let store: EntityStore;

  try {
    store = (await createIndexedDbEntityStore()).store;
  } catch {
    // 隐私模式或企业策略下 IndexedDB 可能不可用。退回内存实现让应用仍能运行，
    // 但数据不会留存——UI 必须把这一点明确告诉用户，不能让人以为一切正常。
    store = createMemoryEntityStore();
  }

  return {
    backendKind: store.kind,
    repository: new Repository(store),
    queue: createBackgroundRunner(store),
    ledger: createUsageLedger(store),
  };
}
