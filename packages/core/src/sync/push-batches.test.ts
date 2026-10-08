import { describe, expect, it } from 'vitest';
import { SyncHttpError } from './http-client.js';
import {
  pushSyncBatch,
  SyncRecordTooLargeError,
  splitSyncPushBatches,
  syncPushBytes,
  validateSyncPushResult,
} from './push-batches.js';
import type { SyncPushResult, SyncTransport, SyncWireRecord } from './types.js';

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture item missing');
  return value;
}

const credentials = { spaceHandle: 'fixture-space', credential: 'fixture-proof' };
const wire = (id = 'fixture', bytes = 20): SyncWireRecord => ({
  collection: 'cards',
  id,
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  sealed: { algorithm: 'AES-256-GCM', iv: 'fixture-iv', ciphertext: 'x'.repeat(bytes) },
});
function ack(records: readonly SyncWireRecord[]): SyncPushResult {
  return {
    head: records.length,
    accepted: records.map((r, index) => ({ collection: r.collection, id: r.id, serverRev: index + 1, index })),
    rejected: [],
  };
}
function transport(push: SyncTransport['push']): SyncTransport {
  return { push, head: async () => ({ head: 0 }), pull: async () => ({ head: 0, records: [] }) };
}

describe('顺序113：实际字节分批与确认校验', () => {
  it('计算UTF-8、JSON转义、逗号与正文外壳，恰好上限不拆', () => {
    const rows = [wire('汉字"\\\n'), wire('emoji-😀')];
    const bytes = new TextEncoder().encode(JSON.stringify({ records: rows })).byteLength;
    expect(syncPushBytes(rows)).toBe(bytes);
    expect([...splitSyncPushBatches(rows, bytes)]).toEqual([rows]);
    const batches = [...splitSyncPushBatches(rows, bytes - 1)];
    expect(batches).toHaveLength(2);
    expect(batches.flat()).toEqual(rows);
    expect(batches.every((b) => syncPushBytes(b) <= bytes - 1)).toBe(true);
  });
  it('条数与字节限制同时生效，空输入不发空请求', () => {
    const rows = Array.from({ length: 401 }, (_, i) => wire(String(i)));
    expect([...splitSyncPushBatches(rows)].map((b) => b.length)).toEqual([200, 200, 1]);
    expect([...splitSyncPushBatches([])]).toEqual([]);
  });
  it('单条超限包含准确坐标、所需字节及上限；不静默丢弃', () => {
    const record = wire('定位记录');
    const required = syncPushBytes([record]);
    expect(() => [...splitSyncPushBatches([record], required - 1)]).toThrow(SyncRecordTooLargeError);
    try {
      [...splitSyncPushBatches([record], required - 1)];
    } catch (e) {
      expect(e).toMatchObject({ collection: 'cards', id: '定位记录', requiredBytes: required, maxBytes: required - 1 });
    }
  });
  it('请求体413自动二分，最终逐个确认', async () => {
    const rows = [wire('a'), wire('b'), wire('c')];
    const calls: number[] = [];
    const confirmed: string[] = [];
    await pushSyncBatch(
      transport(async ({ records }) => {
        calls.push(records.length);
        if (records.length > 1) throw new SyncHttpError(413, 'payload-too-large', 'fixture');
        return ack(records);
      }),
      credentials,
      rows,
      async (sent, _result, accepted) => {
        for (const index of accepted) confirmed.push(defined(sent[index]).id);
      },
    );
    expect(calls).toEqual([3, 1, 2, 1, 1]);
    expect(confirmed).toEqual(['a', 'b', 'c']);
  });
  it.each(['space-full', 'unknown-error'])('配额或未知413（%s）不拆包重试', async (code) => {
    let calls = 0;
    const error = new SyncHttpError(413, code, 'fixture');
    await expect(
      pushSyncBatch(
        transport(async () => {
          calls++;
          throw error;
        }),
        credentials,
        [wire('a'), wire('b')],
        async () => {},
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });
  it('单条被服务器以正文413拒绝时提供定位错误而非无限重试', async () => {
    await expect(
      pushSyncBatch(
        transport(async () => {
          throw new SyncHttpError(413, 'payload-too-large', 'fixture');
        }),
        credentials,
        [wire('single')],
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'sync-record-too-large', id: 'single', maxBytes: null });
  });
  it('旧端全量坐标确认可用，重复坐标缺下标、缺项、重复下标都拒绝', () => {
    const rows = [wire('a'), wire('b')];
    const legacy = {
      head: 2,
      accepted: ack(rows).accepted.map(({ collection, id, serverRev }) => ({ collection, id, serverRev })),
    };
    expect([...validateSyncPushResult(rows, legacy)]).toEqual([0, 1]);
    expect(() => validateSyncPushResult([wire('a'), wire('a')], legacy)).toThrow('逐项确认');
    expect(() => validateSyncPushResult(rows, { head: 2, accepted: [defined(ack(rows).accepted[0])] })).toThrow(
      '逐项确认',
    );
    expect(() =>
      validateSyncPushResult(rows, {
        head: 2,
        accepted: [defined(ack(rows).accepted[0]), defined(ack(rows).accepted[0])],
      }),
    ).toThrow('逐项确认');
  });
  it('拒绝必须附匹配坐标的非低版本胜者，不能混入成功下标', () => {
    const rows = [wire('a'), wire('b')];
    const result = {
      head: 2,
      accepted: [defined(ack(rows).accepted[0])],
      rejected: [{ index: 1, current: { ...defined(rows[1]), serverRev: 2 } }],
    };
    expect([...validateSyncPushResult(rows, result)]).toEqual([0]);
    expect(() =>
      validateSyncPushResult(rows, {
        ...result,
        rejected: [{ index: 0, current: { ...defined(rows[0]), serverRev: 2 } }],
      }),
    ).toThrow('逐项确认');
    expect(() =>
      validateSyncPushResult(rows, {
        ...result,
        rejected: [{ index: 1, current: { ...defined(rows[1]), updatedAt: '2020', serverRev: 2 } }],
      }),
    ).toThrow('逐项确认');
  });
});
