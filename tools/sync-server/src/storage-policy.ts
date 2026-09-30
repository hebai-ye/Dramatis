import type { SqliteDatabase, SyncAppendQuota } from '../../../packages/core/src/index.js';

/** 同步宿主创建策略表，管理端只操作既有的表；世代变化后旧配额失效。 */
export function createSpaceQuotaResolver(db: SqliteDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS space_policies (
    space_handle TEXT PRIMARY KEY, space_epoch TEXT NOT NULL,
    max_bytes INTEGER, revision INTEGER NOT NULL
  )`);
  const select = db.prepare(`SELECT p.max_bytes FROM space_policies p
    JOIN spaces s ON s.space_handle=p.space_handle AND s.epoch=p.space_epoch
    WHERE p.space_handle=?`);
  // 调用点位于 core 的 IMMEDIATE 写事务，策略修改不能从判定与写入之间插队。
  return (handle: string, base: SyncAppendQuota, usage: { records: number; bytes: number }): SyncAppendQuota => {
    const row = select.get(handle) as { max_bytes: number | null } | undefined;
    if (!row) return base;
    const cap = row.max_bytes ?? base.maxBytes;
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > 1024 ** 4) throw new Error('空间配额策略无效。');
    // 已超过新配额时允许不增长的替换／缩减；不删除现有记录。
    return { ...base, maxBytes: Math.max(cap, usage.bytes) };
  };
}
