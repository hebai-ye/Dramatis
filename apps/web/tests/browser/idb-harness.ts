import { createIndexedDbEntityStore, DB_CONNECTION_EVENT } from '../../src/lib/db';

type Opened = Awaited<ReturnType<typeof createIndexedDbEntityStore>>;
type Row = { id: string; roomId?: string; updatedAt?: string; text?: string };
const allowed = /^q7-test-[a-zA-Z0-9_-]+$/;
const production = new Map<string, Opened>();
const native = new Map<string, IDBDatabase[]>();
const deletes = new Map<string, Promise<'success' | 'error'>>();
const deleteStatus = new Map<string, 'pending' | 'success' | 'error'>();
const events: string[] = [];
window.addEventListener(DB_CONNECTION_EVENT, (event) => events.push((event as CustomEvent<string>).detail));

function check(name: string): void {
  if (!allowed.test(name)) throw new Error('Q7 harness database name rejected');
}

function nativeOpen(name: string, version: number, oldSchema = false): Promise<number> {
  check(name);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      if (!oldSchema) return;
      const store = request.result.createObjectStore('entities', { keyPath: ['collection', 'id'] });
      store.createIndex('byCollection', 'collection');
    };
    request.onsuccess = () => {
      native.set(name, [...(native.get(name) ?? []), request.result]);
      resolve(request.result.version);
    };
    request.onerror = () => reject(request.error);
  });
}

function closeNative(name: string): void {
  check(name);
  for (const db of native.get(name) ?? []) db.close();
  native.delete(name);
}

function closeProduction(name: string): void {
  check(name);
  production.get(name)?.db.close();
  production.delete(name);
}

const q7 = {
  events,
  async open(name: string) {
    check(name);
    const opened = await createIndexedDbEntityStore(name);
    production.set(name, opened);
    const tx = opened.db.transaction('entities');
    return { version: opened.db.version, indexes: [...tx.store.indexNames] };
  },
  nativeOpen,
  closeNative,
  closeProduction,
  async put(name: string, collection: string, value: Row) {
    check(name);
    await production.get(name)?.store.put(collection, value);
  },
  async get(name: string, collection: string, id: string) {
    check(name);
    return production.get(name)?.store.get<Row>(collection, id);
  },
  async list(name: string, collection: string, roomId: string) {
    check(name);
    return production.get(name)?.store.list<Row>(collection, { where: { roomId } });
  },
  async transaction(name: string, rollback: boolean) {
    check(name);
    const store = production.get(name)?.store;
    if (!store?.transaction) throw new Error('transaction unavailable');
    try {
      await store.transaction(async (scope) => {
        await scope.put('messages', { id: rollback ? 'rollback-m' : 'commit-m', roomId: 'room' });
        await scope.put('memories', { id: rollback ? 'rollback-a' : 'commit-a', roomId: 'room' });
        if (rollback) throw new Error('rollback requested');
      });
      return 'committed';
    } catch (error) {
      if (rollback && (error as Error).message === 'rollback requested') return 'rolled-back';
      throw error;
    }
  },
  async autoCommitAfterNativeComplete(name: string) {
    check(name);
    const store = production.get(name)?.store;
    if (!store?.transaction) throw new Error('transaction unavailable');
    let resolveCompletion!: (event: 'complete' | 'abort') => void;
    const completion = new Promise<'complete' | 'abort'>((resolve) => {
      resolveCompletion = resolve;
    });
    let captured = false;
    let nestedTransactionAvailable: boolean | null = null;
    let completedBeforeSecond = false;
    let secondAttempted = false;
    let secondPutRejectionName: string | null = null;
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
      const tx = original.call(this, storeNames, mode, options);
      if (this.name === name && mode === 'readwrite' && !captured) {
        captured = true;
        tx.addEventListener('complete', () => resolveCompletion('complete'), { once: true });
        tx.addEventListener('abort', () => resolveCompletion('abort'), { once: true });
      }
      return tx;
    };
    let rejectionName: string | null = null;
    try {
      await store.transaction(async (scope) => {
        nestedTransactionAvailable = scope.transaction !== undefined;
        await scope.put('messages', { id: 'auto-first', text: 'persisted before callback returned' });
        const event = await completion;
        if (event !== 'complete') throw new Error('native transaction aborted before second put');
        completedBeforeSecond = true;
        secondAttempted = true;
        try {
          await scope.put('messages', { id: 'auto-second', text: 'must not persist' });
        } catch (error) {
          secondPutRejectionName = error instanceof Error ? error.name : String(error);
          throw error;
        }
      });
    } catch (error) {
      rejectionName = error instanceof Error ? error.name : String(error);
    } finally {
      IDBDatabase.prototype.transaction = original;
    }
    return {
      captured,
      nestedTransactionAvailable,
      completedBeforeSecond,
      secondAttempted,
      secondPutRejectionName,
      rejectionName,
    };
  },
  async deleteBlocked(name: string) {
    check(name);
    deleteStatus.set(name, 'pending');
    let resolveVisible!: () => void;
    let rejectVisible!: (error: Error) => void;
    const visible = new Promise<void>((resolve, reject) => {
      resolveVisible = resolve;
      rejectVisible = reject;
    });
    const nativeSettled = new Promise<'success' | 'error'>((resolveNative) => {
      const request = indexedDB.deleteDatabase(name);
      request.onblocked = () => rejectVisible(new Error('delete blocked'));
      request.onsuccess = () => {
        deleteStatus.set(name, 'success');
        resolveNative('success');
        resolveVisible();
      };
      request.onerror = () => {
        deleteStatus.set(name, 'error');
        resolveNative('error');
        rejectVisible(request.error ?? new Error('delete failed'));
      };
    });
    deletes.set(name, nativeSettled);
    return visible;
  },
  async waitNativeDelete(name: string) {
    check(name);
    const settled = deletes.get(name);
    if (!settled) throw new Error('no native deletion request');
    return settled;
  },
  nativeDeleteStatus(name: string) {
    check(name);
    return deleteStatus.get(name) ?? null;
  },
  async cleanup(name: string) {
    check(name);
    closeProduction(name);
    closeNative(name);
    const nativeResult = await deletes.get(name);
    deletes.delete(name);
    deleteStatus.delete(name);
    if (nativeResult === 'success') return;
    if (nativeResult === 'error') throw new Error('native deletion failed');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('cleanup blocked'));
    });
  },
};

declare global {
  interface Window {
    q7: typeof q7;
  }
}
window.q7 = q7;
