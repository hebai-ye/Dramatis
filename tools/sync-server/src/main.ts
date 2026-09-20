import { mkdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSyncStore, createSyncServer, handleSyncRequest } from '../../../packages/core/src/index.js';

/**
 * 独立同步服务端（P2-6 第四步·部署）。
 *
 * 它就是「`handleSyncRequest` + SQLite」的一个宿主：协议、鉴权、游标、合并
 * 全在内核里（与内存服务端、Cloudflare Worker 共用同一份代码），这里只负责
 * HTTP、配置、日志、进程信号。
 *
 * **它拿不到明文**：库里只有坐标、密文、两份凭证哈希、两份钥匙封装。
 * 日志里也**不打印** Authorization 头与请求体——那两样是最容易被顺手写进
 * 日志的敏感信息。
 *
 * 配置一律走环境变量或命令行参数（见 `.env.example`），不读任何文件里的密钥；
 * 这样仓库里不会、也不需要出现你个人的任何设置。
 */

export interface ServerConfig {
  dataPath: string;
  host: string;
  port: number;
  /** 允许跨域调用的来源；空数组 = 只允许同源。 */
  allowedOrigins: readonly string[];
  /** 配了就用 HTTPS 直接对外（适合自签证书或已有证书的场景）。 */
  tls: { cert: string; key: string } | null;
  quiet: boolean;
}

const DEFAULT_DATA = './data/sync.db';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

/** 解析配置：命令行参数优先于环境变量，都没给就用默认值。 */
export function readConfig(argv: readonly string[], env: Record<string, string | undefined>): ServerConfig {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const [name, inline] = token.slice(2).split('=');
    if (name === undefined) continue;
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, 'true');
    }
  }

  const pick = (flag: string, variable: string): string | undefined => flags.get(flag) ?? env[variable];
  const origins = (pick('origins', 'DRAMATIS_SYNC_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  const certPath = pick('tls-cert', 'DRAMATIS_SYNC_TLS_CERT');
  const keyPath = pick('tls-key', 'DRAMATIS_SYNC_TLS_KEY');

  return {
    dataPath: resolve(pick('data', 'DRAMATIS_SYNC_DATA') ?? DEFAULT_DATA),
    host: pick('host', 'DRAMATIS_SYNC_HOST') ?? DEFAULT_HOST,
    port: Number(pick('port', 'DRAMATIS_SYNC_PORT') ?? DEFAULT_PORT),
    allowedOrigins: origins,
    tls:
      certPath !== undefined && keyPath !== undefined
        ? { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
        : null,
    quiet: flags.has('quiet') || env.DRAMATIS_SYNC_QUIET === '1',
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> | undefined {
  if (chunks.length === 0) return undefined;
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 请求体上限：正常同步一次几 KB，给 8 MB 已经是宽容的防线。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  return concat(chunks);
}

export interface RunningServer {
  stop(): Promise<void>;
}

/** 起服务。返回一个可以停掉它的句柄（单测/脚本都用得上）。 */
export function startServer(config: ServerConfig): RunningServer {
  mkdirSync(dirname(config.dataPath), { recursive: true });
  const db = new DatabaseSync(config.dataPath);
  const store = createSqliteSyncStore(db);
  const server = createSyncServer(store);
  const startedAt = Date.now();

  const log = (line: string): void => {
    if (config.quiet) return;
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const started = Date.now();
      const path = request.url ?? '/';
      try {
        // 健康检查：给运维/探活用，不碰数据库
        if (path === '/' || path.startsWith('/health')) {
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ ok: true, uptimeMs: Date.now() - startedAt }));
          return;
        }

        const host = typeof request.headers.host === 'string' ? request.headers.host : '127.0.0.1';
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value === undefined) continue;
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const body = await readBody(request);

        const handled = await handleSyncRequest(
          new Request(`http://${host}${path}`, {
            method: request.method ?? 'GET',
            headers,
            ...(body === undefined ? {} : { body }),
          }),
          { server, cors: { allowedOrigins: config.allowedOrigins } },
        );

        const text = await handled.text();
        response.statusCode = handled.status;
        handled.headers.forEach((value: string, key: string) => {
          response.setHeader(key, value);
        });
        response.end(text);
      } catch (error) {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(
          JSON.stringify({
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          }),
        );
      } finally {
        // 只记方法、路径、状态、耗时——**不记 Authorization，也不记请求体**
        const status = response.statusCode;
        log(`${request.method ?? 'GET'} ${path} → ${String(status)} (${String(Date.now() - started)} ms)`);
      }
    })();
  };

  const http = config.tls === null ? createHttpServer(handler) : createHttpsServer(config.tls, handler);

  http.listen(config.port, config.host, () => {
    const scheme = config.tls === null ? 'http' : 'https';
    log(
      [
        'Dramatis 同步服务端已启动',
        `  监听：${scheme}://${config.host}:${String(config.port)}`,
        `  数据：${config.dataPath}`,
        `  跨源：${config.allowedOrigins.length === 0 ? '只允许同源（没配 DRAMATIS_SYNC_ORIGINS）' : config.allowedOrigins.join('、')}`,
        '  提示：服务端只存密文与哈希，日志不记录凭证与请求体。',
      ].join('\n'),
    );
  });

  return {
    stop: () =>
      new Promise<void>((resolveStop) => {
        http.close(() => {
          db.close();
          resolveStop();
        });
      }),
  };
}

/** 直接 `node start.mjs` 时走到这里。 */
function main(): void {
  const config = readConfig(process.argv.slice(2), process.env);
  const server = startServer(config);

  const shutdown = (): void => {
    void server.stop().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
