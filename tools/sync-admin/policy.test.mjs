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
