import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { apiAccountingAvailable, recordPurchase } from './api-accounting.js';
import type { AuditEvent } from './audit.js';
import { backupBeforeChange } from './backup.js';
import { accountSpaceHandle, normalizeAccountId } from './identity.js';
import {
  effectiveQuota,
  MEMBERSHIP_FIELDS,
  type MembershipRecord,
  type MembershipRow,
  membershipProjection,
  presentMembership,
  readMembership,
} from './membership.js';
import { getVipPlan, type VipPlan } from './vip-plans.js';

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
  account_id: string | null;
  display_name: string | null;
  max_bytes: number | null;
  revision: number;
  membership: MembershipRecord | null;
  api_paid_until: string | null;
  api_revision: number;
}
interface Changes {
  accountId?: string;
  displayName?: string;
  maxBytes?: number | null;
  membership?: MembershipRecord;
  membershipAction?: 'grant' | 'renew' | 'revoke' | 'purchase';
  purchase?: VipPlan;
  purchaseAt?: string;
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
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const membershipsAvailable =
    ['space_epoch', ...MEMBERSHIP_FIELDS].every((name) => columns('space_memberships').includes(name)) &&
    [
      'operation_id',
      'space_handle',
      'space_epoch',
      'action',
      'event_at',
      'started_at',
      'expires_at',
      'max_bytes',
    ].every((name) => columns('membership_events').includes(name));
  const plansAvailable = ['plan_id', 'plan_version'].every((name) => columns('space_memberships').includes(name));
  const billingAvailable = plansAvailable && apiAccountingAvailable(db);
  const select = db.prepare(`SELECT s.space_handle,s.epoch,p.account_id,p.display_name,q.max_bytes,
    COALESCE(q.revision,0) AS revision,${membershipProjection(membershipsAvailable, plansAvailable)},
    ${billingAvailable ? 'a.paid_until' : 'NULL'} AS api_paid_until,
    ${billingAvailable ? 'COALESCE(a.revision,0)' : '0'} AS api_revision FROM spaces s
    LEFT JOIN account_profiles p ON p.space_handle=s.space_handle AND p.space_epoch=s.epoch
    LEFT JOIN space_policies q ON q.space_handle=s.space_handle AND q.space_epoch=s.epoch
    ${membershipsAvailable ? 'LEFT JOIN space_memberships m ON m.space_handle=s.space_handle AND m.space_epoch=s.epoch' : ''}
    ${billingAvailable ? 'LEFT JOIN api_accounts a ON a.space_handle=s.space_handle AND a.space_epoch=s.epoch' : ''}
    WHERE s.space_handle=?`);
  const read = (handle: string): Snapshot => {
    const row = select.get(handle) as (Omit<Snapshot, 'membership'> & MembershipRow) | undefined;
    if (!row?.epoch) return deny(404, 'space-not-found', '空间不存在或尚未升级。');
    return { ...row, membership: readMembership(row) };
  };
  const now = options.now ?? Date.now;
  const pending = new Map<string, Pending>();
  return {
    prepare(input: Record<string, unknown>) {
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).some(
          (key) => !['spaceHandle', 'accountId', 'displayName', 'maxBytes', 'membership'].includes(key),
        ) ||
        typeof input.spaceHandle !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.spaceHandle)
      ) {
        return deny(400, 'bad-request', '修改字段无效。');
      }
      const snapshot = read(input.spaceHandle);
      const changes: Changes = {};
      const instant = now();
      if ('membership' in input) {
        if (Object.keys(input).some((key) => !['spaceHandle', 'membership'].includes(key)))
          return deny(400, 'mixed-membership-change', '会员操作须单独预览，不能混合账户或固定配额修改。');
        if (!membershipsAvailable) return deny(409, 'membership-unavailable', '会员表尚未启用，请先更新同步服务。');
        if (snapshot.account_id === null) return deny(409, 'unclaimed', '请先关联原账户 ID，再开通会员。');
        const value = input.membership;
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return deny(400, 'bad-membership', '会员资料无效。');
        const memberInput = value as Record<string, unknown>;
        const action = memberInput.action;
        if (
          typeof action !== 'string' ||
          !['grant', 'renew', 'revoke', 'purchase'].includes(action) ||
          Object.keys(memberInput).some(
            (key) =>
              !(
                action === 'purchase'
                  ? ['action', 'planId']
                  : action === 'revoke'
                    ? ['action']
                    : ['action', 'durationDays', 'maxBytes']
              ).includes(key),
          )
        )
          return deny(400, 'bad-membership', '会员操作或字段无效。');
        const previous = snapshot.membership;
        const state = presentMembership(previous, instant);
        if (action === 'purchase') {
          if (!billingAvailable) return deny(409, 'billing-unavailable', '套餐账本尚未启用，请先更新同步服务。');
          let plan: VipPlan;
          try {
            plan = getVipPlan(memberInput.planId);
          } catch {
            return deny(400, 'bad-plan', '请选择服务端目录中的套餐。');
          }
          if (state?.status === 'active' && (previous?.planId !== plan.id || previous?.maxBytes !== plan.maxBytes))
            return deny(409, 'plan-switch-denied', '有效会员仅支持同档付费续期；历史自定义会员或跨档请另行处理。');
          const from = state?.status === 'active' && previous ? Date.parse(previous.expiresAt) : instant;
          changes.membership = {
            startedAt: state?.status === 'active' && previous ? previous.startedAt : new Date(instant).toISOString(),
            expiresAt: new Date(from + plan.durationDays * 86400000).toISOString(),
            revokedAt: null,
            maxBytes: plan.maxBytes,
            revision: (previous?.revision ?? 0) + 1,
            planId: plan.id,
            planVersion: plan.version,
          };
          changes.purchase = plan;
          changes.purchaseAt = new Date(instant).toISOString();
        }
        if (action === 'grant' && state?.status === 'active')
          return deny(409, 'already-vip', '会员仍有效，请使用续期。');
        if ((action === 'renew' || action === 'revoke') && !previous)
          return deny(409, 'membership-not-found', '此账户没有当前会员记录。');
        if ((action === 'renew' || action === 'revoke') && previous?.revokedAt !== null)
          return deny(409, 'membership-revoked', '会员已撤销，请重新开通。');
        if (action === 'purchase') {
          // 套餐期限及容量已由服务端目录确定，不接受客户端报价。
        } else if (action === 'revoke' && previous) {
          changes.membership = {
            ...previous,
            revokedAt: new Date(instant).toISOString(),
            revision: previous.revision + 1,
          };
        } else {
          const days = memberInput.durationDays;
          const quota = memberInput.maxBytes;
          if (
            typeof days !== 'number' ||
            !Number.isInteger(days) ||
            days < 1 ||
            days > 3650 ||
            typeof quota !== 'number' ||
            !Number.isSafeInteger(quota) ||
            quota < 1 ||
            quota > 1024 ** 4
          )
            return deny(400, 'bad-membership', '会员期限须为1到3650整数天，容量须为1字节到1TiB。');
          const from = action === 'renew' && previous ? Math.max(instant, Date.parse(previous.expiresAt)) : instant;
          if (!Number.isFinite(from)) return deny(409, 'bad-membership-state', '现有到期时间无效，不能续期。');
          changes.membership = {
            startedAt: action === 'renew' && previous ? previous.startedAt : new Date(instant).toISOString(),
            expiresAt: new Date(from + days * 86400000).toISOString(),
            revokedAt: null,
            maxBytes: quota,
            revision: (previous?.revision ?? 0) + 1,
            planId: action === 'renew' && previous?.maxBytes === quota ? previous.planId : null,
            planVersion: action === 'renew' && previous?.maxBytes === quota ? previous.planVersion : null,
          };
        }
        changes.membershipAction = action as Changes['membershipAction'];
      }
      if ('accountId' in input) {
        if (snapshot.account_id !== null) return deny(409, 'already-linked', '此空间已关联账户，不能重新分配账户 ID。');
        const accountId = normalizeAccountId(input.accountId);
        if (accountId === null) return deny(400, 'bad-account-id', '账户 ID 必须为 1 到 128 个字符且无控制字符。');
        if (accountSpaceHandle(accountId) !== snapshot.space_handle)
          return deny(
            409,
            'account-mismatch',
            '该 ID 对应的空间句柄与目标不符，请核对原账户 ID；关联不能改变账户身份。',
          );
        changes.accountId = accountId;
        if (!('displayName' in input)) {
          if (accountId.length > 80) return deny(400, 'bad-name', '请为此账户填写 1 到 80 个字符的显示名。');
          changes.displayName = accountId;
        }
      }
      if ('displayName' in input) {
        if (snapshot.account_id === null && !changes.accountId)
          return deny(409, 'unclaimed', '请先填写与此空间匹配的账户 ID，再登记显示名。');
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
        ...(changes.purchase
          ? {
              purchase: {
                planId: changes.purchase.id,
                planVersion: changes.purchase.version,
                planName: changes.purchase.name,
                durationDays: changes.purchase.durationDays,
                maxBytes: changes.purchase.maxBytes,
                priceFen: changes.purchase.priceFen,
                creditNanoyuan: changes.purchase.creditNanoyuan,
                paidUntil: new Date(
                  Math.max(instant, snapshot.api_paid_until === null ? instant : Date.parse(snapshot.api_paid_until)) +
                    changes.purchase.durationDays * 86400000,
                ).toISOString(),
              },
            }
          : {}),
        before: {
          accountId: snapshot.account_id,
          displayName: snapshot.display_name,
          maxBytes: snapshot.max_bytes,
          ...effectiveQuota(snapshot.max_bytes, snapshot.membership, options.defaultMaxBytes, instant),
        },
        after: {
          accountId: changes.accountId ?? snapshot.account_id,
          displayName: changes.displayName ?? snapshot.display_name,
          maxBytes: 'maxBytes' in changes ? changes.maxBytes : snapshot.max_bytes,
          ...effectiveQuota(
            ('maxBytes' in changes ? changes.maxBytes : snapshot.max_bytes) ?? null,
            changes.membership ?? snapshot.membership,
            options.defaultMaxBytes,
            instant,
          ),
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
      const action = item.changes.membershipAction
        ? `membership-${item.changes.membershipAction}`
        : item.changes.accountId
          ? 'account-link'
          : 'change';
      const event = {
        operationId,
        spaceHandle: item.handle,
        backupFile,
        ...('maxBytes' in item.changes ? { maxBytes: item.changes.maxBytes } : {}),
        ...(item.changes.membership
          ? {
              maxBytes: item.changes.membership.maxBytes,
              startedAt: item.changes.membership.startedAt,
              expiresAt: item.changes.membership.expiresAt,
            }
          : {}),
        durationMs: 0,
      };
      try {
        options.audit({ ...event, action: `${action}-intent`, status: 200 });
      } catch {
        return deny(503, 'audit-failed', '操作审计失败，修改未执行。');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const snapshot = read(item.handle);
        if (version(snapshot) !== item.version) deny(409, 'stale-preview', '空间资料已改变，请重新预览。');
        if (item.changes.accountId) {
          db.prepare(`INSERT INTO account_profiles(space_handle,account_id,display_name,claimed_at,space_epoch)
            VALUES(?,?,?,?,?) ON CONFLICT(space_handle) DO UPDATE SET account_id=excluded.account_id,
            display_name=excluded.display_name,claimed_at=excluded.claimed_at,space_epoch=excluded.space_epoch
            WHERE account_profiles.space_epoch<>excluded.space_epoch`).run(
            item.handle,
            item.changes.accountId,
            item.changes.displayName,
            new Date(now()).toISOString(),
            snapshot.epoch,
          );
        } else if ('displayName' in item.changes)
          db.prepare('UPDATE account_profiles SET display_name=? WHERE space_handle=? AND space_epoch=?').run(
            item.changes.displayName,
            item.handle,
            snapshot.epoch,
          );
        if (item.changes.membership) {
          const member = item.changes.membership;
          db.prepare(`INSERT INTO space_memberships(space_handle,space_epoch,started_at,expires_at,revoked_at,max_bytes,revision)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(space_handle) DO UPDATE SET space_epoch=excluded.space_epoch,
            started_at=excluded.started_at,expires_at=excluded.expires_at,revoked_at=excluded.revoked_at,
            max_bytes=excluded.max_bytes,revision=excluded.revision`).run(
            item.handle,
            snapshot.epoch,
            member.startedAt,
            member.expiresAt,
            member.revokedAt,
            member.maxBytes,
            member.revision,
          );
          db.prepare(`INSERT INTO membership_events(operation_id,space_handle,space_epoch,action,event_at,started_at,expires_at,max_bytes)
            VALUES(?,?,?,?,?,?,?,?)`).run(
            operationId,
            item.handle,
            snapshot.epoch,
            item.changes.membershipAction,
            new Date(now()).toISOString(),
            member.startedAt,
            member.expiresAt,
            member.maxBytes,
          );
          if (plansAvailable)
            db.prepare(
              'UPDATE space_memberships SET plan_id=?,plan_version=? WHERE space_handle=? AND space_epoch=?',
            ).run(member.planId ?? null, member.planVersion ?? null, item.handle, snapshot.epoch);
          if (item.changes.purchase)
            recordPurchase(db, {
              operationId,
              spaceHandle: item.handle,
              spaceEpoch: snapshot.epoch,
              plan: item.changes.purchase,
              eventAt: item.changes.purchaseAt ?? new Date(now()).toISOString(),
            });
        } else
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
            action: `${action}-rejected`,
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
        options.audit({ ...event, action: `${action}-applied`, status: 200 });
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
