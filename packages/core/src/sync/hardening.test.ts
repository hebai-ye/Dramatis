/**
 * 公网加固（审计 A7 / A9 / C8 / C9 / C10 / C11 / C12）。
 *
 * 每一条都有两面：坏数据 / 滥用要被挡住，**真实客户端写出来的数据一条都不能被误伤**。
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createSpaceCredentials } from '../crypto/keys.js';
import { encryptRecord } from '../crypto/records.js';
import { newId, nowIso } from '../model/ids.js';
import { handleSyncRequest, type SyncHttpDeps } from './http.js';
import {
  createMemorySyncStore,
  createRateWindow,
  createSyncServer,
  type SyncServerStore,
  syncRowBytes,
} from './server.js';
import { createSqliteSyncStore, SYNC_SCHEMA_SQL } from './sqlite.js';
import type { SyncWireRecord } from './types.js';

const FAST = { handleIterations: 100, keyIterations: 200 };

async function harness(store: SyncServerStore = createMemorySyncStore(), extra: Partial<SyncHttpDeps> = {}) {
  const created = await createSpaceCredentials({ userId: `旅人-${newId()}`, password: '同步密码', ...FAST });
  const server = createSyncServer(store, { limits: { metaReadsPerMinute: 3 } });
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    handleSyncRequest(new Request(`http://sync.test${path}`, init), { server, ...extra });
  const registered = await call('/spaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      spaceHandle: created.spaceHandle,
      credentialHash: created.credentialHash,
      recoveryCredentialHash: created.recoveryCredentialHash,
      keyWraps: { password: created.passwordWrap, recovery: created.recoveryWrap },
    }),
  });
  expect(registered.status).toBe(201);
  const push = (records: unknown[]): Promise<Response> =>
    call(`/spaces/${created.spaceHandle}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.credential}` },
      body: JSON.stringify({ records }),
    });
  return { created, server, call, push };
}

/** 与真实客户端一模一样的一条：uuid / `provider:<uuid>` 的 id、toISOString 时间戳、uuid 设备号。 */
async function realistic(encKey: CryptoKey, spaceHandle: string, id = newId()): Promise<SyncWireRecord> {
  const updatedAt = nowIso();
  return {
    collection: 'messages',
    id,
    updatedAt,
    deletedAt: null,
    sealed: await encryptRecord(
      encKey,
      { spaceHandle, collection: 'messages', id, updatedAt },
      { id, content: '你好' },
    ),
    deviceId: newId(),
  };
}

describe('线上字段的形状护栏（审计 A7）', () => {
  it('真实客户端的记录照收：uuid、provider:uuid、墓碑、老客户端不带设备号', async () => {
    const { created, push } = await harness();
    const one = await realistic(created.encKey, created.spaceHandle);
    const credential = await realistic(created.encKey, created.spaceHandle, `provider:${newId()}`);
    const tombstone = { ...(await realistic(created.encKey, created.spaceHandle)), deletedAt: nowIso() };
    const { deviceId: _dropped, ...legacy } = await realistic(created.encKey, created.spaceHandle);
    const response = await push([one, credential, tombstone, legacy]);
    expect(response.status).toBe(200);
  });

  it('超长 id / 超长设备号 / 带控制字符 / 时间戳塞垃圾 / 密文不是 base64url → 400', async () => {
    const { created, push } = await harness();
    const base = await realistic(created.encKey, created.spaceHandle);
    const bad = [
      { ...base, id: 'x'.repeat(10_000) },
      { ...base, deviceId: 'd'.repeat(10_000) },
      { ...base, id: 'a\nb' },
      { ...base, updatedAt: 'x'.repeat(1000) },
      { ...base, deletedAt: 'y'.repeat(1000) },
      { ...base, sealed: { ...base.sealed, ciphertext: '不是 base64' } },
      { ...base, deviceId: 42 },
    ];
    for (const record of bad) {
      expect((await push([record])).status).toBe(400);
    }
  });

  it('keyWraps 只收 password / recovery 两份钥匙封装，别的形状或太大 → 400', async () => {
    const created = await createSpaceCredentials({ userId: '别人', password: '同步密码', ...FAST });
    const server = createSyncServer(createMemorySyncStore());
    const post = (keyWraps: unknown): Promise<Response> =>
      handleSyncRequest(
        new Request('http://sync.test/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            spaceHandle: created.spaceHandle,
            credentialHash: created.credentialHash,
            recoveryCredentialHash: created.recoveryCredentialHash,
            keyWraps,
          }),
        }),
        { server, clientKey: newId() },
      );
    expect((await post({ junk: 'x'.repeat(100_000) })).status).toBe(400);
    expect((await post({ password: { ...created.passwordWrap, extra: 'x' } })).status).toBe(400);
    expect((await post({ password: 'x'.repeat(100_000) })).status).toBe(400);
    expect((await post({ password: created.passwordWrap, recovery: created.recoveryWrap })).status).toBe(201);
  });

  it('配额按整行算：超长 id 的小记录也吃配额（spaceUsage 与写入判定同一口径）', async () => {
    const store = createMemorySyncStore();
    const { created, push } = await harness(store);
    const record = await realistic(created.encKey, created.spaceHandle, `m-${'x'.repeat(200)}`);
    expect((await push([record])).status).toBe(200);
    const usage = await store.spaceUsage?.(created.spaceHandle);
    expect(usage?.bytes).toBe(syncRowBytes(record));
    expect(usage?.bytes ?? 0).toBeGreaterThan(200);
  });
});

describe('公开元数据（审计 A9）', () => {
  it('不再给出凭证哈希，只给钥匙封装；同一句柄一分钟内取太多次 → 429', async () => {
    const { created, call } = await harness();
    const meta = await call(`/spaces/${created.spaceHandle}`);
    expect(meta.status).toBe(200);
    const payload = (await meta.json()) as Record<string, unknown>;
    expect(payload.credentialHash).toBeUndefined();
    expect(payload.recoveryCredentialHash).toBeUndefined();
    expect(Object.keys(payload.keyWraps as object).sort()).toEqual(['password', 'recovery']);

    await call(`/spaces/${created.spaceHandle}`);
    await call(`/spaces/${created.spaceHandle}`);
    const limited = await call(`/spaces/${created.spaceHandle}`);
    expect(limited.status).toBe(429);
  });
});

describe('限流表会清理（审计 C8）', () => {
  it('过了窗口的 key 被清掉；key 数有上限', () => {
    let clock = 0;
    const window = createRateWindow({ limit: 2, now: () => clock, maxKeys: 100 });
    for (let index = 0; index < 50; index += 1) window.hit(`ip-${String(index)}`);
    expect(window.size()).toBe(50);
    clock += 61_000;
    window.hit('fresh');
    expect(window.size()).toBe(1);

    for (let index = 0; index < 500; index += 1) window.hit(`flood-${String(index)}`);
    expect(window.size()).toBeLessThanOrEqual(100);

    // 限流本身照常：同一个 key 第三次被挡
    expect(window.hit('same')).toBe(true);
    expect(window.hit('same')).toBe(true);
    expect(window.hit('same')).toBe(false);
  });
});

describe('错误与参数（审计 C9 / C12）', () => {
  it('内部异常对外只回通用文案，原文交给 onInternalError', async () => {
    const seen: unknown[] = [];
    const store = createMemorySyncStore();
    const { created, push } = await harness(store, { onInternalError: (error) => seen.push(error) });
    store.append = async () => {
      throw new Error('SQLITE_CORRUPT: /var/lib/secret/path.db');
    };
    delete (store as { appendWithinQuota?: unknown }).appendWithinQuota;
    const response = await push([await realistic(created.encKey, created.spaceHandle)]);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('SQLITE');
    expect(text).not.toContain('/var/lib');
    expect(seen).toHaveLength(1);
  });

  it('limit=abc 退回默认页大小，而不是 NaN', async () => {
    const { created, push, call } = await harness();
    await push([await realistic(created.encKey, created.spaceHandle)]);
    const response = await call(`/spaces/${created.spaceHandle}/pull?since=0&limit=abc`, {
      headers: { authorization: `Bearer ${created.credential}` },
    });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { records: unknown[] };
    expect(page.records).toHaveLength(1);
  });
});

describe('SQLite 增量用量与事务内配额（审计 C10 / C11）', () => {
  function sqliteStore() {
    const db = new DatabaseSync(':memory:');
    return { db, store: createSqliteSyncStore(db) };
  }

  it('增量计数与全表统计一致（覆盖、同批重复坐标都算对）', async () => {
    const { db, store } = sqliteStore();
    const { created, push } = await harness(store);
    const first = await realistic(created.encKey, created.spaceHandle, 'same-id');
    const other = await realistic(created.encKey, created.spaceHandle);
    expect((await push([first, other])).status).toBe(200);
    const again = await realistic(created.encKey, created.spaceHandle, 'same-id');
    const twice = await realistic(created.encKey, created.spaceHandle, 'same-id');
    expect((await push([again, twice])).status).toBe(200);

    const usage = await store.spaceUsage?.(created.spaceHandle);
    const truth = db
      .prepare(
        `SELECT COUNT(*) AS records, SUM(LENGTH(CAST(collection AS BLOB)) + LENGTH(CAST(id AS BLOB))
           + LENGTH(CAST(updated_at AS BLOB)) + COALESCE(LENGTH(CAST(deleted_at AS BLOB)), 0)
           + COALESCE(LENGTH(CAST(device_id AS BLOB)), 0) + LENGTH(CAST(sealed AS BLOB))) AS bytes
         FROM records WHERE space_handle = ?1`,
      )
      .get(created.spaceHandle) as { records: number; bytes: number };
    expect(usage).toEqual({ records: truth.records, bytes: truth.bytes });
    expect(truth.records).toBe(2);
  });

  it('老库（没有计数列）启动时补列并回填', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE spaces (space_handle TEXT PRIMARY KEY, credential_hash TEXT NOT NULL,
        recovery_credential_hash TEXT NOT NULL, key_wraps TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE records (space_handle TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
        server_rev INTEGER NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sealed TEXT NOT NULL,
        PRIMARY KEY (space_handle, collection, id));
      CREATE TABLE heads (space_handle TEXT PRIMARY KEY, head INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('h', 'c', 'r', '{}', '2026-01-01T00:00:00.000Z');
      INSERT INTO records VALUES ('h', 'messages', 'a', 1, '2026-01-01T00:00:00.000Z', NULL, '{"x":1}');
      INSERT INTO heads VALUES ('h', 1);
    `);
    const store = createSqliteSyncStore(db);
    const usage = await store.spaceUsage?.('h');
    expect(usage?.records).toBe(1);
    expect(usage?.bytes).toBe('messages'.length + 1 + '2026-01-01T00:00:00.000Z'.length + '{"x":1}'.length);
    // 老空间补上了纪元
    expect((await store.getSpace('h'))?.epoch).toBeTruthy();
    // 再跑一遍建表 / 迁移是幂等的
    db.exec(SYNC_SCHEMA_SQL);
    expect((await createSqliteSyncStore(db).spaceUsage?.('h'))?.records).toBe(1);
  });

  it('配额在写入事务里判：超了整批回滚，号与计数都不动；覆盖已有的不算新条数', async () => {
    const { store } = sqliteStore();
    const created = await createSpaceCredentials({ userId: '配额', password: '同步密码', ...FAST });
    await store.createSpace({
      spaceHandle: created.spaceHandle,
      credentialHash: created.credentialHash,
      recoveryCredentialHash: created.credentialHash,
      keyWraps: {},
      createdAt: nowIso(),
    });
    const server = createSyncServer(store, { limits: { maxRecordsPerSpace: 2 } });
    const push = (records: SyncWireRecord[]) =>
      server.push({ spaceHandle: created.spaceHandle, credential: created.credential, records });

    const a = await realistic(created.encKey, created.spaceHandle, 'a');
    const b = await realistic(created.encKey, created.spaceHandle, 'b');
    await push([a, b]);
    const before = await store.spaceUsage?.(created.spaceHandle);
    const head = await store.head(created.spaceHandle);

    await expect(push([await realistic(created.encKey, created.spaceHandle, 'c')])).rejects.toMatchObject({
      status: 413,
      code: 'space-full',
    });
    expect(await store.spaceUsage?.(created.spaceHandle)).toEqual(before);
    expect(await store.head(created.spaceHandle)).toBe(head);

    await expect(push([await realistic(created.encKey, created.spaceHandle, 'a')])).resolves.toBeTruthy();
  });
});
