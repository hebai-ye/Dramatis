/**
 * 同步循环（P2-6 第三步，对应 SYNC.md §4.3）。
 *
 * ```
 * 1. 读本地同步状态（拉取游标 pulledHead + 推送点 pushedAt）
 * 2. 把 updatedAt > pushedAt 的记录加密推上去
 * 3. 拉 serverRev > pulledHead 的记录 → 解密 → 按 §4.2 合并 → 推进游标
 * ```
 *
 * 三条性质，都能在单测里验：
 *
 * - **幂等**：同一批记录推两次、合并两次，结果一样（合并只认时间戳与墓碑）。
 * - **推进有序**：先推后拉。否则本地刚改的东西会先被远端的旧版本覆盖一次，
 *   虽然下一轮还能改回来，但那一下闪动是没必要的。
 * - **失败不推进游标**：推失败就下次重推；拉回来有解不开的记录就**停下来报错**，
 *   不静默跳过（宁可让人看见，也不要少一条数据还装作同步成功）。
 */

import { CryptoError } from '../crypto/errors.js';
import { decryptRecord, encryptRecord } from '../crypto/records.js';
import type { Repository } from '../storage/repository.js';
import { mergeRemoteRecords } from './merge.js';
import type { LocalSyncRecord, SyncReport, SyncState, SyncTransport, SyncWireRecord } from './types.js';

export interface RunSyncInput {
  repository: Repository;
  transport: SyncTransport;
  spaceHandle: string;
  /** 每请求带一次的凭证（`Authorization: Bearer`）。 */
  credential: string;
  /** 主密钥（`openSpace` 的输出），用来加解密记录。 */
  encKey: CryptoKey;
  /** 一次最多拉多少条；不给就一次拉完。 */
  limit?: number;
}

function later(left: string | null, right: string): string {
  if (left === null) return right;
  return right > left ? right : left;
}

/** 跑一次同步。抛错表示「这一轮没成」——本地库与游标都保持原样，下次重来。 */
export async function runSync(input: RunSyncInput): Promise<SyncReport> {
  const repository = input.repository;
  const stored = await repository.readSyncState();
  // 换空间就作废重来：上一个空间的游标会把这里的记录当成「已经拉过」
  const state: SyncState =
    stored.spaceHandle === input.spaceHandle
      ? stored
      : { spaceHandle: input.spaceHandle, pulledHead: 0, pushedAt: null };

  // ---- 1. 推 ----
  const outbound = await repository.listSyncRecords({ since: state.pushedAt });
  let pushedAt = state.pushedAt;
  let pushed = 0;
  let head = state.pulledHead;

  if (outbound.length > 0) {
    const wire: SyncWireRecord[] = [];
    for (const record of outbound) {
      wire.push({
        collection: record.collection,
        id: record.id,
        updatedAt: record.updatedAt,
        deletedAt: record.deletedAt,
        sealed: await encryptRecord(
          input.encKey,
          {
            spaceHandle: input.spaceHandle,
            collection: record.collection,
            id: record.id,
            updatedAt: record.updatedAt,
          },
          record.value,
        ),
      });
    }

    const result = await input.transport.push({
      spaceHandle: input.spaceHandle,
      credential: input.credential,
      baseHead: state.pulledHead,
      records: wire,
    });

    pushed = wire.length;
    head = Math.max(head, result.head);
    for (const record of outbound) pushedAt = later(pushedAt, record.updatedAt);
  }

  // ---- 2. 拉 ----
  const pulled = await input.transport.pull({
    spaceHandle: input.spaceHandle,
    credential: input.credential,
    since: state.pulledHead,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });

  const decoded: LocalSyncRecord[] = [];
  for (const record of pulled.records) {
    let value: unknown;
    try {
      value = await decryptRecord<unknown>(
        input.encKey,
        {
          spaceHandle: input.spaceHandle,
          collection: record.collection,
          id: record.id,
          updatedAt: record.updatedAt,
        },
        record.sealed,
      );
    } catch (error) {
      // 解不开就整轮停下：可能是密码不对，也可能是服务端动了这条记录。
      // 静默跳过等于把「有人改过你的数据」这件事藏起来。
      const reason = error instanceof CryptoError ? error.message : String(error);
      throw new CryptoError(`拉取 ${record.collection}/${record.id} 时解不开：${reason}`);
    }
    decoded.push({
      collection: record.collection,
      id: record.id,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
      value,
    });
  }

  // ---- 3. 合并 ----
  const merged = await mergeRemoteRecords(decoded, {
    get: (record) => repository.getSyncRecord(record.collection, record.id),
    put: (record) => repository.putSyncRecord(record),
  });

  // 拉回来的东西本来就在服务端上，不用再推回去。不更新推送点的话，一台空设备
  // 第一次同步之后会把刚拉下来的整个世界原样推上去（无害，但白跑一趟流量）。
  for (const record of decoded) pushedAt = later(pushedAt, record.updatedAt);

  // 游标只在整轮走完之后推进（推送点同理）：中途抛错就下次重来，不会有半截状态
  await repository.writeSyncState({
    spaceHandle: input.spaceHandle,
    pulledHead: pulled.head,
    pushedAt,
  });

  return {
    spaceHandle: input.spaceHandle,
    pushed,
    pulled: decoded.length,
    applied: merged.applied,
    skipped: merged.skipped,
    head: pulled.head,
  };
}
