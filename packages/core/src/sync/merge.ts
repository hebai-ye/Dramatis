/**
 * 合并规则（P2-6 第三步，对应 SYNC.md §4.2）。
 *
 * 只有一条规则要记：**先比 `updatedAt`，平局时墓碑赢，其余保留本地**。
 *
 * - 为什么不用向量时钟 / CRDT：SYNC §6 明确不做。这个产品的场景是「一个人两台设备
 *   轮流用」，不是多人实时协作；LWW 的代价（同毫秒改同一条会丢一边）远小于 CRDT
 *   的复杂度。
 * - 为什么平局时墓碑赢：同一毫秒里「删掉」和「改了一下」撞上时，复活一条用户删过
 *   的东西比少一条更糟。
 * - 记忆不特殊：不同 id 本来就是两条（全留），同一个 id 才轮到这条规则。
 */

import type { LocalSyncRecord } from './types.js';

export type MergeDecision = 'take-remote' | 'keep-local';

/** 判断该不该用远端这条覆盖本地。纯函数，好测也好解释。 */
export function decideMerge(
  local: Pick<LocalSyncRecord, 'updatedAt' | 'deletedAt'> | null,
  remote: Pick<LocalSyncRecord, 'updatedAt' | 'deletedAt'>,
): MergeDecision {
  if (local === null) return 'take-remote';
  if (remote.updatedAt > local.updatedAt) return 'take-remote';
  if (remote.updatedAt < local.updatedAt) return 'keep-local';

  const remoteIsTombstone = remote.deletedAt !== null;
  const localIsTombstone = local.deletedAt !== null;
  if (remoteIsTombstone && !localIsTombstone) return 'take-remote';
  return 'keep-local';
}

export interface MergeResult {
  applied: number;
  skipped: number;
  /**
   * 被挡回去的那些（远端较旧、本机留着）的坐标，`collection/id` 形式。
   *
   * 为什么给坐标而不是只给个数：调用方要拿它去对照「这条远端记录是哪台设备写的」
   * （顺序 19 的覆盖可见性）。合并本身不关心设备，就不替它下结论。
   */
  overriddenIds: Set<string>;
}

/** 合并一批远端记录（写入由调用方提供的 `put` 完成，便于单测与内核复用同一套规则）。 */
export async function mergeRemoteRecords(
  records: readonly LocalSyncRecord[],
  io: {
    get: (record: LocalSyncRecord) => Promise<Pick<LocalSyncRecord, 'updatedAt' | 'deletedAt'> | null>;
    put: (record: LocalSyncRecord) => Promise<void>;
  },
): Promise<MergeResult> {
  let applied = 0;
  let skipped = 0;
  const overriddenIds = new Set<string>();

  for (const record of records) {
    const local = await io.get(record);
    if (decideMerge(local, record) === 'take-remote') {
      await io.put(record);
      applied += 1;
    } else {
      skipped += 1;
      /*
       * 同一个版本（时间戳相同、墓碑状态相同）只是「回声」，不是覆盖：
       * 拉回来的正是本机已经有的那一份，没有谁被挡回去。
       */
      const identical =
        local !== null &&
        local.updatedAt === record.updatedAt &&
        (local.deletedAt !== null) === (record.deletedAt !== null);
      if (!identical) overriddenIds.add(`${record.collection}/${record.id}`);
    }
  }

  return { applied, skipped, overriddenIds };
}
