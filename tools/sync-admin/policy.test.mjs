import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSqliteSyncStore } from '../sync-server/dist/packages/core/src/index.js';
import { createSpaceQuotaResolver } from '../sync-server/dist/tools/sync-server/src/storage-policy.js';

test('单空间策略在写事务中生效，不能绕过零容量限制', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createSqliteSyncStore(db, { resolveQuota: (_handle, base) => ({ ...base, maxBytes: 0 }) });
  try {
    await store.createSpace({
      spaceHandle: 'fixture-policy',
      credentialHash: 'fixture-hash',
      recoveryCredentialHash: 'fixture-recovery',
      keyWraps: {},
      createdAt: '2026-01-01',
      epoch: 'fixture-epoch',
    });
    await assert.rejects(
      store.appendWithinQuota(
        'fixture-policy',
        [
          {
            collection: 'settings',
            id: 'fixture',
            updatedAt: '2026-01-01',
            deletedAt: null,
            sealed: { ciphertext: 'fixture' },
          },
        ],
        { maxRecords: 10, maxBytes: 10000 },
      ),
      (error) => error.kind === 'bytes' && error.limit === 0,
    );
    assert.equal((await store.spaceUsage('fixture-policy')).records, 0);
    assert.equal(await store.head('fixture-policy'), 0);
  } finally {
    db.close();
  }
});

test('空间配额允许高于默认值，并在降低后仅拒绝增长，重建后回到默认', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createSqliteSyncStore(db, { resolveQuota: (h, q, u) => resolver(h, q, u) });
  const resolver = createSpaceQuotaResolver(db);
  try {
    await store.createSpace({
      spaceHandle: 'fixture-policy',
      credentialHash: 'fixture',
      recoveryCredentialHash: 'fixture',
      keyWraps: {},
      createdAt: '2026-01-01',
      epoch: 'fixture-epoch',
    });
    const wire = (text) => [
      { collection: 'settings', id: 'fixture', updatedAt: '2026-01-01', deletedAt: null, sealed: { ciphertext: text } },
    ];
    db.prepare('INSERT INTO space_policies VALUES (?, ?, ?, ?)').run('fixture-policy', 'fixture-epoch', 1000, 1);
    await store.appendWithinQuota('fixture-policy', wire('x'.repeat(100)), { maxRecords: 1, maxBytes: 1 });
    db.exec('UPDATE space_policies SET max_bytes = 0');
    await assert.rejects(
      store.appendWithinQuota('fixture-policy', wire('x'.repeat(200)), { maxRecords: 1, maxBytes: 1000 }),
      (e) => e.kind === 'bytes',
    );
    await store.appendWithinQuota('fixture-policy', wire('x'), { maxRecords: 1, maxBytes: 1000 });
    db.exec('UPDATE space_policies SET max_bytes = NULL');
    await assert.rejects(
      store.appendWithinQuota('fixture-policy', wire('xxx'), { maxRecords: 1, maxBytes: 1 }),
      (e) => e.kind === 'bytes',
    );
    await store.appendWithinQuota('fixture-policy', wire(''), { maxRecords: 1, maxBytes: 1 });
    db.exec("UPDATE spaces SET epoch = 'fixture-recreated'");
    await store.appendWithinQuota('fixture-policy', wire('xx'), { maxRecords: 1, maxBytes: 1000 });
    assert.equal((await store.spaceUsage('fixture-policy')).records, 1);
  } finally {
    db.close();
  }
});

test('全局降额后，无自定义策略的旧空间仍可缩减，但不能增长', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createSqliteSyncStore(db, { resolveQuota: (h, q, u) => resolver(h, q, u) });
  const resolver = createSpaceQuotaResolver(db);
  try {
    await store.createSpace({
      spaceHandle: 'fixture-inherited',
      credentialHash: 'fixture',
      recoveryCredentialHash: 'fixture',
      keyWraps: {},
      createdAt: '2026-01-01',
      epoch: 'fixture-epoch',
    });
    const wire = (text) => [
      { collection: 'settings', id: 'fixture', updatedAt: '2026-01-01', deletedAt: null, sealed: { ciphertext: text } },
    ];
    await store.appendWithinQuota('fixture-inherited', wire('x'.repeat(200)), { maxRecords: 10, maxBytes: 1000 });
    await store.appendWithinQuota('fixture-inherited', wire('x'.repeat(150)), { maxRecords: 10, maxBytes: 100 });
    const before = await store.spaceUsage('fixture-inherited');
    const head = await store.head('fixture-inherited');
    assert.ok(before.bytes > 100);
    await assert.rejects(
      store.appendWithinQuota('fixture-inherited', wire('x'.repeat(151)), { maxRecords: 10, maxBytes: 100 }),
      (e) => e.kind === 'bytes',
    );
    assert.deepEqual(await store.spaceUsage('fixture-inherited'), before);
    assert.equal(await store.head('fixture-inherited'), head);
    await store.appendWithinQuota('fixture-inherited', wire('x'.repeat(150)), { maxRecords: 10, maxBytes: 100 });
    assert.deepEqual(await store.spaceUsage('fixture-inherited'), before);
  } finally {
    db.close();
  }
});

const VIP_START = '2030-01-01T00:00:00.000Z';
const VIP_END = '2030-02-01T00:00:00.000Z';
const vipWire = (length) => [
  {
    collection: 'settings',
    id: 'fixture',
    updatedAt: '2026-01-01',
    deletedAt: null,
    sealed: { ciphertext: 'x'.repeat(length) },
  },
];

async function vipFixture() {
  const db = new DatabaseSync(':memory:');
  let time = Date.parse(VIP_START);
  const store = createSqliteSyncStore(db, { resolveQuota: (h, q, u) => resolver(h, q, u) });
  const resolver = createSpaceQuotaResolver(db, () => time);
  // 模拟已经存在的会员数据，旧版 resolver 可正常读取库但尚不会使用这些权益。
  db.exec(`CREATE TABLE IF NOT EXISTS space_memberships (
    space_handle TEXT PRIMARY KEY, space_epoch TEXT NOT NULL,
    started_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
    max_bytes INTEGER NOT NULL, revision INTEGER NOT NULL
  )`);
  await store.createSpace({
    spaceHandle: 'fixture-vip',
    credentialHash: 'fixture-hash',
    recoveryCredentialHash: 'fixture-recovery',
    keyWraps: {},
    createdAt: '2026-01-01',
    epoch: 'fixture-epoch',
  });
  db.prepare(
    'INSERT INTO space_memberships(space_handle,space_epoch,started_at,expires_at,revoked_at,max_bytes,revision) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('fixture-vip', 'fixture-epoch', VIP_START, VIP_END, null, 1000, 1);
  return {
    db,
    store,
    setTime(value) {
      time = value;
    },
    append(length) {
      return store.appendWithinQuota('fixture-vip', vipWire(length), { maxRecords: 10, maxBytes: 100 });
    },
  };
}

test('同步宿主创建会员状态和权益变动表，重启初始化保留既有行', async () => {
  const db = new DatabaseSync(':memory:');
  createSqliteSyncStore(db);
  try {
    createSpaceQuotaResolver(db);
    assert.doesNotThrow(() => {
      db.prepare(
        'INSERT INTO space_memberships(space_handle,space_epoch,started_at,expires_at,revoked_at,max_bytes,revision) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('fixture-vip', 'fixture-epoch', VIP_START, VIP_END, null, 1000, 1);
      db.prepare('INSERT INTO membership_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'fixture-operation',
        'fixture-vip',
        'fixture-epoch',
        'grant',
        VIP_START,
        VIP_START,
        VIP_END,
        1000,
      );
    });
    createSpaceQuotaResolver(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM space_memberships').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM membership_events').get().n, 1);
  } finally {
    db.close();
  }
});

test('VIP 按服务器时钟生效，到期边界立即回默认并保留超额数据', async () => {
  const fixture = await vipFixture();
  try {
    fixture.setTime(Date.parse(VIP_START) - 1);
    await assert.rejects(fixture.append(200), (e) => e.kind === 'bytes' && e.limit === 100);
    assert.equal(await fixture.store.head('fixture-vip'), 0);
    fixture.setTime(Date.parse(VIP_START));
    await fixture.append(200);
    fixture.setTime(Date.parse(VIP_END) - 1);
    await fixture.append(201);
    const before = await fixture.store.spaceUsage('fixture-vip');
    const head = await fixture.store.head('fixture-vip');
    fixture.setTime(Date.parse(VIP_END));
    await assert.rejects(fixture.append(202), (e) => e.kind === 'bytes');
    assert.deepEqual(await fixture.store.spaceUsage('fixture-vip'), before);
    assert.equal(await fixture.store.head('fixture-vip'), head);
    await fixture.append(201);
    await fixture.append(150);
    assert.ok((await fixture.store.spaceUsage('fixture-vip')).bytes > 100);
    await assert.rejects(fixture.append(151), (e) => e.kind === 'bytes');
  } finally {
    fixture.db.close();
  }
});

test('撤销 VIP 后下次写入使用默认，超额空间仍可缩减', async () => {
  const fixture = await vipFixture();
  try {
    await fixture.append(200);
    fixture.db.prepare('UPDATE space_memberships SET revoked_at = ?').run(VIP_START);
    const before = await fixture.store.spaceUsage('fixture-vip');
    await assert.rejects(fixture.append(201), (e) => e.kind === 'bytes');
    assert.deepEqual(await fixture.store.spaceUsage('fixture-vip'), before);
    await fixture.append(150);
  } finally {
    fixture.db.close();
  }
});

test('人工固定配额包含零容量且始终优先于 VIP，清空策略恢复 VIP', async () => {
  const fixture = await vipFixture();
  try {
    const policy = fixture.db.prepare('INSERT OR REPLACE INTO space_policies VALUES (?, ?, ?, ?)');
    for (const cap of [0, 100]) {
      policy.run('fixture-vip', 'fixture-epoch', cap, 1);
      await assert.rejects(fixture.append(200), (e) => e.kind === 'bytes' && e.limit === cap);
    }
    policy.run('fixture-vip', 'fixture-epoch', 2000, 2);
    await fixture.append(1200);
    await fixture.append(0);
    policy.run('fixture-vip', 'fixture-epoch', null, 3);
    await fixture.append(200);
  } finally {
    fixture.db.close();
  }
});

test('空间重建后旧世代 VIP 和人工配额失效', async () => {
  const fixture = await vipFixture();
  try {
    await fixture.append(200);
    fixture.db.prepare('INSERT INTO space_policies VALUES (?, ?, ?, ?)').run('fixture-vip', 'fixture-epoch', 2000, 1);
    fixture.db.exec("UPDATE spaces SET epoch = 'fixture-new-epoch'");
    const before = await fixture.store.spaceUsage('fixture-vip');
    await assert.rejects(fixture.append(201), (e) => e.kind === 'bytes');
    assert.deepEqual(await fixture.store.spaceUsage('fixture-vip'), before);
    await fixture.append(150);
  } finally {
    fixture.db.close();
  }
});

test('无效有效期不授予 VIP，非法有效 VIP 容量拒绝写入', async () => {
  const fixture = await vipFixture();
  try {
    fixture.db.exec("UPDATE space_memberships SET expires_at = 'invalid-date'");
    await assert.rejects(fixture.append(200), (e) => e.kind === 'bytes' && e.limit === 100);
    fixture.db.prepare('UPDATE space_memberships SET expires_at = ?').run(VIP_END);
    const capacity = fixture.db.prepare('UPDATE space_memberships SET max_bytes = ?');
    for (const cap of [0, -1, 1.5, 1024 ** 4 + 1]) {
      capacity.run(cap);
      await assert.rejects(fixture.append(1), /空间配额策略无效/);
      assert.equal(await fixture.store.head('fixture-vip'), 0);
    }
  } finally {
    fixture.db.close();
  }
});
