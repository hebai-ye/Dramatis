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
import { newSpaceEpoch, type SyncServerStore, type SyncSpaceRecord } from './server.js';
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
  created_at TEXT NOT NULL,
  epoch TEXT
);
CREATE TABLE IF NOT EXISTS records (
  space_handle TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  server_rev INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT,
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
  /*
   * 顺序 14 加的列：老库（建表语句那时还没有 `device_id`）里没有它，
   * 而 `CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列。
   *
   * 为什么用 PRAGMA 探一下再 ALTER，而不是 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`：
   * SQLite 到 3.4x 都还不支持那个 `IF NOT EXISTS`（Postgres 才有）。探一次是幂等的，
   * 重复启动不会报错。
   */
  const columns = db.prepare('PRAGMA table_info(records)').all() as { name?: string }[];
  if (!columns.some((column) => column.name === 'device_id')) {
    db.exec('ALTER TABLE records ADD COLUMN device_id TEXT');
  }

  /*
   * 审计 A4 加的空间纪元。老库补列之后，给每个还没有纪元的空间补一个随机值：
   * 客户端第一次见到它时只是记下来（本地没有旧纪元可比），不会误判成重建。
   * 每次启动都跑一遍补漏（`WHERE epoch IS NULL`），回滚到老版本再升级也能补上。
   */
  const spaceColumns = db.prepare('PRAGMA table_info(spaces)').all() as { name?: string }[];
  if (!spaceColumns.some((column) => column.name === 'epoch')) {
    db.exec('ALTER TABLE spaces ADD COLUMN epoch TEXT');
  }
  db.exec("UPDATE spaces SET epoch = lower(hex(randomblob(16))) WHERE epoch IS NULL OR epoch = ''");
}

/**
 * 打开库之后立刻设的两个 PRAGMA（顺序 61）。
 *
 * - `journal_mode = WAL`：默认的 rollback journal 是**写的时候锁住整库读**，
 *   于是「服务端在写 + 备份脚本在 `VACUUM INTO`」会互相把对方顶回去（`SQLITE_BUSY`
 *   直接失败）。WAL 让读与写并行，备份也就不必抢窗口。
 * - `busy_timeout = 5000`：撞上锁时**等 5 秒**再放弃，而不是立刻报错。
 *   对一个每 20 秒推一次、每次几百毫秒的自建服务端来说，这条比重试逻辑更实在。
 *
 * 放在独立的函数里而不是塞进 `ensureSyncSchema`：一个是「库的形状」，
 * 一个是「库怎么并发」，混在一起以后调不动。开在 `:memory:` 上时 WAL 会被
 * SQLite 忽略（内存库本来就没有日志文件），不会报错。
 */
export function applySqlitePragmas(db: SqliteDatabase): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
}

interface SpaceRow {
  space_handle: string;
  credential_hash: string;
  recovery_credential_hash: string;
  key_wraps: string;
  created_at: string;
  epoch?: string | null;
}

interface RecordRow {
  collection: string;
  id: string;
  server_rev: number;
  updated_at: string;
  deleted_at: string | null;
  sealed: string;
  device_id: string | null;
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
    ...(typeof value.epoch === 'string' && value.epoch !== '' ? { epoch: value.epoch } : {}),
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
    ...(value.device_id === null || value.device_id === undefined ? {} : { deviceId: value.device_id }),
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
          `INSERT INTO spaces (space_handle, credential_hash, recovery_credential_hash, key_wraps, created_at, epoch)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(space_handle) DO NOTHING`,
        )
        .run(
          record.spaceHandle,
          record.credentialHash,
          record.recoveryCredentialHash,
          JSON.stringify(record.keyWraps),
          record.createdAt,
          record.epoch ?? newSpaceEpoch(),
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
          `INSERT INTO records (space_handle, collection, id, server_rev, updated_at, deleted_at, sealed, device_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(space_handle, collection, id)
           DO UPDATE SET server_rev = excluded.server_rev, updated_at = excluded.updated_at,
                         deleted_at = excluded.deleted_at, sealed = excluded.sealed,
                         device_id = excluded.device_id`,
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
            record.deviceId ?? null,
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
          `SELECT collection, id, server_rev, updated_at, deleted_at, sealed, device_id
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

    /** 按设备聚合（顺序 14）：每条记录只有一行，直接 GROUP BY。 */
    async deviceUsage(spaceHandle) {
      const rows = db
        .prepare(
          `SELECT device_id, COUNT(*) AS records, MAX(updated_at) AS last_write_at
           FROM records
           WHERE space_handle = ?1 AND device_id IS NOT NULL
           GROUP BY device_id
           ORDER BY last_write_at DESC`,
        )
        .all(spaceHandle) as { device_id: string; records: number; last_write_at: string }[];
      return rows.map((row) => ({
        deviceId: row.device_id,
        records: row.records,
        lastWriteAt: row.last_write_at,
      }));
    },

    /** 总量护栏（顺序 61）：数一下这张表有多少个空间。 */
    async spaceCount() {
      const row = db.prepare('SELECT COUNT(*) AS count FROM spaces').get() as { count: number } | undefined;
      return row?.count ?? 0;
    },

    /**
     * 换密码（顺序 15）：只换密码那份哈希与封装。
     *
     * 恢复码那份（`recovery_credential_hash` / `key_wraps.recovery`）**刻意不动**——
     * 它是「忘了密码」的等价凭证，换密码不该顺手废掉它。
     */
    async rotatePassword(spaceHandle, patch) {
      const row = db.prepare('SELECT key_wraps FROM spaces WHERE space_handle = ?1').get(spaceHandle) as
        | { key_wraps: string }
        | undefined;
      if (row === undefined) return false;
      const wraps = JSON.parse(row.key_wraps) as Record<string, unknown>;
      wraps.password = patch.passwordWrap;
      db.prepare('UPDATE spaces SET credential_hash = ?2, key_wraps = ?3 WHERE space_handle = ?1').run(
        spaceHandle,
        patch.credentialHash,
        JSON.stringify(wraps),
      );
      return true;
    },

    stats() {
      const spaces = db.prepare('SELECT COUNT(*) AS count FROM spaces').get() as { count: number };
      const records = db.prepare('SELECT COUNT(*) AS count FROM records').get() as { count: number };
      const head = db.prepare('SELECT COALESCE(SUM(head), 0) AS total FROM heads').get() as { total: number };
      return { spaces: spaces.count, records: records.count, head: head.total };
    },
  };
}
