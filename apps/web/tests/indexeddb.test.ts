import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createIndexedDbEntityStore, DB_CONNECTION_EVENT } from '../src/lib/db';

type Row = { id: string; roomId?: string; updatedAt?: string; text?: string };
const names: string[] = [];
const connections: IDBDatabase[] = [];
const eventTarget = new EventTarget();
Object.defineProperty(globalThis, 'window', { configurable: true, value: eventTarget });
if (typeof CustomEvent === 'undefined') {
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class<T> extends Event {
      detail: T;
      constructor(type: string, init: CustomEventInit<T>) {
        super(type);
        this.detail = init.detail as T;
      }
    },
  });
}

function name(): string {
  const value = `q7-test-${randomUUID()}`;
  names.push(value);
  return value;
}

function nativeOpen(databaseName: string, version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => {
      connections.push(request.result);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

afterEach(async () => {
  for (const db of connections.splice(0)) db.close();
  await Promise.all(
    names.splice(0).map(
      (databaseName) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
    ),
  );
});

describe('IndexedDB store behavior with fake-indexeddb', () => {
  it('commits across collections and rolls back when the transaction callback throws', async () => {
    const { db, store } = await createIndexedDbEntityStore(name());
    connections.push(db);
    await store.transaction?.(async (scope) => {
      await scope.put('messages', { id: 'm1', text: 'kept' });
      await scope.put('memories', { id: 'a1', text: 'kept' });
    });
    expect(await store.get<Row>('messages', 'm1')).toMatchObject({ text: 'kept' });
    expect(await store.get<Row>('memories', 'a1')).toMatchObject({ text: 'kept' });
    await expect(
      store.transaction?.(async (scope) => {
        await scope.put('messages', { id: 'm2', text: 'rolled back' });
        await scope.put('memories', { id: 'a2', text: 'rolled back' });
        throw new Error('cancel');
      }),
    ).rejects.toThrow('cancel');
    expect(await store.get('messages', 'm2')).toBeNull();
    expect(await store.get('memories', 'a2')).toBeNull();
  });

  it('updates duplicate keys and clones written and returned values', async () => {
    const { db, store } = await createIndexedDbEntityStore(name());
    connections.push(db);
    const input = { id: 'same', roomId: 'room-a', text: 'first' };
    await store.put('messages', input);
    input.text = 'mutated source';
    expect(await store.get<Row>('messages', 'same')).toMatchObject({ text: 'first' });
    await store.put('messages', { id: 'same', roomId: 'room-a', text: 'second' });
    expect(await store.count('messages')).toBe(1);
    const output = await store.get<Row>('messages', 'same');
    if (output) output.text = 'mutated result';
    expect(await store.get<Row>('messages', 'same')).toMatchObject({ text: 'second' });
  });

  it('filters by compound room key and honors inclusive listSince', async () => {
    const { db, store } = await createIndexedDbEntityStore(name());
    connections.push(db);
    await store.bulkPut('messages', [
      { id: 'a', roomId: 'r1', updatedAt: '2026-01-01T00:00:00Z', text: 'same' },
      { id: 'b', roomId: 'r1', updatedAt: '2026-01-02T00:00:00Z', text: 'later' },
      { id: 'c', roomId: 'r2', updatedAt: '2026-01-03T00:00:00Z', text: 'other' },
    ]);
    expect((await store.list<Row>('messages', { where: { roomId: 'r1' } })).map((row) => row.id)).toEqual(['a', 'b']);
    expect(await store.count('messages', { roomId: 'r1', text: 'later' })).toBe(1);
    const threshold = '2026-01-01T00:00:00Z';
    expect((await store.listSince<Row>('messages', threshold)).map((row) => row.id)).toEqual(['b', 'c']);
    expect((await store.listSince<Row>('messages', threshold, { inclusive: true })).map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('upgrades v1 without dropping its row and creates v2 indexes', async () => {
    const databaseName = name();
    const old = await nativeOpen(databaseName, 1, (db) => {
      const store = db.createObjectStore('entities', { keyPath: ['collection', 'id'] });
      store.createIndex('byCollection', 'collection');
    });
    await new Promise<void>((resolve, reject) => {
      const tx = old.transaction('entities', 'readwrite');
      tx.objectStore('entities').put({
        collection: 'messages',
        id: 'old',
        value: { id: 'old', roomId: 'r1', updatedAt: '2026-01-01T00:00:00Z' },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    old.close();
    const { db, store } = await createIndexedDbEntityStore(databaseName);
    connections.push(db);
    expect(db.version).toBe(2);
    expect([...db.transaction('entities').store.indexNames]).toEqual([
      'byCollection',
      'byCollectionRoom',
      'byCollectionUpdated',
    ]);
    expect(await store.get<Row>('messages', 'old')).toMatchObject({ roomId: 'r1' });
  });

  it('emits blocked until an old native connection closes, then opens', async () => {
    const databaseName = name();
    const old = await nativeOpen(databaseName, 1, (db) => {
      const store = db.createObjectStore('entities', { keyPath: ['collection', 'id'] });
      store.createIndex('byCollection', 'collection');
    });
    const blocked = new Promise<string>((resolve) =>
      eventTarget.addEventListener(DB_CONNECTION_EVENT, (event) => resolve((event as CustomEvent<string>).detail), {
        once: true,
      }),
    );
    const opening = createIndexedDbEntityStore(databaseName);
    expect(await blocked).toBe('blocked');
    old.close();
    const { db } = await opening;
    connections.push(db);
    expect(db.version).toBe(2);
  });

  it('closes a production v2 connection when native v3 requests an upgrade', async () => {
    const databaseName = name();
    const { db } = await createIndexedDbEntityStore(databaseName);
    connections.push(db);
    const blocking = new Promise<string>((resolve) =>
      eventTarget.addEventListener(DB_CONNECTION_EVENT, (event) => resolve((event as CustomEvent<string>).detail), {
        once: true,
      }),
    );
    const upgraded = nativeOpen(databaseName, 3);
    expect(await blocking).toBe('blocking');
    expect((await upgraded).version).toBe(3);
  });
});
