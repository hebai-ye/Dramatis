import { SyncHttpError } from './http-client.js';
import type { SyncCredentials, SyncPushResult, SyncTransport, SyncWireRecord } from './types.js';

export const SYNC_PUSH_MAX_BYTES = 8 * 1024 * 1024;
export const SYNC_PUSH_MAX_RECORDS = 200;
const encoder = new TextEncoder();

/** 按真实HTTP正文计量，包含JSON外壳、逗号与转义。 */
export function syncPushBytes(records: readonly SyncWireRecord[]): number {
  return encoder.encode(JSON.stringify({ records })).byteLength;
}

export class SyncRecordTooLargeError extends Error {
  override readonly name = 'SyncRecordTooLargeError';
  readonly code = 'sync-record-too-large';
  constructor(
    readonly collection: string,
    readonly id: string,
    readonly requiredBytes: number,
    readonly maxBytes: number | null,
  ) {
    super(
      `同步记录 ${collection}/${id} 需要 ${String(requiredBytes)} 字节，${maxBytes === null ? '服务端仍以请求体过大拒绝，未提供具体上限' : `超过单次请求上限 ${String(maxBytes)} 字节`}；未跳过该记录。`,
    );
  }
}

export function* splitSyncPushBatches(
  records: readonly SyncWireRecord[],
  maxBytes = SYNC_PUSH_MAX_BYTES,
  maxRecords = SYNC_PUSH_MAX_RECORDS,
): Generator<SyncWireRecord[]> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new Error('同步分批上限必须为正整数。');
  }
  const envelopeBytes = syncPushBytes([]);
  let bytes = envelopeBytes;
  let batch: SyncWireRecord[] = [];
  for (const record of records) {
    const recordBytes = encoder.encode(JSON.stringify(record)).byteLength;
    const singleBytes = envelopeBytes + recordBytes;
    if (singleBytes > maxBytes) {
      throw new SyncRecordTooLargeError(record.collection, record.id, singleBytes, maxBytes);
    }
    if (batch.length > 0 && (batch.length >= maxRecords || bytes + 1 + recordBytes > maxBytes)) {
      yield batch;
      batch = [];
      bytes = envelopeBytes;
    }
    bytes += recordBytes + (batch.length > 0 ? 1 : 0);
    batch.push(record);
  }
  if (batch.length > 0) yield batch;
}

/** 逐项核验确认结果；legacy响应只在所有坐标唯一且全部确认时可接受。 */
export function validateSyncPushResult(records: readonly SyncWireRecord[], result: SyncPushResult): Set<number> {
  const invalid = (): never => {
    throw new Error('同步服务端的逐项确认不完整或不匹配，未推进同步水位线。');
  };
  if (!Number.isSafeInteger(result.head) || result.head < 0 || !Array.isArray(result.accepted)) invalid();
  if (result.rejected !== undefined && !Array.isArray(result.rejected)) invalid();
  const seen = new Set<number>();
  const accepted = new Set<number>();
  for (const item of result.accepted) {
    let index = item.index;
    if (index === undefined) {
      const matches = records.flatMap((record, i) =>
        record.collection === item.collection && record.id === item.id ? [i] : [],
      );
      if (matches.length !== 1) invalid();
      index = matches[0];
    }
    if (index === undefined || !Number.isSafeInteger(index) || seen.has(index)) return invalid();
    const record = records[index];
    if (
      record === undefined ||
      record.collection !== item.collection ||
      record.id !== item.id ||
      !Number.isSafeInteger(item.serverRev) ||
      item.serverRev <= 0 ||
      item.serverRev > result.head
    )
      invalid();
    seen.add(index);
    accepted.add(index);
  }
  for (const rejection of result.rejected ?? []) {
    const { index, current } = rejection;
    if (!Number.isSafeInteger(index) || seen.has(index)) invalid();
    const record = records[index];
    if (
      record === undefined ||
      current == null ||
      record.collection !== current.collection ||
      record.id !== current.id ||
      typeof current.updatedAt !== 'string' ||
      current.updatedAt < record.updatedAt ||
      (current.deletedAt !== null && typeof current.deletedAt !== 'string') ||
      !Number.isSafeInteger(current.serverRev) ||
      current.serverRev <= 0 ||
      current.serverRev > result.head
    )
      invalid();
    seen.add(index);
  }
  if (seen.size !== records.length) invalid();
  return accepted;
}

/** 只有请求体413可拆分；space-full配额错误必须原样报出。 */
export async function pushSyncBatch(
  transport: SyncTransport,
  credentials: SyncCredentials,
  records: readonly SyncWireRecord[],
  onResult: (batch: readonly SyncWireRecord[], result: SyncPushResult, accepted: ReadonlySet<number>) => Promise<void>,
): Promise<void> {
  let result: SyncPushResult;
  try {
    result = await transport.push({ ...credentials, records });
  } catch (error) {
    if (!(error instanceof SyncHttpError) || error.status !== 413 || error.code !== 'payload-too-large') throw error;
    if (records.length === 1) {
      const record = records[0];
      if (record === undefined) throw error;
      throw new SyncRecordTooLargeError(record.collection, record.id, syncPushBytes(records), null);
    }
    const middle = Math.floor(records.length / 2);
    if (middle === 0) throw error;
    await pushSyncBatch(transport, credentials, records.slice(0, middle), onResult);
    await pushSyncBatch(transport, credentials, records.slice(middle), onResult);
    return;
  }
  await onResult(records, result, validateSyncPushResult(records, result));
}
