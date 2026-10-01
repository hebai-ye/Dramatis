import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SYNC_SCHEMA_SQL } from '../sync-server/dist/packages/core/src/index.js';
import { createAdminOperations } from './dist/operations.js';
import { createAdminStore } from './dist/store.js';

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-vip-test-'));
  const dataPath = join(dir, 'fixture.db');
  const backupPath = join(dir, 'backups');
  mkdirSync(backupPath);
  const db = new DatabaseSync(dataPath);
  db.exec(SYNC_SCHEMA_SQL);
  db.exec(
    "INSERT INTO spaces VALUES ('fixture-vip','forbidden-hash','forbidden-recovery','forbidden-wraps','2026-01-01','fixture-epoch'); INSERT INTO heads VALUES ('fixture-vip',0,0,0); CREATE TABLE account_profiles(space_handle TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,claimed_at TEXT,space_epoch TEXT); INSERT INTO account_profiles VALUES ('fixture-vip','fixture-account','fixture-name','2026-01-01','fixture-epoch'); CREATE TABLE space_policies(space_handle TEXT PRIMARY KEY,space_epoch TEXT NOT NULL,max_bytes INTEGER,revision INTEGER NOT NULL); CREATE TABLE space_memberships(space_handle TEXT PRIMARY KEY,space_epoch TEXT NOT NULL,started_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,max_bytes INTEGER NOT NULL,revision INTEGER NOT NULL); CREATE TABLE membership_events(operation_id TEXT PRIMARY KEY,space_handle TEXT NOT NULL,space_epoch TEXT NOT NULL,action TEXT NOT NULL,event_at TEXT NOT NULL,started_at TEXT NOT NULL,expires_at TEXT NOT NULL,max_bytes INTEGER NOT NULL);",
  );
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  const events = [];
  const now = () => clock;
  const ops = createAdminOperations({
    dataPath,
    backupPath,
    defaultMaxBytes: 96 * 1024 ** 2,
    now,
    audit: (event) => events.push(event),
    ...options,
  });
  const store = createAdminStore(dataPath, 96 * 1024 ** 2, now);
  const prepare = (membership = { action: 'grant', durationDays: 30, maxBytes: 1024 ** 3 }) =>
    ops.prepare({ spaceHandle: 'fixture-vip', membership });
  const commit = (preview, handle = 'fixture-vip') =>
    ops.commit({ confirmationId: preview.confirmationId, confirmSpaceHandle: handle });
  return {
    db,
    store,
    ops,
    dir,
    dataPath,
    backupPath,
    events,
    prepare,
    commit,
    setClock(value) {
      clock = value;
    },
    close() {
      store.close();
      ops.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('VIP开通先预览确认及备份，原凭证不变并保存权益记录', () => {
  const f = fixture();
  try {
    const sensitive = f.db.prepare('SELECT * FROM spaces').get();
    f.db
      .prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)')
      .run('fixture-vip', 'messages', 'fixture-entity', 1, '2026-01-01', null, 'fixture-device', 'forbidden-sealed');
    const records = f.db.prepare('SELECT * FROM records').all();
    const preview = f.prepare();
    assert.equal(preview.before.membership, null);
    assert.equal(preview.after.membership.status, 'active');
    assert.equal(preview.after.quotaSource, 'vip');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM space_memberships').get().n, 0);
    assert.throws(() => f.commit(preview, 'wrong-handle'));
    assert.equal(readdirSync(f.backupPath).length, 0);
    const result = f.commit(f.prepare());
    const backup = new DatabaseSync(join(f.backupPath, result.backupFile), { readOnly: true });
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM space_memberships').get().n, 0);
    backup.close();
    assert.deepEqual(f.db.prepare('SELECT * FROM spaces').get(), sensitive);
    assert.deepEqual(f.db.prepare('SELECT * FROM records').all(), records);
    assert.equal(f.store.detail('fixture-vip').space.quotaLimitBytes, 1024 ** 3);
    assert.equal(f.store.detail('fixture-vip').membershipHistory[0].action, 'grant');
    assert.equal(f.store.overview().vipActive, 1);
    assert.equal(JSON.stringify(f.events).includes('fixture-account'), false);
  } finally {
    f.close();
  }
});

test('VIP续期从未过期结束日延长，到期/撤销实时恢复默认且保留会员记录', () => {
  const f = fixture();
  try {
    f.commit(f.prepare());
    const renewal = f.prepare({ action: 'renew', durationDays: 10, maxBytes: 512 * 1024 ** 2 });
    assert.equal(renewal.after.membership.expiresAt, '2026-11-10T00:00:00.000Z');
    f.commit(renewal);
    f.setClock(Date.parse('2026-11-10T00:00:00.000Z'));
    assert.equal(f.store.detail('fixture-vip').space.membership.status, 'expired');
    assert.equal(f.store.detail('fixture-vip').space.quotaLimitBytes, 96 * 1024 ** 2);
    assert.equal(f.store.overview().vipExpired, 1);
    const revived = f.prepare({ action: 'renew', durationDays: 2, maxBytes: 1024 ** 3 });
    assert.equal(revived.after.membership.expiresAt, '2026-11-12T00:00:00.000Z');
    f.commit(revived);
    f.commit(f.prepare({ action: 'revoke' }));
    const detail = f.store.detail('fixture-vip');
    assert.equal(detail.space.membership.status, 'revoked');
    assert.equal(detail.space.quotaLimitBytes, 96 * 1024 ** 2);
    assert.deepEqual(
      detail.membershipHistory.map((e) => e.action),
      ['revoke', 'renew', 'renew', 'grant'],
    );
    assert.equal(f.store.overview().vipRevoked, 1);
    assert.throws(() => f.prepare({ action: 'renew', durationDays: 1, maxBytes: 1024 ** 3 }));
  } finally {
    f.close();
  }
});

test('固定配额包括零容量优先于VIP，过期仍保留固定配额', () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO space_policies VALUES (?,?,?,?)').run('fixture-vip', 'fixture-epoch', 0, 3);
    const before = f.db.prepare('SELECT * FROM space_policies').get();
    const preview = f.prepare();
    assert.equal(preview.after.quotaSource, 'manual');
    assert.equal(preview.after.quotaLimitBytes, 0);
    f.commit(preview);
    f.setClock(Date.parse('2027-01-01T00:00:00Z'));
    assert.equal(f.store.detail('fixture-vip').space.quotaLimitBytes, 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM space_policies').get(), before);
  } finally {
    f.close();
  }
});

test('VIP拒绝未关联账户、混合修改、非法参数、过期票据和并发续期', () => {
  const f = fixture();
  try {
    for (const membership of [
      null,
      [],
      { action: ['grant'], durationDays: 1, maxBytes: 1 },
      { action: 'grant', durationDays: 0, maxBytes: 1 },
      { action: 'grant', durationDays: 1, maxBytes: 0 },
      { action: 'grant', durationDays: 1.2, maxBytes: 1 },
      { action: 'grant', durationDays: 1, maxBytes: 1024 ** 4 + 1 },
      { action: 'grant', durationDays: 1, maxBytes: 1, password: 'secret' },
      { action: 'revoke', durationDays: 1 },
    ])
      assert.throws(() => f.prepare(membership));
    assert.throws(() =>
      f.ops.prepare({
        spaceHandle: 'fixture-vip',
        displayName: 'mixed',
        membership: { action: 'grant', durationDays: 1, maxBytes: 1 },
      }),
    );
    const expired = f.prepare();
    f.setClock(Date.parse('2026-10-01T00:02:01Z'));
    assert.throws(() => f.commit(expired));
    const first = f.prepare();
    const second = f.prepare();
    f.commit(second);
    assert.throws(() => f.commit(first));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_events').get().n, 1);
    f.db.exec("UPDATE spaces SET epoch='fixture-new'");
    assert.equal(f.store.detail('fixture-vip').space.membership, null);
    assert.equal(f.store.detail('fixture-vip').membershipHistory.length, 0);
    assert.throws(() => f.prepare());
  } finally {
    f.close();
  }
});

test('VIP备份/意图审计失败不写，提交后审计失败返回已保存警告', () => {
  const f = fixture({
    audit: () => {
      throw new Error('fixture audit failure');
    },
  });
  try {
    assert.throws(
      () => f.commit(f.prepare()),
      (e) => e.code === 'audit-failed',
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM space_memberships').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_events').get().n, 0);
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    rmSync(g.backupPath, { recursive: true, force: true });
    assert.throws(
      () => g.commit(g.prepare()),
      (e) => e.code === 'backup-failed',
    );
    assert.equal(g.db.prepare('SELECT COUNT(*) AS n FROM space_memberships').get().n, 0);
  } finally {
    g.close();
  }
  const h = fixture({
    audit: (e) => {
      if (e.action.endsWith('-applied')) throw new Error('fixture result failure');
    },
  });
  try {
    const result = h.commit(h.prepare());
    assert.equal(result.applied, true);
    assert.ok(result.auditWarning);
    assert.equal(h.store.detail('fixture-vip').space.membership.status, 'active');
  } finally {
    h.close();
  }
});
