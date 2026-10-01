import { createVault } from '@dramatis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAccountSyncInfo } from './account-auth';
import * as accountDb from './db';
import { browserVaultStorage, createBrowserKeyStore, openBrowserVault, removeBrowserKeyRefs } from './keystore';

const boundary = vi.hoisted(() => ({
  rows: new Map<string, Array<{ collection: string; id: string; value: unknown }>>(),
  failedReads: new Set<string>(),
  beforeRead: null as (() => Promise<void>) | null,
}));

vi.mock('idb', () => ({
  openDB: async (name: string) => {
    if (boundary.failedReads.has(name)) throw new Error('账户库读取失败');
    return {
      close() {},
      async getAllFromIndex(_store: string, _index: string, collection: string) {
        const beforeRead = boundary.beforeRead;
        boundary.beforeRead = null;
        if (beforeRead !== null) await beforeRead();
        if (boundary.failedReads.has(name)) throw new Error('账户库读取失败');
        return (boundary.rows.get(name) ?? []).filter((row) => row.collection === collection);
      },
      async get(_store: string, [collection, id]: string[]) {
        return boundary.rows.get(name)?.find((row) => row.collection === collection && row.id === id);
      },
    };
  },
}));

const registryKey = 'dramatis.accounts.v2';
const queueKey = 'dramatis.accounts.pendingDelete.v1';
const plainKey = 'dramatis.keys.v1';
const vaultKey = 'dramatis.vault.v1';
let values: Map<string, string>;
let deniedWrites: Set<string>;
let deniedReads: Set<string>;
let blockedDatabases: Set<string>;
let deletedDatabases: string[];

function account(id: string): accountDb.LocalAccount {
  return {
    id,
    accountId: `test-${id}`,
    name: `测试账户${id}`,
    dbName: `dramatis:acct:${id}`,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    lastOpenedAt: null,
    legacy: false,
  };
}

function seedRegistry(accounts = [account('a'), account('b')], activeId = 'a') {
  values.set(registryKey, JSON.stringify({ version: 2, activeId, accounts }));
}

function seedQueue(refs = ['owned'], dbName = 'dramatis:acct:removed') {
  values.set(
    queueKey,
    JSON.stringify({ items: [{ dbName, label: '待清理', secretRefs: refs, queuedAt: '2026-09-30' }] }),
  );
}

function refs(dbName: string, keyRefs: string[]) {
  boundary.rows.set(
    dbName,
    keyRefs.map((keyRef, index) => ({
      collection: 'providerProfiles',
      id: `p${index}`,
      value: { id: `p${index}`, keyRef },
    })),
  );
}

beforeEach(() => {
  values = new Map();
  deniedWrites = new Set();
  deniedReads = new Set();
  blockedDatabases = new Set();
  deletedDatabases = [];
  boundary.rows.clear();
  boundary.failedReads.clear();
  boundary.beforeRead = null;
  vi.stubGlobal('navigator', { locks: crossTabLocks() });
  vi.stubGlobal('localStorage', {
    getItem(key: string) {
      if (deniedReads.has(key)) throw new Error('存储拒绝读取');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (deniedWrites.has(key)) throw new Error('存储拒绝写入');
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  });
  vi.stubGlobal('indexedDB', {
    databases: async () => [...boundary.rows.keys()].map((name) => ({ name })),
    deleteDatabase(name: string) {
      const request = { onsuccess: null as (() => void) | null, onblocked: null as (() => void) | null };
      queueMicrotask(() => {
        if (blockedDatabases.has(name)) request.onblocked?.();
        else {
          deletedDatabases.push(name);
          boundary.rows.delete(name);
          request.onsuccess?.();
        }
      });
      return request;
    },
  });
  seedRegistry();
});

afterEach(() => vi.unstubAllGlobals());

function pauseNextRead() {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  boundary.beforeRead = async () => {
    started();
    await gate;
  };
  return { entered, release };
}

function crossTabLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const result = (tails.get(name) ?? Promise.resolve()).then(callback, callback);
      tails.set(
        name,
        result.catch(() => undefined),
      );
      return result;
    },
  };
}

describe('账户清理交错与全局互斥', () => {
  async function pauseDatabaseScan(databases: string[]) {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', {
      deleteDatabase: previous.deleteDatabase.bind(previous),
      databases: async () => {
        entered();
        await gate;
        return databases.map((name) => ({ name }));
      },
    });
    const loading = accountDb.loadAccountRegistry();
    await started;
    return { loading, release };
  }

  it('旧库扫描期间删除的账户不会因扫描旧快照写回而复活', async () => {
    const scan = await pauseDatabaseScan(['dramatis:acct:a', 'dramatis:acct:b', 'dramatis:acct:legacy-new']);
    const { deleteAccountLocally } = await import('./account-deletion');
    await deleteAccountLocally(account('b'));
    expect(accountDb.pendingAccountDeletionCount()).toBe(0);
    scan.release();
    const registry = await scan.loading;
    expect(registry.accounts.map((item) => item.id)).toEqual(['a', 'legacy-legacy-new']);
    expect(accountDb.readAccountRegistry().accounts.map((item) => item.id)).toEqual(['a', 'legacy-legacy-new']);
  });

  it('扫描后重读注册表保留期间新建的账户与名称修改', async () => {
    const scan = await pauseDatabaseScan(['dramatis:acct:a', 'dramatis:acct:b', 'dramatis:acct:legacy-new']);
    accountDb.renameAccount('a', '扫描期间修改的名称');
    const added = accountDb.createAccount({ accountId: 'test-added', name: '扫描期间新增' });
    scan.release();
    const registry = await scan.loading;
    expect(registry.accounts.find((item) => item.id === 'a')?.name).toBe('扫描期间修改的名称');
    expect(registry.accounts.some((item) => item.id === added.id)).toBe(true);
    expect(accountDb.readAccountRegistry().accounts.some((item) => item.id === added.id)).toBe(true);
  });

  it('没有 Web Locks 时清理写回保留读取快照后新排入的 B 任务', async () => {
    vi.stubGlobal('navigator', {});
    seedQueue([], 'dramatis:acct:removed');
    const paused = pauseNextRead();
    const flush = accountDb.flushPendingAccountDeletions();
    await paused.entered;
    const queuedB = account('queued-b');
    refs(queuedB.dbName, []);
    accountDb.queueAccountDeletion(queuedB, ['new-b-ref']);
    paused.release();
    expect(await flush).toEqual({ deleted: 1, remaining: 1 });
    expect(JSON.parse(values.get(queueKey) ?? '{}').items).toEqual([
      expect.objectContaining({ dbName: 'dramatis:acct:queued-b', secretRefs: ['new-b-ref'] }),
    ]);
    expect((await accountDb.loadAccountRegistry()).accounts.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('没有 Web Locks 时不会移除同一数据库后来重新排入的新 queuedAt 项', async () => {
    vi.stubGlobal('navigator', {});
    seedQueue([], 'dramatis:acct:removed');
    const paused = pauseNextRead();
    const flush = accountDb.flushPendingAccountDeletions();
    await paused.entered;
    accountDb.queueAccountDeletion(account('removed'), ['later-ref']);
    const newer = values.get(queueKey);
    paused.release();
    expect(await flush).toEqual({ deleted: 1, remaining: 1 });
    expect(values.get(queueKey)).toBe(newer);
  });

  it('多个交错 flush 不会丢失期间新增且被其他标签页阻塞的 B 任务', async () => {
    vi.stubGlobal('navigator', {});
    seedQueue([], 'dramatis:acct:removed');
    const paused = pauseNextRead();
    const first = accountDb.flushPendingAccountDeletions();
    await paused.entered;
    const second = accountDb.flushPendingAccountDeletions();
    const queuedB = account('queued-b');
    blockedDatabases.add(queuedB.dbName);
    accountDb.queueAccountDeletion(queuedB, ['new-b-ref']);
    paused.release();
    await Promise.all([first, second]);
    expect(JSON.parse(values.get(queueKey) ?? '{}').items).toEqual([
      expect.objectContaining({ dbName: 'dramatis:acct:queued-b', secretRefs: ['new-b-ref'] }),
    ]);
    expect(accountDb.pendingAccountDeletionCount()).toBe(1);
  });

  it('另一标签页占据全局账户锁时，删除不会提前排队或移除账户', async () => {
    const locks = crossTabLocks();
    vi.stubGlobal('navigator', { locks });
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const otherTab = locks.request('dramatis-account-deletion', async () => {
      entered();
      await gate;
    });
    await started;
    const { deleteAccountLocally } = await import('./account-deletion');
    const deletion = deleteAccountLocally(account('b'));
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(accountDb.readAccountRegistry().accounts.map((item) => item.id)).toEqual(['a', 'b']);
      expect(values.has(queueKey)).toBe(false);
    } finally {
      release();
      await otherTab;
      await deletion;
    }
    expect(accountDb.readAccountRegistry().accounts.map((item) => item.id)).toEqual(['a']);
  });

  it('启动 flush 等待同一个跨标签页账户锁后才清库', async () => {
    seedQueue([], 'dramatis:acct:removed');
    const locks = crossTabLocks();
    vi.stubGlobal('navigator', { locks });
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const otherTab = locks.request('dramatis-account-deletion', async () => {
      entered();
      await gate;
    });
    await started;
    const flush = accountDb.flushPendingAccountDeletions();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deletedDatabases).toEqual([]);
      expect(accountDb.pendingAccountDeletionCount()).toBe(1);
    } finally {
      release();
      await otherTab;
    }
    expect(await flush).toEqual({ deleted: 1, remaining: 0 });
  });

  it('账户锁被拒绝时保留任务并明确失败', async () => {
    seedQueue();
    vi.stubGlobal('navigator', {
      locks: {
        request: async () => {
          throw new Error('账户锁不可用');
        },
      },
    });
    await expect(accountDb.flushPendingAccountDeletions()).rejects.toThrow('账户锁不可用');
    expect(accountDb.pendingAccountDeletionCount()).toBe(1);
    expect(deletedDatabases).toEqual([]);
  });
});

describe('账户删除的严格密钥清理', () => {
  it('真实普通 vault set 与账户清理交错时保留新引用并且不复活旧引用', async () => {
    const storage = browserVaultStorage();
    await createVault(storage, '测试口令', { iterations: 200 });
    const vault = await openBrowserVault('测试口令');
    await vault.store.set('owned', '待清理的测试密钥');
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = storage.read.bind(storage);
    const spy = vi.spyOn(storage, 'read').mockImplementationOnce(async () => {
      const raw = await read();
      entered();
      await gate;
      return raw;
    });
    try {
      const saving = vault.store.set('new-ref', '新保存的测试密钥');
      await started;
      const deleting = removeBrowserKeyRefs(['owned']);
      await Promise.race([deleting, new Promise((resolve) => setTimeout(resolve, 10))]);
      release();
      await Promise.all([saving, deleting]);
      expect(await vault.store.list()).toEqual(['new-ref']);
      expect(await vault.store.get('new-ref')).toBe('新保存的测试密钥');
      expect(await vault.store.get('owned')).toBeNull();
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('存在口令库而无 Web Locks 时拒绝账户清理，保留队列与数据库', async () => {
    vi.stubGlobal('navigator', {});
    seedQueue(['owned']);
    values.set(plainKey, JSON.stringify({ owned: '明文待删' }));
    await createVault(browserVaultStorage(), '测试口令', { iterations: 200 });
    const before = values.get(vaultKey);
    await expect(removeBrowserKeyRefs(['owned'])).rejects.toThrow(/不支持安全清理口令库/);
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect(values.get(vaultKey)).toBe(before);
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ owned: '明文待删' });
    expect(deletedDatabases).toEqual([]);
  });

  it('口令库互斥锁拒绝时清理明确失败并保留队列', async () => {
    seedQueue(['owned']);
    const locks = crossTabLocks();
    vi.stubGlobal('navigator', {
      locks: {
        request<T>(name: string, callback: () => Promise<T>) {
          if (name === 'dramatis-key-vault') return Promise.reject(new Error('口令库清理锁不可用'));
          return locks.request(name, callback);
        },
      },
    });
    await expect(removeBrowserKeyRefs(['owned'])).rejects.toThrow('口令库清理锁不可用');
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect(deletedDatabases).toEqual([]);
  });

  it('清理读取期间新保存的明文引用不被旧缓存整份写回覆盖', async () => {
    values.set(plainKey, JSON.stringify({ owned: '待删', existing: '保留' }));
    const removal = removeBrowserKeyRefs(['owned']);
    values.set(plainKey, JSON.stringify({ owned: '待删', existing: '保留', newlySaved: '新保存' }));
    await removal;
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ existing: '保留', newlySaved: '新保存' });
  });

  it('清理读取期间新保存的口令库引用不被旧文件写回覆盖', async () => {
    const file = {
      kind: 'dramatis-key-vault',
      version: 1,
      kdf: { algorithm: 'PBKDF2-SHA256', iterations: 1, salt: 'test' },
      check: { iv: 'test', ciphertext: 'test' },
      secrets: { owned: { iv: 'test', ciphertext: 'test' }, existing: { iv: 'kept', ciphertext: 'kept' } },
    };
    values.set(vaultKey, JSON.stringify(file));
    const removal = removeBrowserKeyRefs(['owned']);
    values.set(
      vaultKey,
      JSON.stringify({ ...file, secrets: { ...file.secrets, newlySaved: { iv: 'new', ciphertext: 'new' } } }),
    );
    await removal;
    expect(JSON.parse(values.get(vaultKey) ?? '{}').secrets).toEqual({
      existing: { iv: 'kept', ciphertext: 'kept' },
      newlySaved: { iv: 'new', ciphertext: 'new' },
    });
  });

  it('口令库持续发生交错修改时清理明确失败并保留队列和数据库', async () => {
    seedQueue(['owned']);
    values.set(plainKey, JSON.stringify({ owned: '待删' }));
    const file = {
      kind: 'dramatis-key-vault',
      version: 1,
      kdf: { algorithm: 'PBKDF2-SHA256', iterations: 1, salt: 'test' },
      check: { iv: 'test', ciphertext: 'test' },
      secrets: { owned: { iv: 'test', ciphertext: 'test' } },
    };
    values.set(vaultKey, JSON.stringify(file));
    let revision = 0;
    vi.stubGlobal('localStorage', {
      getItem(key: string) {
        const value = values.get(key) ?? null;
        if (key === vaultKey) {
          revision += 1;
          values.set(
            vaultKey,
            JSON.stringify({
              ...file,
              secrets: { ...file.secrets, another: { iv: String(revision), ciphertext: 'new' } },
            }),
          );
        }
        return value;
      },
      setItem: (key: string, value: string) => values.set(key, value),
    });
    await expect(removeBrowserKeyRefs(['owned'])).rejects.toThrow(/正在被其他/);
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect(deletedDatabases).toEqual([]);
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ owned: '待删' });
    expect(JSON.parse(values.get(vaultKey) ?? '{}').secrets).toHaveProperty('another');
  });

  it('明文缓存拒写时抛错，普通密钥保存仍可降级', async () => {
    values.set(plainKey, JSON.stringify({ owned: '测试数据', other: '保留' }));
    deniedWrites.add(plainKey);
    await expect(createBrowserKeyStore('device').set('ordinary', '测试数据')).resolves.toBeUndefined();
    await expect(removeBrowserKeyRefs(['owned'])).rejects.toThrow();
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ owned: '测试数据', other: '保留' });
  });

  it('口令库拒写时清理失败，不把残留密钥算作已删除', async () => {
    values.set(
      vaultKey,
      JSON.stringify({
        kind: 'dramatis-key-vault',
        version: 1,
        kdf: { algorithm: 'PBKDF2-SHA256', iterations: 1, salt: 'test' },
        check: { iv: 'test', ciphertext: 'test' },
        secrets: { owned: { iv: 'test', ciphertext: 'test' } },
      }),
    );
    deniedWrites.add(vaultKey);
    await expect(removeBrowserKeyRefs(['owned'])).rejects.toThrow();
    expect(JSON.parse(values.get(vaultKey) ?? '{}').secrets).toHaveProperty('owned');
  });

  it.each([plainKey, vaultKey])('无法读取 %s 时明确失败', async (key) => {
    deniedReads.add(key);
    await expect(removeBrowserKeyRefs(['owned'])).rejects.toThrow();
  });

  it('坏掉的密钥缓存不当成空缓存成功', async () => {
    values.set(plainKey, '{invalid');
    await expect(removeBrowserKeyRefs(['owned'])).rejects.toThrow();
  });

  it('口令库 secrets 损坏时不当成空缓存', async () => {
    values.set(
      vaultKey,
      JSON.stringify({
        kind: 'dramatis-key-vault',
        version: 1,
        kdf: { algorithm: 'PBKDF2-SHA256', iterations: 1, salt: 'test' },
        check: { iv: 'test', ciphertext: 'test' },
        secrets: '无法读取的条目',
      }),
    );
    await expect(removeBrowserKeyRefs(['owned'])).rejects.toThrow();
  });

  it('待删条目损坏时不抹掉原队列或声称清理成功', async () => {
    const raw = JSON.stringify({ items: [{ dbName: 'dramatis:acct:removed', secretRefs: null }] });
    values.set(queueKey, raw);
    await expect(accountDb.flushPendingAccountDeletions()).rejects.toThrow();
    expect(values.get(queueKey)).toBe(raw);
    expect(deletedDatabases).toEqual([]);
  });

  it('口令库成功清理时保留其他账户的条目', async () => {
    values.set(
      vaultKey,
      JSON.stringify({
        kind: 'dramatis-key-vault',
        version: 1,
        kdf: { algorithm: 'PBKDF2-SHA256', iterations: 1, salt: 'test' },
        check: { iv: 'test', ciphertext: 'test' },
        secrets: { owned: { iv: 'test', ciphertext: 'test' }, shared: { iv: 'kept', ciphertext: 'kept' } },
      }),
    );
    await removeBrowserKeyRefs(['owned']);
    expect(JSON.parse(values.get(vaultKey) ?? '{}').secrets).toEqual({ shared: { iv: 'kept', ciphertext: 'kept' } });
  });

  it('清理拒写保留旧队列与数据库，并在下次恢复写入后成功重试', async () => {
    seedQueue();
    values.set(plainKey, JSON.stringify({ owned: '测试数据', other: '保留' }));
    deniedWrites.add(plainKey);
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect(deletedDatabases).toEqual([]);
    expect(JSON.parse(values.get(queueKey) ?? '{}').items).toHaveLength(1);
    deniedWrites.clear();
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 1, remaining: 0 });
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ other: '保留' });
  });

  it('共享模型引用由其他已注册账户保留', async () => {
    seedQueue(['shared', 'owned']);
    refs(account('a').dbName, ['shared']);
    values.set(plainKey, JSON.stringify({ shared: '保留', owned: '测试数据' }));
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 1, remaining: 0 });
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ shared: '保留' });
  });

  it('其他账户引用读取失败时不冒险删除共享缓存或数据库', async () => {
    seedQueue();
    boundary.failedReads.add(account('a').dbName);
    values.set(plainKey, JSON.stringify({ owned: '保留' }));
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect(deletedDatabases).toEqual([]);
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ owned: '保留' });
  });

  it('其他账户的 credential.id 也保护共享引用', async () => {
    seedQueue(['shared', 'owned']);
    boundary.rows.set(account('a').dbName, [
      {
        collection: 'providerCredentials',
        id: 'shared',
        value: { id: 'shared' },
      },
    ]);
    values.set(plainKey, JSON.stringify({ shared: '保留', owned: '测试数据' }));
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 1, remaining: 0 });
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ shared: '保留' });
  });

  it('注册表不可读取时不清密钥或数据库', async () => {
    seedQueue();
    deniedReads.add(registryKey);
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect(deletedDatabases).toEqual([]);
  });

  it('IndexedDB 不可用时不会返回删除成功', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(accountDb.deleteLocalDatabase('dramatis:acct:removed')).rejects.toThrow();
  });

  it('仍在注册表里的待删账户不清库，避免注册表拒写后误删', async () => {
    seedQueue(['owned'], account('b').dbName);
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect(deletedDatabases).toEqual([]);
  });

  it('队列清理写入拒绝时不能返回清理成功', async () => {
    seedQueue();
    deniedWrites.add(queueKey);
    await expect(accountDb.flushPendingAccountDeletions()).rejects.toThrow();
    expect(JSON.parse(values.get(queueKey) ?? '{}').items).toHaveLength(1);
  });

  it('排队持久化拒绝时不能装作排队成功', () => {
    deniedWrites.add(queueKey);
    expect(() => accountDb.queueAccountDeletion(account('b'), ['owned'])).toThrow();
  });

  it('被其他标签页阻塞保留标记，旧库扫描不会复活账户', async () => {
    const dbName = 'dramatis:acct:removed';
    seedQueue([], dbName);
    refs(dbName, []);
    blockedDatabases.add(dbName);
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect((await accountDb.loadAccountRegistry()).accounts.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('读取账户密钥引用失败会抛出', async () => {
    boundary.failedReads.add(account('b').dbName);
    await expect(accountDb.listAccountSecretRefs(account('b').dbName)).rejects.toThrow();
  });
});

describe('账户状态与旧注册表兼容', () => {
  it('状态读取失败可区分于未配置', async () => {
    boundary.failedReads.add(account('b').dbName);
    await expect(readAccountSyncInfo(account('b'))).rejects.toThrow();
  });

  it('成功读取无同步配置仍返回未配置', async () => {
    expect(await readAccountSyncInfo(account('b'))).toEqual({
      configured: false,
      lastSyncAt: null,
      endpoint: null,
      unlocked: false,
    });
  });

  it('旧单账户注册表迁移保持数据库名', () => {
    values.delete(registryKey);
    values.set('dramatis.localAccount.v1', JSON.stringify({ id: 'old-test', label: '旧测试账户' }));
    expect(accountDb.readAccountRegistry().accounts[0]).toMatchObject({
      id: 'old-test',
      accountId: 'old-test',
      dbName: 'dramatis:acct:old-test',
      legacy: true,
    });
  });
});

describe('结构化本机账户删除', () => {
  async function deleteAccount(target: accountDb.LocalAccount) {
    const module = await import('./account-deletion');
    return module.deleteAccountLocally(target);
  }

  it('非当前账户删除清掉自己的同步密码，保留其他账户', async () => {
    values.set(plainKey, JSON.stringify({ 'sync:password:b': '测试数据', 'sync:password:a': '保留' }));
    expect(await deleteAccount(account('b'))).toEqual({ requiresReload: false, pending: 0, warning: null });
    expect(JSON.parse(values.get(plainKey) ?? '{}')).toEqual({ 'sync:password:a': '保留' });
    expect(accountDb.readAccountRegistry().accounts.map((item) => item.id)).toEqual(['a']);
    expect(deletedDatabases).toEqual(['dramatis:acct:b']);
  });

  it('当前账户先移除并排队，等待页面释放连接', async () => {
    const result = await deleteAccount(account('a'));
    expect(result).toEqual({ requiresReload: true, pending: 1, warning: null });
    expect(accountDb.readAccountRegistry().activeId).toBe('b');
    expect(deletedDatabases).toEqual([]);
    expect(JSON.parse(values.get(queueKey) ?? '{}').items[0].secretRefs).toContain('sync:password:a');
  });

  it('使用重新读取的账户记录，最后一个账户不可删除', async () => {
    seedRegistry([account('b')], 'b');
    await expect(deleteAccount(account('b'))).rejects.toThrow(/至少/);
    expect(values.has(queueKey)).toBe(false);
    expect(deletedDatabases).toEqual([]);
  });

  it('过期记录的数据库名不会造成误删', async () => {
    expect(await deleteAccount({ ...account('b'), dbName: account('a').dbName })).toMatchObject({ pending: 0 });
    expect(deletedDatabases).toEqual(['dramatis:acct:b']);
  });

  it('非当前账户清理失败返回警告与待清理数量', async () => {
    blockedDatabases.add(account('b').dbName);
    const result = await deleteAccount(account('b'));
    expect(result.requiresReload).toBe(false);
    expect(result.pending).toBe(1);
    expect(result.warning).toBeTruthy();
    expect(JSON.parse(values.get(queueKey) ?? '{}').items).toHaveLength(1);
  });

  it('队列拒写阻止账户注册表移除', async () => {
    deniedWrites.add(queueKey);
    await expect(deleteAccount(account('b'))).rejects.toThrow(/写入/);
    expect(accountDb.readAccountRegistry().accounts).toHaveLength(2);
    expect(deletedDatabases).toEqual([]);
  });

  it('注册表拒写留下可重试队列，但不会误删仍注册的账户', async () => {
    deniedWrites.add(registryKey);
    await expect(deleteAccount(account('b'))).rejects.toThrow(/写入/);
    expect(accountDb.readAccountRegistry().accounts).toHaveLength(2);
    expect(JSON.parse(values.get(queueKey) ?? '{}').items).toHaveLength(1);
    expect(await accountDb.flushPendingAccountDeletions()).toEqual({ deleted: 0, remaining: 1 });
    expect(deletedDatabases).toEqual([]);
  });

  it('目标账户密钥引用读失败时不排队、不移除注册表', async () => {
    boundary.failedReads.add(account('b').dbName);
    await expect(deleteAccount(account('b'))).rejects.toThrow(/读取/);
    expect(accountDb.readAccountRegistry().accounts).toHaveLength(2);
    expect(values.has(queueKey)).toBe(false);
    expect(deletedDatabases).toEqual([]);
  });

  it('启动提示计数只读旧队列，不写注册表或队列', () => {
    seedQueue();
    const before = [...values.entries()];
    expect(accountDb.pendingAccountDeletionCount()).toBe(1);
    expect([...values.entries()]).toEqual(before);
  });

  it('启动提示读取队列失败或损坏时明确失败，避免显示零待清理', () => {
    values.set(queueKey, '{invalid');
    expect(() => accountDb.pendingAccountDeletionCount()).toThrow();
    deniedReads.add(queueKey);
    expect(() => accountDb.pendingAccountDeletionCount()).toThrow();
  });
});
