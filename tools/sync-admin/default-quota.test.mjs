import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createSqliteSyncStore, hashCredential } from '../sync-server/dist/packages/core/src/index.js';
import { createSpaceQuotaResolver } from '../sync-server/dist/tools/sync-server/src/storage-policy.js';

test('真实同步宿主默认96MiB：边界允许、超额原子拒绝、自定义额度保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-default-quota-'));
  const path = join(dir, 'fixture.db');
  const cap = 96 * 1024 ** 2;
  const credential = 'fixture-quota-proof';
  let db = new DatabaseSync(path);
  const store = createSqliteSyncStore(db);
  const wire = {
    collection: 'messages',
    id: 'fixture',
    updatedAt: '2026-01-01',
    deletedAt: null,
    sealed: { algorithm: 'AES-256-GCM', iv: 'fixture-iv', ciphertext: 'x'.repeat(100) },
  };
  const bytes = Buffer.byteLength(wire.collection + wire.id + wire.updatedAt + JSON.stringify(wire.sealed));
  let child;
  try {
    await store.createSpace({
      spaceHandle: 'fixture-quota',
      credentialHash: await hashCredential(credential),
      recoveryCredentialHash: 'fixture-recovery',
      keyWraps: {},
      createdAt: '2026-01-01',
      epoch: 'fixture-epoch',
    });
    // 仅隔离假库：用计数器代表既有用量，避免构造96MiB请求或生产数据。
    db.prepare('UPDATE heads SET byte_count=? WHERE space_handle=?').run(cap - bytes, 'fixture-quota');
    await store.createSpace({
      spaceHandle: 'fixture-custom',
      credentialHash: await hashCredential(credential),
      recoveryCredentialHash: 'fixture-recovery',
      keyWraps: {},
      createdAt: '2026-01-01',
      epoch: 'fixture-epoch',
    });
    createSpaceQuotaResolver(db);
    db.prepare('INSERT INTO space_policies VALUES (?, ?, ?, ?)').run(
      'fixture-custom',
      'fixture-epoch',
      128 * 1024 ** 2,
      1,
    );
    db.prepare('UPDATE heads SET byte_count=? WHERE space_handle=?').run(cap, 'fixture-custom');
    db.close();
    db = null;
    const reserve = createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('DRAMATIS_SYNC_')) delete env[key];
    const entry = join(dirname(fileURLToPath(import.meta.url)), '../sync-server/start.mjs');
    child = spawn(process.execPath, [entry, '--host', '127.0.0.1', '--port', String(port), '--data', path, '--quiet'], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error(`隔离同步进程退出：${errors}`);
      try {
        ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(200) })).ok;
      } catch {}
      if (ready) break;
      await setTimeout(50);
    }
    assert.equal(ready, true, '隔离同步服务启动');
    const pushTo = (handle, records) =>
      fetch(`${origin}/spaces/${handle}/push`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ records }),
      });
    const push = (...records) => pushTo('fixture-quota', records);
    const first = await push(wire);
    assert.equal(first.status, 200, await first.text());
    db = new DatabaseSync(path);
    const read = () =>
      db.prepare('SELECT head,record_count,byte_count FROM heads WHERE space_handle=?').get('fixture-quota');
    const before = read();
    const readRecords = () => db.prepare('SELECT * FROM records ORDER BY space_handle,collection,id').all();
    const beforeRecords = readRecords();
    assert.equal(before.byte_count, cap);
    const growing = { ...wire, sealed: { ...wire.sealed, ciphertext: `${wire.sealed.ciphertext}x` } };
    const denied = await push(growing);
    assert.equal(denied.status, 413);
    assert.equal((await denied.json()).error.code, 'space-full');
    assert.deepEqual(read(), before);
    assert.deepEqual(readRecords(), beforeRecords);
    assert.equal((await push(growing, { ...wire, id: 'fixture-new' })).status, 413);
    assert.deepEqual(read(), before);
    assert.deepEqual(readRecords(), beforeRecords);
    assert.equal(
      db.prepare('SELECT max_bytes FROM space_policies WHERE space_handle=?').get('fixture-custom').max_bytes,
      128 * 1024 ** 2,
    );
    assert.equal((await pushTo('fixture-custom', [wire])).status, 200);
    assert.ok(db.prepare('SELECT byte_count FROM heads WHERE space_handle=?').get('fixture-custom').byte_count > cap);
    db.prepare('INSERT INTO space_policies VALUES (?, ?, ?, ?)').run(
      'fixture-quota',
      'fixture-epoch',
      128 * 1024 ** 2,
      1,
    );
    assert.equal((await push(growing)).status, 200);
    assert.equal(read().byte_count, cap + 1);
    assert.equal(
      db.prepare('SELECT max_bytes FROM space_policies WHERE space_handle=?').get('fixture-quota').max_bytes,
      128 * 1024 ** 2,
    );
  } finally {
    db?.close();
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
