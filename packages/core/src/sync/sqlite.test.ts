import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createSpaceCredentials } from '../crypto/keys.js';
import { encryptRecord } from '../crypto/records.js';
import { createSyncServer } from './server.js';
import { createSqliteSyncStore, SYNC_SCHEMA_SQL } from './sqlite.js';
import type { SyncWireRecord } from './types.js';

/**
 * SQLite 存储的测试（用 Node 自带的 `node:sqlite`）。
 *
 * 这一层的 bug 全藏在 SQL 里——号有没有真的递增、事务回不回滚、`since` 是不是
 * 开区间、空间之间会不会串——所以用真的数据库跑，而不是内存 Map。
 */

const FAST = { handleIterations: 100, keyIterations: 200 };
const AT = '2026-09-20T00:00:00.000Z';

async function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec(SYNC_SCHEMA_SQL);
  const store = createSqliteSyncStore(db);
  const server = createSyncServer(store);
  const created = await createSpaceCredentials({ userId: '旅人', password: '同步密码', ...FAST });

  await server.createSpace({
    spaceHandle: created.spaceHandle,
    credentialHash: created.credentialHash,
    recoveryCredentialHash: created.recoveryCredentialHash,
    keyWraps: { password: created.passwordWrap, recovery: created.recoveryWrap },
    at: AT,
  });

  const wire = async (id: string, updatedAt: string, deletedAt: string | null = null): Promise<SyncWireRecord> => ({
    collection: 'messages',
    id,
    updatedAt,
    deletedAt,
    sealed: await encryptRecord(
      created.encKey,
      { spaceHandle: created.spaceHandle, collection: 'messages', id, updatedAt },
      { id, content: `内容 ${id}` },
    ),
  });

  return { db, store, server, created, wire };
}

describe('SQLite 存储', () => {
  it('空间：建一次成功，再建同一个句柄返回 false（不覆盖）', async () => {
    const { server, created } = await harness();

    const again = await server.createSpace({
      spaceHandle: created.spaceHandle,
      credentialHash: '别的哈希',
      recoveryCredentialHash: '别的哈希',
      at: '2027-01-01T00:00:00.000Z',
    });

    expect(again).toBe('exists');
    // 原来的哈希没被改掉——否则谁先注册谁定这条就白写了
    const meta = await server.getSpaceMeta(created.spaceHandle);
    expect(meta?.credentialHash).toBe(created.credentialHash);
    expect(meta?.createdAt).toBe(AT);
  });

  it('号单调递增，且同一坐标的新版本覆盖旧行（不是追加两行）', async () => {
    const { server, created, store, wire } = await harness();

    const first = await server.push({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      baseHead: 0,
      records: [await wire('m1', '2026-09-20T00:00:01.000Z')],
    });
    const second = await server.push({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      baseHead: first.head,
      records: [await wire('m1', '2026-09-20T00:00:02.000Z'), await wire('m2', '2026-09-20T00:00:03.000Z')],
    });

    expect(first.accepted[0]?.serverRev).toBe(1);
    expect(second.accepted.map((record) => record.serverRev)).toEqual([2, 3]);
    expect(second.head).toBe(3);
    // m1 被覆盖：库里只有两行
    expect(store.stats().records).toBe(2);
  });

  it('list 的 since 是开区间，limit 真的生效，且按号升序', async () => {
    const { server, created, wire } = await harness();
    await server.push({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      baseHead: 0,
      records: [
        await wire('m1', '2026-09-20T00:00:01.000Z'),
        await wire('m2', '2026-09-20T00:00:02.000Z'),
        await wire('m3', '2026-09-20T00:00:03.000Z'),
      ],
    });

    const all = await server.pull({ spaceHandle: created.spaceHandle, credential: created.credential, since: 0 });
    expect(all.records.map((record) => record.serverRev)).toEqual([1, 2, 3]);

    const afterFirst = await server.pull({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      since: 1,
    });
    expect(afterFirst.records.map((record) => record.serverRev)).toEqual([2, 3]);

    const page = await server.pull({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      since: 0,
      limit: 2,
    });
    expect(page.records.map((record) => record.serverRev)).toEqual([1, 2]);
  });

  it('墓碑（deletedAt）与密文原样进出：服务端不解释内容', async () => {
    const { server, created, wire } = await harness();
    const tombstoneAt = '2026-09-20T00:00:09.000Z';
    await server.push({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      baseHead: 0,
      records: [await wire('m1', tombstoneAt, tombstoneAt)],
    });

    const pulled = await server.pull({ spaceHandle: created.spaceHandle, credential: created.credential, since: 0 });
    expect(pulled.records[0]?.deletedAt).toBe(tombstoneAt);
    expect(pulled.records[0]?.sealed.algorithm).toBe('AES-256-GCM');
  });

  it('空间之间完全隔离：另一个空间拉不到这个空间的记录', async () => {
    const { server, created, wire } = await harness();
    const other = await createSpaceCredentials({ userId: '另一个人', password: '别的密码', ...FAST });
    await server.createSpace({
      spaceHandle: other.spaceHandle,
      credentialHash: other.credentialHash,
      recoveryCredentialHash: other.recoveryCredentialHash,
      at: AT,
    });

    await server.push({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      baseHead: 0,
      records: [await wire('m1', '2026-09-20T00:00:01.000Z')],
    });

    const foreign = await server.pull({ spaceHandle: other.spaceHandle, credential: other.credential, since: 0 });
    expect(foreign.records).toHaveLength(0);
    expect(foreign.head).toBe(0);
  });

  it('凭证不对时服务端拒绝（两种凭证都认，伪造的不认）', async () => {
    const { server, created } = await harness();

    await expect(server.head({ spaceHandle: created.spaceHandle, credential: '伪造的凭证' })).rejects.toThrowError(
      /凭证/,
    );
    // 恢复码那份凭证也认（等价凭证）
    await expect(
      server.head({ spaceHandle: created.spaceHandle, credential: created.recoveryCredential }),
    ).resolves.toEqual({ head: 0 });
  });

  it('空 push 不动号（服务端不因为一次空请求就跳号）', async () => {
    const { server, created } = await harness();
    const result = await server.push({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      baseHead: 0,
      records: [],
    });

    expect(result).toEqual({ head: 0, accepted: [] });
  });
});
