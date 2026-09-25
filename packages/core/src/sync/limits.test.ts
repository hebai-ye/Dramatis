/**
 * 服务端护栏（顺序 16）：每空间配额与写入限流。
 *
 * 这一条是「邀请朋友之前必须先有」的东西——说的不是能不能存，而是
 * **出事时有没有界**：一个写错的客户端不该能用一次请求吃掉服务端。
 */

import { describe, expect, it } from 'vitest';
import { createSpaceCredentials } from '../crypto/keys.js';
import type { EncryptedRecord } from '../crypto/records.js';
import { encryptRecord } from '../crypto/records.js';
import { handleSyncRequest } from './http.js';
import { createMemorySyncStore, createSyncServer, type DEFAULT_SYNC_LIMITS, SyncServerError } from './server.js';
import type { SyncWireRecord } from './types.js';

/** 测试里把 KDF 迭代数调小：这里验的是护栏，不是 KDF 强度。 */
const FAST = { handleIterations: 100, keyIterations: 200 };

async function spaceWithServer(limits: Partial<typeof DEFAULT_SYNC_LIMITS>, now?: () => number) {
  const created = await createSpaceCredentials({ userId: '旅人', password: '同步密码', ...FAST });
  const store = createMemorySyncStore();
  await store.createSpace({
    spaceHandle: created.spaceHandle,
    credentialHash: created.credentialHash,
    recoveryCredentialHash: created.credentialHash,
    keyWraps: {},
    createdAt: '2026-09-21T00:00:00.000Z',
  });
  const server = createSyncServer(store, { limits, ...(now === undefined ? {} : { now }) });
  return { created, store, server };
}

/** 造一条形状合法的密文记录（内容无所谓，护栏不看内容）。 */
async function wire(encKey: CryptoKey, spaceHandle: string, index: number): Promise<SyncWireRecord> {
  const id = `msg-${String(index)}`;
  const updatedAt = new Date(Date.UTC(2026, 8, 21, 0, 0, index)).toISOString();
  const sealed: EncryptedRecord = await encryptRecord(
    encKey,
    { spaceHandle, collection: 'messages', id, updatedAt },
    { id, content: `第 ${String(index)} 句` },
  );
  return { collection: 'messages', id, updatedAt, deletedAt: null, sealed };
}

describe('每空间配额与限流（顺序 16）', () => {
  it('一次请求带太多条 → 413，而且一条都没落库', async () => {
    const { created, store, server } = await spaceWithServer({ maxRecordsPerPush: 3 });
    const records = await Promise.all([0, 1, 2, 3].map((index) => wire(created.encKey, created.spaceHandle, index)));

    await expect(
      server.push({ spaceHandle: created.spaceHandle, credential: created.credential, records }),
    ).rejects.toMatchObject({ status: 413, code: 'space-full' });
    expect(store.debugRows(created.spaceHandle).size).toBe(0);
  });

  it('空间条数到顶 → 413（按「这批写完之后」判，不是等写进去再拦）', async () => {
    const { created, server } = await spaceWithServer({ maxRecordsPerSpace: 2 });
    const first = await Promise.all([0, 1].map((index) => wire(created.encKey, created.spaceHandle, index)));
    await server.push({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      records: first,
    });

    const extra = [await wire(created.encKey, created.spaceHandle, 9)];
    await expect(
      server.push({ spaceHandle: created.spaceHandle, credential: created.credential, records: extra }),
    ).rejects.toMatchObject({ status: 413 });

    // 覆盖已有的一条不算新条数（审计 C11：配额在写入事务里按「写完之后」精确算）：
    // 空间满了之后仍然能改、能删已有的记录
    await expect(
      server.push({
        spaceHandle: created.spaceHandle,
        credential: created.credential,
        records: [await wire(created.encKey, created.spaceHandle, 0)],
      }),
    ).resolves.toBeTruthy();
  });

  it('写入限流：一分钟内的第 N+1 次 → 429，过了一分钟又能写', async () => {
    let clock = 1_000_000;
    const { created, server } = await spaceWithServer({ pushesPerMinute: 2 }, () => clock);
    const one = await wire(created.encKey, created.spaceHandle, 0);
    const push = () =>
      server.push({ spaceHandle: created.spaceHandle, credential: created.credential, records: [one] });

    await push();
    await push();
    await expect(push()).rejects.toMatchObject({ status: 429, code: 'rate-limited' });

    clock += 61_000;
    await expect(push()).resolves.toBeTruthy();
  });

  it('没实现 spaceUsage 的存储跳过配额检查（老后端起得来）', async () => {
    const { created } = await spaceWithServer({});
    // 换个只实现必需方法的存储：不该因为它少了 stats 就报错
    const bare = createMemorySyncStore();
    await bare.createSpace({
      spaceHandle: created.spaceHandle,
      credentialHash: created.credentialHash,
      recoveryCredentialHash: created.credentialHash,
      keyWraps: {},
      createdAt: '2026-09-21T00:00:00.000Z',
    });
    delete (bare as { spaceUsage?: unknown }).spaceUsage;
    delete (bare as { appendWithinQuota?: unknown }).appendWithinQuota;
    const server = createSyncServer(bare, { limits: { maxRecordsPerSpace: 0 } });

    const one = await wire(created.encKey, created.spaceHandle, 0);
    await expect(
      server.push({ spaceHandle: created.spaceHandle, credential: created.credential, records: [one] }),
    ).resolves.toBeTruthy();

    // 有 spaceUsage 的存储、同一档限制：照样被挡住（说明护栏真的在看用量）
    const { created: other, server: strict } = await spaceWithServer({ maxRecordsPerSpace: 0 });
    const strictWire = await wire(other.encKey, other.spaceHandle, 0);
    await expect(
      strict.push({ spaceHandle: other.spaceHandle, credential: other.credential, records: [strictWire] }),
    ).rejects.toBeInstanceOf(SyncServerError);
  });

  it('HTTP 层把护栏翻成 413 / 429（不是 500）', async () => {
    const { created, server } = await spaceWithServer({ maxRecordsPerPush: 1 });
    const deps = { server };
    const body = {
      records: [await wire(created.encKey, created.spaceHandle, 0), await wire(created.encKey, created.spaceHandle, 1)],
    };
    const response = await handleSyncRequest(
      new Request(`http://127.0.0.1:5273/sync/spaces/${created.spaceHandle}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${created.credential}` },
        body: JSON.stringify(body),
      }),
      deps,
    );
    expect(response.status).toBe(413);
    const parsed = (await response.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('space-full');
  });
});

/**
 * 顺序 61 补的三道闸：`POST /spaces` 的来源限流与总量上限、以及字节配额改成
 * 「写完之后」判。这三条都是「公开接口能被不认识的人打」的防线。
 */
describe('建空间护栏（顺序 61）', () => {
  async function createBody() {
    const created = await createSpaceCredentials({
      userId: `旅人-${String(Math.random())}`,
      password: '同步密码',
      ...FAST,
    });
    return {
      created,
      body: JSON.stringify({
        spaceHandle: created.spaceHandle,
        credentialHash: created.credentialHash,
        recoveryCredentialHash: created.recoveryCredentialHash,
        keyWraps: {},
      }),
    };
  }

  async function postSpace(server: ReturnType<typeof createSyncServer>, clientKey: string, body: string) {
    return handleSyncRequest(
      new Request('http://127.0.0.1:5273/sync/spaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      { server, clientKey },
    );
  }

  it('同一个来源一分钟内建太多 → 429，另一个来源不受影响', async () => {
    const store = createMemorySyncStore();
    const server = createSyncServer(store, { limits: { spacesPerMinute: 2 } });

    const first = await createBody();
    const second = await createBody();
    const third = await createBody();

    expect((await postSpace(server, '1.2.3.4', first.body)).status).toBe(201);
    expect((await postSpace(server, '1.2.3.4', second.body)).status).toBe(201);

    const blocked = await postSpace(server, '1.2.3.4', third.body);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('rate-limited');

    // 换一个来源照常能建：限流是按来源，不是把整个服务端锁掉
    expect((await postSpace(server, '5.6.7.8', third.body)).status).toBe(201);
  });

  it('限流窗口按注入的时钟滑动，一分钟后就又能建', async () => {
    const store = createMemorySyncStore();
    let clock = 0;
    const server = createSyncServer(store, { limits: { spacesPerMinute: 1 }, now: () => clock });

    const first = await createBody();
    const second = await createBody();
    expect((await postSpace(server, '1.2.3.4', first.body)).status).toBe(201);
    expect((await postSpace(server, '1.2.3.4', second.body)).status).toBe(429);

    clock += 61_000;
    expect((await postSpace(server, '1.2.3.4', second.body)).status).toBe(201);
  });

  it('服务端上的空间总数到上限 → 503 server-full（409 的语义不变）', async () => {
    const store = createMemorySyncStore();
    const server = createSyncServer(store, { limits: { maxSpaces: 1 } });

    const first = await createBody();
    expect((await postSpace(server, '1.2.3.4', first.body)).status).toBe(201);

    const second = await createBody();
    const full = await postSpace(server, '9.9.9.9', second.body);
    expect(full.status).toBe(503);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe('server-full');

    // 同一个空间再建一次仍然是 409（「已经有了」和「装不下了」是两件事）
    const duplicate = await postSpace(server, '9.9.9.9', first.body);
    expect(duplicate.status).toBe(409);
  });

  it('字节配额按「写完之后」判：一批塞不下就整批拒绝', async () => {
    const { created, server } = await spaceWithServer({ maxBytesPerSpace: 1 });
    const one = await wire(created.encKey, created.spaceHandle, 0);

    // 上限 1 字节、随便一条密文都超：判据是 usage + 这一批 > 上限
    await expect(
      server.push({ spaceHandle: created.spaceHandle, credential: created.credential, records: [one] }),
    ).rejects.toMatchObject({ status: 413, code: 'space-full' });
  });
});
