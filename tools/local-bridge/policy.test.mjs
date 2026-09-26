/**
 * 本地助手访问策略的测试（审计 A1 / A13 / C19 / C20）。
 *
 * 跑法：`node --test tools/`（零依赖，用 node:test）。
 * 前半是纯函数单测，后半真的起本地助手与假模型服务，用原始 HTTP 请求验证。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkAccess,
  clampTimeout,
  createSerialQueue,
  DEFAULT_ALLOWED_ORIGINS,
  isAllowedHost,
  isAllowedOrigin,
  isAuthorized,
  MAX_BODY_BYTES,
  parseOriginList,
  parsePort,
  readLimitedBody,
} from './policy.mjs';

const allowed = [...DEFAULT_ALLOWED_ORIGINS];

describe('Host / Origin 校验', () => {
  it('只认本机 Host 与正确端口', () => {
    assert.equal(isAllowedHost('127.0.0.1:8791', 8791), true);
    assert.equal(isAllowedHost('LOCALHOST:8791', 8791), true);
    assert.equal(isAllowedHost('127.0.0.1:8792', 8791), false);
    assert.equal(isAllowedHost('evil.example:8791', 8791), false);
    assert.equal(isAllowedHost('127.0.0.1', 8791), false);
    assert.equal(isAllowedHost(undefined, 8791), false);
  });

  it('Origin 白名单：正式站点与本机 5273', () => {
    for (const origin of DEFAULT_ALLOWED_ORIGINS) assert.equal(isAllowedOrigin(origin, allowed), true);
    assert.equal(isAllowedOrigin('https://evil.example', allowed), false);
    assert.equal(isAllowedOrigin('https://dramatissync.com.evil.example', allowed), false);
    assert.equal(isAllowedOrigin('http://127.0.0.1:5274', allowed), false);
    assert.equal(isAllowedOrigin('null', allowed), false);
    assert.equal(isAllowedOrigin(undefined, allowed), true);
  });

  it('额外来源解析与规范化，非法项报错', () => {
    assert.deepEqual(parseOriginList(' http://127.0.0.1:4173/ , https://a.example '), [
      'http://127.0.0.1:4173',
      'https://a.example',
    ]);
    assert.deepEqual(parseOriginList(undefined), []);
    assert.throws(() => parseOriginList('not a url'));
    assert.throws(() => parseOriginList('ftp://x.example'));
  });

  it('checkAccess：DNS rebinding（Host 不对）一律 403', () => {
    const result = checkAccess({
      method: 'POST',
      headers: { host: 'rebind.evil.example:8791', origin: 'https://dramatissync.com' },
      port: 8791,
      allowedOrigins: allowed,
      token: '',
    });
    assert.deepEqual([result.ok, result.status], [false, 403]);
  });

  it('checkAccess：无 Origin 且 Host 正确时放行（curl）', () => {
    assert.equal(
      checkAccess({
        method: 'GET',
        headers: { host: '127.0.0.1:8791' },
        port: 8791,
        allowedOrigins: allowed,
        token: '',
      }).ok,
      true,
    );
  });

  it('配对令牌：设置后需要 Bearer；预检免令牌', () => {
    assert.equal(isAuthorized(undefined, ''), true);
    assert.equal(isAuthorized(undefined, 'abc'), false);
    assert.equal(isAuthorized('Bearer abc', 'abc'), true);
    assert.equal(isAuthorized('bearer abc', 'abc'), true);
    assert.equal(isAuthorized('Bearer abd', 'abc'), false);
    assert.equal(isAuthorized('Bearer abcd', 'abc'), false);
    assert.equal(isAuthorized('abc', 'abc'), false);
    const base = { headers: { host: '127.0.0.1:8791' }, port: 8791, allowedOrigins: allowed, token: 'abc' };
    assert.equal(checkAccess({ ...base, method: 'GET' }).status, 401);
    assert.equal(checkAccess({ ...base, method: 'OPTIONS' }).ok, true);
  });

  it('端口校验', () => {
    assert.equal(parsePort(undefined, 8791, 'p'), 8791);
    assert.equal(parsePort('65535', 1, 'p'), 65535);
    for (const bad of ['0', '65536', '-1', '12.5', 'abc', '80x', ' ']) {
      assert.throws(() => parsePort(bad, 1, 'p'), /1-65535/);
    }
  });
});

describe('输入上限', () => {
  it('timeoutMs 夹在 5s..600s', () => {
    assert.equal(clampTimeout(1), 5_000);
    assert.equal(clampTimeout(10_000_000), 600_000);
    assert.equal(clampTimeout(30_000), 30_000);
    assert.equal(clampTimeout('30000'), 180_000);
    assert.equal(clampTimeout(Number.NaN), 180_000);
    assert.equal(clampTimeout(Number.POSITIVE_INFINITY), 180_000);
  });

  it('请求体超过上限抛 413', async () => {
    const small = Object.assign(Readable.from([Buffer.from('{"a":1}')]), { headers: {} });
    assert.equal(await readLimitedBody(small), '{"a":1}');
    const big = Object.assign(Readable.from([Buffer.alloc(600_000), Buffer.alloc(600_000)]), { headers: {} });
    await assert.rejects(readLimitedBody(big), (error) => error.status === 413);
    const declared = Object.assign(Readable.from([]), { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } });
    await assert.rejects(readLimitedBody(declared), (error) => error.status === 413);
  });

  it('串行队列：一次只跑一个，超出排队上限 429', async () => {
    const queue = createSerialQueue(1);
    let running = 0;
    let maxRunning = 0;
    const releases = [];
    const task = () =>
      new Promise((resolve) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        releases.push(() => {
          running -= 1;
          resolve('done');
        });
      });
    const first = queue.run(task);
    const second = queue.run(task);
    await assert.rejects(queue.run(task), (error) => error.status === 429);
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()();
    assert.equal(await first, 'done');
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()();
    assert.equal(await second, 'done');
    assert.equal(maxRunning, 1);
    assert.equal(await queue.run(async () => 'again'), 'again');
  });
});

// ---------- 真起进程的集成测试 ----------

async function freePort() {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startProcess(script, argv, env = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...argv], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', (code) => reject(new Error(`进程提前退出：${String(code)}`)));
  });
  return child;
}

function raw(port, { method = 'GET', path = '/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('本地助手进程', () => {
  it('Origin / Host / 令牌 / 请求体上限', async () => {
    const port = await freePort();
    const cdp = await freePort(); // 没人监听：/health 会回 attached:false
    const child = await startProcess('./server.mjs', ['--port', String(port), '--cdp', String(cdp)], {
      DRAMATIS_BRIDGE_ORIGINS: 'http://127.0.0.1:4173',
    });
    try {
      const host = `127.0.0.1:${String(port)}`;
      const ok = await raw(port, { headers: { host, origin: 'https://dramatissync.com' } });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers['access-control-allow-origin'], 'https://dramatissync.com');

      const extra = await raw(port, { headers: { host, origin: 'http://127.0.0.1:4173' } });
      assert.equal(extra.headers['access-control-allow-origin'], 'http://127.0.0.1:4173');

      const evil = await raw(port, { headers: { host, origin: 'https://evil.example' } });
      assert.equal(evil.status, 403);
      assert.equal(evil.headers['access-control-allow-origin'], undefined);

      const rebind = await raw(port, { headers: { host: `evil.example:${String(port)}` } });
      assert.equal(rebind.status, 403);

      const curl = await raw(port, { headers: { host } });
      assert.equal(curl.status, 200);
      assert.equal(curl.headers['access-control-allow-origin'], undefined);

      const preflight = await raw(port, {
        method: 'OPTIONS',
        path: '/ask',
        headers: { host, origin: 'http://localhost:5273', 'access-control-request-method': 'POST' },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5273');
      assert.equal(preflight.headers['access-control-allow-private-network'], 'true');

      const huge = await raw(port, {
        method: 'POST',
        path: '/ask',
        headers: { host, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'x'.repeat(MAX_BODY_BYTES + 10) }),
      });
      assert.equal(huge.status, 413);

      const badJson = await raw(port, { method: 'POST', path: '/ask', headers: { host }, body: '{' });
      assert.equal(badJson.status, 400);
    } finally {
      child.kill();
    }
  });

  it('设置令牌后必须带 Bearer', async () => {
    const port = await freePort();
    const cdp = await freePort();
    const child = await startProcess('./server.mjs', ['--port', String(port), '--cdp', String(cdp)], {
      DRAMATIS_BRIDGE_TOKEN: 's3cret',
    });
    try {
      const host = `127.0.0.1:${String(port)}`;
      assert.equal((await raw(port, { headers: { host } })).status, 401);
      assert.equal((await raw(port, { headers: { host, authorization: 'Bearer s3cret' } })).status, 200);
    } finally {
      child.kill();
    }
  });

  it('非法端口启动即报错退出', async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', 'abc']);
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
  });
});

describe('假模型服务（C19）', () => {
  it('只放行本机来源（任意端口），不回 *', async () => {
    const port = await freePort();
    const child = await startProcess('../fake-model/server.mjs', ['--port', String(port)]);
    try {
      const local = await raw(port, { path: '/v1/models', headers: { origin: 'http://localhost:61234' } });
      assert.equal(local.status, 200);
      assert.equal(local.headers['access-control-allow-origin'], 'http://localhost:61234');
      const evil = await raw(port, { path: '/v1/models', headers: { origin: 'https://evil.example' } });
      assert.equal(evil.status, 403);
      assert.equal(evil.headers['access-control-allow-origin'], undefined);
      const curl = await raw(port, { path: '/v1/models' });
      assert.equal(curl.status, 200);
    } finally {
      child.kill();
    }
  });
});

describe('桌面启动器（C20）', () => {
  it('DRAMATIS_PORT 非法时报错退出', async () => {
    for (const bad of ['abc', '0', '70000', '12.5']) {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../desktop/launch.mjs', import.meta.url))], {
        env: { ...process.env, DRAMATIS_PORT: bad, DRAMATIS_NO_OPEN: '1' },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const code = await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(code, 1, bad);
      assert.match(stderr, /1-65535/);
    }
  });
});
