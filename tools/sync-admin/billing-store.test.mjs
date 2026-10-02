import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SYNC_SCHEMA_SQL } from '../sync-server/dist/packages/core/src/index.js';
import { createAdminStore } from './dist/store.js';

const accounting = existsSync(new URL('./dist/api-accounting.js', import.meta.url))
  ? await import('./dist/api-accounting.js')
  : {};
const plans = existsSync(new URL('./dist/vip-plans.js', import.meta.url)) ? await import('./dist/vip-plans.js') : {};
const start = Date.parse('2026-10-02T00:00:00.000Z');
const usage = { promptTokens: 12, cacheHitTokens: 2, cacheMissTokens: 10, completionTokens: 3, totalTokens: 15 };

function fixture({ billing = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-billing-store-'));
  const path = join(dir, 'fixture.db');
  const db = new DatabaseSync(path);
  db.exec(SYNC_SCHEMA_SQL);
  db.prepare('INSERT INTO spaces VALUES (?,?,?,?,?,?)').run(
    'fixture-billing',
    'forbidden-credential',
    'forbidden-recovery',
    'forbidden-wraps',
    '2026-10-01',
    'fixture-epoch',
  );
  db.prepare('INSERT INTO heads VALUES (?,?,?,?)').run('fixture-billing', 0, 0, 0);
  let clock = start;
  if (billing) {
    db.exec(`CREATE TABLE space_memberships(space_handle TEXT PRIMARY KEY,space_epoch TEXT NOT NULL,
      started_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,max_bytes INTEGER NOT NULL,revision INTEGER NOT NULL,
      plan_id TEXT,plan_version INTEGER);
      CREATE TABLE membership_events(operation_id TEXT PRIMARY KEY,space_handle TEXT NOT NULL,space_epoch TEXT NOT NULL,
      action TEXT NOT NULL,event_at TEXT NOT NULL,started_at TEXT NOT NULL,expires_at TEXT NOT NULL,max_bytes INTEGER NOT NULL);
      INSERT INTO space_memberships VALUES('fixture-billing','fixture-epoch','2026-10-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z',NULL,268435456,1,'vip-month-256',1);`);
    assert.equal(typeof accounting.initializeApiAccounting, 'function');
    accounting.initializeApiAccounting(db);
  }
  const now = () => clock;
  const ledger = () => accounting.createApiLedger(db, now);
  const purchase = (operationId = 'purchase-one') => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = accounting.recordPurchase(db, {
        operationId,
        spaceHandle: 'fixture-billing',
        spaceEpoch: 'fixture-epoch',
        plan: plans.getVipPlan('vip-month-256'),
        eventAt: new Date(clock).toISOString(),
      });
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const reserve = (requestId = 'request-one') =>
    ledger().reserve({
      requestId,
      spaceHandle: 'fixture-billing',
      spaceEpoch: 'fixture-epoch',
      reservedNanoyuan: '2000000000',
      priceVersion: 'price-v1',
      pricePeriod: 'peak',
      maxOutputTokens: 100,
      model: 'deepseek-flash',
      proof: { credentialHash: 'forbidden-credential', recoveryCredentialHash: 'forbidden-recovery' },
    });
  return {
    db,
    path,
    ledger,
    purchase,
    reserve,
    store: () => createAdminStore(path, 96 * 1024 ** 2, now),
    setClock(value) {
      clock = value;
    },
    close(store) {
      store?.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('旧库只读详情明确账本尚未启用，不建运营表或输出凭证', () => {
  const f = fixture();
  let store;
  try {
    const before = readFileSync(f.path);
    store = createAdminStore(f.path);
    const billing = store.detail('fixture-billing').apiBilling;
    assert.equal(billing?.available, false);
    assert.equal(billing.status, 'schema-unavailable');
    assert.equal(billing.serviceStatus, '托管网关尚未对最终用户开放');
    assert.deepEqual(billing.purchases, []);
    assert.deepEqual(billing.requests, []);
    assert.deepEqual(readFileSync(f.path), before);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='api_accounts'").get().n, 0);
    assert.equal(JSON.stringify(store.detail('fixture-billing')).includes('forbidden-'), false);
  } finally {
    f.close(store);
  }
});

test('只读托管详情安全投影购买和真实usage，余额精确到纳元，未决调用保持预留', () => {
  const f = fixture({ billing: true });
  let store;
  try {
    f.purchase();
    f.reserve();
    f.ledger().markSent('request-one');
    f.ledger().settle({
      requestId: 'request-one',
      chargedNanoyuan: '10123',
      usage,
      model: 'deepseek-flash',
      priceVersion: 'price-v1',
      pricePeriod: 'peak',
      upstreamId: 'safe-upstream-id',
    });
    f.reserve('request-pending');
    f.ledger().markSent('request-pending');
    f.ledger().markPending('request-pending', 'missing-usage');
    for (const table of ['membership_purchases', 'api_balance_events', 'api_accounts', 'api_requests'])
      f.db.exec(`ALTER TABLE ${table} ADD COLUMN forbidden_secret TEXT DEFAULT 'forbidden-api-key-or-body'`);
    const before = readFileSync(f.path);
    store = f.store();
    const detail = store.detail('fixture-billing');
    assert.equal(detail.space.membership.planId, 'vip-month-256');
    const billing = detail.apiBilling;
    assert.equal(billing.available, true);
    assert.equal(billing.balanceNanoyuan, '4999989877');
    assert.equal(billing.reservedNanoyuan, '2000000000');
    assert.equal(billing.availableNanoyuan, '2999989877');
    assert.equal(billing.grantedNanoyuan, '5000000000');
    assert.equal(billing.spentNanoyuan, '10123');
    assert.equal(billing.serviceStatus, '托管网关尚未对最终用户开放');
    assert.equal(billing.purchases[0].creditNanoyuan, '5000000000');
    const settled = billing.requests.find((request) => request.requestId === 'request-one');
    assert.deepEqual(settled.usage, usage);
    assert.equal(settled.chargedNanoyuan, '10123');
    assert.equal(settled.upstreamId, 'safe-upstream-id');
    assert.equal(billing.requests.find((request) => request.requestId === 'request-pending').state, 'pending');
    for (const forbidden of ['forbidden-', 'space_epoch', 'spaceEpoch', 'credentialHash', 'sealed', 'key_wraps'])
      assert.equal(JSON.stringify(detail).includes(forbidden), false, forbidden);
    assert.deepEqual(readFileSync(f.path), before);
  } finally {
    f.close(store);
  }
});

test('到期及撤销后账目保留，赠送不恢复付费资格，重建epoch不继承旧账目', () => {
  const f = fixture({ billing: true });
  let store;
  try {
    f.purchase();
    store = f.store();
    f.setClock(Date.parse('2026-11-01T00:00:00.000Z'));
    let billing = store.detail('fixture-billing').apiBilling;
    assert.equal(billing.paidActive, false);
    assert.equal(billing.vipActive, false);
    assert.equal(billing.balanceNanoyuan, '5000000000');
    f.db.exec("UPDATE space_memberships SET expires_at='2027-01-01T00:00:00.000Z'");
    billing = store.detail('fixture-billing').apiBilling;
    assert.equal(billing.vipActive, true);
    assert.equal(billing.paidActive, false);
    assert.equal(billing.status, 'paid-expired');
    assert.equal(billing.purchases.length, 1);
    f.setClock(start);
    f.db.exec("UPDATE space_memberships SET revoked_at='2026-10-02T00:00:00.000Z'");
    billing = store.detail('fixture-billing').apiBilling;
    assert.equal(billing.vipActive, false);
    assert.equal(billing.balanceNanoyuan, '5000000000');
    f.db.exec("UPDATE spaces SET epoch='rebuilt-epoch'");
    billing = store.detail('fixture-billing').apiBilling;
    assert.equal(billing.balanceNanoyuan, '0');
    assert.equal(billing.paidUntil, null);
    assert.deepEqual(billing.purchases, []);
    assert.deepEqual(billing.requests, []);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_purchases').get().n, 1);
  } finally {
    f.close(store);
  }
});

test('详情仅显示当前epoch最近50笔购买和调用，汇总余额仍包含完整账本', () => {
  const f = fixture({ billing: true });
  let store;
  try {
    for (let i = 0; i < 55; i++) {
      f.setClock(start + i * 1000);
      f.purchase(`purchase-${i}`);
      f.reserve(`request-${i}`);
      f.ledger().releaseUnsent(`request-${i}`);
    }
    store = f.store();
    const billing = store.detail('fixture-billing').apiBilling;
    assert.equal(billing.balanceNanoyuan, '275000000000');
    assert.equal(billing.purchases.length, 50);
    assert.equal(billing.requests.length, 50);
    assert.equal(billing.purchases[0].operationId, 'purchase-54');
    assert.equal(billing.requests[0].requestId, 'request-54');
    assert.equal(
      billing.purchases.some((purchase) => purchase.operationId === 'purchase-0'),
      false,
    );
  } finally {
    f.close(store);
  }
});
