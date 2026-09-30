import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SYNC_SCHEMA_SQL } from '../sync-server/dist/packages/core/src/index.js';
import { createAdminHandler } from './dist/http.js';
import { createAdminOperations } from './dist/operations.js';
import { createAdminStore } from './dist/store.js';

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-edit-test-'));
  const dataPath = join(dir, 'sync.db');
  const backupPath = join(dir, 'backups');
  mkdirSync(backupPath);
  const db = new DatabaseSync(dataPath);
  db.exec(SYNC_SCHEMA_SQL);
  db.exec(
    "INSERT INTO spaces VALUES ('fixture-handle','forbidden-hash','forbidden-recovery','forbidden-wraps','2026-01-01','fixture-epoch'); INSERT INTO heads VALUES ('fixture-handle',0,0,0); CREATE TABLE account_profiles(space_handle TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,claimed_at TEXT,space_epoch TEXT); INSERT INTO account_profiles VALUES ('fixture-handle','fixture-account','before-name','2026-01-01','fixture-epoch'); CREATE TABLE space_policies(space_handle TEXT PRIMARY KEY,space_epoch TEXT NOT NULL,max_bytes INTEGER,revision INTEGER NOT NULL);",
  );
  const events = [];
  const ops = createAdminOperations({
    dataPath,
    backupPath,
    defaultMaxBytes: 256 * 1024 ** 2,
    audit: (e) => events.push(e),
    ...options,
  });
  const name = () => db.prepare('SELECT display_name FROM account_profiles').get().display_name;
  const prepare = (patch = {}) =>
    ops.prepare({ spaceHandle: 'fixture-handle', displayName: 'after-name', maxBytes: 1024 ** 3, ...patch });
  const commit = (preview, handle = 'fixture-handle') =>
    ops.commit({ confirmationId: preview.confirmationId, confirmSpaceHandle: handle });
  return {
    dir,
    dataPath,
    backupPath,
    db,
    ops,
    events,
    name,
    prepare,
    commit,
    close() {
      ops.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('预览不写库；错确认不备份；正确确认保存快照后原子修改且票据不能重放', () => {
  const f = fixture();
  try {
    const p = f.prepare();
    assert.equal(f.name(), 'before-name');
    assert.equal(readdirSync(f.backupPath).length, 0);
    assert.throws(() => f.commit(p, 'wrong-handle'));
    assert.equal(f.name(), 'before-name');
    assert.equal(readdirSync(f.backupPath).length, 0);
    const p2 = f.prepare();
    const result = f.commit(p2);
    assert.equal(f.name(), 'after-name');
    const saved = new DatabaseSync(join(f.backupPath, result.backupFile), { readOnly: true });
    assert.equal(saved.prepare('SELECT display_name FROM account_profiles').get().display_name, 'before-name');
    saved.close();
    assert.equal(f.db.prepare('SELECT max_bytes FROM space_policies').get().max_bytes, 1073741824);
    assert.throws(() => f.commit(p2));
    assert.equal(JSON.stringify(f.events).includes('before-name'), false);
  } finally {
    f.close();
  }
});

test('HTTP编辑要求token及精确Origin，预览与确认后可查询有效配额', async () => {
  const f = fixture();
  const store = createAdminStore(f.dataPath);
  const token = 'fixture-edit-token-for-test-only-012345678901234567890';
  try {
    const handler = createAdminHandler({
      store,
      token,
      port: 8788,
      assets: { html: '', js: '', css: '' },
      audit: () => {},
      backupStatus: () => ({ available: true, files: [] }),
      syncHealth: async () => ({ ok: true }),
      operations: f.ops,
    });
    const post = (path, body, headers = {}) =>
      handler(
        new Request(`http://127.0.0.1:8788${path}`, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:8788',
            origin: 'http://127.0.0.1:8788',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
    assert.equal(
      (
        await post(
          '/api/changes/prepare',
          { spaceHandle: 'fixture-handle', maxBytes: 1024 ** 3 },
          { origin: 'http://attacker.invalid' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          '/api/changes/prepare',
          { spaceHandle: 'fixture-handle', maxBytes: 1024 ** 3 },
          { authorization: '' },
        )
      ).status,
      401,
    );
    const response = await post('/api/changes/prepare', {
      spaceHandle: 'fixture-handle',
      displayName: 'http-name',
      maxBytes: 1024 ** 3,
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    const saved = await post('/api/changes/commit', {
      confirmationId: preview.confirmationId,
      confirmSpaceHandle: 'fixture-handle',
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).applied, true);
    assert.equal(store.detail('fixture-handle').space.quotaLimitBytes, 1073741824);
    assert.equal(
      (await post('/api/changes/prepare', { spaceHandle: 'fixture-handle', maxBytes: 0 }, { origin: '' })).status,
      403,
    );
  } finally {
    store.close();
    f.close();
  }
});

test('备份失败或意图审计失败均保留原名称和配额', () => {
  for (const failure of ['backup', 'audit']) {
    const f = fixture(
      failure === 'audit'
        ? {
            audit: () => {
              throw new Error('fixture-audit-failure');
            },
          }
        : {},
    );
    try {
      const p = f.prepare();
      if (failure === 'backup') rmSync(f.backupPath, { recursive: true });
      assert.throws(() => f.commit(p));
      assert.equal(f.name(), 'before-name');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM space_policies').get().n, 0);
    } finally {
      f.close();
    }
  }
});

test('过期、并发修改和重建的确认均拒绝，不接受任意资料字段', () => {
  let now = 0;
  const f = fixture({ now: () => now });
  try {
    assert.throws(() => f.prepare({ accountId: 'forged' }));
    const expired = f.prepare();
    now = 120001;
    assert.throws(() => f.commit(expired));
    const first = f.prepare();
    const second = f.prepare();
    f.commit(first);
    assert.throws(() => f.commit(second));
    const rebuilt = f.prepare({ displayName: 'another-name' });
    f.db.exec("UPDATE spaces SET epoch='new-epoch'");
    assert.throws(() => f.commit(rebuilt));
    assert.equal(f.name(), 'after-name');
  } finally {
    f.close();
  }
});

test('未认领空间只能配置配额，恢复默认保留默认口径', () => {
  const f = fixture();
  try {
    f.db.exec('DELETE FROM account_profiles');
    assert.throws(() => f.prepare());
    const p = f.ops.prepare({ spaceHandle: 'fixture-handle', maxBytes: 0 });
    f.commit(p);
    const reset = f.ops.prepare({ spaceHandle: 'fixture-handle', maxBytes: null });
    f.commit(reset);
    assert.equal(f.db.prepare('SELECT max_bytes FROM space_policies').get().max_bytes, null);
  } finally {
    f.close();
  }
});
