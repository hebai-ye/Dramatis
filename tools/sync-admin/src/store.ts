import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createApiLedger } from './api-accounting.js';
import { accountSpaceHandle, normalizeAccountId } from './identity.js';
import {
  effectiveQuota,
  MEMBERSHIP_FIELDS,
  type MembershipRow,
  membershipProjection,
  readMembership,
} from './membership.js';

interface SpaceRow extends MembershipRow {
  space_handle: string;
  space_epoch: string | null;
  created_at: string;
  head: number | null;
  record_count: number | null;
  byte_count: number | null;
  account_id: string | null;
  display_name: string | null;
  claimed_at: string | null;
  policy_max_bytes: number | null;
}

function presentBilling(summary: ReturnType<ReturnType<typeof createApiLedger>['summary']>) {
  return {
    available: summary.available,
    balanceNanoyuan: summary.balanceNanoyuan,
    reservedNanoyuan: summary.reservedNanoyuan,
    availableNanoyuan: summary.availableNanoyuan,
    grantedNanoyuan: summary.grantedNanoyuan,
    spentNanoyuan: summary.spentNanoyuan,
    paidUntil: summary.paidUntil,
    paidActive: summary.paidActive,
    vipActive: summary.vipActive,
    status: summary.status,
    revision: summary.revision,
    serviceStatus: '托管网关尚未对最终用户开放',
    purchases: summary.purchases.map((purchase) => ({
      operationId: purchase.operationId,
      planId: purchase.planId,
      planVersion: purchase.planVersion,
      planName: purchase.planName,
      durationDays: purchase.durationDays,
      maxBytes: purchase.maxBytes,
      priceFen: purchase.priceFen,
      creditNanoyuan: purchase.creditNanoyuan,
      eventAt: purchase.eventAt,
      paidUntil: purchase.paidUntil,
      revision: purchase.revision,
    })),
    requests: summary.requests.map((request) => ({
      requestId: request.requestId,
      state: request.state,
      reservedNanoyuan: request.reservedNanoyuan,
      chargedNanoyuan: request.chargedNanoyuan,
      model: request.model,
      priceVersion: request.priceVersion,
      pricePeriod: request.pricePeriod,
      maxOutputTokens: request.maxOutputTokens,
      startedAt: request.startedAt,
      sentAt: request.sentAt,
      completedAt: request.completedAt,
      upstreamId: request.upstreamId,
      usage: request.usage
        ? {
            promptTokens: request.usage.promptTokens,
            cacheHitTokens: request.usage.cacheHitTokens,
            cacheMissTokens: request.usage.cacheMissTokens,
            completionTokens: request.usage.completionTokens,
            totalTokens: request.usage.totalTokens,
            ...(request.usage.reasoningTokens === undefined ? {} : { reasoningTokens: request.usage.reasoningTokens }),
          }
        : null,
      pendingReason: request.pendingReason,
    })),
  };
}

function present(row: SpaceRow, defaultMaxBytes: number, now: number, membershipsAvailable: boolean) {
  return {
    spaceHandle: row.space_handle,
    createdAt: row.created_at,
    head: row.head,
    records: row.record_count,
    quotaBytes: row.byte_count,
    ...effectiveQuota(row.policy_max_bytes, readMembership(row), defaultMaxBytes, now),
    membershipsAvailable,
    customQuota: row.policy_max_bytes !== null,
    profile:
      row.account_id === null
        ? null
        : {
            accountId: row.account_id,
            displayName: row.display_name,
            claimedAt: row.claimed_at,
          },
  };
}

/** 与同步存储分开：不建表、不迁移、不取实体、凭证或钥匙封装。 */
export function createAdminStore(path: string, defaultMaxBytes = 96 * 1024 ** 2, now = Date.now) {
  if (!existsSync(path)) throw new Error('同步数据库不存在，管理台拒绝新建空库。');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // 兼容早期 Node 22；query_only 也阻止不支持 readOnly 参数的宿主执行写 SQL。
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const spacesColumns = columns('spaces');
    const headsColumns = columns('heads');
    if (!spacesColumns.includes('space_handle') || !columns('records').includes('sealed')) {
      throw new Error('同步数据库形状不兼容。');
    }
    const profiles = spacesColumns.includes('epoch') && columns('account_profiles').includes('space_epoch');
    const counters = headsColumns.includes('record_count') && headsColumns.includes('byte_count');
    const policies =
      spacesColumns.includes('epoch') &&
      ['space_epoch', 'max_bytes', 'revision'].every((name) => columns('space_policies').includes(name));
    const memberships =
      spacesColumns.includes('epoch') &&
      ['space_epoch', ...MEMBERSHIP_FIELDS].every((name) => columns('space_memberships').includes(name));
    const membershipPlans =
      memberships && ['plan_id', 'plan_version'].every((name) => columns('space_memberships').includes(name));
    const history = [
      'operation_id',
      'space_handle',
      'space_epoch',
      'action',
      'event_at',
      'started_at',
      'expires_at',
      'max_bytes',
    ].every((name) => columns('membership_events').includes(name));
    const join = `FROM spaces s LEFT JOIN heads h ON h.space_handle = s.space_handle
      ${profiles ? 'LEFT JOIN account_profiles p ON p.space_handle = s.space_handle AND p.space_epoch = s.epoch' : ''}
      ${policies ? 'LEFT JOIN space_policies q ON q.space_handle=s.space_handle AND q.space_epoch=s.epoch' : ''}
      ${memberships ? 'LEFT JOIN space_memberships m ON m.space_handle=s.space_handle AND m.space_epoch=s.epoch' : ''}`;
    const ledger = createApiLedger(db, now);
    const projection = `s.space_handle, ${spacesColumns.includes('epoch') ? 's.epoch' : 'NULL'} AS space_epoch, s.created_at, h.head,
      ${counters ? 'h.record_count, h.byte_count' : 'NULL AS record_count, NULL AS byte_count'},
      ${profiles ? 'p.account_id, p.display_name, p.claimed_at' : 'NULL AS account_id, NULL AS display_name, NULL AS claimed_at'},
      ${policies ? 'q.max_bytes AS policy_max_bytes' : 'NULL AS policy_max_bytes'},${membershipProjection(memberships, membershipPlans)}`;

    const snapshot = <T>(read: () => T): T => {
      db.exec('BEGIN');
      try {
        const result = read();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };

    return {
      overview() {
        return snapshot(() => {
          const totals = db
            .prepare(`SELECT COUNT(*) AS spaces,
            ${profiles ? 'COUNT(p.account_id)' : '0'} AS accounts,
            ${counters ? 'CASE WHEN COUNT(h.byte_count) = COUNT(*) THEN COALESCE(SUM(h.byte_count), 0) ELSE NULL END' : 'NULL'} AS quota_bytes
            ${join}`)
            .get() as { spaces: number; accounts: number; quota_bytes: number | null };
          const records = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
          const counts = { vipActive: 0, vipExpired: 0, vipRevoked: 0 };
          if (memberships) {
            const instant = now();
            const rows = db
              .prepare(`SELECT ${membershipProjection(true)} ${join} WHERE m.space_handle IS NOT NULL`)
              .all() as MembershipRow[];
            for (const row of rows) {
              const member = effectiveQuota(null, readMembership(row), defaultMaxBytes, instant).membership;
              if (member?.status === 'active') counts.vipActive++;
              else if (member?.status === 'expired') counts.vipExpired++;
              else if (member?.status === 'revoked') counts.vipRevoked++;
            }
          }
          return {
            spaces: totals.spaces,
            accounts: totals.accounts,
            unclaimed: totals.spaces - totals.accounts,
            records,
            quotaBytes: totals.quota_bytes,
            profilesAvailable: profiles,
            membershipsAvailable: memberships && history,
            ...counts,
          };
        });
      },
      list(options: { offset: number; limit: number; search: string }) {
        const accountId = normalizeAccountId(options.search);
        const derivedHandle = accountId === null ? '' : accountSpaceHandle(accountId);
        return snapshot(() => {
          const pattern = `%${options.search.replace(/[\\%_]/g, '\\$&')}%`;
          const where = `WHERE s.space_handle=? OR s.space_handle LIKE ? ESCAPE '\\'
            ${profiles ? "OR p.account_id LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\'" : ''}`;
          const params = profiles ? [derivedHandle, pattern, pattern, pattern] : [derivedHandle, pattern];
          const total = (db.prepare(`SELECT COUNT(*) AS n ${join} ${where}`).get(...params) as { n: number }).n;
          const rows = db
            .prepare(`SELECT ${projection} ${join} ${where}
            ORDER BY s.created_at DESC, s.space_handle ASC LIMIT ? OFFSET ?`)
            .all(...params, options.limit, options.offset) as SpaceRow[];
          return {
            spaces: rows.map((row) => present(row, defaultMaxBytes, now(), memberships && history)),
            total,
            offset: options.offset,
            limit: options.limit,
          };
        });
      },
      detail(handle: string) {
        return snapshot(() => {
          const row = db.prepare(`SELECT ${projection} ${join} WHERE s.space_handle = ?`).get(handle) as
            | SpaceRow
            | undefined;
          if (row === undefined) return null;
          const collections = db
            .prepare(`SELECT collection, COUNT(*) AS records,
            SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS tombstones
            FROM records WHERE space_handle = ? GROUP BY collection ORDER BY collection`)
            .all(handle) as { collection: string; records: number; tombstones: number }[];
          const aggregate = db
            .prepare(`SELECT MAX(updated_at) AS updated_at,
            COALESCE(SUM(LENGTH(CAST(sealed AS BLOB))), 0) AS sealed_bytes,
            COUNT(DISTINCT NULLIF(device_id, '')) AS devices FROM records WHERE space_handle = ?`)
            .get(handle) as { updated_at: string | null; sealed_bytes: number; devices: number };
          const devices = db
            .prepare(`SELECT device_id AS deviceId, COUNT(*) AS records,
            MAX(updated_at) AS clientUpdatedAt FROM records WHERE space_handle = ? AND device_id IS NOT NULL AND device_id != ''
            GROUP BY device_id ORDER BY MAX(server_rev) DESC LIMIT 100`)
            .all(handle) as { deviceId: string; records: number; clientUpdatedAt: string }[];
          return {
            space: present(row, defaultMaxBytes, now(), memberships && history),
            apiBilling: presentBilling(ledger.summary(handle, row.space_epoch ?? '')),
            membershipHistory: history
              ? db
                  .prepare(`SELECT e.action,e.event_at AS eventAt,e.started_at AS startedAt,
              e.expires_at AS expiresAt,e.max_bytes AS maxBytes FROM membership_events e
              JOIN spaces s ON s.space_handle=e.space_handle AND s.epoch=e.space_epoch
              WHERE e.space_handle=? ORDER BY e.rowid DESC LIMIT 20`)
                  .all(handle)
              : [],
            collections: collections.map((item) => ({
              collection: item.collection,
              records: item.records,
              tombstones: item.tombstones,
            })),
            devices: devices.map((item) => ({
              deviceId: item.deviceId,
              records: item.records,
              clientUpdatedAt: item.clientUpdatedAt,
            })),
            deviceCount: aggregate.devices,
            clientUpdatedAt: aggregate.updated_at,
            ciphertextJsonBytes: aggregate.sealed_bytes,
          };
        });
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type AdminStore = ReturnType<typeof createAdminStore>;
