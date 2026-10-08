import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashCredential } from '../crypto/keys.js';
import {
  createMemorySyncStore,
  createSyncServer,
  type SyncServerLimits,
  type SyncServerStore,
  syncRowBytes,
} from './server.js';
import { createSqliteSyncStore } from './sqlite.js';
import type { SyncWireRecord } from './types.js';

const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const T3 = '2026-01-01T00:00:03.000Z';
const T4 = '2026-01-01T00:00:04.000Z';
const credentials = { spaceHandle: 'fixture-conditional-space', credential: 'fixture-conditional-secret' };

function wire(id: string, updatedAt = T2, patch: Partial<SyncWireRecord> = {}): SyncWireRecord {
  return {
    collection: 'messages',
    id,
    updatedAt,
    deletedAt: null,
    sealed: { algorithm: 'AES-256-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' },
    ...patch,
  };
}

async function harness(kind: 'memory' | 'sqlite', limits: Partial<SyncServerLimits> = {}) {
  let store: SyncServerStore;
  if (kind === 'sqlite') {
    const db = new DatabaseSync(':memory:');
    onTestFinished(() => db.close());
    store = createSqliteSyncStore(db);
  } else {
    store = createMemorySyncStore();
  }
  const hash = await hashCredential(credentials.credential);
  await store.createSpace({
    spaceHandle: credentials.spaceHandle,
    credentialHash: hash,
    recoveryCredentialHash: hash,
    keyWraps: {},
    createdAt: T1,
  });
  const server = createSyncServer(store, { limits });
  const push = (records: SyncWireRecord[]) => server.push({ ...credentials, records });
  const rows = () => store.list(credentials.spaceHandle, { since: 0, limit: 500 });
  const usage = () => store.spaceUsage?.(credentials.spaceHandle);
  return { store, server, push, rows, usage };
}

describe.each(['memory', 'sqlite'] as const)('A03 原子条件写 · %s', (kind) => {
  it('能力由实际后端声明，严格较旧版本不覆盖也不涨 head / 用量', async () => {
    const { server, push, rows, usage } = await harness(kind);
    expect((await server.head(credentials)).capabilities).toEqual({ conditionalPush: true });
    const newest = wire('m', T3, { deviceId: 'fixture-device-z' });
    await push([newest]);
    const before = await usage();
    const result = await push([wire('m', T1), wire('m', T2)]);
    expect(result).toEqual({
      head: 1,
      accepted: [],
      rejected: [0, 1].map((index) => ({ index, current: { ...newest, serverRev: 1 } })),
    });
    expect(await usage()).toEqual(before);
    expect(await rows()).toEqual([{ ...newest, serverRev: 1 }]);
    expect((await push([wire('m', T4)])).accepted).toEqual([
      { index: 0, collection: 'messages', id: 'm', serverRev: 2 },
    ]);
  });

  it.each([false, true])('相同时间墓碑优先，先写墓碑 = %s', async (tombstoneFirst) => {
    const { push, rows } = await harness(kind);
    const live = wire('m');
    const tombstone = wire('m', T2, { deletedAt: T2 });
    await push([tombstoneFirst ? tombstone : live]);
    const result = await push([tombstoneFirst ? live : tombstone]);
    expect(result.accepted).toHaveLength(tombstoneFirst ? 0 : 1);
    expect(result.rejected).toHaveLength(tombstoneFirst ? 1 : 0);
    expect(await rows()).toEqual([{ ...tombstone, serverRev: tombstoneFirst ? 1 : 2 }]);
  });

  it('时间优先于墓碑：旧墓碑不能删新内容，更新版本可显式复活', async () => {
    const { push, rows } = await harness(kind);
    await push([wire('m', T2, { deletedAt: T2 })]);
    await push([wire('m', T3)]);
    const rejected = await push([wire('m', T2, { deletedAt: T2 })]);
    expect(rejected.head).toBe(2);
    expect(rejected.accepted).toEqual([]);
    expect(await rows()).toEqual([{ ...wire('m', T3), serverRev: 2 }]);
  });

  it.each([null, T2])('同类型时间平局继续后到写覆盖，不排序设备号，deletedAt=%s', async (deletedAt) => {
    const { push, rows } = await harness(kind);
    const first = wire('m', T2, { deletedAt, deviceId: 'fixture-z' });
    const second = wire('m', T2, {
      deletedAt,
      deviceId: 'fixture-a',
      sealed: { ...first.sealed, ciphertext: 'BBBB' },
    });
    await push([first]);
    expect((await push([second])).accepted[0]?.serverRev).toBe(2);
    expect(await rows()).toEqual([{ ...second, serverRev: 2 }]);
    expect((await push([first])).accepted[0]?.serverRev).toBe(3);
    expect(await rows()).toEqual([{ ...first, serverRev: 3 }]);
  });

  it('陈旧重发始终 no-op；同版本重发保留原有后到写语义且不涨条数/字节', async () => {
    const { push, usage } = await harness(kind);
    const record = wire('m', T3);
    await push([record]);
    const before = await usage();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await push([wire('m', T1)])).head).toBe(1);
    }
    expect((await push([record])).head).toBe(2);
    expect(await usage()).toEqual(before);
  });

  it('混合批次与重复坐标逐项返回索引；rejected.current 是本批最终胜者', async () => {
    const { push, rows, usage } = await harness(kind);
    await push([wire('a', T2)]);
    const finalA = wire('a', T3);
    const finalB = wire('b', T2, { deletedAt: T2 });
    const finalC = wire('c', T1);
    const result = await push([wire('a', T1), finalA, wire('a', T2), wire('b', T1), finalB, wire('b', T2), finalC]);
    expect(result.head).toBe(5);
    expect(result.accepted.map((item) => [item.index, item.id, item.serverRev])).toEqual([
      [1, 'a', 2],
      [3, 'b', 3],
      [4, 'b', 4],
      [6, 'c', 5],
    ]);
    expect(result.rejected).toEqual([
      { index: 0, current: { ...finalA, serverRev: 2 } },
      { index: 2, current: { ...finalA, serverRev: 2 } },
      { index: 5, current: { ...finalB, serverRev: 4 } },
    ]);
    expect(await rows()).toEqual([
      { ...finalA, serverRev: 2 },
      { ...finalB, serverRev: 4 },
      { ...finalC, serverRev: 5 },
    ]);
    expect(await usage()).toEqual({
      records: 3,
      bytes: [finalA, finalB, finalC].reduce((sum, r) => sum + syncRowBytes(r), 0),
    });
  });

  it('被拒的超大旧项不占条数/字节；满额仍可更新同坐标', async () => {
    const current = wire('配额/fixture', T3);
    const { push, usage } = await harness(kind, { maxRecordsPerSpace: 1, maxBytesPerSpace: syncRowBytes(current) });
    await push([current]);
    const stale = wire(current.id, T1, { sealed: { ...current.sealed, ciphertext: 'A'.repeat(10_000) } });
    const result = await push([stale, wire(current.id, T4)]);
    expect(result.head).toBe(2);
    expect(result.accepted.map((item) => item.index)).toEqual([1]);
    expect(result.rejected?.[0]?.index).toBe(0);
    expect(await usage()).toEqual({ records: 1, bytes: syncRowBytes(current) });
  });

  it('批内最后接受的版本决定配额，不是最后输入；较小旧项不能掩盖超额新项', async () => {
    const small = wire('m', T2);
    const big = wire('m', T3, { sealed: { ...small.sealed, ciphertext: 'A'.repeat(1000) } });
    const { push, rows, usage, server } = await harness(kind, { maxBytesPerSpace: syncRowBytes(small) });
    await push([small]);
    const before = await rows();
    await expect(push([big, wire('m', T1)])).rejects.toMatchObject({ status: 413, code: 'space-full' });
    expect(await rows()).toEqual(before);
    expect((await server.head(credentials)).head).toBe(1);
    expect(await usage()).toEqual({ records: 1, bytes: syncRowBytes(small) });
    // 反之，真正更新的小版本覆盖批内大版本后最终未超额，应整批接受。
    expect((await push([big, wire('m', T4)])).head).toBe(3);
    expect(await usage()).toEqual({ records: 1, bytes: syncRowBytes(small) });
  });

  it('条数配额失败：含拒绝项/覆盖项/新增项的整批原子失败，重试不跳号', async () => {
    const { push, rows, usage, server } = await harness(kind, { maxRecordsPerSpace: 1 });
    await push([wire('a', T2)]);
    const before = await rows();
    const beforeUsage = await usage();
    await expect(push([wire('a', T1), wire('a', T3), wire('b', T2)])).rejects.toMatchObject({ status: 413 });
    expect(await rows()).toEqual(before);
    expect(await usage()).toEqual(beforeUsage);
    expect((await server.head(credentials)).head).toBe(1);
    expect((await push([wire('a', T3)])).accepted[0]?.serverRev).toBe(2);
  });

  it('全拒绝批次在降低配额后仍是 no-op，不会因已有用量超额失败', async () => {
    const { store, push, usage } = await harness(kind);
    await push([wire('m', T3)]);
    const before = await usage();
    const lower = createSyncServer(store, { limits: { maxRecordsPerSpace: 0, maxBytesPerSpace: 0 } });
    const result = await lower.push({ ...credentials, records: [wire('m', T1)] });
    expect(result.accepted).toEqual([]);
    expect(result.head).toBe(1);
    expect(await usage()).toEqual(before);
  });

  it('旧 append / appendWithinQuota 保持数组返回，同时遵守条件版本规则', async () => {
    const { store, rows } = await harness(kind);
    await store.append(credentials.spaceHandle, [wire('m', T3)]);
    expect(await store.append(credentials.spaceHandle, [wire('m', T1)])).toEqual([]);
    expect(
      await store.appendWithinQuota?.(credentials.spaceHandle, [wire('m', T2)], { maxRecords: 1, maxBytes: 1000 }),
    ).toEqual([]);
    expect(await rows()).toEqual([{ ...wire('m', T3), serverRev: 1 }]);
  });

  it('两个服务端共享同一 store 并发推送，最终保留更新版本且配额不超', async () => {
    const { store, server, rows, usage } = await harness(kind, { maxRecordsPerSpace: 1 });
    const other = createSyncServer(store, { limits: { maxRecordsPerSpace: 1 } });
    await Promise.all([
      server.push({ ...credentials, records: [wire('m', T3)] }),
      other.push({ ...credentials, records: [wire('m', T1)] }),
    ]);
    expect((await rows())[0]?.updatedAt).toBe(T3);
    expect((await usage())?.records).toBe(1);
  });
});

it('legacy 存储不声明条件写能力，返回旧版 head/accepted 仍可用', async () => {
  const { store } = await harness('memory');
  const legacy: SyncServerStore = {
    getSpace: store.getSpace,
    createSpace: store.createSpace,
    head: store.head,
    append: store.append,
    list: store.list,
  };
  const server = createSyncServer(legacy);
  expect((await server.head(credentials)).capabilities).toBeUndefined();
  const result = await server.push({ ...credentials, records: [wire('m')] });
  expect(result.head).toBe(1);
  expect(result.rejected).toBeUndefined();
});

it('条件写失败绝不回退到旧 append，也不伪造 accepted', async () => {
  const { store } = await harness('memory');
  let legacyWrites = 0;
  store.appendConditionalWithinQuota = async () => {
    throw new Error('fixture-transaction-failure');
  };
  store.append = async () => {
    legacyWrites += 1;
    return [];
  };
  const server = createSyncServer(store);
  await expect(server.push({ ...credentials, records: [wire('m')] })).rejects.toThrow('fixture-transaction-failure');
  expect(legacyWrites).toBe(0);
  expect(await store.head(credentials.spaceHandle)).toBe(0);
});
