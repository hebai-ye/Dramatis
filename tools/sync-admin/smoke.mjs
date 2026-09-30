/** 本机真浏览器验收：只在临时目录造测试库，三个监听均绑定回环。 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SYNC_SCHEMA_SQL } from '../sync-server/dist/packages/core/src/index.js';
import { createAccountProfileHandler } from '../sync-server/dist/tools/sync-server/src/accounts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = mkdtempSync(join(tmpdir(), 'dramatis-admin-smoke-'));
const dbPath = join(data, 'sync.db');
const db = new DatabaseSync(dbPath);
db.exec(SYNC_SCHEMA_SQL);
createAccountProfileHandler(db);
db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?)').run(
  'fixture-unclaimed',
  'fixture-hash',
  'fixture-recovery-hash',
  '{}',
  '2026-01-01',
  'fixture-epoch',
);
db.prepare('INSERT INTO heads VALUES (?, 0, 0, 0)').run('fixture-unclaimed');
db.close();
// 明确的测试凭证，只能用于此一次性回环验收环境。
const token = 'fixture-admin-token-for-test-only-012345678901234567890';
const children = [
  spawn(process.execPath, ['tools/sync-server/start.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      DRAMATIS_SYNC_HOST: '127.0.0.1',
      DRAMATIS_SYNC_PORT: '17887',
      DRAMATIS_SYNC_DATA: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
  spawn(process.execPath, ['tools/sync-admin/start.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      DRAMATIS_ADMIN_HOST: '127.0.0.1',
      DRAMATIS_ADMIN_PORT: '17888',
      DRAMATIS_ADMIN_SYNC_PORT: '17887',
      DRAMATIS_ADMIN_DATA: dbPath,
      DRAMATIS_ADMIN_AUDIT: join(data, 'audit.jsonl'),
      DRAMATIS_ADMIN_TOKEN: token,
      DRAMATIS_ADMIN_BACKUPS: join(data, 'backups'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
];
for (const child of children)
  child.on('exit', (code) => {
    if (code) stop();
  });
const proxy = createServer((request, response) => {
  void (async () => {
    const path = new URL(request.url, 'http://127.0.0.1:17880').pathname;
    if (path.startsWith('/sync/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = { ...request.headers, host: '127.0.0.1:17880' };
      const result = await fetch(`http://127.0.0.1:17887${request.url.slice(5)}`, {
        method: request.method,
        headers,
        ...(body.length ? { body } : {}),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const file = resolve(root, 'apps/web/dist', `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${join(root, 'apps/web/dist')}${process.platform === 'win32' ? '\\' : '/'}`)) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const types = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
      };
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404);
      response.end();
    }
  })().catch(() => {
    response.writeHead(503);
    response.end();
  });
});
function stop() {
  proxy.close();
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
proxy.listen(17880, '127.0.0.1', () =>
  process.stdout.write(`SMOKE_DIRECTORY=${data}\nWEB=http://127.0.0.1:17880\nADMIN=http://127.0.0.1:17888\n`),
);
