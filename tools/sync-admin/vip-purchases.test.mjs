import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SYNC_SCHEMA_SQL } from '../sync-server/dist/packages/core/src/index.js';
import { createSpaceQuotaResolver } from '../sync-server/dist/tools/sync-server/src/storage-policy.js';
import { createAdminOperations } from './dist/operations.js';

function fixture(options = {}) {
  const { legacy = false, ...operationOptions } = options;
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-purchase-fixture-'));
  const dataPath = join(dir, 'fixture.db');
  const backupPath = join(dir, 'backups');
  mkdirSync(backupPath);
  const db = new DatabaseSync(dataPath);
  db.exec(SYNC_SCHEMA_SQL);
  db.exec(
    "INSERT INTO spaces VALUES ('fixture-paid','forbidden-credential','forbidden-recovery','forbidden-wrap','2026-01-01','epoch-paid'); CREATE TABLE account_profiles(space_handle TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,claimed_at TEXT,space_epoch TEXT); INSERT INTO account_profiles VALUES ('fixture-paid','fixture-account','fixture-name','2026-01-01','epoch-paid');",
  );
  createSpaceQuotaResolver(db);
  if (legacy)
    db.exec(
      'DROP TABLE IF EXISTS api_requests; DROP TABLE IF EXISTS api_balance_events; DROP TABLE IF EXISTS membership_purchases; DROP TABLE IF EXISTS api_accounts;',
    );
  let clock = Date.parse('2026-10-02T00:00:00Z');
  const events = [];
  const ops = createAdminOperations({
    dataPath,
    backupPath,
    defaultMaxBytes: 96 * 1024 ** 2,
    now: () => clock,
    audit: (e) => events.push(e),
    ...operationOptions,
  });
  return {
    db,
    dir,
    ops,
    events,
    backupPath,
    prepare: (planId = 'vip-month-256') =>
      ops.prepare({ spaceHandle: 'fixture-paid', membership: { action: 'purchase', planId } }),
    commit: (p) => ops.commit({ confirmationId: p.confirmationId, confirmSpaceHandle: 'fixture-paid' }),
    gift: (days = 1, maxBytes = 256 * 1024 ** 2) =>
      ops.prepare({ spaceHandle: 'fixture-paid', membership: { action: 'renew', durationDays: days, maxBytes } }),
    setClock: (value) => {
      clock = Date.parse(value);
    },
    close: () => {
      ops.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('四档套餐预览及确认准确记录标价50%额度，重复票据不双发', () => {
  for (const [id, days, maxBytes, priceFen, credit] of [
    ['vip-month-256', 30, 256 * 1024 ** 2, 1000, '5000000000'],
    ['vip-quarter-512', 90, 512 * 1024 ** 2, 3000, '15000000000'],
    ['vip-year-1g', 365, 1024 ** 3, 6800, '34000000000'],
    ['vip-year-5g', 365, 5 * 1024 ** 3, 9800, '49000000000'],
  ]) {
    const f = fixture();
    try {
      const p = f.prepare(id);
      assert.equal(p.purchase.planId, id);
      assert.equal(p.purchase.durationDays, days);
      assert.equal(p.purchase.priceFen, priceFen);
      assert.equal(p.purchase.creditNanoyuan, credit);
      assert.equal(p.after.membership.maxBytes, maxBytes);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_purchases').get().n, 0);
      f.commit(p);
      assert.throws(() => f.commit(p));
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_purchases').get().n, 1);
      assert.equal(f.db.prepare('SELECT SUM(amount_nanoyuan) AS n FROM api_balance_events').get().n.toString(), credit);
      assert.equal(f.db.prepare('SELECT plan_id FROM space_memberships').get().plan_id, id);
      assert.equal(readdirSync(f.backupPath).length, 1);
      assert.equal(JSON.stringify(f.events).includes('fixture-account'), false);
    } finally {
      f.close();
    }
  }
});

test('同档续费原子延长并发放，跨档拒绝，赠送无发放且不恢复付费资格', () => {
  const f = fixture();
  try {
    f.commit(f.prepare());
    const p = f.prepare();
    assert.equal(p.after.membership.expiresAt, '2026-12-01T00:00:00.000Z');
    assert.equal(p.purchase.paidUntil, '2026-12-01T00:00:00.000Z');
    f.commit(p);
    assert.throws(
      () => f.prepare('vip-year-5g'),
      (e) => e.code === 'plan-switch-denied',
    );
    f.setClock('2026-12-01T00:00:00Z');
    const account = f.db.prepare('SELECT * FROM api_accounts').get();
    f.commit(f.gift(7));
    assert.deepEqual(f.db.prepare('SELECT * FROM api_accounts').get(), account);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_purchases').get().n, 2);
    f.commit(f.gift(1, 512 * 1024 ** 2));
    assert.equal(f.db.prepare('SELECT plan_id FROM space_memberships').get().plan_id, null);
    assert.throws(
      () => f.prepare(),
      (e) => e.code === 'plan-switch-denied',
    );
  } finally {
    f.close();
  }
});

test('购买拒绝客户端报价和过时付费资格预览', () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.ops.prepare({
        spaceHandle: 'fixture-paid',
        membership: { action: 'purchase', planId: 'vip-month-256', priceFen: 1 },
      }),
    );
    assert.throws(() => f.prepare('unknown-plan'));
    f.commit(f.prepare());
    const p = f.prepare();
    f.db.exec('UPDATE api_accounts SET revision=revision+1');
    assert.throws(
      () => f.commit(p),
      (e) => e.code === 'stale-preview',
    );
    const q = f.prepare();
    f.db.exec("UPDATE spaces SET epoch='new-epoch'");
    assert.throws(
      () => f.commit(q),
      (e) => e.code === 'stale-preview',
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_purchases').get().n, 1);
  } finally {
    f.close();
  }
});

test('旧schema拒绝套餐购买，未认领拒绝购买，固定零配额继续优先', () => {
  const legacy = fixture({ legacy: true });
  try {
    assert.throws(
      () => legacy.prepare(),
      (e) => e.code === 'billing-unavailable',
    );
  } finally {
    legacy.close();
  }
  const f = fixture();
  try {
    f.db.exec('DELETE FROM account_profiles');
    assert.throws(
      () => f.prepare(),
      (e) => e.code === 'unclaimed',
    );
    f.db.exec(
      "INSERT INTO account_profiles VALUES ('fixture-paid','fixture-account','fixture-name','2026-01-01','epoch-paid'); INSERT INTO space_policies VALUES ('fixture-paid','epoch-paid',0,1)",
    );
    const p = f.prepare();
    assert.equal(p.after.quotaSource, 'manual');
    assert.equal(p.after.quotaLimitBytes, 0);
    f.commit(p);
    assert.equal(f.db.prepare('SELECT max_bytes FROM space_policies').get().max_bytes, 0);
  } finally {
    f.close();
  }
});

test('购买意图审计失败及事务失败不能只保存VIP而丢失额度', () => {
  const f = fixture({
    audit: () => {
      throw new Error('fixture audit unavailable');
    },
  });
  try {
    assert.throws(
      () => f.commit(f.prepare()),
      (e) => e.code === 'audit-failed',
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM space_memberships').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM api_balance_events').get().n, 0);
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    g.db.exec(
      "CREATE TRIGGER fixture_failure BEFORE INSERT ON api_balance_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    assert.throws(
      () => g.commit(g.prepare()),
      (e) => e.code === 'change-failed',
    );
    assert.equal(g.db.prepare('SELECT COUNT(*) AS n FROM space_memberships').get().n, 0);
    assert.equal(g.db.prepare('SELECT COUNT(*) AS n FROM membership_purchases').get().n, 0);
    assert.equal(g.db.prepare('SELECT COUNT(*) AS n FROM api_accounts').get().n, 0);
  } finally {
    g.close();
  }
});
