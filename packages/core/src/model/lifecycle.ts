/**
 * 实体的生命周期字段（P2-6 数据层前置）。
 *
 * 同步要求每条记录带 `updatedAt` 与 `deletedAt`：
 *
 * - `updatedAt` 是 LWW 的比较依据，也是「这条记录变过没有」的判据；
 * - `deletedAt` 是**软删除**。直接删掉的话，另一台设备下次同步会把自己
 *   那份还在的记录当成「新的」推回来，用户会发现删掉的东西自己复活了。
 *   所以删除只是盖章，查询默认把它们过滤掉。
 *
 * 老数据没有 `deletedAt` 字段——`isAlive` 把「字段不存在」与「字段为 null」
 * 一视同仁，迁移也会补上 null（见 `Repository.MIGRATIONS` 的 v5）。
 */

/** 参与同步的实体都带这两样（`updatedAt` 必填，`deletedAt` 可缺省表示未删除）。 */
export interface LifecycleFields {
  updatedAt: string;
  deletedAt: string | null;
}

/** 这条记录还在（没有被软删除）。null / undefined 都算还在。 */
export function isAlive(entity: { deletedAt?: string | null } | null | undefined): boolean {
  if (entity === null || entity === undefined) return false;
  return (entity.deletedAt ?? null) === null;
}

/** 过滤掉软删除的记录，保持原有顺序。 */
export function aliveOnly<T extends { deletedAt?: string | null }>(items: readonly T[]): T[] {
  return items.filter((item) => isAlive(item));
}
