/**
 * SQLite 版存储（P2-6 第四步·部署）。
 *
 * 它**不 import 任何 SQLite 驱动**：只要求调用方递进来一个「像
 * `node:sqlite` 的 `DatabaseSync`」的对象。这样做有两个好处：
 *
 * - `core` 维持零运行时依赖、也不把 Node 内置模块带进浏览器构建；
 * - 单测里可以直接塞一个真的 `node:sqlite`（Node 22.5+ 自带），
 *   把 SQL 逻辑测透——这一层藏 bug 的地方全在 SQL 上。
 *
 * 线上用它的是 `tools/sync-server`（腾讯云 / 任何一台装了 Node 的机器）。
 */

import { CryptoError } from '../crypto/errors.js';
import type { SyncServerStore, SyncSpaceRecord } from './server.js';
import type { SyncAcceptedRecord, SyncPulledRecord, SyncWireRecord } from './types.js';

/** 我们用到的那几个方法（`node:sqlite` 与 better-sqlite3 都是这个形状）。 */
export interface SqliteStatement {
  all(...params: readonly unknown[]): unknown[];
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /** 事务包一层（`node:sqlite` 没有 transaction()，用 BEGIN/COMMIT 也能做）。 */
  close?(): void;
}

/**
 * 建表语句。`wrangler`（D1）与 `node:sqlite` 都能直接跑这份。
 *
 * 索引是给拉取用的：`pull?since=` 的查询是「按 space 找 server_rev 大于某个值的行」，
 * 没有索引就是全表扫（D1 还会按扫描行数计费，见 EVAL 相关记录）。
 */
export const SYNC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS spaces (
  space_handle TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL,
  recovery_credential_hash TEXT NOT NULL,
  key_wraps TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  space_handle TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  server_rev INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  sealed TEXT NOT NULL,
  PRIMARY KEY (space_handle, collection, id)
);
CREATE INDEX IF NOT EXISTS records_by_rev ON records (space_handle, server_rev);
CREATE TABLE IF NOT EXISTS heads (
  space_handle TEXT PRIMARY KEY,
  head INTEGER NOT NULL
);
`;

/** 跑一遍建表（幂等，启动时调一次）。 */
export function ensureSyncSchema(db: SqliteDatabase): void {
  db.exec(SYNC_SCHEMA_SQL);
}

interface SpaceRow {
  space_handle: string;
  credential_hash: string;
  recovery_credential_hash: string;
  key_wraps: string;
  created_at: string;
}

interface RecordRow {
  collection: string;
  id: string;
  server_rev: number;
  updated_at: string;
  deleted_at: string | null;
  sealed: string;
}

function asSpace(row: unknown): SyncSpaceRecord | null {
  if (row === null || row === undefined) return null;
  const value = row as SpaceRow;
  return {
    spaceHandle: value.space_handle,
    credentialHash: value.credential_hash,
    recoveryCredentialHash: value.recovery_credential_hash,
    keyWraps: JSON.parse(value.key_wraps) as Record<string, unknown>,
    createdAt: value.created_at,
  };
}

function asPulledRecord(row: unknown): SyncPulledRecord {
  const value = row as RecordRow;
  return {
    collection: value.collection as SyncPulledRecord['collection'],
    id: value.id,
    updatedAt: value.updated_at,
    deletedAt: value.deleted_at,
    sealed: JSON.parse(value.sealed) as SyncPulledRecord['sealed'],
    serverRev: value.server_rev,
  };
}

/** 诊断用：这张表里现在有多少条、头号是多少。 */
export interface SqliteStoreStats {
  spaces: number;
  records: number;
  head: number;
}

export function createSqliteSyncStore(db: SqliteDatabase): SyncServerStore & { stats(): SqliteStoreStats } {
  ensureSyncSchema(db);

  const getHead = (spaceHandle: string): number => {
    const row = db.prepare('SELECT head FROM heads WHERE space_handle = ?1').get(spaceHandle) as
      | { head: number }
      | undefined;
    return row?.head ?? 0;
  };

  return {
    async getSpace(spaceHandle) {
      return asSpace(db.prepare('SELECT * FROM spaces WHERE space_handle = ?1').get(spaceHandle));
    },

    async createSpace(record) {
      // 用 INSERT ... ON CONFLICT DO NOTHING 一次判定：返回 changes === 0 就是已存在，
      // 比「先查再插」少一次往返，也不会被并发插队（SYNC §4.6 的 409 语义）
      const inserted = db
        .prepare(
          `INSERT INTO spaces (space_handle, credential_hash, recovery_credential_hash, key_wraps, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(space_handle) DO NOTHING`,
        )
        .run(
          record.spaceHandle,
          record.credentialHash,
          record.recoveryCredentialHash,
          JSON.stringify(record.keyWraps),
          record.createdAt,
        ) as { changes?: number };

      if ((inserted.changes ?? 0) === 0) return false;

      // 新建的空间要有 heads 行，后面的号才从 1 开始
      db.prepare('INSERT INTO heads (space_handle, head) VALUES (?1, 0) ON CONFLICT(space_handle) DO NOTHING').run(
        record.spaceHandle,
      );
      return true;
    },

    async head(spaceHandle) {
      return getHead(spaceHandle);
    },

    async append(spaceHandle, records: readonly SyncWireRecord[]) {
      if (records.length === 0) return [];

      const accepted: SyncAcceptedRecord[] = [];
      let head = getHead(spaceHandle);
      if (db.prepare('SELECT space_handle FROM spaces WHERE space_handle = ?1').get(spaceHandle) === undefined) {
        throw new CryptoError('空间不存在。');
      }

      // 事务包住：号与行要么一起落，要么都不落（中途失败不能留下跳号的空洞）
      db.exec('BEGIN');
      try {
        const upsert = db.prepare(
          `INSERT INTO records (space_handle, collection, id, server_rev, updated_at, deleted_at, sealed)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(space_handle, collection, id)
           DO UPDATE SET server_rev = excluded.server_rev, updated_at = excluded.updated_at,
                         deleted_at = excluded.deleted_at, sealed = excluded.sealed`,
        );

        for (const record of records) {
          head += 1;
          upsert.run(
            spaceHandle,
            record.collection,
            record.id,
            head,
            record.updatedAt,
            record.deletedAt,
            JSON.stringify(record.sealed),
          );
          accepted.push({ collection: record.collection, id: record.id, serverRev: head });
        }

        db.prepare(
          'INSERT INTO heads (space_handle, head) VALUES (?1, ?2) ON CONFLICT(space_handle) DO UPDATE SET head = excluded.head',
        ).run(spaceHandle, head);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      return accepted;
    },

    async list(spaceHandle, options) {
      const rows = db
        .prepare(
          `SELECT collection, id, server_rev, updated_at, deleted_at, sealed
           FROM records WHERE space_handle = ?1 AND server_rev > ?2
           ORDER BY server_rev ASC LIMIT ?3`,
        )
        .all(spaceHandle, options.since, options.limit);
      return rows.map(asPulledRecord);
    },

    /**
     * 给配额用的用量（顺序 16）。
     *
     * `bytes` 用 `length(sealed)` 而不是解出 base64 再量：这条查询要跑在
     * 每次写入之前，答案只需要**随记录增长而增长**、量级对得上就行；
     * 为了精确到字节去把每行 JSON 解析一遍，代价反而是每次写入都要全表读。
     */
    async spaceUsage(spaceHandle) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(sealed)), 0) AS bytes
           FROM records WHERE space_handle = ?1`,
        )
        .get(spaceHandle) as { records: number; bytes: number } | undefined;
      return { records: row?.records ?? 0, bytes: row?.bytes ?? 0 };
    },

    stats() {
      const spaces = db.prepare('SELECT COUNT(*) AS count FROM spaces').get() as { count: number };
      const records = db.prepare('SELECT COUNT(*) AS count FROM records').get() as { count: number };
      const head = db.prepare('SELECT COALESCE(SUM(head), 0) AS total FROM heads').get() as { total: number };
      return { spaces: spaces.count, records: records.count, head: head.total };
    },
  };
}
