import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createSpaceCredentials } from '../crypto/keys.js';
import { decryptRecord, encryptRecord } from '../crypto/records.js';
import { handleSyncRequest } from './http.js';
import { createHttpSyncTransport } from './http-client.js';
import { createMemorySyncStore, createSyncServer } from './server.js';
import { createSqliteSyncStore } from './sqlite.js';
import type { SyncPushResult, SyncWireRecord } from './types.js';

const AT = '2026-01-01T00:00:02.000Z';
const EARLIER = '2026-01-01T00:00:01.000Z';

describe.each(['memory', 'sqlite'] as const)('A03 HTTP 完整条件写协议 · %s', (kind) => {
  it('head 能力与 accepted/rejected 经 JSON 往返，当前记录可按其版本解密', async () => {
    const db = kind === 'sqlite' ? new DatabaseSync(':memory:') : null;
    if (db !== null) onTestFinished(() => db.close());
    const store = db === null ? createMemorySyncStore() : createSqliteSyncStore(db);
    const server = createSyncServer(store);
    const created = await createSpaceCredentials({
      userId: 'fixture-http-conditional',
      password: 'fixture-test-secret',
      handleIterations: 100,
      keyIterations: 200,
    });
    await server.createSpace({ ...created, at: AT });
    const credentials = { spaceHandle: created.spaceHandle, credential: created.credential };
    const transport = createHttpSyncTransport({
      endpoint: 'https://sync.example.test',
      fetchImpl: (input, init) => handleSyncRequest(new Request(input, init), { server }),
    });
    expect((await transport.head(credentials)).capabilities).toEqual({ conditionalPush: true });
    const makeWire = async (id: string, updatedAt: string, deletedAt: string | null): Promise<SyncWireRecord> => ({
      collection: 'messages',
      id,
      updatedAt,
      deletedAt,
      deviceId: 'fixture-device-current',
      sealed: await encryptRecord(
        created.encKey,
        { spaceHandle: created.spaceHandle, collection: 'messages', id, updatedAt },
        { id, content: 'fixture-current-ciphertext' },
      ),
    });
    const current = await makeWire('same', AT, AT);
    await transport.push({ ...credentials, records: [current] });
    const stale = await makeWire('same', EARLIER, null);
    const newRecord = await makeWire('new', AT, null);
    const tieLive = await makeWire('same', AT, null);
    const result = await transport.push({ ...credentials, records: [stale, newRecord, tieLive] });
    expect(result).toEqual({
      head: 2,
      accepted: [{ index: 1, collection: 'messages', id: 'new', serverRev: 2 }],
      rejected: [0, 2].map((index) => ({ index, current: { ...current, serverRev: 1 } })),
    });
    const rejected = result.rejected?.[0]?.current;
    expect(rejected).toBeDefined();
    if (rejected === undefined) throw new Error('missing rejection fixture');
    const value = await decryptRecord(
      created.encKey,
      {
        spaceHandle: created.spaceHandle,
        collection: rejected.collection,
        id: rejected.id,
        updatedAt: rejected.updatedAt,
      },
      rejected.sealed,
    );
    expect(value).toEqual({ id: 'same', content: 'fixture-current-ciphertext' });
    // 无 socket / 服务进程：真实 Request -> route -> JSON -> HTTP 客户端路径。
    const pulled = await transport.pull({ ...credentials, since: 0 });
    expect(pulled.records).toContainEqual(rejected);
  });
});

it('HTTP 客户端不替 legacy 响应补造能力、rejected 或 accepted 索引', async () => {
  const oldPush: SyncPushResult = { head: 1, accepted: [{ collection: 'messages', id: 'fixture', serverRev: 1 }] };
  const transport = createHttpSyncTransport({
    endpoint: 'https://sync.example.test',
    fetchImpl: (input) => Promise.resolve(Response.json(String(input).endsWith('/head') ? { head: 1 } : oldPush)),
  });
  const credentials = { spaceHandle: 'fixture-legacy', credential: 'fixture-secret' };
  expect(await transport.head(credentials)).toEqual({ head: 1 });
  expect(await transport.push({ ...credentials, records: [] })).toEqual(oldPush);
});

it('HTTP 层完整保留重复坐标 rejected 与 accepted 的原请求索引', async () => {
  const current: SyncWireRecord = {
    collection: 'messages',
    id: 'fixture',
    updatedAt: AT,
    deletedAt: null,
    sealed: { algorithm: 'AES-256-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' },
  };
  const expected: SyncPushResult = {
    head: 8,
    accepted: [{ index: 2, collection: 'messages', id: 'fixture', serverRev: 8 }],
    rejected: [0, 1].map((index) => ({ index, current: { ...current, serverRev: 8 } })),
  };
  const transport = createHttpSyncTransport({
    endpoint: 'https://sync.example.test',
    fetchImpl: () => Promise.resolve(Response.json(expected)),
  });
  expect(
    await transport.push({
      spaceHandle: 'fixture',
      credential: 'fixture-secret',
      records: [current, current, current],
    }),
  ).toEqual(expected);
});
