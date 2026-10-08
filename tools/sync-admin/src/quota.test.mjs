import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SYNC_LIMITS } from '../../sync-server/dist/packages/core/src/sync/server.js';
import { createAdminHandler } from '../dist/http.js';
import { readAdminConfig } from '../dist/main.js';
import { readSyncQuotaHealth, verifyQuotaHealth } from '../dist/quota-check.js';
import { DEFAULT_STORAGE_MAX_BYTES, parseDefaultStorageMiB } from '../dist/quota-policy.js';

const token = 'fixture-admin-proof-012345678901234567890123456789';
const MiB = 1024 ** 2;
const configEnv = {
  DRAMATIS_ADMIN_DATA: 'fixture.db',
  DRAMATIS_ADMIN_TOKEN: token,
  DRAMATIS_ADMIN_AUDIT: 'fixture.jsonl',
};

test('B14：core与管理配置共用96MiB单源，合法小数MiB按整数字节解析', () => {
  assert.equal(DEFAULT_STORAGE_MAX_BYTES, 96 * MiB);
  assert.equal(DEFAULT_SYNC_LIMITS.maxBytesPerSpace, DEFAULT_STORAGE_MAX_BYTES);
  assert.equal(readAdminConfig(configEnv).defaultMaxBytes, DEFAULT_STORAGE_MAX_BYTES);
  assert.equal(parseDefaultStorageMiB('128'), 128 * MiB);
  assert.equal(parseDefaultStorageMiB('0.5'), MiB / 2);
  assert.equal(parseDefaultStorageMiB('1048576'), 1024 ** 4);
});
for (const raw of ['', ' ', '0', '-1', 'NaN', 'Infinity', '0x60', '1e2', '96x', '1048577', '0.0000001']) {
  test(`B14：非法默认配额${JSON.stringify(raw)}不静默回退`, () => {
    assert.throws(() => parseDefaultStorageMiB(raw));
    assert.throws(() => readAdminConfig({ ...configEnv, DRAMATIS_ADMIN_DEFAULT_MAX_MB: raw }));
  });
}
test('B14：健康字段缺失、旧版本、不可达或伪造非有限值不能通过门禁', async () => {
  for (const health of [
    { ok: false },
    { ok: true },
    { ok: true, storageQuota: { version: 2, defaultMaxBytes: 96 * MiB } },
    { ok: true, storageQuota: { version: 1, defaultMaxBytes: NaN } },
  ]) {
    assert.throws(() => verifyQuotaHealth(health, 96 * MiB), { code: 'quota-unverified', status: 503 });
  }
  assert.throws(
    () => verifyQuotaHealth({ ok: true, storageQuota: { version: 1, defaultMaxBytes: 128 * MiB } }, 96 * MiB),
    { code: 'quota-mismatch', status: 503 },
  );
  verifyQuotaHealth({ ok: true, storageQuota: { version: 1, defaultMaxBytes: 96 * MiB } }, 96 * MiB);
  for (const response of [
    new Response('bad-json'),
    new Response('null'),
    new Response('{"ok":true}', { status: 503 }),
  ]) {
    const health = await readSyncQuotaHealth(8787, async () => response);
    assert.throws(() => verifyQuotaHealth(health, 96 * MiB), { code: 'quota-unverified' });
  }
  assert.deepEqual(
    await readSyncQuotaHealth(8787, async () => {
      throw new Error('offline');
    }),
    { ok: false },
  );
});

test('B14：授权后才探活，配置漂移拒绝读/预览/确认，不碰仓储或审计票据', async () => {
  let checks = 0;
  let dataAccess = 0;
  const handler = createAdminHandler({
    token,
    port: 8788,
    assets: { html: '', js: '', css: '' },
    audit() {},
    backupStatus: () => ({ available: false, files: [] }),
    syncHealth: async () => ({ ok: true }),
    verifyQuota: async () => {
      checks++;
      verifyQuotaHealth({ ok: true, storageQuota: { version: 1, defaultMaxBytes: 128 * MiB } }, 96 * MiB);
    },
    store: {
      overview() {
        dataAccess++;
      },
      list() {
        dataAccess++;
      },
    },
    operations: {
      prepare() {
        dataAccess++;
      },
      commit() {
        dataAccess++;
      },
    },
  });
  const base = 'http://127.0.0.1:8788';
  assert.equal(
    (await handler(new Request(`${base}/api/overview`, { headers: { host: '127.0.0.1:8788' } }))).status,
    401,
  );
  assert.equal(checks, 0);
  for (const [route, method] of [
    ['/api/overview', 'GET'],
    ['/api/spaces', 'GET'],
    ['/api/changes/prepare', 'POST'],
    ['/api/changes/commit', 'POST'],
  ]) {
    const response = await handler(
      new Request(`${base}${route}`, {
        method,
        headers: {
          host: '127.0.0.1:8788',
          origin: base,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'quota-mismatch');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(checks, 4);
  assert.equal(dataAccess, 0);
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
function spawnService(script, env, args = []) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith('DRAMATIS_')) delete clean[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], {
    env: { ...clean, ...env },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.output = '';
  child.stderr.on('data', (chunk) => {
    child.output += chunk;
  });
  return child;
}
async function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const end = once(child, 'exit');
    child.kill();
    await end;
  }
}
async function waitReady(child, url, headers = {}) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`fixture service failed: ${child.output}`);
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(100) });
      if (r.ok) return r;
    } catch {}
    await delay(30);
  }
  throw new Error('fixture service startup timeout');
}
async function waitExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  for (let i = 0; i < 100; i++) {
    await delay(30);
    if (child.exitCode !== null) return child.exitCode;
  }
  throw new Error('fixture process did not exit');
}
function cleanFixture(dir) {
  const target = resolve(dir),
    parent = resolve(tmpdir());
  assert.ok(target.startsWith(`${parent}${process.platform === 'win32' ? '\\' : '/'}`));
  rmSync(target, { recursive: true, force: true });
}

test('B14真实进程：同步CLI优先、管理启动漂移门禁、运行后漂移关闭API且不改库', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-b14-'));
  const db = join(dir, 'fixture.db');
  const syncPort = await freePort(),
    adminPort = await freePort();
  let sync, admin, mismatch;
  const syncEnv = {
    DRAMATIS_SYNC_DATA: db,
    DRAMATIS_SYNC_PORT: String(syncPort),
    DRAMATIS_SYNC_MAX_MB: '128',
    DRAMATIS_SYNC_QUIET: '1',
  };
  const adminEnv = {
    DRAMATIS_ADMIN_DATA: db,
    DRAMATIS_ADMIN_PORT: String(adminPort),
    DRAMATIS_ADMIN_SYNC_PORT: String(syncPort),
    DRAMATIS_ADMIN_TOKEN: token,
    DRAMATIS_ADMIN_AUDIT: join(dir, 'audit.jsonl'),
    DRAMATIS_ADMIN_DEFAULT_MAX_MB: '192',
  };
  const base = `http://127.0.0.1:${adminPort}`;
  try {
    sync = spawnService('../../sync-server/start.mjs', syncEnv, ['--max-mb', '192']);
    const health = await (await waitReady(sync, `http://127.0.0.1:${syncPort}/health`)).json();
    assert.deepEqual(health.storageQuota, { version: 1, defaultMaxBytes: 192 * MiB });
    const before = readFileSync(db);
    mismatch = spawnService('../start.mjs', { ...adminEnv, DRAMATIS_ADMIN_DEFAULT_MAX_MB: '96' });
    assert.equal(await waitExit(mismatch), 1);
    assert.match(mismatch.output, /默认配额不一致/);
    assert.deepEqual(readFileSync(db), before);
    admin = spawnService('../start.mjs', adminEnv);
    const result = await (await waitReady(admin, `${base}/api/overview`, { authorization: `Bearer ${token}` })).json();
    assert.equal(result.syncHealth.storageQuota.defaultMaxBytes, 192 * MiB);
    await stop(sync);
    sync = spawnService('../../sync-server/start.mjs', { ...syncEnv, DRAMATIS_SYNC_MAX_MB: '256' });
    await waitReady(sync, `http://127.0.0.1:${syncPort}/health`);
    const failed = await fetch(`${base}/api/spaces`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'quota-mismatch');
    await stop(sync);
    sync = undefined;
    const offline = await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(offline.status, 503);
    assert.equal((await offline.json()).error, 'quota-unverified');
  } finally {
    await stop(admin);
    await stop(mismatch);
    await stop(sync);
    cleanFixture(dir);
  }
});

test('B14真实进程：同步错误配额在打开数据库前退出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-b14-invalid-'));
  const db = join(dir, 'fixture.db');
  let child;
  try {
    child = spawnService('../../sync-server/start.mjs', {
      DRAMATIS_SYNC_DATA: db,
      DRAMATIS_SYNC_MAX_MB: 'not-a-number',
    });
    assert.equal(await waitExit(child), 1);
    assert.equal(existsSync(db), false);
  } finally {
    await stop(child);
    cleanFixture(dir);
  }
});
