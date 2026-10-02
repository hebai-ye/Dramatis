import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSpaceQuotaResolver } from '../sync-server/dist/tools/sync-server/src/storage-policy.js';

const accounting = existsSync(new URL('./dist/api-accounting.js', import.meta.url))
  ? await import('./dist/api-accounting.js')
  : {};
const plans = existsSync(new URL('./dist/vip-plans.js', import.meta.url)) ? await import('./dist/vip-plans.js') : {};
const start = Date.parse('2026-10-02T00:00:00.000Z');
const handle = 'accounting-space';
const epoch = 'accounting-epoch';
const usage = { promptTokens: 12, cacheHitTokens: 2, cacheMissTokens: 10, completionTokens: 3, totalTokens: 15 };

function fixture({ initialize = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-accounting-'));
  const path = join(dir, 'sync.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE spaces(space_handle TEXT PRIMARY KEY, credential_hash TEXT NOT NULL,
      recovery_credential_hash TEXT NOT NULL,key_wraps TEXT NOT NULL,created_at TEXT NOT NULL,epoch TEXT);
    CREATE TABLE records(id TEXT PRIMARY KEY,sealed TEXT);
    CREATE TABLE space_memberships(space_handle TEXT PRIMARY KEY,space_epoch TEXT NOT NULL,
      started_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,max_bytes INTEGER NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE membership_events(operation_id TEXT PRIMARY KEY,space_handle TEXT NOT NULL,space_epoch TEXT NOT NULL,
      action TEXT NOT NULL,event_at TEXT NOT NULL,started_at TEXT NOT NULL,expires_at TEXT NOT NULL,max_bytes INTEGER NOT NULL);
    INSERT INTO spaces VALUES('accounting-space','credential-hash','recovery-hash','forbidden-key-wraps','2026-10-01','accounting-epoch');
    INSERT INTO records VALUES('old-record','forbidden-sealed');
    INSERT INTO space_memberships VALUES('accounting-space','accounting-epoch','2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',NULL,268435456,1);`);
  let clock = start;
  if (initialize) {
    assert.equal(
      typeof accounting.initializeApiAccounting,
      'function',
      'purchase ledger initialization is implemented',
    );
    accounting.initializeApiAccounting(db);
  }
  const purchase = (
    operationId = 'purchase-one',
    planId = 'vip-month-256',
    eventAt = new Date(clock).toISOString(),
  ) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = accounting.recordPurchase(db, {
        operationId,
        spaceHandle: handle,
        spaceEpoch: epoch,
        plan: plans.getVipPlan(planId),
        eventAt,
      });
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const ledger = () => accounting.createApiLedger(db, () => clock);
  const reserve = (overrides = {}) =>
    ledger().reserve({
      requestId: 'request-one',
      spaceHandle: handle,
      spaceEpoch: epoch,
      reservedNanoyuan: '2000000000',
      priceVersion: 'price-v1',
      pricePeriod: 'peak',
      maxOutputTokens: 100,
      model: 'deepseek-flash',
      proof: { credentialHash: 'credential-hash', recoveryCredentialHash: 'recovery-hash' },
      ...overrides,
    });
  return {
    db,
    path,
    purchase,
    ledger,
    reserve,
    setClock(value) {
      clock = value;
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('四档购买消费额度和价格为服务端精确快照，两个年档分开', () => {
  assert.ok(Array.isArray(plans.VIP_PLANS), 'server-owned plan catalog exists');
  assert.deepEqual(
    plans.VIP_PLANS.map((p) => [p.id, p.durationDays, p.maxBytes, p.priceFen, p.creditNanoyuan]),
    [
      ['vip-month-256', 30, 268435456, 1000, '5000000000'],
      ['vip-quarter-512', 90, 536870912, 3000, '15000000000'],
      ['vip-year-1g', 365, 1073741824, 6800, '34000000000'],
      ['vip-year-5g', 365, 5368709120, 9800, '49000000000'],
    ],
  );
  assert.throws(() => plans.getVipPlan('unknown'));
  for (const [id, expected] of [
    ['vip-month-256', '5000000000'],
    ['vip-quarter-512', '15000000000'],
    ['vip-year-1g', '34000000000'],
    ['vip-year-5g', '49000000000'],
  ]) {
    const f = fixture();
    try {
      f.purchase('catalog-purchase', id);
      assert.equal(f.ledger().summary(handle, epoch).balanceNanoyuan, expected);
    } finally {
      f.close();
    }
  }
});

test('宿主幂等迁移旧会员为nullable套餐身份且不补历史购买或实体', () => {
  const f = fixture({ initialize: false });
  try {
    const old = f.db.prepare('SELECT * FROM records').all();
    createSpaceQuotaResolver(f.db);
    createSpaceQuotaResolver(f.db);
    const member = f.db.prepare('SELECT * FROM space_memberships').get();
    assert.equal(member.plan_id, null, 'legacy memberships must gain an explicit nullable plan identity');
    assert.equal(member.plan_version, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_purchases').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM api_balance_events').get().n, 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM records').all(), old);
    const resolver = createSpaceQuotaResolver(f.db, () => start);
    f.db.exec("INSERT INTO space_policies VALUES('accounting-space','accounting-epoch',0,1)");
    assert.equal(resolver(handle, { maxBytes: 96, maxRecords: 20 }, { bytes: 0, records: 0 }).maxBytes, 0);
  } finally {
    f.close();
  }
});

test('购买在调用者事务内原子发放，回滚无余额，同operation仅发一次且拒绝payload冲突', () => {
  const f = fixture();
  try {
    const input = {
      operationId: 'purchase-one',
      spaceHandle: handle,
      spaceEpoch: epoch,
      plan: plans.getVipPlan('vip-month-256'),
      eventAt: '2026-10-02T00:00:00.000Z',
    };
    f.db.exec('BEGIN IMMEDIATE');
    accounting.recordPurchase(f.db, input);
    f.db.exec('ROLLBACK');
    assert.equal(f.ledger().summary(handle, epoch).balanceNanoyuan, '0');
    const first = f.purchase();
    assert.equal(first.paidUntil, '2026-11-01T00:00:00.000Z');
    assert.equal(first.created, true);
    const repeat = f.purchase();
    assert.equal(repeat.created, false);
    assert.equal(repeat.revision, 1);
    assert.equal(f.ledger().summary(handle, epoch).balanceNanoyuan, '5000000000');
    assert.throws(() => f.purchase('purchase-one', 'vip-quarter-512'));
    assert.equal(f.purchase('purchase-two').paidUntil, '2026-12-01T00:00:00.000Z');
    assert.equal(f.ledger().summary(handle, epoch).grantedNanoyuan, '10000000000');
  } finally {
    f.close();
  }
});

test('购买拒绝假造目录快照、旧schema和旧epoch，不能留下部分credit', () => {
  const f = fixture();
  try {
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(() =>
      accounting.recordPurchase(f.db, {
        operationId: 'forged',
        spaceHandle: handle,
        spaceEpoch: epoch,
        plan: { ...plans.getVipPlan('vip-month-256'), creditNanoyuan: '9000000000000000' },
        eventAt: '2026-10-02T00:00:00.000Z',
      }),
    );
    f.db.exec('ROLLBACK');
    f.db.exec("UPDATE spaces SET epoch='new-epoch'");
    assert.throws(() => f.purchase());
    assert.equal(f.ledger().summary(handle, epoch).balanceNanoyuan, '0');
    f.db.exec('DROP TABLE api_accounts');
    assert.throws(() => f.purchase('missing-schema'));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_purchases').get().n, 0);
  } finally {
    f.close();
  }
});

test('同账户仅一个未决调用，跨连接预留不透支，同ID幂等且不能换owner或payload', () => {
  const f = fixture();
  let second;
  try {
    f.purchase();
    assert.equal(f.reserve().isNew, true);
    assert.equal(f.reserve().isNew, false);
    assert.throws(() => f.reserve({ reservedNanoyuan: '2000000001' }));
    assert.throws(() => f.reserve({ spaceEpoch: 'foreign-epoch' }));
    second = new DatabaseSync(f.path);
    assert.throws(() =>
      accounting
        .createApiLedger(second, () => start)
        .reserve({
          requestId: 'request-two',
          spaceHandle: handle,
          spaceEpoch: epoch,
          reservedNanoyuan: '4000000000',
          priceVersion: 'price-v1',
          pricePeriod: 'peak',
          maxOutputTokens: 100,
        }),
    );
    assert.equal(f.ledger().summary(handle, epoch).reservedNanoyuan, '2000000000');
    assert.equal(f.ledger().summary(handle, epoch).availableNanoyuan, '3000000000');
    f.ledger().releaseUnsent('request-one');
    assert.equal(f.reserve().isNew, false, 'released ID cannot be dispatched again');
    assert.equal(f.reserve({ requestId: 'request-two', reservedNanoyuan: '5000000000' }).isNew, true);
  } finally {
    second?.close();
    f.close();
  }
});

test('预留事务重查epoch、凭证快照、会员和独立付费资格，赠送延期不能恢复API', () => {
  const f = fixture();
  try {
    f.purchase();
    f.db.exec("UPDATE spaces SET credential_hash='rotated-hash'");
    assert.throws(() => f.reserve());
    f.db.exec("UPDATE spaces SET credential_hash='credential-hash'");
    f.setClock(Date.parse('2026-11-01T00:00:00.000Z'));
    f.db.exec("UPDATE space_memberships SET expires_at='2027-01-01T00:00:00.000Z'");
    assert.equal(f.ledger().summary(handle, epoch).status, 'paid-expired');
    assert.throws(() => f.reserve());
    assert.equal(f.ledger().summary(handle, epoch).balanceNanoyuan, '5000000000');
    f.purchase('new-purchase');
    assert.equal(f.reserve().isNew, true);
    f.ledger().releaseUnsent('request-one');
    f.db.exec("UPDATE space_memberships SET revoked_at='2026-11-01T00:00:00.000Z'");
    assert.throws(() => f.reserve({ requestId: 'revoked-call' }));
    f.db.exec("UPDATE spaces SET epoch='rebuilt-epoch'");
    assert.equal(f.ledger().summary(handle, 'rebuilt-epoch').balanceNanoyuan, '0');
    assert.throws(() => f.reserve({ requestId: 'stale-call' }));
  } finally {
    f.close();
  }
});

test('发送前持久化状态，可信usage结算追加唯一费用并释放余量，重复结算不双扣', () => {
  const f = fixture();
  try {
    f.purchase();
    f.reserve();
    assert.throws(() =>
      f.ledger().settle({
        requestId: 'request-one',
        chargedNanoyuan: '10123',
        usage,
        priceVersion: 'price-v1',
        pricePeriod: 'peak',
      }),
    );
    f.ledger().markSent('request-one');
    const result = f.ledger().settle({
      requestId: 'request-one',
      chargedNanoyuan: 10123n,
      usage,
      model: 'deepseek-flash',
      upstreamId: 'upstream-safe-id',
      priceVersion: 'price-v1',
      pricePeriod: 'peak',
    });
    assert.equal(result.state, 'settled');
    f.ledger().settle({
      requestId: 'request-one',
      chargedNanoyuan: '10123',
      usage,
      model: 'deepseek-flash',
      upstreamId: 'upstream-safe-id',
      priceVersion: 'price-v1',
      pricePeriod: 'peak',
    });
    assert.throws(() =>
      f.ledger().settle({
        requestId: 'request-one',
        chargedNanoyuan: '10124',
        usage,
        model: 'deepseek-flash',
        upstreamId: 'upstream-safe-id',
        priceVersion: 'price-v1',
        pricePeriod: 'peak',
      }),
    );
    const summary = f.ledger().summary(handle, epoch);
    assert.equal(summary.balanceNanoyuan, '4999989877');
    assert.equal(summary.spentNanoyuan, '10123');
    assert.equal(summary.reservedNanoyuan, '0');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM api_balance_events WHERE event_type='charge'").get().n, 1);
  } finally {
    f.close();
  }
});

test('缺usage和任何未知发送结果保留冻结，重启仅释放能证明未发送的预留', () => {
  const f = fixture();
  try {
    f.purchase();
    f.reserve();
    assert.deepEqual(f.ledger().recover(), { released: 1, pending: 0 });
    assert.equal(f.ledger().summary(handle, epoch).reservedNanoyuan, '0');
    f.reserve({ requestId: 'sent-call' });
    f.ledger().markSent('sent-call');
    assert.deepEqual(f.ledger().recover(), { released: 0, pending: 1 });
    const pending = f.ledger().summary(handle, epoch);
    assert.equal(pending.requests[0].state, 'pending');
    assert.equal(pending.reservedNanoyuan, '2000000000');
    assert.throws(() => f.ledger().releaseUnsent('sent-call'));
    assert.throws(() => f.reserve({ requestId: 'second-call' }));
    f.ledger().markPending('sent-call', 'missing-usage');
    assert.equal(f.ledger().summary(handle, epoch).spentNanoyuan, '0');
  } finally {
    f.close();
  }
});

test('价格待核对保留真实usage和上游ID，冻结不收费，后续可信结算仅扣一次', () => {
  const f = fixture();
  try {
    f.purchase();
    f.reserve();
    f.ledger().markSent('request-one');
    f.ledger().markPending('request-one', 'price-boundary', { usage, upstreamId: 'upstream-known-id' });
    let summary = f.ledger().summary(handle, epoch);
    assert.equal(summary.requests[0].state, 'pending');
    assert.deepEqual(summary.requests[0].usage, usage);
    assert.equal(summary.requests[0].upstreamId, 'upstream-known-id');
    assert.equal(summary.requests[0].pendingReason, 'price-boundary');
    assert.equal(summary.reservedNanoyuan, '2000000000');
    assert.equal(summary.spentNanoyuan, '0');
    f.ledger().markPending('request-one', 'upstream-disconnected');
    summary = f.ledger().summary(handle, epoch);
    assert.deepEqual(summary.requests[0].usage, usage, 'a later failure preserves the trusted usage already saved');
    assert.equal(summary.requests[0].upstreamId, 'upstream-known-id');
    const settlement = {
      requestId: 'request-one',
      chargedNanoyuan: '10123',
      usage,
      upstreamId: 'upstream-known-id',
      priceVersion: 'price-v1',
      pricePeriod: 'peak',
    };
    f.ledger().settle(settlement);
    f.ledger().settle(settlement);
    assert.equal(f.ledger().summary(handle, epoch).spentNanoyuan, '10123');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM api_balance_events WHERE event_type='charge'").get().n, 1);
  } finally {
    f.close();
  }
});

test('待核对元数据先校验，错误usage或不安全上游ID不得部分改变调用状态', () => {
  const f = fixture();
  try {
    f.purchase();
    f.reserve();
    f.ledger().markSent('request-one');
    const before = f.ledger().summary(handle, epoch).requests[0];
    assert.throws(() =>
      f.ledger().markPending('request-one', 'price-boundary', {
        usage: { ...usage, totalTokens: 14 },
        upstreamId: 'valid-id',
      }),
    );
    assert.deepEqual(f.ledger().summary(handle, epoch).requests[0], before);
    assert.throws(() =>
      f.ledger().markPending('request-one', 'price-boundary', {
        usage,
        upstreamId: 'forbidden-raw-body\n',
      }),
    );
    assert.deepEqual(f.ledger().summary(handle, epoch).requests[0], before);
    assert.equal(f.ledger().summary(handle, epoch).spentNanoyuan, '0');
    assert.equal(f.ledger().summary(handle, epoch).reservedNanoyuan, '2000000000');
  } finally {
    f.close();
  }
});

test('无效金额或不一致usage拒绝结算并保持原冻结，金额单条不越SQLite安全整数', () => {
  const f = fixture();
  try {
    f.purchase();
    for (const value of ['9000000000000001', '-1', '1.2', 1.2, '01'])
      assert.throws(() => f.reserve({ reservedNanoyuan: value }));
    f.reserve();
    f.ledger().markSent('request-one');
    for (const malformed of [
      { ...usage, cacheMissTokens: 9 },
      { ...usage, totalTokens: 14 },
      { ...usage, completionTokens: 101, totalTokens: 113 },
      { ...usage, reasoningTokens: 4 },
    ]) {
      assert.throws(() =>
        f.ledger().settle({
          requestId: 'request-one',
          chargedNanoyuan: '10123',
          usage: malformed,
          priceVersion: 'price-v1',
          pricePeriod: 'peak',
        }),
      );
    }
    assert.throws(() =>
      f.ledger().settle({
        requestId: 'request-one',
        chargedNanoyuan: '2000000001',
        usage,
        priceVersion: 'price-v1',
        pricePeriod: 'peak',
      }),
    );
    assert.equal(f.ledger().summary(handle, epoch).reservedNanoyuan, '2000000000');
    assert.equal(f.ledger().summary(handle, epoch).balanceNanoyuan, '5000000000');
  } finally {
    f.close();
  }
});

test('追加事件汇总用BigInt，累计金额超过number安全范围仍返回准确十进制string', () => {
  const f = fixture();
  try {
    f.purchase();
    const insert = f.db.prepare(`INSERT INTO api_balance_events(event_id,space_handle,space_epoch,event_type,
      source_operation_id,request_id,amount_nanoyuan,created_at) VALUES(?,?,?,'credit',?,NULL,?,?)`);
    for (let index = 0; index < 3; index++)
      insert.run(`large-${index}`, handle, epoch, `large-op-${index}`, 9000000000000000n, '2026-10-02');
    const summary = f.ledger().summary(handle, epoch);
    assert.equal(summary.balanceNanoyuan, '27000005000000000');
    assert.equal(summary.grantedNanoyuan, '27000005000000000');
    assert.doesNotThrow(() => JSON.stringify(summary));
  } finally {
    f.close();
  }
});

test('账本预留输出护栏与网关一致，不能超过16384 tokens', () => {
  const f = fixture();
  try {
    f.purchase();
    assert.throws(() => f.reserve({ maxOutputTokens: 16385 }));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM api_requests').get().n, 0);
  } finally {
    f.close();
  }
});

test('超过模型完整上下文的usage不能扣款，即使输入和输出单项未超限', () => {
  const f = fixture();
  try {
    f.purchase();
    f.reserve();
    f.ledger().markSent('request-one');
    assert.throws(() =>
      f.ledger().settle({
        requestId: 'request-one',
        chargedNanoyuan: '1',
        usage: {
          promptTokens: 1048576,
          cacheHitTokens: 0,
          cacheMissTokens: 1048576,
          completionTokens: 1,
          totalTokens: 1048577,
        },
        priceVersion: 'price-v1',
        pricePeriod: 'peak',
      }),
    );
    assert.equal(f.ledger().summary(handle, epoch).reservedNanoyuan, '2000000000');
    assert.equal(f.ledger().summary(handle, epoch).spentNanoyuan, '0');
  } finally {
    f.close();
  }
});

test('结算状态落盘失败同事务回滚费用事件，之后只能成功扣款一次', () => {
  const f = fixture();
  try {
    f.purchase();
    f.reserve();
    f.ledger().markSent('request-one');
    f.db.exec(
      "CREATE TRIGGER reject_settlement BEFORE UPDATE OF state ON api_requests WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'fixture settlement disk failure'); END",
    );
    const settlement = {
      requestId: 'request-one',
      chargedNanoyuan: '10123',
      usage,
      priceVersion: 'price-v1',
      pricePeriod: 'peak',
    };
    assert.throws(() => f.ledger().settle(settlement));
    assert.equal(f.ledger().summary(handle, epoch).spentNanoyuan, '0');
    assert.equal(f.ledger().summary(handle, epoch).reservedNanoyuan, '2000000000');
    f.db.exec('DROP TRIGGER reject_settlement');
    f.ledger().settle(settlement);
    assert.equal(f.ledger().summary(handle, epoch).spentNanoyuan, '10123');
  } finally {
    f.close();
  }
});

test('购买和余额历史追加后不可改写或删除', () => {
  const f = fixture();
  try {
    f.purchase();
    for (const statement of [
      'UPDATE api_balance_events SET amount_nanoyuan=0',
      'DELETE FROM api_balance_events',
      'UPDATE membership_purchases SET api_credit_nanoyuan=0',
      'DELETE FROM membership_purchases',
    ])
      assert.throws(() => f.db.exec(statement));
    assert.equal(f.ledger().summary(handle, epoch).balanceNanoyuan, '5000000000');
  } finally {
    f.close();
  }
});

test('只读summary不迁移或恢复，安全投影不泄露额外秘密列且仅当前epoch最近50条', () => {
  const f = fixture();
  let reader;
  try {
    f.purchase();
    f.reserve();
    f.ledger().markSent('request-one');
    f.db.exec(
      "ALTER TABLE api_requests ADD COLUMN secret_body TEXT DEFAULT 'forbidden-prompt-key'; ALTER TABLE membership_purchases ADD COLUMN secret_key TEXT DEFAULT 'forbidden-api-key'",
    );
    reader = new DatabaseSync(f.path, { readOnly: true });
    reader.exec('PRAGMA query_only=ON');
    const safe = accounting.createApiLedger(reader, () => start).summary(handle, epoch);
    const json = JSON.stringify(safe);
    for (const secret of ['forbidden-', 'credential-hash', 'recovery-hash', 'secret_body', 'secret_key'])
      assert.equal(json.includes(secret), false);
    assert.equal(safe.requests[0].state, 'sent');
    assert.equal(safe.purchases.length, 1);
    assert.equal(accounting.createApiLedger(reader, () => start).summary(handle, 'other-epoch').purchases.length, 0);
    assert.equal(f.db.prepare('SELECT state FROM api_requests').get().state, 'sent');
  } finally {
    reader?.close();
    f.close();
  }
  const old = fixture({ initialize: false });
  try {
    const result = accounting.createApiLedger(old.db, () => start).summary(handle, epoch);
    assert.equal(result.available, false);
    assert.equal(result.status, 'schema-unavailable');
    assert.equal(old.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='api_accounts'").get().n, 0);
  } finally {
    old.close();
  }
});

test('旧库没有epoch时空epoch只读查询返回schema未启用，已有账本仍拒绝空epoch', () => {
  const old = fixture({ initialize: false });
  try {
    old.db.exec('ALTER TABLE spaces DROP COLUMN epoch');
    const before = old.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    const result = accounting.createApiLedger(old.db, () => start).summary(handle, '');
    assert.equal(result.available, false);
    assert.equal(result.status, 'schema-unavailable');
    assert.equal(result.balanceNanoyuan, '0');
    assert.deepEqual(old.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), before);
  } finally {
    old.close();
  }
  const current = fixture();
  try {
    assert.throws(() => current.ledger().summary(handle, ''));
  } finally {
    current.close();
  }
});
