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
  /** 一页最多拉多少条（服务端还会再夹一层上限）；不给就用服务端的默认页大小。 */
  limit?: number;
}

/**
 * 一次同步最多拉几页。
 *
 * 分页是必需的（服务端一页默认 200 条，上限 500），但循环必须有上界：
 * 服务端要是坏到「永远说还有」，客户端不该跟着转不出来。200 页 × 500 条
 * 远超任何一次正常的补齐。
 */
const MAX_PULL_ROUNDS = 200;

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

  // ---- 2. 拉（分页拉，直到追平服务端）----
  //
  // 服务端一页只给 200 条（见 sync/server.ts 的 DEFAULT_PULL_LIMIT），所以这里必须
  // **一直拉到追平**。曾经的写法只拉一页，并且把全局头号当成新游标——一台新设备
  // 同步一个超过一页的空间时，会「同步成功」出一份残缺的数据（换设备复现过）。
  let cursor = state.pulledHead;
  let serverHead = cursor;
  let pulledCount = 0;
  let applied = 0;
  let skipped = 0;
  let truncated = false;

  for (let round = 0; ; round += 1) {
    const page = await input.transport.pull({
      spaceHandle: input.spaceHandle,
      credential: input.credential,
      since: cursor,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });

    // 返回的这一批**真正**给到了哪里：有记录看最后一条的号，没记录就是没得拉
    const last = page.records[page.records.length - 1];
    const pageEnd = last === undefined ? page.head : last.serverRev;
    // 老服务端不发 serverHead / hasMore，按「游标有没有追平全局头号」自己判断
    serverHead = Math.max(serverHead, page.serverHead ?? page.head);
    const hasMore = page.hasMore ?? pageEnd < (page.serverHead ?? page.head);

    const decoded: LocalSyncRecord[] = [];
    for (const record of page.records) {
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

    // 逐页合并，而不是先攒齐再合并：空间大的时候内存不必扛下整份数据
    const merged = await mergeRemoteRecords(decoded, {
      get: (record) => repository.getSyncRecord(record.collection, record.id),
      put: (record) => repository.putSyncRecord(record),
    });
    applied += merged.applied;
    skipped += merged.skipped;
    pulledCount += decoded.length;

    // 拉回来的东西本来就在服务端上，不用再推回去。不更新推送点的话，一台空设备
    // 第一次同步之后会把刚拉下来的整个世界原样推上去（无害，但白跑一趟流量）。
    for (const record of decoded) pushedAt = later(pushedAt, record.updatedAt);

    cursor = pageEnd;
    if (!hasMore || decoded.length === 0) break;
    if (round + 1 >= MAX_PULL_ROUNDS) {
      truncated = true;
      break;
    }
  }

  const reportedHead = Math.max(serverHead, cursor);
  // 拉到的位置（cursor）才是下次的起点；服务端头号只用于显示「还差多少」。
  // 到上限被迫停下时不装作成功——游标只推进到真正拿到的位置，下一次接着拉。
  head = Math.max(head, truncated ? cursor : reportedHead);

  // 游标只在整轮走完之后推进（推送点同理）：中途抛错就下次重来，不会有半截状态
  await repository.writeSyncState({
    spaceHandle: input.spaceHandle,
    pulledHead: cursor,
    pushedAt,
  });

  return {
    spaceHandle: input.spaceHandle,
    pushed,
    pulled: pulledCount,
    applied,
    skipped,
    head,
  };
}
