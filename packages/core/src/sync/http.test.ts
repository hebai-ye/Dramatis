import { describe, expect, it } from 'vitest';
import { createSpaceCredentials, openSpace } from '../crypto/keys.js';
import { decryptRecord, encryptRecord } from '../crypto/records.js';
import { handleSyncRequest } from './http.js';
import { createMemorySyncStore, createSyncServer } from './server.js';
import type { SyncWireRecord } from './types.js';

const FAST = { handleIterations: 100, keyIterations: 200 };
const AT = '2026-09-20T00:00:00.000Z';

/** 起一个「服务器」，返回一个只会发请求的小客户端。 */
async function harness() {
  const created = await createSpaceCredentials({ userId: '旅人', password: '同步密码', ...FAST });
  const store = createMemorySyncStore();
  const server = createSyncServer(store);

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    handleSyncRequest(new Request(`http://sync.test${path}`, init), { server, now: () => AT });

  const body = <T>(response: Response): Promise<T> => response.json() as Promise<T>;

  const registerSpace = (): Promise<Response> =>
    call('/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        spaceHandle: created.spaceHandle,
        credentialHash: created.credentialHash,
        recoveryCredentialHash: created.recoveryCredentialHash,
        keyWraps: { password: created.passwordWrap, recovery: created.recoveryWrap },
        at: AT,
      }),
    });

  return { created, store, server, call, body, registerSpace };
}

describe('HTTP 外壳 · 空间', () => {
  it('建空间：第一次 201，重复建 409（不覆盖已有空间）', async () => {
    const { registerSpace } = await harness();

    const first = await registerSpace();
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ status: 'created' });

    const second = await registerSpace();
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('space-exists');
  });

  it('建空间缺字段 → 400，且说得清缺什么', async () => {
    const { call, body } = await harness();
    const response = await call('/spaces', { method: 'POST', body: JSON.stringify({ spaceHandle: 'x' }) });
    expect(response.status).toBe(400);
    expect((await body<{ error: { message: string } }>(response)).error.message).toContain('spaceHandle');
  });

  it('取空间元数据是公开的（加入的人得先拿到钥匙封装），但只知道句柄 → 404', async () => {
    const { call, body, registerSpace, created } = await harness();
    await registerSpace();

    const unknown = await call(`/spaces/${encodeURIComponent('这个句柄没人建过')}`);
    expect(unknown.status).toBe(404);
    expect(body).toBeTypeOf('function');

    const meta = await call(`/spaces/${created.spaceHandle}`);
    expect(meta.status).toBe(200);
    const payload = await body<{ keyWraps: Record<string, unknown> }>(meta);
    expect(Object.keys(payload.keyWraps).sort()).toEqual(['password', 'recovery']);
    // 服务端手里没有密码，也没有明文，只有哈希与封装
    expect(JSON.stringify(payload)).not.toContain('同步密码');
  });
});

describe('HTTP 外壳 · 鉴权与路由', () => {
  it('head / push / pull 都要凭证：不带 401，写错 401，空间不存在 404', async () => {
    const { call, body, registerSpace, created } = await harness();
    await registerSpace();

    const noCredential = await call(`/spaces/${created.spaceHandle}/head`);
    expect(noCredential.status).toBe(401);
    expect((await body<{ error: { code: string } }>(noCredential)).error.code).toBe('unauthorized');

    const wrongCredential = await call(`/spaces/${created.spaceHandle}/head`, {
      headers: { authorization: `Bearer ${encodeURIComponent('伪造')}` },
    });
    expect(wrongCredential.status).toBe(401);

    const ghost = await call(`/spaces/${encodeURIComponent('这个句柄没人建过')}/head`, {
      headers: { authorization: 'Bearer x' },
    });
    expect(ghost.status).toBe(404);
    expect((await body<{ error: { code: string } }>(ghost)).error.code).toBe('space-not-found');
  });

  it('方法用错与路由不存在都有明确回答', async () => {
    const { call, registerSpace, created } = await harness();
    await registerSpace();

    expect((await call(`/spaces/${created.spaceHandle}/head`, { method: 'POST' })).status).toBe(405);
    expect((await call(`/spaces/${created.spaceHandle}/push`, { method: 'GET' })).status).toBe(405);
    expect((await call('/nope')).status).toBe(404);
  });

  it('push 的记录形状不对 → 400（坏数据不进库）', async () => {
    const { call, registerSpace, created } = await harness();
    await registerSpace();

    const response = await call(`/spaces/${created.spaceHandle}/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ baseHead: 0, records: [{ collection: 'messages', id: 'm1' }] }),
    });
    expect(response.status).toBe(400);
  });
});

describe('HTTP 外壳 · 走一遍真实推拉', () => {
  it('A 建空间推一条，B 用密码加入后拉到并解开', async () => {
    const { created, call, body, registerSpace } = await harness();
    await registerSpace();

    const coordinates = {
      spaceHandle: created.spaceHandle,
      collection: 'messages' as const,
      id: 'msg-http-1',
      updatedAt: '2026-09-20T00:00:01.000Z',
    };
    const payload = { id: 'msg-http-1', content: '「三十箱货是谁的？」' };
    const wire: SyncWireRecord = {
      collection: 'messages',
      id: coordinates.id,
      updatedAt: coordinates.updatedAt,
      deletedAt: null,
      sealed: await encryptRecord(created.encKey, coordinates, payload),
    };

    const pushed = await call(`/spaces/${created.spaceHandle}/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ baseHead: 0, records: [wire] }),
    });
    expect(pushed.status).toBe(200);
    const pushResult = await body<{ head: number; accepted: { serverRev: number }[] }>(pushed);
    expect(pushResult.head).toBe(1);
    expect(pushResult.accepted[0]?.serverRev).toBe(1);

    // B 用密码加入：先取空间元数据，再解主密钥、算凭证
    const meta = await body<{ keyWraps: { password: unknown } }>(await call(`/spaces/${created.spaceHandle}`));
    const joined = await openSpace({
      spaceHandle: created.spaceHandle,
      secret: '同步密码',
      purpose: 'password',
      wrapped: meta.keyWraps.password as never,
      keyIterations: FAST.keyIterations,
    });
    expect(joined.credential).toBe(created.credential);

    const pulled = await body<{ head: number; records: { serverRev: number; sealed: unknown }[] }>(
      await call(`/spaces/${created.spaceHandle}/pull?since=0`, {
        headers: { authorization: `Bearer ${joined.credential}` },
      }),
    );
    expect(pulled.records).toHaveLength(1);
    expect(pulled.records[0]?.serverRev).toBe(1);

    const decoded = await decryptRecord<typeof payload>(joined.encKey, coordinates, pulled.records[0]?.sealed as never);
    expect(decoded).toEqual(payload);

    // 服务端那边全是密文
    expect(JSON.stringify(pulled)).not.toContain('三十箱');
  });

  it('游标与 limit：先拉一页，再从 since 往后拉剩下的', async () => {
    const { created, call, body, registerSpace } = await harness();
    await registerSpace();

    const records: SyncWireRecord[] = [];
    for (let index = 0; index < 3; index += 1) {
      const updatedAt = `2026-09-20T00:00:0${String(index)}.000Z`;
      records.push({
        collection: 'memories',
        id: `mem-${String(index)}`,
        updatedAt,
        deletedAt: null,
        sealed: await encryptRecord(
          created.encKey,
          { spaceHandle: created.spaceHandle, collection: 'memories', id: `mem-${String(index)}`, updatedAt },
          { index },
        ),
      });
    }
    await call(`/spaces/${created.spaceHandle}/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ baseHead: 0, records }),
    });

    const firstPage = await body<{
      head: number;
      serverHead: number;
      hasMore: boolean;
      records: { serverRev: number }[];
    }>(
      await call(`/spaces/${created.spaceHandle}/pull?since=0&limit=2`, {
        headers: { authorization: `Bearer ${created.credential}` },
      }),
    );
    expect(firstPage.records.map((record) => record.serverRev)).toEqual([1, 2]);
    // 分页语义：head 是「这一批给到哪里」，不是全局头号，
    // 否则客户端会把游标推到末尾、把没拉到的记录永久漏掉
    expect(firstPage.head).toBe(2);
    expect(firstPage.serverHead).toBe(3);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await body<{ head: number; hasMore: boolean; records: { serverRev: number }[] }>(
      await call(`/spaces/${created.spaceHandle}/pull?since=2&limit=2`, {
        headers: { authorization: `Bearer ${created.credential}` },
      }),
    );
    expect(secondPage.records.map((record) => record.serverRev)).toEqual([3]);
    expect(secondPage.head).toBe(3);
    expect(secondPage.hasMore).toBe(false);

    // 拉完之后再来一次：一条都没有，head 停在原地（不会倒退成 0）
    const empty = await body<{ head: number; hasMore: boolean; records: unknown[] }>(
      await call(`/spaces/${created.spaceHandle}/pull?since=3`, {
        headers: { authorization: `Bearer ${created.credential}` },
      }),
    );
    expect(empty.records).toHaveLength(0);
    expect(empty.head).toBe(3);
    expect(empty.hasMore).toBe(false);
  });

  it('空间之间完全隔离：同一个 id 在不同空间里互不可见', async () => {
    const first = await harness();
    await first.registerSpace();

    const second = await createSpaceCredentials({ userId: '另一个人', password: '另一个密码', ...FAST });
    await first.call('/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        spaceHandle: second.spaceHandle,
        credentialHash: second.credentialHash,
        recoveryCredentialHash: second.recoveryCredentialHash,
      }),
    });

    const updatedAt = '2026-09-20T00:00:00.000Z';
    const wireFor = async (space: typeof first.created): Promise<SyncWireRecord> => ({
      collection: 'messages',
      id: 'same-id',
      updatedAt,
      deletedAt: null,
      sealed: await encryptRecord(
        space.encKey,
        { spaceHandle: space.spaceHandle, collection: 'messages', id: 'same-id', updatedAt },
        { owner: space.spaceHandle },
      ),
    });

    await first.call(`/spaces/${first.created.spaceHandle}/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.created.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ baseHead: 0, records: [await wireFor(first.created)] }),
    });

    const fromOtherSpace = await first.body<{ records: unknown[] }>(
      await first.call(`/spaces/${second.spaceHandle}/pull?since=0`, {
        headers: { authorization: `Bearer ${second.credential}` },
      }),
    );
    expect(fromOtherSpace.records).toHaveLength(0);
  });
});

describe('HTTP 外壳 · 跨源（部署到另一台机器时用）', () => {
  /** 起一个只放行指定来源的服务端。 */
  async function corsHarness(allowedOrigins: readonly string[]) {
    const created = await createSpaceCredentials({ userId: '旅人', password: '密码', ...FAST });
    const server = createSyncServer(createMemorySyncStore());
    // 空间先登记好，这样下面测的是「凭证不对」而不是「空间不存在」
    await server.createSpace({
      spaceHandle: created.spaceHandle,
      credentialHash: created.credentialHash,
      recoveryCredentialHash: created.recoveryCredentialHash,
      at: AT,
    });
    const call = (init: RequestInit = {}): Promise<Response> =>
      handleSyncRequest(new Request(`http://sync.test/spaces/${created.spaceHandle}/head`, init), {
        server,
        cors: { allowedOrigins },
      });
    return { created, call };
  }

  it('放行的来源：预检回 204 并带上允许头', async () => {
    const { call } = await corsHarness(['http://127.0.0.1:5273']);
    const response = await call({
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5273', 'access-control-request-method': 'GET' },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5273');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(response.headers.get('vary')).toContain('origin');
  });

  it('真请求也带 CORS 头（浏览器才把响应交给页面）', async () => {
    const { call } = await corsHarness(['http://127.0.0.1:5273']);
    const response = await call({
      headers: { origin: 'http://127.0.0.1:5273', authorization: 'Bearer wrong-credential' },
    });

    // 401 也要带头：否则页面连「凭证不对」这句话都读不到
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5273');
  });

  it('没放行的来源：403，且写清原因', async () => {
    const { call } = await corsHarness(['http://127.0.0.1:5273']);
    const response = await call({ headers: { origin: 'https://someone-else.example' } });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('origin-not-allowed');
  });

  it('没配 cors 时不加任何头（同源部署的默认行为不变）', async () => {
    const created = await createSpaceCredentials({ userId: '旅人', password: '密码', ...FAST });
    const server = createSyncServer(createMemorySyncStore());
    const response = await handleSyncRequest(
      new Request(`http://sync.test/spaces/${created.spaceHandle}/head`, {
        headers: { origin: 'http://127.0.0.1:5273' },
      }),
      { server },
    );

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('白名单为空 = 只跑同源：带着 Origin 的同源 POST 不该被拒', async () => {
    const created = await createSpaceCredentials({ userId: '旅人', password: '密码', ...FAST });
    const server = createSyncServer(createMemorySyncStore());
    await server.createSpace({
      spaceHandle: created.spaceHandle,
      credentialHash: created.credentialHash,
      recoveryCredentialHash: created.recoveryCredentialHash,
      at: AT,
    });

    // 浏览器发 POST 时，同源请求也会带 Origin 头（fetch 规范）。部署到服务器当天
    // 就是因为这点让「同一个域名下打开的网页调不了自己的后端」。
    const response = await handleSyncRequest(
      new Request('http://sync.test/spaces', {
        method: 'POST',
        headers: { origin: 'https://dramatissync.example', 'content-type': 'application/json' },
        body: JSON.stringify({
          spaceHandle: created.spaceHandle,
          credentialHash: created.credentialHash,
          recoveryCredentialHash: created.recoveryCredentialHash,
        }),
      }),
      { server, cors: { allowedOrigins: [] } },
    );

    // 空间已存在 → 409；关键是**不是** 403（来源没有被误判成跨源）
    expect(response.status).toBe(409);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
