import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from './audit.js';
import { backupBeforeChange } from './backup.js';

export class AdminOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const deny = (status: number, code: string, message: string): never => {
  throw new AdminOperationError(status, code, message);
};
interface Snapshot {
  space_handle: string;
  epoch: string;
  display_name: string | null;
  max_bytes: number | null;
  revision: number;
}
interface Changes {
  displayName?: string;
  maxBytes?: number | null;
}
interface Pending {
  handle: string;
  version: string;
  changes: Changes;
  expiresAt: number;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: 登记名称拒绝控制字符
const CONTROLS = /[\u0000-\u001f\u007f]/;
const version = (snapshot: Snapshot) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

export function createAdminOperations(options: {
  dataPath: string;
  backupPath: string;
  defaultMaxBytes: number;
  audit(event: AuditEvent): void;
  now?: () => number;
}) {
  if (!existsSync(options.dataPath)) throw new Error('数据库不存在。');
  const db = new DatabaseSync(options.dataPath);
  db.exec('PRAGMA busy_timeout=5000');
  const select = db.prepare(`SELECT s.space_handle,s.epoch,p.display_name,q.max_bytes,
    COALESCE(q.revision,0) AS revision FROM spaces s
    LEFT JOIN account_profiles p ON p.space_handle=s.space_handle AND p.space_epoch=s.epoch
    LEFT JOIN space_policies q ON q.space_handle=s.space_handle AND q.space_epoch=s.epoch
    WHERE s.space_handle=?`);
  const read = (handle: string): Snapshot => {
    const row = select.get(handle) as Snapshot | undefined;
    if (!row?.epoch) return deny(404, 'space-not-found', '空间不存在或尚未升级。');
    return row;
  };
  const now = options.now ?? Date.now;
  const pending = new Map<string, Pending>();
  return {
    prepare(input: Record<string, unknown>) {
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).some((key) => !['spaceHandle', 'displayName', 'maxBytes'].includes(key)) ||
        typeof input.spaceHandle !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.spaceHandle)
      ) {
        return deny(400, 'bad-request', '修改字段无效。');
      }
      const snapshot = read(input.spaceHandle);
      const changes: Changes = {};
      if ('displayName' in input) {
        if (snapshot.display_name === null) return deny(409, 'unclaimed', '未认领空间不能由管理员登记名称。');
        if (
          typeof input.displayName !== 'string' ||
          input.displayName.trim() === '' ||
          input.displayName.length > 80 ||
          CONTROLS.test(input.displayName)
        )
          return deny(400, 'bad-name', '显示名必须为 1 到 80 个字符。');
        if (input.displayName.trim() !== snapshot.display_name) changes.displayName = input.displayName.trim();
      }
      if ('maxBytes' in input) {
        if (
          input.maxBytes !== null &&
          (typeof input.maxBytes !== 'number' ||
            !Number.isSafeInteger(input.maxBytes) ||
            input.maxBytes < 0 ||
            input.maxBytes > 1024 ** 4)
        )
          return deny(400, 'bad-quota', '容量必须是 0 到 1 TiB 的整数字节数。');
        if (input.maxBytes !== snapshot.max_bytes) changes.maxBytes = input.maxBytes as number | null;
      }
      if (!Object.keys(changes).length) return deny(400, 'no-change', '没有需要保存的修改。');
      for (const [key, value] of pending) if (value.expiresAt <= now()) pending.delete(key);
      if (pending.size >= 128) return deny(429, 'too-many-previews', '待确认修改过多，请稍后再试。');
      const confirmationId = randomBytes(32).toString('base64url');
      const expiresAt = now() + 120000;
      pending.set(confirmationId, { handle: snapshot.space_handle, version: version(snapshot), changes, expiresAt });
      return {
        confirmationId,
        expiresAt,
        spaceHandle: snapshot.space_handle,
        before: {
          displayName: snapshot.display_name,
          maxBytes: snapshot.max_bytes,
          quotaLimitBytes: snapshot.max_bytes ?? options.defaultMaxBytes,
        },
        after: {
          displayName: changes.displayName ?? snapshot.display_name,
          maxBytes: 'maxBytes' in changes ? changes.maxBytes : snapshot.max_bytes,
          quotaLimitBytes: ('maxBytes' in changes ? changes.maxBytes : snapshot.max_bytes) ?? options.defaultMaxBytes,
        },
      };
    },
    commit(input: Record<string, unknown>) {
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).some((key) => !['confirmationId', 'confirmSpaceHandle'].includes(key)) ||
        typeof input.confirmationId !== 'string'
      )
        return deny(400, 'bad-confirmation', '确认资料无效。');
      const item = pending.get(input.confirmationId);
      pending.delete(input.confirmationId);
      if (!item || item.expiresAt <= now() || input.confirmSpaceHandle !== item.handle)
        return deny(409, 'confirmation-invalid', '确认已过期或空间句柄不匹配，请重新预览。');
      if (version(read(item.handle)) !== item.version)
        return deny(409, 'stale-preview', '空间资料已改变，请重新预览。');
      let backupFile: string;
      try {
        backupFile = backupBeforeChange(db, options.dataPath, options.backupPath);
      } catch {
        return deny(503, 'backup-failed', '自动备份失败，修改未执行。');
      }
      const operationId = randomUUID();
      const event = {
        operationId,
        spaceHandle: item.handle,
        backupFile,
        ...('maxBytes' in item.changes ? { maxBytes: item.changes.maxBytes } : {}),
        durationMs: 0,
      };
      try {
        options.audit({ ...event, action: 'change-intent', status: 200 });
      } catch {
        return deny(503, 'audit-failed', '操作审计失败，修改未执行。');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const snapshot = read(item.handle);
        if (version(snapshot) !== item.version) deny(409, 'stale-preview', '空间资料已改变，请重新预览。');
        if ('displayName' in item.changes)
          db.prepare('UPDATE account_profiles SET display_name=? WHERE space_handle=? AND space_epoch=?').run(
            item.changes.displayName,
            item.handle,
            snapshot.epoch,
          );
        db.prepare(`INSERT INTO space_policies(space_handle,space_epoch,max_bytes,revision) VALUES(?,?,?,?)
          ON CONFLICT(space_handle) DO UPDATE SET space_epoch=excluded.space_epoch,max_bytes=excluded.max_bytes,revision=excluded.revision`).run(
          item.handle,
          snapshot.epoch,
          'maxBytes' in item.changes ? item.changes.maxBytes : snapshot.max_bytes,
          snapshot.revision + 1,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        try {
          options.audit({
            ...event,
            action: 'change-rejected',
            status: error instanceof AdminOperationError ? error.status : 503,
          });
        } catch {
          /* 已有意图审计；绝不泄漏内部错误。 */
        }
        if (error instanceof AdminOperationError) throw error;
        return deny(503, 'change-failed', '修改失败，事务已回滚。');
      }
      let auditWarning: string | null = null;
      try {
        options.audit({ ...event, action: 'change-applied', status: 200 });
      } catch {
        auditWarning = '修改已保存，但结果审计追加失败；操作意图已记录，请检查审计权限与磁盘。';
      }
      return { applied: true, spaceHandle: item.handle, operationId, backupFile, auditWarning };
    },
    close() {
      pending.clear();
      db.close();
    },
  };
}
