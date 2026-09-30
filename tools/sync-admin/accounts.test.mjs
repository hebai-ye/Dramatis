import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { deriveSpaceHandle, hashCredential } from '../sync-server/dist/packages/core/src/index.js';
import { createAccountProfileHandler } from '../sync-server/dist/tools/sync-server/src/accounts.js';

async function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE spaces (space_handle TEXT PRIMARY KEY, credential_hash TEXT, recovery_credential_hash TEXT, epoch TEXT)',
  );
  const handle = await deriveSpaceHandle('fixture-account');
  db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)').run(
    handle,
    await hashCredential('fixture-password-proof'),
    await hashCredential('fixture-recovery-proof'),
    'fixture-epoch',
  );
  return { db, handle, handler: createAccountProfileHandler(db) };
}

function claim(f, patch = {}, proof = 'fixture-password-proof', headers = {}) {
  return f.handler(
    new Request('http://localhost/accounts/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${proof}`, ...headers },
      body: JSON.stringify({
        spaceHandle: f.handle,
        accountId: 'fixture-account',
        displayName: '测试账户',
        confirmed: true,
        ...patch,
      }),
    }),
    { clientKey: 'fixture-source' },
  );
}

test('认领要求明确同意和有效所有权，拒绝账户ID伪造', async () => {
  const f = await fixture();
  try {
    assert.equal((await claim(f, { confirmed: false })).status, 400);
    assert.equal((await claim(f, {}, 'wrong-proof')).status, 401);
    assert.equal((await claim(f, { accountId: 'another-fixture-account' })).status, 409);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_profiles').get().n, 0);
  } finally {
    f.db.close();
  }
});

test('密码与恢复凭证均可认领，重复认领不能覆盖服务端显示名', async () => {
  const f = await fixture();
  try {
    const first = await claim(f, {}, 'fixture-recovery-proof');
    assert.equal(first.status, 201);
    assert.equal((await first.json()).profile.displayName, '测试账户');
    const repeat = await claim(f, { displayName: '不同设备的名字' });
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).profile.displayName, '测试账户');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_profiles').get().n, 1);
  } finally {
    f.db.close();
  }
});

test('认领仅存最小资料，拒绝多余敏感字段和跨源请求', async () => {
  const f = await fixture();
  try {
    assert.equal((await claim(f, { password: 'must-never-store' })).status, 400);
    assert.equal((await claim(f, {}, 'fixture-password-proof', { origin: 'https://unexpected.invalid' })).status, 403);
    assert.equal((await claim(f, { displayName: 'x'.repeat(81) })).status, 400);
    assert.equal((await claim(f)).status, 201);
    const row = f.db.prepare('SELECT * FROM account_profiles').get();
    assert.deepEqual(Object.keys(row).sort(), [
      'account_id',
      'claimed_at',
      'display_name',
      'space_epoch',
      'space_handle',
    ]);
  } finally {
    f.db.close();
  }
});

test('认领失败尝试也限流，超限不再验证凭证', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await claim(f, {}, 'wrong-proof')).status, 401);
    assert.equal((await claim(f)).status, 429);
  } finally {
    f.db.close();
  }
});

test('同源浏览器经过TLS反代且Host被改写时仍能认领，跨站请求拒绝', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await claim(f, {}, 'fixture-password-proof', {
          origin: 'https://public-fixture.invalid:8443',
          'sec-fetch-site': 'same-origin',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await claim(f, {}, 'fixture-password-proof', {
          origin: 'https://public-fixture.invalid:8443',
          'sec-fetch-site': 'cross-site',
        })
      ).status,
      403,
    );
  } finally {
    f.db.close();
  }
});
