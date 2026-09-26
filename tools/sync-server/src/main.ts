import { mkdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import {
  applySqlitePragmas,
  createSqliteSyncStore,
  createSyncServer,
  handleSyncRequest,
  resolveClientKey,
  type SyncServerLimits,
} from '../../../packages/core/src/index.js';

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
  /**
   * 护栏（顺序 16）。默认值写在核心里（`DEFAULT_SYNC_LIMITS`），
   * 这里留几个口子让运维可以按自己的机器调，不用改代码。
   */
  limits: Partial<SyncServerLimits>;
  /**
   * 前面有几层可信反向代理（审计 A8，默认 1）。限流认来源时从 `X-Forwarded-For`
   * 的右边数这么多跳（一层时优先 `X-Real-IP`）；0 = 不信任何转发头。
   */
  trustedProxyHops: number;
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

  /** 只在「给了且是个正整数」时才覆盖默认护栏：写错一个字符不该把服务端变成没有护栏。 */
  const positive = (flag: string, variable: string): number | undefined => {
    const raw = pick(flag, variable);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const maxRecords = positive('max-records', 'DRAMATIS_SYNC_MAX_RECORDS');
  const maxMb = positive('max-mb', 'DRAMATIS_SYNC_MAX_MB');
  const pushesPerMinute = positive('pushes-per-minute', 'DRAMATIS_SYNC_PUSHES_PER_MINUTE');
  const spacesPerMinute = positive('spaces-per-minute', 'DRAMATIS_SYNC_SPACES_PER_MINUTE');
  const maxSpaces = positive('max-spaces', 'DRAMATIS_SYNC_MAX_SPACES');
  const metaReadsPerMinute = positive('meta-reads-per-minute', 'DRAMATIS_SYNC_META_READS_PER_MINUTE');
  const hopsRaw = pick('trusted-proxy-hops', 'DRAMATIS_SYNC_TRUSTED_PROXY_HOPS');
  const hops = hopsRaw === undefined ? Number.NaN : Number(hopsRaw);
  const limits: Partial<SyncServerLimits> = {
    ...(maxRecords === undefined ? {} : { maxRecordsPerSpace: maxRecords }),
    ...(maxMb === undefined ? {} : { maxBytesPerSpace: maxMb * 1024 * 1024 }),
    ...(pushesPerMinute === undefined ? {} : { pushesPerMinute }),
    ...(spacesPerMinute === undefined ? {} : { spacesPerMinute }),
    ...(maxSpaces === undefined ? {} : { maxSpaces }),
    ...(metaReadsPerMinute === undefined ? {} : { metaReadsPerMinute }),
  };

  return {
    dataPath: resolve(pick('data', 'DRAMATIS_SYNC_DATA') ?? DEFAULT_DATA),
    host: pick('host', 'DRAMATIS_SYNC_HOST') ?? DEFAULT_HOST,
    port: Number(pick('port', 'DRAMATIS_SYNC_PORT') ?? DEFAULT_PORT),
    allowedOrigins: origins,
    tls:
      certPath !== undefined && keyPath !== undefined
        ? { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
        : null,
    limits,
    // 写错（负数、非整数）就退回默认的 1 层，而不是变成「谁的头都信」
    trustedProxyHops: Number.isInteger(hops) && hops >= 0 && hops <= 10 ? hops : 1,
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

/**
 * 请求体上限：正常同步一次几 KB 到几百 KB（客户端 200 条一包），8 MB 是宽容的防线。
 *
 * 不降到 1-2 MB（审计 A7 的建议之一）：一包 200 条长消息可能超过 2 MB，超了客户端
 * 那一包就永远推不上去。磁盘被刷满的风险由「整行计配额 + 字段长度上限」挡住。
 * 放在 nginx 后面时，`client_max_body_size` 要不小于这个值（见 SYNC-DEPLOY.md）。
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 请求体超限（审计 C9）：回 413，而不是笼统的 500。 */
class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  // 声明了长度就先看一眼：明摆着超的不必读进内存
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLargeError('请求体太大');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError('请求体太大');
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
  // WAL + busy_timeout（顺序 61）：服务端写入与 6 小时一次的备份不再互相顶掉
  applySqlitePragmas(db);
  const store = createSqliteSyncStore(db);
  const server = createSyncServer(store, { limits: config.limits });
  const startedAt = Date.now();

  const log = (line: string): void => {
    if (config.quiet) return;
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  };
  /** 内部异常只进服务端日志（stderr，quiet 也照写），不回给客户端（审计 C9）。 */
  const logError = (where: string, error: unknown): void => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`${new Date().toISOString()} [error] ${where} ${detail}\n`);
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

        /*
         * 给公开接口限流用的「来源」（顺序 61，审计 A8）。
         *
         * 站在 nginx 后面时 socket 地址永远是 127.0.0.1，那样限流就退化成
         * 「全服务器共用一个窗口」——所以**来自本机**的请求才看转发头，而且从右边数：
         * `X-Real-IP`（一层代理时）或 `X-Forwarded-For` 的倒数第 N 跳。以前取第一跳，
         * 那是客户端自己能填的。规则写在内核的 `resolveClientKey` 里，有单测。
         */
        const clientKey = resolveClientKey({
          socketAddress: request.socket.remoteAddress ?? '',
          headers: request.headers,
          trustedProxyHops: config.trustedProxyHops,
        });

        const handled = await handleSyncRequest(
          new Request(`http://${host}${path}`, {
            method: request.method ?? 'GET',
            headers,
            ...(body === undefined ? {} : { body }),
          }),
          {
            server,
            cors: { allowedOrigins: config.allowedOrigins },
            ...(clientKey === '' ? {} : { clientKey }),
            onInternalError: (error) => {
              logError(`${request.method ?? 'GET'} ${path.split('?')[0] ?? ''}`, error);
            },
          },
        );

        const text = await handled.text();
        response.statusCode = handled.status;
        handled.headers.forEach((value: string, key: string) => {
          response.setHeader(key, value);
        });
        response.end(text);
      } catch (error) {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        if (error instanceof BodyTooLargeError) {
          response.statusCode = 413;
          response.end(
            JSON.stringify({
              error: {
                code: 'payload-too-large',
                message: `请求体太大（上限 ${String(MAX_BODY_BYTES / 1024 / 1024)} MB）。`,
              },
            }),
          );
          return;
        }
        // 审计 C9：异常原文（可能带路径、SQL）只进日志，对外一句通用的话
        logError(`${request.method ?? 'GET'} ${path.split('?')[0] ?? ''}`, error);
        response.statusCode = 500;
        response.end(JSON.stringify({ error: { code: 'internal', message: '服务端出错了，请稍后再试。' } }));
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
        `  可信代理：${String(config.trustedProxyHops)} 层（限流认来源时从 X-Forwarded-For 右边数；0 = 只看 socket）`,
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
