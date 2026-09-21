import {
  applyQuery,
  type BackgroundRunner,
  createBackgroundRunner,
  createMemoryEntityStore,
  createUsageLedger,
  type EntityQuery,
  type EntityStore,
  matchesWhere,
  newId,
  nowIso,
  Repository,
  type UsageLedger,
} from '@dramatis/core';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

const DB_NAME = 'dramatis';

/**
 * 个人账户 = 一个独立的数据容器（顺序 37，账户重构 A1）。
 *
 * 为什么这么做：以前所有世界都堆在同一个库里，换同步空间只换「推到哪」，
 * 本地数据不分家——两个账户的东西会合并到一起（用户 2026-09-21 提的正是这件事）。
 * 把库名带上内部 storageId 之后，「切账户」就等于「切一份本地数据」：天然隔离，
 * 不用给实体加空间字段，也不用改任何查询。
 *
 * 用户语义（2026-09-21 拍板）：
 *
 * - `accountId`：用户自己设置，设备/服务器内唯一，**创建后不可改**；
 * - `name`：用户可见名称，可以重复，可以随时改；
 * - `id`：内部稳定 storageId，只用来命名数据库和隔离密钥，不展示给普通用户。
 *
 * 旧版 `dramatis.localAccount.v1` 会原地迁移：原来的 id 变成 accountId，
 * 原数据库名保持不变，因此不会复制、移动或重命名任何世界数据。
 */
const LEGACY_ACCOUNT_STORAGE_KEY = 'dramatis.localAccount.v1';
const ACCOUNT_REGISTRY_KEY = 'dramatis.accounts.v2';

export interface LocalAccount {
  /** 内部稳定 id：数据库名与密钥命名空间使用它。 */
  id: string;
  /** 用户设置、设备内唯一、创建后不可改。 */
  accountId: string;
  /** 用户可见名称，可重复、可修改。 */
  name: string;
  /** 这个账户对应的 IndexedDB 库。 */
  dbName: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  /** 由旧版单账户数据迁移而来，界面可以给一次「确认账户 ID」提示。 */
  legacy: boolean;
}

export interface AccountRegistry {
  version: 2;
  activeId: string;
  accounts: LocalAccount[];
}

export function accountDbName(id: string): string {
  const safe = id
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .slice(0, 40);
  return `${DB_NAME}:acct:${safe === '' ? 'default' : safe}`;
}

function legacyAccountIdFromDbName(dbName: string): string {
  if (dbName === DB_NAME) return 'local';
  return dbName.startsWith(`${DB_NAME}:acct:`) ? dbName.slice(`${DB_NAME}:acct:`.length) : dbName;
}

function createLocalAccountRecord(input: {
  id?: string;
  accountId: string;
  name: string;
  dbName?: string;
  createdAt?: string;
  updatedAt?: string;
  lastOpenedAt?: string | null;
  legacy?: boolean;
}): LocalAccount {
  const id = input.id ?? newId();
  const at = input.createdAt ?? nowIso();
  return {
    id,
    accountId: input.accountId.trim(),
    name: input.name.trim() === '' ? '未命名账户' : input.name.trim(),
    dbName: input.dbName ?? accountDbName(id),
    createdAt: at,
    updatedAt: input.updatedAt ?? at,
    lastOpenedAt: input.lastOpenedAt ?? null,
    legacy: input.legacy ?? false,
  };
}

function readRegistry(): AccountRegistry | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_REGISTRY_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<AccountRegistry>;
    if (parsed.version !== 2 || typeof parsed.activeId !== 'string' || !Array.isArray(parsed.accounts)) return null;
    const accounts = parsed.accounts.filter(
      (account): account is LocalAccount =>
        typeof account === 'object' &&
        account !== null &&
        typeof account.id === 'string' &&
        typeof account.accountId === 'string' &&
        typeof account.name === 'string' &&
        typeof account.dbName === 'string',
    );
    if (accounts.length === 0) return null;
    return {
      version: 2,
      activeId: accounts.some((account) => account.id === parsed.activeId) ? parsed.activeId : (accounts[0]?.id ?? ''),
      accounts,
    };
  } catch {
    return null;
  }
}

function writeRegistry(registry: AccountRegistry): void {
  try {
    localStorage.setItem(ACCOUNT_REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    // 隐私模式：本次会话仍能靠内存中的当前账户继续工作。
  }
}

function migrateLegacyAccount(): AccountRegistry {
  try {
    const raw = localStorage.getItem(LEGACY_ACCOUNT_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { id?: unknown; label?: unknown };
      if (typeof parsed.id === 'string' && parsed.id.trim() !== '') {
        const accountId = parsed.id.trim();
        const account = createLocalAccountRecord({
          id: accountId,
          accountId,
          name: typeof parsed.label === 'string' && parsed.label.trim() !== '' ? parsed.label : accountId,
          dbName: accountDbName(accountId),
          legacy: true,
        });
        const registry: AccountRegistry = { version: 2, activeId: account.id, accounts: [account] };
        writeRegistry(registry);
        return registry;
      }
    }
  } catch {
    // 坏掉的旧记录按「本机数据」处理，原数据库不删除。
  }

  const account = createLocalAccountRecord({
    id: 'local',
    accountId: 'local',
    name: '本机数据',
    dbName: DB_NAME,
    legacy: true,
  });
  const registry: AccountRegistry = { version: 2, activeId: account.id, accounts: [account] };
  writeRegistry(registry);
  return registry;
}

/** 读取账户注册表；第一次调用会自动迁移 v1。 */
export function readAccountRegistry(): AccountRegistry {
  return readRegistry() ?? migrateLegacyAccount();
}

export function readActiveAccount(): LocalAccount {
  const registry = readAccountRegistry();
  return (
    registry.accounts.find((account) => account.id === registry.activeId) ?? (registry.accounts[0] as LocalAccount)
  );
}

function writeAccountRegistry(registry: AccountRegistry): void {
  writeRegistry({ ...registry, version: 2 });
}

export function accountRegistry(): AccountRegistry {
  return readAccountRegistry();
}

export function writeActiveAccount(account: LocalAccount | null): void {
  const registry = readAccountRegistry();
  if (account === null) {
    const fallback = registry.accounts[0];
    if (fallback === undefined) return;
    writeAccountRegistry({ ...registry, activeId: fallback.id });
    return;
  }

  const at = nowIso();
  const next = {
    ...account,
    updatedAt: at,
    lastOpenedAt: at,
    dbName: account.dbName || accountDbName(account.id),
  };
  const accounts = registry.accounts.some((item) => item.id === next.id)
    ? registry.accounts.map((item) => (item.id === next.id ? next : item))
    : [...registry.accounts, next];
  writeAccountRegistry({ version: 2, activeId: next.id, accounts });
}

export function createAccount(input: { accountId: string; name: string }): LocalAccount {
  const registry = readAccountRegistry();
  const accountId = input.accountId.trim();
  if (accountId === '') throw new Error('账户 ID 不能为空。');
  if (registry.accounts.some((account) => account.accountId.toLowerCase() === accountId.toLowerCase())) {
    throw new Error('这个账户 ID 已经在这台设备上使用过，请换一个。');
  }
  const storageId = newId();
  const at = nowIso();
  const account = createLocalAccountRecord({
    id: storageId,
    accountId,
    name: input.name,
    dbName: accountDbName(storageId),
    createdAt: at,
    updatedAt: at,
    lastOpenedAt: at,
  });
  writeAccountRegistry({ version: 2, activeId: registry.activeId, accounts: [...registry.accounts, account] });
  return account;
}

export function renameAccount(id: string, name: string): LocalAccount {
  const registry = readAccountRegistry();
  const account = registry.accounts.find((item) => item.id === id);
  if (account === undefined) throw new Error('找不到这个账户。');
  const next: LocalAccount = {
    ...account,
    name: name.trim() === '' ? account.name : name.trim(),
    updatedAt: nowIso(),
  };
  writeAccountRegistry({
    ...registry,
    accounts: registry.accounts.map((item) => (item.id === id ? next : item)),
  });
  return next;
}

export function removeAccount(id: string): void {
  const registry = readAccountRegistry();
  const remaining = registry.accounts.filter((account) => account.id !== id);
  if (remaining.length === 0) throw new Error('至少要保留一个账户。');
  const activeId = registry.activeId === id ? (remaining[0]?.id ?? '') : registry.activeId;
  writeAccountRegistry({ version: 2, activeId, accounts: remaining });
}

/**
 * 把浏览器里已经存在、但注册表还没记住的数据库补进来。
 *
 * 这是 A1 的兼容入口：老版本只把账户 id 塞在数据库名里，没有结构化注册表。
 * 打开账户面板时调用一次，就能把旧库原样纳入账户列表；数据库名不动。
 */
export async function loadAccountRegistry(): Promise<AccountRegistry> {
  const registry = readAccountRegistry();
  const databases = await listLocalDatabases();
  const known = new Set(registry.accounts.map((account) => account.dbName));
  let changed = false;
  const accounts = [...registry.accounts];

  for (const dbName of databases) {
    if (known.has(dbName)) continue;
    const accountId = legacyAccountIdFromDbName(dbName);
    const storageId = dbName === DB_NAME ? 'local' : `legacy-${accountId}`;
    if (accounts.some((account) => account.id === storageId)) continue;
    const account = createLocalAccountRecord({
      id: storageId,
      accountId,
      name: accountId === 'local' ? '本机数据' : accountId,
      dbName,
      legacy: true,
    });
    accounts.push(account);
    known.add(dbName);
    changed = true;
  }

  const next: AccountRegistry = {
    version: 2,
    activeId: accounts.some((account) => account.id === registry.activeId)
      ? registry.activeId
      : (accounts[0]?.id ?? ''),
    accounts,
  };
  if (changed) writeAccountRegistry(next);
  return next;
}

/** 现在该打开哪个库。 */
export function activeDbName(): string {
  return readActiveAccount().dbName;
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
