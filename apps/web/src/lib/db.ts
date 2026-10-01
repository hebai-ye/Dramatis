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
import { removeBrowserKeyRefs } from './keystore';
import { createSerialQueue, withCrossTabLock } from './sync-queue';
import { createTaskQueueExtras, type TaskQueueExtras } from './task-queue';

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
const PENDING_ACCOUNT_DELETIONS_KEY = 'dramatis.accounts.pendingDelete.v1';
const accountDeletionQueue = createSerialQueue();

/** 删除临界段与启动清理共用一把全局锁；调用方必须先释放临界段再调用 flush。 */
export function withAccountDeletionLock<T>(task: () => Promise<T>): Promise<T> {
  return accountDeletionQueue.run(() => withCrossTabLock('dramatis-account-deletion', task));
}

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

interface PendingAccountDeletion {
  dbName: string;
  label: string;
  secretRefs: string[];
  queuedAt: string;
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

function readRegistry(strict = false): AccountRegistry | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_REGISTRY_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<AccountRegistry>;
    if (parsed.version !== 2 || typeof parsed.activeId !== 'string' || !Array.isArray(parsed.accounts)) {
      if (strict) throw new Error('账户注册表无法读取，未执行删除。');
      return null;
    }
    const accounts = parsed.accounts.filter(
      (account): account is LocalAccount =>
        typeof account === 'object' &&
        account !== null &&
        typeof account.id === 'string' &&
        typeof account.accountId === 'string' &&
        typeof account.name === 'string' &&
        typeof account.dbName === 'string',
    );
    if (accounts.length === 0 || (strict && accounts.length !== parsed.accounts.length)) {
      if (strict) throw new Error('账户注册表不完整，未执行删除。');
      return null;
    }
    return {
      version: 2,
      activeId: accounts.some((account) => account.id === parsed.activeId) ? parsed.activeId : (accounts[0]?.id ?? ''),
      accounts,
    };
  } catch (error) {
    if (strict) throw error;
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

function readPendingAccountDeletions(strict = false): PendingAccountDeletion[] {
  try {
    const raw = localStorage.getItem(PENDING_ACCOUNT_DELETIONS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { items?: unknown }).items)) {
      if (strict) throw new Error('账户待清理队列无法读取。');
      return [];
    }
    const rawItems = (parsed as { items: unknown[] }).items;
    const items = rawItems.filter((item): item is PendingAccountDeletion => {
      if (typeof item !== 'object' || item === null) return false;
      const record = item as Record<string, unknown>;
      return (
        typeof record.dbName === 'string' &&
        typeof record.label === 'string' &&
        Array.isArray(record.secretRefs) &&
        record.secretRefs.every((ref) => typeof ref === 'string') &&
        typeof record.queuedAt === 'string'
      );
    });
    if (strict && items.length !== rawItems.length) throw new Error('账户待清理条目不完整，未覆盖原队列。');
    return items;
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

function writePendingAccountDeletions(items: readonly PendingAccountDeletion[]): void {
  localStorage.setItem(PENDING_ACCOUNT_DELETIONS_KEY, JSON.stringify({ items }));
}

/** 只读旧版待删除队列；不可读时抛错，让启动界面显示未知而非零待清理。 */
export function pendingAccountDeletionCount(): number {
  return readPendingAccountDeletions(true).length;
}

/** 删除操作不允许把读取失败当成空注册表或触发迁移。 */
export function readAccountRegistryForDeletion(): AccountRegistry {
  const registry = readRegistry(true);
  if (registry === null) throw new Error('账户注册表不存在，未执行删除。');
  return registry;
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
  const registry = readAccountRegistryForDeletion();
  const remaining = registry.accounts.filter((account) => account.id !== id);
  if (remaining.length === 0) throw new Error('至少要保留一个账户。');
  const activeId = registry.activeId === id ? (remaining[0]?.id ?? '') : registry.activeId;
  localStorage.setItem(ACCOUNT_REGISTRY_KEY, JSON.stringify({ version: 2, activeId, accounts: remaining }));
}

/**
 * 硬删除一个账户之前，先把要清理的本机密钥引用找出来。
 *
 * 账户的模型配置在 IndexedDB 里，但 API Key 的本机缓存可能在 localStorage
 * 的明文键空间或口令库里。数据库删掉之前先读出 keyRef，才能真正把缓存也清掉。
 */
export async function listAccountSecretRefs(dbName: string): Promise<string[]> {
  const opened = await createIndexedDbEntityStore(dbName);
  try {
    const profiles = await opened.store.list<Record<string, unknown>>('providerProfiles');
    const credentials = await opened.store.list<Record<string, unknown>>('providerCredentials');
    const refs = new Set<string>();
    for (const profile of profiles) {
      if (typeof profile.keyRef === 'string' && profile.keyRef !== '') refs.add(profile.keyRef);
    }
    for (const credential of credentials) {
      if (typeof credential.id === 'string' && credential.id !== '') refs.add(credential.id);
    }
    return [...refs];
  } finally {
    opened.db.close();
  }
}

/**
 * 把账户删除排进「下次启动一定执行」的队列。
 *
 * 为什么要排队：当前账户的 IndexedDB 连接正开着，直接 deleteDatabase 会被
 * blocked。先在注册表里移除账户并关掉页面，下一次打开应用时旧连接已经释放，
 * 再删库；如果其他标签页还占着，标记会保留并在之后每次启动重试。
 */
export function queueAccountDeletion(account: LocalAccount, secretRefs: readonly string[]): void {
  const current = readPendingAccountDeletions(true).filter((item) => item.dbName !== account.dbName);
  current.push({
    dbName: account.dbName,
    label: account.name,
    secretRefs: [...new Set(secretRefs)].filter((ref) => ref !== ''),
    queuedAt: nowIso(),
  });
  writePendingAccountDeletions(current);
}

/** IndexedDB 的 deleteDatabase 是事件式 API；封装成能 await 的 Promise。 */
export function deleteLocalDatabase(dbName: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('本机数据库不可用，账户清理未完成。'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`删除本机数据库失败：${dbName}`));
    request.onblocked = () => reject(new Error(`账户数据仍被其他标签页占用：${dbName}。关闭其他标签页后会自动重试。`));
  });
}

/** 启动时重试所有排队的硬删除；失败的保留标记，避免账户被扫描“复活”。 */
export function flushPendingAccountDeletions(): Promise<{ deleted: number; remaining: number }> {
  return withAccountDeletionLock(flushPendingAccountDeletionsLocked);
}

async function flushPendingAccountDeletionsLocked(): Promise<{ deleted: number; remaining: number }> {
  const items = readPendingAccountDeletions(true);
  if (items.length === 0) return { deleted: 0, remaining: 0 };

  const completed = new Set<string>();
  const itemVersion = (item: PendingAccountDeletion) =>
    JSON.stringify([item.dbName, item.label, item.queuedAt, item.secretRefs]);
  let deleted = 0;
  for (const item of items) {
    try {
      const registry = readAccountRegistryForDeletion();
      // 排队成功而注册表拒写时，仍注册的容器必须保留，等待用户重试删除。
      if (registry.accounts.some((account) => account.dbName === item.dbName)) {
        continue;
      }
      const retainedRefs = new Set<string>();
      for (const account of registry.accounts) {
        for (const ref of await listAccountSecretRefs(account.dbName)) retainedRefs.add(ref);
      }
      await removeBrowserKeyRefs(item.secretRefs.filter((ref) => !retainedRefs.has(ref)));
      await deleteLocalDatabase(item.dbName);
      completed.add(itemVersion(item));
      deleted += 1;
    } catch {
      // 保留当前任务，下一轮重试。
    }
  }
  // 无 Web Locks 的其他标签页仍可能在 await 期间排入任务。仅移除本轮完成的
  // 同一版本；读取快照之后新增或重新排队的条目必须保留。
  const remaining = readPendingAccountDeletions(true).filter((item) => !completed.has(itemVersion(item)));
  writePendingAccountDeletions(remaining);
  return { deleted, remaining: remaining.length };
}

/**
 * 把浏览器里已经存在、但注册表还没记住的数据库补进来。
 *
 * 这是 A1 的兼容入口：老版本只把账户 id 塞在数据库名里，没有结构化注册表。
 * 打开账户面板时调用一次，就能把旧库原样纳入账户列表；数据库名不动。
 */
export async function loadAccountRegistry(): Promise<AccountRegistry> {
  const initial = readAccountRegistry();
  const initiallyKnown = new Set(initial.accounts.map((account) => account.dbName));
  const initiallyPending = readPendingAccountDeletions(true).map((item) => item.dbName);
  const databases = await listLocalDatabases();
  return withAccountDeletionLock(async () => {
    // 扫描期间可能删除、添加或重命名账户，必须基于最新注册表追加。最初已经
    // 注册或待删的库不会重新导入，即使扫描过程中已清理并移除了待删标记。
    const registry = readAccountRegistry();
    const pendingDeletions = new Set([
      ...initiallyPending,
      ...readPendingAccountDeletions(true).map((item) => item.dbName),
    ]);
    const known = new Set([...initiallyKnown, ...registry.accounts.map((account) => account.dbName)]);
    let changed = false;
    const accounts = [...registry.accounts];

    for (const dbName of databases) {
      if (pendingDeletions.has(dbName)) continue;
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
  });
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
 *
 * **设备号也不带过去**（审计 C3）：`device.id` 是 `(deviceId, localSeq)` 排序的一半，
 * 两个库共用一个设备号，同步到同一空间后两边各自发的 1 号、2 号就会撞在一起。
 *
 * 写入放在**一个事务**里：中途失败（配额满、页面关掉）就整批回滚，不会留下半个账户。
 */
export function shouldCopyRow(row: { collection: string; id: string }): boolean {
  if (row.collection !== 'meta') return true;
  return !row.id.startsWith('sync.') && row.id !== 'device.id';
}

export async function copyLocalDatabase(from: string, to: string): Promise<number> {
  const source = await createIndexedDbEntityStore(from);
  const target = await createIndexedDbEntityStore(to);
  let copied = 0;
  try {
    const rows = await source.db.getAll(STORE);
    // 同步状态不带过去（见上面的说明）
    const keep = rows.filter(shouldCopyRow);
    const tx = target.db.transaction(STORE, 'readwrite');
    for (const row of keep) void tx.store.put(row);
    await tx.done;
    copied = keep.length;
  } finally {
    source.db.close();
    target.db.close();
  }
  return copied;
}
/** 数据库连接出状况时发给界面的事件名（审计 B13）；detail 是 'blocked' | 'blocking'。 */
export const DB_CONNECTION_EVENT = 'dramatis:db-connection';
export type DbConnectionIssue = 'blocked' | 'blocking';

function announceDbConnection(issue: DbConnectionIssue): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<DbConnectionIssue>(DB_CONNECTION_EVENT, { detail: issue }));
}

/**
 * 库版本（顺序 62：1 → 2）。
 *
 * 2 只是**加两个索引**，不改任何记录的形状——升级是幂等的，老库打开时自动建索引，
 * 数据一条不动（`upgrade` 里不碰记录）。为什么不一次性加更多索引：每个索引都会
 * 拖慢写入，而写入（每条消息一次）比读取频繁得多。
 */
const DB_VERSION = 2;
const STORE = 'entities';

/**
 * `updatedAt` 索引上界的哨兵（顺序 62）。
 *
 * 复合索引的键是 `[collection, updatedAt]`，要「这个集合里时间戳大于某个值的行」
 * 就得给上界一个比任何时间戳都大的字符串。ISO 时间戳只由 `0-9 T : . - Z` 组成，
 * 都小于 `\uffff`，所以拿它当上界既安全又不必知道时间戳的确切形状。
 */
const LAST_TIMESTAMP = '\uffff';

interface EntityRecord {
  collection: string;
  id: string;
  value: unknown;
}

interface DramatisSchema extends DBSchema {
  entities: {
    key: [string, string];
    value: EntityRecord;
    indexes: {
      byCollection: string;
      /** `['collection','value.roomId']`：按世界读消息/角色/场景（顺序 62）。 */
      byCollectionRoom: [string, string];
      /** `['collection','value.updatedAt']`：同步的增量读（顺序 62）。 */
      byCollectionUpdated: [string, string];
    };
  };
}

/**
 * 一个「记录来源」（顺序 77）：要么是库连接本身（每次写各自成事务），要么是某个
 * 父事务里的作用域（所有读写都落在那个事务上）。
 *
 * 抽出来是因为同一个门面要服务这两种来源，而它们的**语义必须一字不差**——测试跑
 * 内存实现、线上跑这个实现，两边行为对不上时最难查的就是这种地方。所以值层面的
 * 逻辑（matchesWhere / applyQuery / 结构化克隆）只写一遍。
 */
interface RecordSource {
  read(collection: string, where?: Record<string, unknown>): Promise<EntityRecord[]>;
  readSince(range: IDBKeyRange): Promise<EntityRecord[]>;
  get(collection: string, id: string): Promise<EntityRecord | undefined>;
  put(record: EntityRecord): Promise<void>;
  bulkPut(records: readonly EntityRecord[]): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  update<T extends { id: string }>(
    collection: string,
    id: string,
    mutate: (current: T | null) => T | undefined,
  ): Promise<T | null>;
  clear(collection: string): Promise<void>;
}

/**
 * 用某个记录来源拼出一个 `EntityStore`（顺序 77）。
 *
 * `runTransaction` 只有「库连接」那一侧才有：事务作用域里不能再开事务（IndexedDB
 * 不支持嵌套），所以作用域自己的 `transaction` 是 `undefined`。
 */
function createStoreFromSource(
  source: RecordSource,
  runTransaction?: <T>(run: (scope: EntityStore) => Promise<T>) => Promise<T>,
): EntityStore {
  const store: EntityStore = {
    kind: 'indexeddb',

    async get<T>(collection: string, id: string): Promise<T | null> {
      const record = await source.get(collection, id);
      return record === undefined ? null : (structuredClone(record.value) as T);
    },

    async put<T extends { id: string }>(collection: string, value: T): Promise<void> {
      await source.put({ collection, id: value.id, value: structuredClone(value) });
    },

    async bulkPut<T extends { id: string }>(collection: string, values: readonly T[]): Promise<void> {
      await source.bulkPut(values.map((value) => ({ collection, id: value.id, value: structuredClone(value) })));
    },

    async remove(collection: string, id: string): Promise<void> {
      await source.delete(collection, id);
    },

    async list<T>(collection: string, query?: EntityQuery): Promise<T[]> {
      const records = await source.read(collection, query?.where);
      const values = records.map((record) => record.value).filter((value) => matchesWhere(value, query?.where));
      return applyQuery(values, query) as T[];
    },

    async count(collection: string, where?: Record<string, unknown>): Promise<number> {
      const records = await source.read(collection, where);
      return records.filter((record) => matchesWhere(record.value, where)).length;
    },

    /**
     * 增量读（顺序 62 / 68）：走 `updatedAt` 索引，只把新写的那几条拿出来。
     *
     * `inclusive` 决定下界含不含等于：同步水位线不含（默认），账单的 `since` 含。
     */
    async listSince<T>(collection: string, updatedAt: string, options?: { inclusive?: boolean }): Promise<T[]> {
      const lowerOpen = !(options?.inclusive ?? false);
      const range = IDBKeyRange.bound([collection, updatedAt], [collection, LAST_TIMESTAMP], lowerOpen, false);
      const records = await source.readSince(range);
      return records.map((record) => record.value) as T[];
    },

    async update<T extends { id: string }>(
      collection: string,
      id: string,
      mutate: (current: T | null) => T | undefined,
    ): Promise<T | null> {
      return source.update<T>(collection, id, mutate);
    },

    async clear(collection: string): Promise<void> {
      await source.clear(collection);
    },
  };

  if (runTransaction !== undefined) store.transaction = runTransaction;
  return store;
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
    /*
     * 升级被别的标签页挡住（审计 B13）：那边还开着旧版本的连接。
     * 告诉用户关掉其他标签页；那边收到 versionchange 后会自己关（见下面的 blocking）。
     */
    blocked() {
      announceDbConnection('blocked');
    },
    /*
     * 本页挡住了别处的升级：立刻关掉连接让对方先升，再提示用户刷新本页。
     * 不关的话，新版本那一页会一直卡在打开数据库这一步。
     */
    blocking() {
      db.close();
      announceDbConnection('blocking');
    },
    upgrade(database, _oldVersion, _newVersion, transaction) {
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: ['collection', 'id'] });
        store.createIndex('byCollection', 'collection');
        store.createIndex('byCollectionRoom', ['collection', 'value.roomId']);
        store.createIndex('byCollectionUpdated', ['collection', 'value.updatedAt']);
        return;
      }
      /*
       * 老库（v1）升上来：只补索引，不动记录。`createIndex` 对已存在的索引会抛错，
       * 所以逐个确认——用户可能从任意一个中间版本升上来。
       */
      const store = transaction.objectStore(STORE);
      if (!store.indexNames.contains('byCollectionRoom')) {
        store.createIndex('byCollectionRoom', ['collection', 'value.roomId']);
      }
      if (!store.indexNames.contains('byCollectionUpdated')) {
        store.createIndex('byCollectionUpdated', ['collection', 'value.updatedAt']);
      }
    },
  });

  /**
   * 库连接来源（顺序 77）：每次写各自成事务。
   *
   * 读取口径（顺序 62）：`where.roomId` 有值时走 `byCollectionRoom` 复合索引——以前
   * 无论查什么都会把这个集合整表读出来再逐条过滤，于是「一个世界的 600 条消息」在
   * 一次 `listRooms` 里要被读三遍（消息 / 角色 / 对话各一次），而同步每 20 秒还会
   * 把 12 个集合整表读一遍。
   *
   * 拿到的这批仍然要过 `matchesWhere`：索引只能按 `roomId` 缩小范围，`deletedAt`
   * 之类的条件还得逐条判——**语义与内存实现、与下面的事务作用域来源都一字不差**。
   */
  const dbSource: RecordSource = {
    async read(collection, where) {
      const roomIdValue = where?.roomId;
      if (typeof roomIdValue === 'string') {
        return db.getAllFromIndex(STORE, 'byCollectionRoom', [collection, roomIdValue]);
      }
      return db.getAllFromIndex(STORE, 'byCollection', collection);
    },

    async readSince(range) {
      return db.getAllFromIndex(STORE, 'byCollectionUpdated', range);
    },

    async get(collection, id) {
      return db.get(STORE, [collection, id]);
    },

    async put(record) {
      await db.put(STORE, record);
    },

    /** 顺序 77：一批写只开**一个**事务（原来就是这样，别退回逐条写）。 */
    async bulkPut(records) {
      const tx = db.transaction(STORE, 'readwrite');
      for (const record of records) void tx.store.put(record);
      await tx.done;
    },

    async delete(collection, id) {
      await db.delete(STORE, [collection, id]);
    },

    /**
     * 原子读-改-写（审计 B3 / B14）：读和写在同一个 readwrite 事务里。
     *
     * IndexedDB 会把同一仓库上重叠的 readwrite 事务（包括别的标签页的）串行执行，
     * 所以两个标签页同时认领同一个任务、同时发 localSeq，只会有一个先读到旧值。
     * `mutate` 是同步的：事务里不能等别的 Promise，否则事务会提前提交。
     */
    async update<T extends { id: string }>(
      collection: string,
      id: string,
      mutate: (current: T | null) => T | undefined,
    ) {
      const tx = db.transaction(STORE, 'readwrite');
      const record = await tx.store.get([collection, id]);
      const current = record === undefined ? null : (structuredClone(record.value) as T);
      const next = mutate(current);
      if (next === undefined) {
        await tx.done;
        return current;
      }
      void tx.store.put({ collection, id, value: structuredClone({ ...next, id }) });
      await tx.done;
      return next;
    },

    async clear(collection) {
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

  /*
   * 顺序 77：把「一轮内的一批写入」放进同一个 readwrite 事务。
   *
   * 之所以真能原子：所有集合都睡在同一张 object store（`STORE`）上，一次事务就能
   * 跨 messages / memories / instances / backgroundTasks 一起提交或整批回滚。
   *
   * 两条硬约束（写在这里，因为违反它们不会报错、只会静默失去原子性）：
   * - `run` 里只能 await 存储操作——IndexedDB 的事务在没有待处理请求时会自动提交，
   *   网络调用或定时器之类的别的 Promise 会让后续写入落到事务外；
   * - 事务里不要再开事务（IndexedDB 不支持嵌套），所以作用域的 `transaction`
   *   是 `undefined`；`worker.kick()` 这类「通知」必须等这里返回之后再发。
   */
  const store = createStoreFromSource(dbSource, async (run) => {
    const tx = db.transaction(STORE, 'readwrite');
    try {
      const result = await run(
        createStoreFromSource({
          async read(collection, where) {
            const roomIdValue = where?.roomId;
            if (typeof roomIdValue === 'string') {
              return tx.store.index('byCollectionRoom').getAll([collection, roomIdValue]);
            }
            return tx.store.index('byCollection').getAll(collection);
          },

          async readSince(range) {
            return tx.store.index('byCollectionUpdated').getAll(range);
          },

          async get(collection, id) {
            return tx.store.get([collection, id]);
          },

          async put(record) {
            await tx.store.put(record);
          },

          async bulkPut(records) {
            for (const record of records) await tx.store.put(record);
          },

          async delete(collection, id) {
            await tx.store.delete([collection, id]);
          },

          async update<T extends { id: string }>(
            collection: string,
            id: string,
            mutate: (current: T | null) => T | undefined,
          ) {
            const record = await tx.store.get([collection, id]);
            const current = record === undefined ? null : (structuredClone(record.value) as T);
            const next = mutate(current);
            if (next === undefined) return current;
            await tx.store.put({ collection, id, value: structuredClone({ ...next, id }) });
            return next;
          },

          async clear(collection) {
            const index = tx.store.index('byCollection');
            let cursor = await index.openCursor(collection);
            while (cursor) {
              await cursor.delete();
              cursor = await cursor.continue();
            }
          },
        }),
      );
      // 事务在没有待处理请求时会自动提交，`tx.done` 只是等它落地、接住写失败。
      await tx.done;
      return result;
    } catch (error) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw error;
    }
  });

  return { store, db };
}

export interface DramatisDb {
  backendKind: string;
  /**
   * 底层存储（顺序 77）。
   *
   * 暴露出来只为一件事：把「一轮内的一批写入」放进同一个事务（`store.transaction`，
   * 见 `turn-write.ts`）。日常读写仍走 `repository` / `queue` / `ledger` / `tasks`
   * 这几个门面，别绕过它们。
   */
  store: EntityStore;
  repository: Repository;
  queue: BackgroundRunner;
  /**
   * 用量账单（P3-7 / T7）。
   *
   * 与仓储共用同一个 EntityStore，因此也在这里一起建好：账单是只增不改的流水，
   * 不参与剧情数据的级联语义（归档不回滚它，删世界才清）。
   */
  ledger: UsageLedger;
  /** 队列的网页侧补充操作：挑任务、退避、重试失败任务（审计 B2）。 */
  tasks: TaskQueueExtras;
}

/**
 * 打开数据库并挂上仓储与后台队列。
 *
 * 两者共用同一个 EntityStore 实例，因此必须在一起创建——
 * 分成两个连接会让事务与缓存语义变得难以推理。
 */
export async function openDramatisDb(): Promise<DramatisDb> {
  /*
   * 先执行上一轮排队的账户硬删除。
   *
   * 当前账户是最常见的删除对象：删除它时页面必须刷新，旧连接才会释放；
   * 这次启动是最可靠的删除时机。失败时标记会保留，并由下次启动继续重试。
   */
  await flushPendingAccountDeletions().catch(() => undefined);

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
    store,
    repository: new Repository(store),
    queue: createBackgroundRunner(store),
    ledger: createUsageLedger(store),
    tasks: createTaskQueueExtras(store),
  };
}
