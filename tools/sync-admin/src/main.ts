import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { appendAudit } from './audit.js';
import { type BackupStatus, createAdminHandler } from './http.js';
import { createAdminOperations } from './operations.js';
import { createAdminStore } from './store.js';

export function readAdminConfig(env: Record<string, string | undefined>) {
  if (env.DRAMATIS_ADMIN_HOST !== undefined && env.DRAMATIS_ADMIN_HOST !== '127.0.0.1') {
    throw new Error('管理服务只能监听 127.0.0.1。');
  }
  const port = Number(env.DRAMATIS_ADMIN_PORT ?? '8788');
  const healthPort = Number(env.DRAMATIS_ADMIN_SYNC_PORT ?? '8787');
  if (![port, healthPort].every((value) => Number.isInteger(value) && value > 0 && value <= 65535)) {
    throw new Error('端口必须是 1 到 65535 的整数。');
  }
  if (!env.DRAMATIS_ADMIN_DATA || !env.DRAMATIS_ADMIN_TOKEN || !env.DRAMATIS_ADMIN_AUDIT) {
    throw new Error('必须配置 DRAMATIS_ADMIN_DATA / TOKEN / AUDIT。');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(env.DRAMATIS_ADMIN_TOKEN)) throw new Error('管理 token 格式不安全。');
  if (env.DRAMATIS_ADMIN_WRITE !== undefined && !['0', '1'].includes(env.DRAMATIS_ADMIN_WRITE))
    throw new Error('写开关无效。');
  const writeEnabled = env.DRAMATIS_ADMIN_WRITE === '1';
  const defaultMaxBytes = Number(env.DRAMATIS_ADMIN_DEFAULT_MAX_MB ?? '256') * 1024 ** 2;
  if (!Number.isSafeInteger(defaultMaxBytes) || defaultMaxBytes <= 0 || defaultMaxBytes > 1024 ** 4)
    throw new Error('默认配额无效。');
  if (writeEnabled && !env.DRAMATIS_ADMIN_BACKUPS) throw new Error('可编辑管理台必须配置备份目录。');
  const dataPath = resolve(env.DRAMATIS_ADMIN_DATA);
  const auditPath = resolve(env.DRAMATIS_ADMIN_AUDIT);
  const databasePaths = [dataPath, `${dataPath}-wal`, `${dataPath}-shm`, `${dataPath}-journal`];
  if (!auditPath.endsWith('.jsonl') || databasePaths.some((path) => path.toLowerCase() === auditPath.toLowerCase())) {
    throw new Error('审计必须是独立的 .jsonl 文件。');
  }
  if (existsSync(auditPath)) {
    const audit = lstatSync(auditPath);
    if (
      audit.isSymbolicLink() ||
      !audit.isFile() ||
      databasePaths.some((path) => {
        if (!existsSync(path)) return false;
        const database = lstatSync(path);
        return database.dev === audit.dev && database.ino === audit.ino;
      })
    )
      throw new Error('审计路径不能指向数据库或链接文件。');
  }
  return {
    port,
    healthPort,
    dataPath,
    token: env.DRAMATIS_ADMIN_TOKEN,
    auditPath,
    backupPath: env.DRAMATIS_ADMIN_BACKUPS ? resolve(env.DRAMATIS_ADMIN_BACKUPS) : null,
    writeEnabled,
    defaultMaxBytes,
  };
}

export function backupStatus(path: string | null, dbName: string): BackupStatus {
  if (path === null || !existsSync(path)) return { available: false, files: [] };
  try {
    const files = readdirSync(path)
      .filter((name) => name.startsWith(`${dbName}.`) && name.endsWith('.bak'))
      .map((file) => {
        const stat = lstatSync(join(path, file));
        return stat.isFile() && !stat.isSymbolicLink()
          ? { file, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
          : null;
      })
      .filter((file) => file !== null)
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, 100);
    return { available: true, files };
  } catch {
    return { available: false, files: [] };
  }
}

export function startAdmin(config: ReturnType<typeof readAdminConfig>) {
  const store = createAdminStore(config.dataPath, config.defaultMaxBytes);
  let operations: ReturnType<typeof createAdminOperations> | undefined;
  try {
    mkdirSync(dirname(config.auditPath), { recursive: true });
    appendAudit(config.auditPath, { action: 'startup', status: 200, durationMs: 0 });
    if (config.writeEnabled && config.backupPath)
      operations = createAdminOperations({
        dataPath: config.dataPath,
        backupPath: config.backupPath,
        defaultMaxBytes: config.defaultMaxBytes,
        audit: (event) => appendAudit(config.auditPath, event),
      });
    const web = fileURLToPath(new URL('../web/', import.meta.url));
    const handler = createAdminHandler({
      store,
      ...(operations ? { operations } : {}),
      token: config.token,
      port: config.port,
      assets: {
        html: readFileSync(join(web, 'index.html'), 'utf8'),
        js: readFileSync(join(web, 'app.js'), 'utf8'),
        css: readFileSync(join(web, 'style.css'), 'utf8'),
      },
      audit: (event) => appendAudit(config.auditPath, event),
      backupStatus: () => backupStatus(config.backupPath, basename(config.dataPath)),
      syncHealth: async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${config.healthPort}/health`, {
            signal: AbortSignal.timeout(1500),
          });
          const body = (await response.json()) as { ok?: unknown; uptimeMs?: unknown };
          return {
            ok: response.ok && body.ok === true,
            ...(typeof body.uptimeMs === 'number' && body.uptimeMs >= 0 ? { uptimeMs: body.uptimeMs } : {}),
          };
        } catch {
          return { ok: false };
        }
      },
    });
    const server = createServer((request, response) => {
      void (async () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        // Host 由处理器检查；构造 URL 固定来源以免攻击者把服务端变成代理。
        let body: Uint8Array<ArrayBuffer> | undefined;
        if (request.method === 'POST') {
          const parts: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.byteLength;
            if (size > 4096) {
              response.statusCode = 413;
              response.end('请求体过大。');
              return;
            }
            parts.push(chunk);
          }
          body = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            body.set(part, offset);
            offset += part.byteLength;
          }
        }
        const handled = await handler(
          new Request(`http://127.0.0.1:${config.port}${request.url ?? '/'}`, {
            method: request.method ?? 'GET',
            headers,
            ...(body ? { body } : {}),
          }),
        );
        response.statusCode = handled.status;
        handled.headers.forEach((value, name) => {
          response.setHeader(name, value);
        });
        response.end(await handled.text());
      })().catch(() => {
        response.statusCode = 503;
        response.end('管理服务暂不可用。');
      });
    });
    server.on('error', () => {
      operations?.close();
      store.close();
      process.stderr.write('管理服务监听失败。\n');
      process.exit(1);
    });
    server.listen(config.port, '127.0.0.1', () => {
      process.stdout.write(`Dramatis 管理台：http://127.0.0.1:${config.port}\n`);
    });
    return {
      stop: () =>
        new Promise<void>((done) => {
          server.close(() => {
            operations?.close();
            store.close();
            done();
          });
        }),
    };
  } catch (error) {
    operations?.close();
    store.close();
    throw error;
  }
}
