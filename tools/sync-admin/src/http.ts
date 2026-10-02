import { timingSafeEqual } from 'node:crypto';
import type { AuditEvent } from './audit.js';
import { AdminOperationError, type createAdminOperations } from './operations.js';
import type { AdminStore } from './store.js';
import { VIP_PLANS } from './vip-plans.js';

export interface BackupStatus {
  available: boolean;
  files: { file: string; bytes: number; modifiedAt: string }[];
}

interface Options {
  store: AdminStore;
  token: string;
  port: number;
  assets: { html: string; js: string; css: string };
  audit(event: AuditEvent): void;
  backupStatus(): BackupStatus;
  syncHealth(): Promise<{ ok: boolean; uptimeMs?: number }>;
  operations?: ReturnType<typeof createAdminOperations>;
}

const SECURITY = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** 管理服务只接受固定本机来源；受控写单独确认，token 不接受查询参数。 */
export function createAdminHandler(options: Options) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(options.token))
    throw new Error('管理 token 必须是至少 32 随机字节生成的 base64url 值。');
  const expected = new TextEncoder().encode(options.token);
  const authority = `127.0.0.1:${options.port}`;
  const origin = `http://${authority}`;
  return async (request: Request): Promise<Response> => {
    const started = Date.now();
    let action = 'request-denied';
    const finish = (
      status: number,
      body: unknown,
      type = 'application/json; charset=utf-8',
      audit = true,
    ): Response => {
      if (audit) options.audit({ action, status, durationMs: Date.now() - started });
      return new Response(type.startsWith('application/json') ? JSON.stringify(body) : String(body), {
        status,
        headers: { ...SECURITY, 'content-type': type },
      });
    };
    try {
      const url = new URL(request.url);
      if (
        url.origin !== origin ||
        request.headers.get('host') !== authority ||
        (request.headers.has('origin') && request.headers.get('origin') !== origin) ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      )
        return finish(403, { error: 'origin-denied' });
      if (request.method === 'OPTIONS') return finish(403, { error: 'origin-denied' });
      const changeRoute = ['/api/changes/prepare', '/api/changes/commit'].includes(url.pathname);
      if (request.method !== 'GET' && !(request.method === 'POST' && changeRoute && options.operations))
        return finish(405, { error: 'read-only' });
      const assets = new Map([
        ['/', [options.assets.html, 'text/html; charset=utf-8']],
        ['/app.js', [options.assets.js, 'text/javascript; charset=utf-8']],
        ['/style.css', [options.assets.css, 'text/css; charset=utf-8']],
      ]);
      const asset = assets.get(url.pathname);
      if (asset !== undefined) {
        if (url.search !== '') return finish(400, { error: 'query-denied' });
        action = 'static';
        return finish(200, asset[0], asset[1]);
      }
      if (!url.pathname.startsWith('/api/')) return finish(404, { error: 'not-found' });
      const proof = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
      const received = new TextEncoder().encode(proof);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        return finish(401, { error: 'unauthorized' });
      }
      const allowedQueries = url.pathname === '/api/spaces' ? ['q', 'offset', 'limit'] : [];
      if ([...url.searchParams.keys()].some((key) => !allowedQueries.includes(key))) {
        return finish(400, { error: 'query-denied' });
      }
      if (request.method === 'POST' && options.operations) {
        if (request.headers.get('origin') !== origin) return finish(403, { error: 'origin-denied' });
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
          return finish(415, { error: 'json-required' });
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > 4096) return finish(413, { error: 'payload-too-large' });
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return finish(400, { error: 'bad-json' });
        }
        action = url.pathname.endsWith('/prepare') ? 'change-prepare' : 'change-commit';
        return action === 'change-prepare'
          ? finish(200, options.operations.prepare(input))
          : finish(200, options.operations.commit(input), 'application/json; charset=utf-8', false);
      }
      if (url.pathname === '/api/plans') {
        action = 'plans-list';
        return finish(200, { plans: VIP_PLANS });
      }
      if (url.pathname === '/api/overview') {
        action = 'overview';
        const health = await options.syncHealth();
        return finish(200, {
          ...options.store.overview(),
          editingEnabled: !!options.operations,
          syncHealth: health,
          backups: options.backupStatus(),
        });
      }
      if (url.pathname === '/api/spaces') {
        action = 'spaces-list';
        const offset = url.searchParams.get('offset') ?? '0';
        const limit = url.searchParams.get('limit') ?? '50';
        const search = url.searchParams.get('q') ?? '';
        if (
          !/^\d{1,7}$/.test(offset) ||
          !/^\d{1,3}$/.test(limit) ||
          Number(offset) > 1_000_000 ||
          Number(limit) < 1 ||
          Number(limit) > 100 ||
          search.length > 128
        ) {
          return finish(400, { error: 'bad-pagination' });
        }
        return finish(200, options.store.list({ offset: Number(offset), limit: Number(limit), search }));
      }
      const detail = /^\/api\/spaces\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
      if (detail?.[1] !== undefined) {
        action = 'space-detail';
        const result = options.store.detail(detail[1]);
        return finish(result === null ? 404 : 200, result ?? { error: 'space-not-found' });
      }
      return finish(404, { error: 'not-found' });
    } catch (error) {
      if (error instanceof AdminOperationError) {
        try {
          return finish(error.status, { error: error.code, message: error.message });
        } catch {
          /* 审计失败时关闭响应。 */
        }
      }
      // 审计写失败也关闭数据出口；不在错误响应中回显路径、SQL 或请求资料。
      return new Response(JSON.stringify({ error: 'admin-unavailable' }), {
        status: 503,
        headers: { ...SECURITY, 'content-type': 'application/json' },
      });
    }
  };
}
