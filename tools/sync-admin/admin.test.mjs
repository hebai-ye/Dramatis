import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { deriveSpaceHandle, SYNC_SCHEMA_SQL } from '../sync-server/dist/packages/core/src/index.js';
import { appendAudit } from './dist/audit.js';
import { createAdminHandler } from './dist/http.js';
import { readAdminConfig } from './dist/main.js';
import { createAdminStore } from './dist/store.js';

const token = 'fixture-admin-proof-012345678901234567890123456789';

function fixture(profiles = true) {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-admin-test-'));
  const path = join(dir, 'sync.db');
  const db = new DatabaseSync(path);
  db.exec(SYNC_SCHEMA_SQL);
  for (const [h, n] of [
    ['fixture-handle', 1],
    ['unclaimed-handle', 0],
  ]) {
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?)').run(
      h,
      'forbidden-hash',
      'forbidden-recovery',
      'forbidden-wraps',
      '2026-01-01',
      'fixture-epoch',
    );
    db.prepare('INSERT INTO heads VALUES (?, ?, ?, ?)').run(h, n, n, n ? 1234 : 0);
  }
  db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'fixture-handle',
    'messages',
    'forbidden-entity-id',
    1,
    '2026-01-02',
    '2026-01-03',
    'fixture-device',
    'forbidden-sealed',
  );
  if (profiles) {
    db.exec(
      'CREATE TABLE account_profiles (space_handle TEXT PRIMARY KEY, account_id TEXT, display_name TEXT, claimed_at TEXT, space_epoch TEXT)',
    );
    db.prepare('INSERT INTO account_profiles VALUES (?, ?, ?, ?, ?)').run(
      'fixture-handle',
      'fixture-account',
      '<img src=x onerror=alert(1)>',
      '2026-01-01',
      'fixture-epoch',
    );
  }
  db.close();
  const before = readFileSync(path);
  const store = createAdminStore(path);
  return {
    dir,
    path,
    store,
    before,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('管理查询关联账户，包含墓碑，字节数沿用heads口径且不泄漏敏感字段', () => {
  const f = fixture();
  try {
    assert.equal(f.store.overview().spaces, 2);
    assert.equal(f.store.overview().accounts, 1);
    const list = f.store.list({ offset: 0, limit: 50, search: 'fixture-account' });
    assert.equal(list.total, 1);
    assert.equal(list.spaces[0].records, 1);
    assert.equal(list.spaces[0].quotaBytes, 1234);
    assert.equal(list.spaces[0].quotaLimitBytes, 96 * 1024 ** 2);
    assert.equal(list.spaces[0].customQuota, false);
    const detail = f.store.detail('fixture-handle');
    assert.deepEqual(detail.collections, [{ collection: 'messages', records: 1, tombstones: 1 }]);
    assert.equal(detail.devices.length, 1);
    assert.equal(detail.ciphertextJsonBytes, 16);
    const output = JSON.stringify({ list, detail });
    for (const forbidden of [
      'forbidden-hash',
      'forbidden-recovery',
      'forbidden-wraps',
      'forbidden-sealed',
      'forbidden-entity-id',
      'credential_hash',
      'key_wraps',
      'space_epoch',
    ]) {
      assert.equal(output.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(readFileSync(f.path), f.before);
  } finally {
    f.close();
  }
});

test('老库没有账户表仍可查询未认领空间，缺失heads明确报用量未知', () => {
  const f = fixture(false);
  try {
    assert.equal(f.store.overview().accounts, 0);
    assert.equal(f.store.detail('fixture-handle').space.profile, null);
    const writer = new DatabaseSync(f.path);
    writer.exec("DELETE FROM heads WHERE space_handle='fixture-handle'");
    writer.close();
    assert.equal(f.store.detail('fixture-handle').space.quotaBytes, null);
    assert.equal(f.store.overview().quotaBytes, null);
  } finally {
    f.close();
  }
});

test('重新创建的空间不会错误关联旧纪元账户资料', () => {
  const f = fixture();
  try {
    const writer = new DatabaseSync(f.path);
    writer.exec("UPDATE spaces SET epoch='new-fixture-epoch' WHERE space_handle='fixture-handle'");
    writer.close();
    assert.equal(f.store.overview().accounts, 0);
    assert.equal(f.store.detail('fixture-handle').space.profile, null);
  } finally {
    f.close();
  }
});

test('已知ID按客户端身份协议找到未登记空间，搜索不写账户资料', async () => {
  const f = fixture();
  try {
    const handle = await deriveSpaceHandle('fixture owner');
    const writer = new DatabaseSync(f.path);
    writer.prepare("UPDATE spaces SET space_handle=? WHERE space_handle='unclaimed-handle'").run(handle);
    writer.prepare("UPDATE heads SET space_handle=? WHERE space_handle='unclaimed-handle'").run(handle);
    writer.close();
    for (const search of ['fixture owner', '  FIXTURE   OWNER  ']) {
      const result = f.store.list({ offset: 0, limit: 50, search });
      assert.equal(result.total, 1);
      assert.equal(result.spaces[0].spaceHandle, handle);
      assert.equal(result.spaces[0].profile, null);
    }
    assert.equal(f.store.overview().accounts, 1);
    assert.equal(f.store.list({ offset: 0, limit: 50, search: 'fixture-unknown' }).total, 0);
  } finally {
    f.close();
  }
});

test('管理HTTP强制token与本机来源，拒绝写接口和下载，限制分页', async () => {
  const f = fixture();
  try {
    const events = [];
    const handler = createAdminHandler({
      store: f.store,
      token,
      port: 8788,
      assets: { html: 'fixture-ui', js: '', css: '' },
      audit: (event) => events.push(event),
      backupStatus: () => ({ available: false, files: [] }),
      syncHealth: async () => ({ ok: true, uptimeMs: 10 }),
    });
    const get = (path, headers = {}, method = 'GET') =>
      handler(
        new Request(`http://127.0.0.1:8788${path}`, {
          method,
          headers: { host: '127.0.0.1:8788', authorization: `Bearer ${token}`, ...headers },
        }),
      );
    assert.equal((await get('/api/spaces', { authorization: '' })).status, 401);
    assert.equal((await get('/api/spaces', { host: 'attacker.invalid' })).status, 403);
    assert.equal((await get('/api/spaces', { origin: 'http://attacker.invalid' })).status, 403);
    assert.equal((await get('/api/spaces', {}, 'POST')).status, 405);
    assert.equal((await get('/api/spaces', {}, 'OPTIONS')).status, 403);
    assert.equal((await get('/api/spaces?limit=501')).status, 400);
    assert.equal((await get('/api/spaces?offset=-1')).status, 400);
    assert.equal((await get('/api/spaces?token=oops')).status, 400);
    assert.equal((await get('/sync/api/spaces')).status, 404);
    assert.equal((await get('/api/backup/download')).status, 404);
    assert.equal((await get('/api/plans', { authorization: '' })).status, 401);
    const catalog = await get('/api/plans');
    assert.equal(catalog.status, 200);
    assert.deepEqual(
      (await catalog.json()).plans.map((plan) => plan.priceFen),
      [1000, 3000, 6800, 9800],
    );
    const response = await get('/api/overview');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.ok(response.headers.get('content-security-policy').includes("default-src 'self'"));
    assert.equal(JSON.stringify(events).includes(token), false);
  } finally {
    f.close();
  }
});

test('追加审计只收固定字段，不写凭证或请求体', () => {
  const f = fixture();
  try {
    const file = join(f.dir, 'audit.jsonl');
    writeFileSync(file, 'existing\n');
    appendAudit(file, { action: 'overview', status: 200, durationMs: 3, authorization: token, body: 'secret' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines[0], 'existing');
    assert.deepEqual(Object.keys(JSON.parse(lines[1])).sort(), ['action', 'durationMs', 'status', 'time']);
  } finally {
    f.close();
  }
});

test('启动配置拒绝公网监听、短token和将审计写入生产库', () => {
  const env = {
    DRAMATIS_ADMIN_DATA: '/fixture/sync.db',
    DRAMATIS_ADMIN_AUDIT: '/fixture/audit.jsonl',
    DRAMATIS_ADMIN_TOKEN: token,
  };
  assert.equal(readAdminConfig(env).defaultMaxBytes, 96 * 1024 ** 2);
  assert.equal(readAdminConfig({ ...env, DRAMATIS_ADMIN_DEFAULT_MAX_MB: '128' }).defaultMaxBytes, 128 * 1024 ** 2);
  assert.throws(() => readAdminConfig({ ...env, DRAMATIS_ADMIN_HOST: '0.0.0.0' }));
  assert.throws(() => readAdminConfig({ ...env, DRAMATIS_ADMIN_TOKEN: 'short' }));
  assert.throws(() => readAdminConfig({ ...env, DRAMATIS_ADMIN_AUDIT: env.DRAMATIS_ADMIN_DATA }));
  assert.throws(() => readAdminConfig({ ...env, DRAMATIS_ADMIN_WRITE: '1' }));
  assert.throws(() => readAdminConfig({ ...env, DRAMATIS_ADMIN_WRITE: 'true' }));
  assert.throws(() => readAdminConfig({ ...env, DRAMATIS_ADMIN_DEFAULT_MAX_MB: 'NaN' }));
  assert.equal(
    readAdminConfig({ ...env, DRAMATIS_ADMIN_WRITE: '1', DRAMATIS_ADMIN_BACKUPS: '/fixture/backups' }).writeEnabled,
    true,
  );
});
