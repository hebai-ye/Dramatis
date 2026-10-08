import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createAccountProfileHandler } from '../dist/tools/sync-server/src/accounts.js';
import { allowedOriginHeaders } from '../dist/tools/sync-server/src/cors.js';

const allowed = 'https://client.example.invalid';
const denied = 'https://unlisted.example.invalid';
const validBody = JSON.stringify({
  confirmed: true,
  spaceHandle: 'fixture-space',
  accountId: 'fixture-account',
  displayName: 'fixture-name',
});

function makeHandler() {
  return createAccountProfileHandler({
    exec() {},
    prepare() {
      throw new Error('这个测试不应读取账户资料');
    },
  });
}

for (const [label, method, body, contentType, status] of [
  ['非法JSON', 'POST', '{', 'application/json', 400],
  ['未认证', 'POST', validBody, 'application/json', 401],
  ['错误方法', 'GET', undefined, undefined, 405],
  ['请求过大', 'POST', 'x'.repeat(4097), 'application/json', 413],
  ['错误媒体类型', 'POST', '{}', 'text/plain', 415],
]) {
  test(`认领${label}返回原错误码并携带允许来源的CORS`, async () => {
    const response = await makeHandler()(
      new Request('https://sync.example.invalid/accounts/claim', {
        method,
        headers: { origin: allowed, ...(contentType ? { 'content-type': contentType } : {}) },
        ...(body === undefined ? {} : { body }),
      }),
      { clientKey: label, allowedOrigins: [allowed] },
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), allowed);
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(typeof (await response.json()).error.code, 'string');
  });
}

test('429同样可读，不向未允许的来源或无Origin请求扩大授权', async () => {
  const handler = makeHandler();
  let response;
  for (let i = 0; i < 11; i++) {
    response = await handler(
      new Request('https://sync.example.invalid/accounts/claim', {
        method: 'POST',
        headers: { origin: allowed, 'content-type': 'application/json' },
        body: '{}',
      }),
      { clientKey: 'rate-fixture', allowedOrigins: [allowed] },
    );
  }
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('access-control-allow-origin'), allowed);
  assert.equal((await response.json()).error.code, 'rate-limited');
  const blocked = await handler(
    new Request('https://sync.example.invalid/accounts/claim', { headers: { origin: denied } }),
    { clientKey: 'denied', allowedOrigins: [allowed] },
  );
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(allowedOriginHeaders(null, [allowed]), { vary: 'Origin' });
  assert.deepEqual(allowedOriginHeaders(denied, [allowed]), { vary: 'Origin' });
});

test('真实HTTP宿主的413/500保留CORS，未允许来源不回显，异常细节不外泄', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dramatis-cors-fixture-'));
  const dataPath = join(dir, 'fixture.db');
  let child;
  let db;
  try {
    const reserve = createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('DRAMATIS_SYNC_')) delete env[key];
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../start.mjs', import.meta.url)),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--data',
        dataPath,
        '--origins',
        allowed,
        '--quiet',
      ],
      { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error(`隔离同步进程退出：${errors}`);
      try {
        ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) })).ok;
      } catch {}
      if (ready) break;
      await setTimeout(50);
    }
    assert.equal(ready, true, '隔离同步服务启动');
    for (const origin of [allowed, denied]) {
      const response = await fetch(`${base}/accounts/claim`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: 'x'.repeat(5000),
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 413);
      assert.equal(response.headers.get('access-control-allow-origin'), origin === allowed ? allowed : null);
      assert.equal(response.headers.get('vary'), 'Origin');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).error.code, 'payload-too-large');
    }
    // 仅在本测试新建的临时数据库制造SQL故障，验证宿主catch而非核心错误包装。
    db = new DatabaseSync(dataPath);
    db.exec('DROP TABLE spaces');
    db.close();
    db = null;
    const failed = await fetch(`${base}/accounts/claim`, {
      method: 'POST',
      headers: { origin: allowed, 'content-type': 'application/json', authorization: 'Bearer fixture-proof' },
      body: validBody,
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('access-control-allow-origin'), allowed);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    const errorBody = await failed.text();
    assert.equal(JSON.parse(errorBody).error.code, 'internal');
    assert.doesNotMatch(errorBody, /SQL|spaces|fixture|\.db/);
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
