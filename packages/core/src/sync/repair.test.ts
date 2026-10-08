import { describe, expect, it } from 'vitest';
import { createSpaceCredentials } from '../crypto/keys.js';
import { encryptRecord } from '../crypto/records.js';
import type { EntityStore } from '../platform/entity-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { Repository } from '../storage/repository.js';
import { runSync } from './loop.js';
import { createMemorySyncTransport } from './memory-transport.js';
import { SYNC_PUSH_MAX_BYTES, syncPushBytes } from './push-batches.js';
import { syncReconciliationKey, syncVersionKey } from './repair.js';
import type { LocalSyncRecord, SyncTransport, SyncWireRecord } from './types.js';

const at = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
function row(day: number, id = 'fixture-card', deleted = false): LocalSyncRecord {
  return {
    collection: 'cards',
    id,
    updatedAt: at(day),
    deletedAt: deleted ? at(day) : null,
    value: { id, name: `revision-${day}`, updatedAt: at(day), deletedAt: deleted ? at(day) : null },
  };
}
async function fixture() {
  const auth = await createSpaceCredentials({
    userId: 'fixture-user',
    password: 'fixture-password',
    handleIterations: 10,
    keyIterations: 10,
  });
  const store = createMemoryEntityStore();
  const repository = new Repository(store);
  const server = createMemorySyncTransport(auth);
  const scope = { spaceHandle: auth.spaceHandle, epoch: (await server.transport.head(auth)).epoch ?? null };
  const run = (transport: SyncTransport = server.transport, repo = repository) =>
    runSync({ ...auth, repository: repo, transport });
  const wire = async (record: LocalSyncRecord): Promise<SyncWireRecord> => ({
    collection: record.collection,
    id: record.id,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    sealed: await encryptRecord(auth.encKey, { ...record, spaceHandle: auth.spaceHandle }, record.value),
  });
  const push = async (record: LocalSyncRecord) => server.transport.push({ ...auth, records: [await wire(record)] });
  return { auth, store, repository, server, scope, run, wire, push };
}

describe('顺序113：同步补推与逐项确认闭环', () => {
  it('升级全量复核找回旧水位线下的较新本地版本，断网后重新打开仍会补推', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(1));
    await f.run();
    await f.repository.putSyncRecord(row(2));
    await f.repository.writeSyncState({ spaceHandle: f.auth.spaceHandle, pulledHead: 1, pushedAt: at(20) });
    await f.repository.setMeta(syncReconciliationKey(f.scope), null);
    await expect(
      f.run({
        ...f.server.transport,
        push: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toThrow('offline');
    expect((await f.repository.listSyncRepairs(f.scope)).map((m) => m.updatedAt)).toEqual([at(2)]);
    expect((await f.repository.readSyncState()).pushedAt).toBe(at(20));
    expect((await f.run(f.server.transport, new Repository(f.store))).pushed).toBe(1);
    expect(f.server.raw()[0]?.updatedAt).toBe(at(2));
    expect(await f.repository.listSyncRepairs(f.scope)).toEqual([]);
  });

  it('升级全量复核也找回服务器完全缺失且时间低于旧水位线的记录', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(1));
    await f.run();
    await f.repository.putSyncRecord(row(2, 'missing-on-server'));
    await f.repository.writeSyncState({ spaceHandle: f.auth.spaceHandle, pulledHead: 1, pushedAt: at(20) });
    await f.repository.setMeta(syncReconciliationKey(f.scope), null);
    expect((await f.run()).pushed).toBe(1);
    expect(f.server.raw().some((r) => r.id === 'missing-on-server')).toBe(true);
    expect(await f.repository.listSyncRepairs(f.scope)).toEqual([]);
  });

  it('服务端并发胜者以拒绝响应合并，不把被拒的旧版本计作已推送', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(1));
    await f.run();
    await f.repository.putSyncRecord(row(2));
    let raced = false;
    const report = await f.run({
      ...f.server.transport,
      push: async (input) => {
        if (!raced) {
          raced = true;
          await f.push(row(3));
        }
        return f.server.transport.push(input);
      },
    });
    expect(report.pushed).toBe(0);
    expect((await f.repository.getSyncRecord('cards', 'fixture-card'))?.updatedAt).toBe(at(3));
    expect(f.server.raw()[0]?.updatedAt).toBe(at(3));
    expect(await f.repository.listSyncRepairs(f.scope)).toEqual([]);
  });

  it('错误或缺项确认不能推进游标，补推凭证保留', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(1));
    const before = await f.repository.readSyncState();
    await expect(f.run({ ...f.server.transport, push: async () => ({ head: 4, accepted: [] }) })).rejects.toThrow(
      '逐项确认',
    );
    expect(await f.repository.readSyncState()).toEqual(before);
    expect(await f.repository.listSyncRepairs(f.scope)).toHaveLength(1);
  });

  it('拒绝响应密文损坏必须报错，不用无法验证的胜者清除补推凭证', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(1));
    await f.run();
    await f.repository.putSyncRecord(row(2));
    const before = await f.repository.readSyncState();
    await expect(
      f.run({
        ...f.server.transport,
        push: async (input) => {
          await f.push(row(3));
          const result = await f.server.transport.push(input);
          return {
            ...result,
            rejected: result.rejected?.map((r) => ({
              ...r,
              current: { ...r.current, sealed: { ...r.current.sealed, ciphertext: 'broken' } },
            })),
          };
        },
      }),
    ).rejects.toThrow('无法解密');
    expect(await f.repository.readSyncState()).toEqual(before);
    expect(await f.repository.listSyncRepairs(f.scope)).toHaveLength(1);
  });

  it('请求飞行期间本地再次编辑，即使时间低于旧水位线也保留新版本待补推', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(1));
    await f.run();
    await f.repository.putSyncRecord(row(2));
    await f.repository.markSyncRepair(f.scope, row(2));
    await f.repository.writeSyncState({ spaceHandle: f.auth.spaceHandle, pulledHead: 1, pushedAt: at(20) });
    await f.run({
      ...f.server.transport,
      push: async (input) => {
        await f.repository.putSyncRecord(row(3));
        return f.server.transport.push(input);
      },
    });
    expect((await f.repository.listSyncRepairs(f.scope))[0]?.updatedAt).toBe(at(3));
    await f.run(f.server.transport, new Repository(f.store));
    expect(f.server.raw()[0]?.updatedAt).toBe(at(3));
    expect(await f.repository.listSyncRepairs(f.scope)).toEqual([]);
  });

  it('旧服务端没有能力字段与下标时仍按完整坐标确认，而不是强制升级协议', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(2));
    const report = await f.run({
      ...f.server.transport,
      head: async (input) => ({ head: (await f.server.transport.head(input)).head }),
      push: async (input) => {
        const result = await f.server.transport.push(input);
        return {
          head: result.head,
          accepted: result.accepted.map(({ collection, id, serverRev }) => ({ collection, id, serverRev })),
        };
      },
    });
    expect(report.pushed).toBe(1);
    expect(await f.repository.listSyncRepairs(f.scope)).toEqual([]);
  });

  it('丢响应后重开仓储可安全重试，不丢已提交记录', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(2));
    await expect(
      f.run({
        ...f.server.transport,
        push: async (input) => {
          await f.server.transport.push(input);
          throw new Error('lost-response');
        },
      }),
    ).rejects.toThrow('lost-response');
    await f.run(f.server.transport, new Repository(f.store));
    expect(f.server.raw()[0]?.updatedAt).toBe(at(2));
    expect(await f.repository.listSyncRepairs(f.scope)).toEqual([]);
  });

  it('补推按空间及epoch隔离，旧请求不能删除新观察到的同版本token', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(2));
    const old = await f.repository.markSyncRepair(f.scope, row(2));
    const fresh = await f.repository.markSyncRepair(f.scope, row(2));
    await f.repository.acknowledgeSyncRepair(old, row(2));
    expect((await f.repository.listSyncRepairs(f.scope))[0]?.token).toBe(fresh.token);
    expect(await f.repository.listSyncRepairs({ ...f.scope, epoch: 'new-epoch' })).toEqual([]);
    expect(await f.repository.listSyncRepairs({ ...f.scope, spaceHandle: 'other-space' })).toEqual([]);
    await f.repository.acknowledgeSyncRepair(fresh, row(2));
    expect(await f.repository.listSyncRepairs(f.scope)).toEqual([]);
  });

  it('原子合并以update中的当前值判定，而不是使用事务外的旧快照', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    await repo.putSyncRecord(row(1));
    const update = store.update?.bind(store);
    if (update === undefined) throw new Error('fixture requires update');
    store.update = async (collection, id, mutate) => {
      if (collection === 'cards') await repo.putSyncRecord(row(3));
      return update(collection, id, mutate);
    };
    expect((await repo.mergeSyncRecord(row(2))).decision).toBe('keep-local');
    expect((await repo.getSyncRecord('cards', 'fixture-card'))?.updatedAt).toBe(at(3));
  });

  it('没有原子update就失败关闭，不偷偷回退get/put', async () => {
    const f = await fixture();
    const noUpdate: EntityStore = { ...f.store, update: undefined };
    await expect(f.run(f.server.transport, new Repository(noUpdate))).rejects.toThrow('原子 update');
  });

  it('墓碑与同时间活记录是不同版本；墓碑仍会补推', async () => {
    const f = await fixture();
    await f.repository.putSyncRecord(row(2));
    await f.run();
    await f.repository.putSyncRecord(row(2, 'fixture-card', true));
    await f.repository.markSyncRepair(f.scope, row(2, 'fixture-card', true));
    await f.run();
    expect(f.server.raw()[0]?.deletedAt).toBe(at(2));
    expect(syncVersionKey(row(2))).not.toBe(syncVersionKey(row(2, 'fixture-card', true)));
  });

  it('真实加密后的同步正文超过8MiB时分批，不只按条数分批', async () => {
    const f = await fixture();
    for (const id of ['large-a', 'large-b']) {
      const record = row(2, id);
      record.value = { ...(record.value as object), content: 'x'.repeat(3_200_000) };
      await f.repository.putSyncRecord(record);
    }
    const sizes: number[] = [];
    const report = await f.run({
      ...f.server.transport,
      push: async (input) => {
        sizes.push(syncPushBytes(input.records));
        return f.server.transport.push(input);
      },
    });
    expect(sizes).toHaveLength(2);
    expect(sizes.every((bytes) => bytes <= SYNC_PUSH_MAX_BYTES)).toBe(true);
    expect(report.pushed).toBe(2);
  });

  it('真实加密后单条超限不发送，保留补推与原游标并报告坐标', async () => {
    const f = await fixture();
    const record = row(2, 'oversized-fixture');
    record.value = { ...(record.value as object), content: 'x'.repeat(6_400_000) };
    await f.repository.putSyncRecord(record);
    const state = await f.repository.readSyncState();
    let calls = 0;
    await expect(
      f.run({
        ...f.server.transport,
        push: async (input) => {
          calls++;
          return f.server.transport.push(input);
        },
      }),
    ).rejects.toMatchObject({ code: 'sync-record-too-large', collection: 'cards', id: record.id });
    expect(calls).toBe(0);
    expect(await f.repository.readSyncState()).toEqual(state);
    expect(await f.repository.listSyncRepairs(f.scope)).toHaveLength(1);
  });

  it('升级全量复核到200页暂停，重启从专用游标续拉，完成前不推', async () => {
    const f = await fixture();
    const records = await Promise.all(Array.from({ length: 202 }, (_, i) => f.wire(row(1, `fixture-${i}`))));
    await f.server.transport.push({ ...f.auth, records });
    await f.repository.putSyncRecord(row(2, 'fixture-0'));
    await f.repository.writeSyncState({ spaceHandle: f.auth.spaceHandle, pulledHead: 202, pushedAt: at(20) });
    const run = (repository: Repository) => runSync({ ...f.auth, repository, transport: f.server.transport, limit: 1 });
    expect((await run(f.repository)).pushed).toBe(0);
    expect(await f.repository.getMeta(syncReconciliationKey(f.scope))).toMatchObject({ cursor: 200, complete: false });
    expect((await run(new Repository(f.store))).pushed).toBe(1);
    expect(f.server.raw().find((r) => r.id === 'fixture-0')?.updatedAt).toBe(at(2));
    expect(await f.repository.getMeta(syncReconciliationKey(f.scope))).toMatchObject({ complete: true });
  });
});
