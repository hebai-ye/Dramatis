import type { SqliteDatabase, SyncAppendQuota } from '../../../packages/core/src/index.js';

interface QuotaRow {
  fixed_max_bytes: number | null;
  vip_max_bytes: number | null;
  started_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/** 同步宿主创建运营表，管理端只操作既有表；世代变化后旧配额与权益失效。 */
export function createSpaceQuotaResolver(db: SqliteDatabase, now: () => number = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS space_policies (
    space_handle TEXT PRIMARY KEY, space_epoch TEXT NOT NULL,
    max_bytes INTEGER, revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS space_memberships (
    space_handle TEXT PRIMARY KEY, space_epoch TEXT NOT NULL,
    started_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
    max_bytes INTEGER NOT NULL, revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS membership_events (
    operation_id TEXT PRIMARY KEY, space_handle TEXT NOT NULL, space_epoch TEXT NOT NULL,
    action TEXT NOT NULL, event_at TEXT NOT NULL, started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, max_bytes INTEGER NOT NULL
  )`);
  const select = db.prepare(`SELECT p.max_bytes AS fixed_max_bytes, m.max_bytes AS vip_max_bytes,
    m.started_at, m.expires_at, m.revoked_at FROM spaces s
    LEFT JOIN space_policies p ON p.space_handle=s.space_handle AND p.space_epoch=s.epoch
    LEFT JOIN space_memberships m ON m.space_handle=s.space_handle AND m.space_epoch=s.epoch
    WHERE s.space_handle=?`);
  // 调用点位于 core 的 IMMEDIATE 写事务，策略修改不能从判定与写入之间插队。
  return (handle: string, base: SyncAppendQuota, usage: { records: number; bytes: number }): SyncAppendQuota => {
    const row = select.get(handle) as QuotaRow | undefined;
    let cap = row?.fixed_max_bytes ?? base.maxBytes;
    if (row?.fixed_max_bytes == null && row?.revoked_at === null && row.started_at && row.expires_at) {
      const time = now();
      if (Date.parse(row.started_at) <= time && time < Date.parse(row.expires_at)) {
        const vipCap = row.vip_max_bytes;
        if (typeof vipCap !== 'number' || !Number.isSafeInteger(vipCap) || vipCap <= 0 || vipCap > 1024 ** 4)
          throw new Error('空间配额策略无效。');
        cap = vipCap;
      }
    }
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > 1024 ** 4) throw new Error('空间配额策略无效。');
    // 已超过新配额时允许不增长的替换／缩减；不删除现有记录。
    return { ...base, maxBytes: Math.max(cap, usage.bytes) };
  };
}
