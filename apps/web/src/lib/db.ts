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

/**
 * 本地账户 = 一个独立的 IndexedDB 库（顺序 37）。
 *
 * 为什么这么做：以前所有世界都堆在同一个库里，换同步空间只换「推到哪」，
 * 本地数据不分家——两个账户的东西会合并到一起（用户 2026-09-21 提的正是这件事）。
 * 把库名带上账户 id 之后，「切账户」就等于「切一份本地数据」：天然隔离，
 * 不用给实体加空间字段，也不用改任何查询。
 *
 * 「本机数据」（没有账户）仍然是原来那个 `dramatis` 库——老数据原地不动。
 */
const ACCOUNT_STORAGE_KEY = 'dramatis.localAccount.v1';

export interface LocalAccount {
  /** 账户标识（用户自己填的名字，会出现在库名里，所以做一次净化）。 */
  id: string;
  /** 显示用，通常与 id 相同。 */
  label: string;
}

export function accountDbName(id: string): string {
  const safe = id
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .slice(0, 40);
  return `${DB_NAME}:acct:${safe === '' ? 'default' : safe}`;
}

export function readActiveAccount(): LocalAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<LocalAccount>;
    if (typeof parsed.id !== 'string' || parsed.id.trim() === '') return null;
    return { id: parsed.id, label: typeof parsed.label === 'string' ? parsed.label : parsed.id };
  } catch {
    return null;
  }
}

export function writeActiveAccount(account: LocalAccount | null): void {
  try {
    if (account === null) localStorage.removeItem(ACCOUNT_STORAGE_KEY);
    else localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
  } catch {
    // 隐私模式：这次会话内照常生效（库名已经由调用方决定了）
  }
}

/** 现在该打开哪个库。 */
export function activeDbName(): string {
  const account = readActiveAccount();
  return account === null ? DB_NAME : accountDbName(account.id);
}

/** 本机有哪些库（Chrome / Edge / Safari 16.4+ 都支持 indexedDB.databases）。 */
export async function listLocalDatabases(): Promise<string[]> {
  if (typeof indexedDB.databases !== 'function') return [DB_NAME];
  const list = await indexedDB.databases();
  return list.map((entry) => entry.name ?? '').filter((name) => name.startsWith(DB_NAME));
}

/**
 * 把一份库整体复制到另一份（新建账户时用：把现在这份数据带过去）。
 *
 * **同步状态不带过去**：`sync.config` / `sync.state` 属于「那个账户连的是哪个空间」，
 * 带过去会让新账户一打开就自动连上旧账户的空间——那是串号。
 */
export async function copyLocalDatabase(from: string, to: string): Promise<number> {
  const source = await createIndexedDbEntityStore(from);
  const target = await createIndexedDbEntityStore(to);
  let copied = 0;
  try {
    const rows = await source.db.getAll(STORE);
    // 同步状态不带过去（见上面的说明）
    const keep = rows.filter((row) => !(row.collection === 'meta' && row.id.startsWith('sync.')));
    for (const row of keep) await target.db.put(STORE, row);
    copied = keep.length;
  } finally {
    source.db.close();
    target.db.close();
  }
  return copied;
}
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
  // 打开**当前账户**的库（顺序 37）：没选账户就是原来那份本机数据。
  const name = activeDbName();
  let store: EntityStore;

  try {
    store = (await createIndexedDbEntityStore(name)).store;
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
