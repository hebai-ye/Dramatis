/**
 * 同步协议的 HTTP 外壳（P2-6 第四步）。
 *
 * 一个 `handleSyncRequest(request, deps) => Response` 把 `SyncServer` 暴露成
 * 五个路由，**开发后端与 Cloudflare Worker 共用它**——两边只有存储适配器不同。
 * 用 fetch 风格的 Request / Response（浏览器、Node 18+、Workers 都有），
 * 所以这份代码不依赖任何一家平台的类型。
 *
 * ```
 * POST /spaces                                登记一个新空间（首次同步时自动做）
 * GET  /spaces/{handle}                       取空间元数据（两份哈希 + 两份钥匙封装）
 * GET  /spaces/{handle}/head                  只问「现在到第几号」
 * POST /spaces/{handle}/push                  推记录（坐标 + 密文）
 * GET  /spaces/{handle}/pull?since=&limit=    拉记录
 * ```
 *
 * **开放与封闭**：
 * - `POST /spaces` 与 `GET /spaces/{handle}` 是**公开**的：加入空间的人必须先
 *   拿到「钥匙封装」才能解出主密钥，而那时候他还没有凭证。里面只有哈希与密文
 *   ——拿到也解不开（`SYNC §4.6`）。
 * - `head` / `push` / `pull` 一律要 `Authorization: Bearer <凭证>`。
 * - 空间之间的数据完全隔离：记录按 `spaceHandle` 分表，句柄不匹配就查不到。
 *
 * 这不是 HTTPS 的替代品：**密码学上的安全来自端到端加密**，HTTPS 只是防止
 * 中间人看到「谁在什么时候同步了多少条」。
 */

import type { EncryptedRecord } from '../crypto/records.js';
import { type CreateSyncSpaceInput, type SyncServer, SyncServerError } from './server.js';
import { SYNC_COLLECTIONS, type SyncCollection, type SyncWireRecord } from './types.js';

export interface SyncHttpDeps {
  server: SyncServer;
  /** 服务端自己的时间（用于记录 `createdAt`），缺省取当前时刻。 */
  now?: () => string;
  /**
   * 允许哪些源跨域调用（P2-6 第四步·部署）。
   *
   * 为什么需要它：应用可能跑在 `http://127.0.0.1:5273`（浏览器里 WebCrypto 只在
   * 安全上下文可用，所以应用多半开在 localhost），而同步服务在另一台机器上——
   * 那就是**跨源**请求，浏览器会先发一个 `OPTIONS` 预检（因为我们带了
   * `Authorization` 头）。不配这一项时行为不变：不加任何 CORS 头，只允许同源调用。
   *
   * 只接受**精确匹配**的源，或者 `'*'`（不推荐：任何网页都能调用你的服务端；
   * 虽然拿不到凭证就没有数据，但没有必要放开）。
   */
  cors?: { allowedOrigins: readonly string[] };
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** 给响应挂上 CORS 头（只在配了 `cors` 时）。 */
function withCors(response: Response, origin: string | null, allowed: readonly string[]): Response {
  if (origin === null) return response;
  const permit = allowed.includes('*') || allowed.includes(origin);
  if (!permit) return response;

  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', allowed.includes('*') ? '*' : origin);
  // 带上 origin 才能让缓存按源分开：否则一个源拿到另一个源的响应
  headers.append('vary', 'origin');
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  headers.set('access-control-allow-headers', 'authorization, content-type');
  headers.set('access-control-max-age', '600');
  return new Response(response.body, { status: response.status, headers });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? '';
}

function isCollection(value: unknown): value is SyncCollection {
  return typeof value === 'string' && (SYNC_COLLECTIONS as readonly string[]).includes(value);
}

/** 把线上那条记录校验成我们要的形状。坏数据一律 400，别让它进库。 */
function readWireRecord(value: unknown): SyncWireRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (!isCollection(record.collection)) return null;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.updatedAt !== 'string' || record.updatedAt === '') return null;

  const deletedAt = record.deletedAt;
  if (deletedAt !== null && typeof deletedAt !== 'string') return null;

  const sealed = asRecord(record.sealed);
  if (sealed === null) return null;
  if (sealed.algorithm !== 'AES-256-GCM') return null;
  if (typeof sealed.iv !== 'string' || typeof sealed.ciphertext !== 'string') return null;

  return {
    collection: record.collection,
    id: record.id,
    updatedAt: record.updatedAt,
    deletedAt,
    sealed: { algorithm: 'AES-256-GCM', iv: sealed.iv, ciphertext: sealed.ciphertext } as EncryptedRecord,
  };
}

function readCreateSpace(value: unknown): CreateSyncSpaceInput | null {
  const body = asRecord(value);
  if (body === null) return null;
  const { spaceHandle, credentialHash, recoveryCredentialHash } = body;
  if (typeof spaceHandle !== 'string' || spaceHandle === '') return null;
  if (typeof credentialHash !== 'string' || credentialHash === '') return null;
  if (typeof recoveryCredentialHash !== 'string' || recoveryCredentialHash === '') return null;

  const wraps = asRecord(body.keyWraps);
  // 未知形状的键值对：服务端照存照还，不解释
  return {
    spaceHandle,
    credentialHash,
    recoveryCredentialHash,
    keyWraps: wraps ?? {},
    at: typeof body.at === 'string' && body.at !== '' ? body.at : new Date().toISOString(),
  };
}

/**
 * 路由。返回值一律是 `Response`——路由之外没有别的出口，所以两种宿主
 * （vite 中间件、Worker）都只需要把请求喂进来。
 */
export async function handleSyncRequest(request: Request, deps: SyncHttpDeps): Promise<Response> {
  const response = await route(request, deps);
  if (deps.cors === undefined) return response;

  const origin = request.headers.get('origin');
  const allowed = deps.cors.allowedOrigins;
  // 白名单为空 = 「只跑同源」：不加任何 CORS 头，也不拒绝。
  //
  // 为什么不能顺手把空名单当成「谁都不许」：浏览器**发 POST 时连
  // 同源请求也会带 Origin 头**（fetch 规范如此）。真按"空名单就拒绝"实现，
  // 同一个域名下打开的网页会连自己的后端都调不动——部署到服务器当天就踩到了。
  // 跨源页面拿不到 CORS 头，浏览器本来就不会把响应交给它，安全性并不因此降低。
  if (allowed.length > 0 && origin !== null && !allowed.includes('*') && !allowed.includes(origin)) {
    // 明确回 403，而不是默默不加头——后者在浏览器里只报一句含糊的 CORS 错误
    return fail(403, 'origin-not-allowed', '这个来源没有被允许调用同步服务端。');
  }
  return withCors(response, origin, allowed);
}

async function route(request: Request, deps: SyncHttpDeps): Promise<Response> {
  const url = new URL(request.url);
  const now = deps.now ?? (() => new Date().toISOString());
  const segments = url.pathname.split('/').filter((part) => part !== '');

  // 跨源预检：只回头，不碰业务（浏览器只关心能不能发那个真请求）
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }

  // /sync/spaces... —— 前缀里的 `sync` 可有可无（Worker 挂在根上，vite 挂在 /sync 下）
  const start = segments[0] === 'sync' ? 1 : 0;
  const [first, second, third] = [segments[start], segments[start + 1], segments[start + 2]];

  if (first !== 'spaces') return fail(404, 'not-found', '没有这个接口。');

  // POST /spaces —— 登记新空间
  if (second === undefined) {
    if (request.method !== 'POST') return fail(405, 'method-not-allowed', '建空间用 POST。');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'bad-request', '请求体不是合法 JSON。');
    }

    const input = readCreateSpace(body);
    if (input === null) {
      return fail(400, 'bad-request', '建空间需要 spaceHandle、credentialHash、recoveryCredentialHash 三个字段。');
    }

    try {
      const result = await deps.server.createSpace({ ...input, at: input.at === '' ? now() : input.at });
      if (result === 'exists') {
        // 不覆盖：这个 id 已经被占了。调用方该做的是「直接同步」，而不是换空间
        return fail(409, 'space-exists', '这个 id 已经有人用了。如果你就是在别处建过它，直接同步即可；否则换一个 id。');
      }
      return json({ status: result }, 201);
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  const spaceHandle = second;
  const rest = third;

  // GET /spaces/{handle} —— 空间元数据（公开：加入的人先拿它才能解主密钥）
  if (rest === undefined) {
    if (request.method !== 'GET') return fail(405, 'method-not-allowed', '取空间元数据用 GET。');
    const space = await deps.server.getSpaceMeta(spaceHandle);
    if (space === null) return fail(404, 'space-not-found', '这个空间不存在。');
    return json({
      spaceHandle: space.spaceHandle,
      credentialHash: space.credentialHash,
      recoveryCredentialHash: space.recoveryCredentialHash,
      keyWraps: space.keyWraps,
      createdAt: space.createdAt,
    });
  }

  const credentials = { spaceHandle, credential: bearer(request) };

  if (rest === 'head') {
    if (request.method !== 'GET') return fail(405, 'method-not-allowed', 'head 用 GET。');
    try {
      return json(await deps.server.head(credentials));
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  if (rest === 'push') {
    if (request.method !== 'POST') return fail(405, 'method-not-allowed', 'push 用 POST。');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'bad-request', '请求体不是合法 JSON。');
    }
    const record = asRecord(body);
    if (record === null || !Array.isArray(record.records)) {
      return fail(400, 'bad-request', 'push 的请求体要有 records 数组。');
    }

    const records: SyncWireRecord[] = [];
    for (const item of record.records) {
      const wire = readWireRecord(item);
      if (wire === null) return fail(400, 'bad-request', '有一条记录的形状不对（集合名 / id / 密文）。');
      if (typeof item === 'object' && item !== null && typeof (item as { deviceId?: unknown }).deviceId === 'string') {
        wire.deviceId = (item as { deviceId: string }).deviceId;
      }
      records.push(wire);
    }

    try {
      return json(
        await deps.server.push({
          ...credentials,
          baseHead: typeof record.baseHead === 'number' ? record.baseHead : 0,
          records,
        }),
      );
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  if (rest === 'pull') {
    if (request.method !== 'GET') return fail(405, 'method-not-allowed', 'pull 用 GET。');
    const since = Number(url.searchParams.get('since') ?? '0');
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam === null ? undefined : Number(limitParam);

    try {
      return json(await deps.server.pull({ ...credentials, since, ...(limit === undefined ? {} : { limit }) }));
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  // GET /spaces/{handle}/devices —— 这个空间最近有哪些设备在写（顺序 14）
  if (rest === 'devices') {
    if (request.method !== 'GET') return fail(405, 'method-not-allowed', 'devices 用 GET。');
    try {
      return json(await deps.server.devices(credentials));
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  // POST /spaces/{handle}/rotate —— 换同步密码（顺序 15）
  if (rest === 'rotate') {
    if (request.method !== 'POST') return fail(405, 'method-not-allowed', 'rotate 用 POST。');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'bad-request', '请求体不是合法 JSON。');
    }
    const record = asRecord(body);
    const credentialHash = typeof record?.credentialHash === 'string' ? record.credentialHash : '';
    if (credentialHash === '' || record?.passwordWrap === undefined) {
      return fail(400, 'bad-request', 'rotate 需要 credentialHash 与 passwordWrap 两个字段。');
    }

    try {
      await deps.server.rotatePassword({
        ...credentials,
        credentialHash,
        passwordWrap: record.passwordWrap,
      });
      return json({ status: 'rotated' });
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  return fail(404, 'not-found', '没有这个接口。');
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof SyncServerError) return fail(error.status, error.code, error.message);
  const message = error instanceof Error ? error.message : String(error);
  return fail(500, 'internal', `服务端出错了：${message}`);
}
