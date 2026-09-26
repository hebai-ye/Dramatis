/**
 * 本地助手的访问策略（审计 A1 / A13）：纯函数，便于单测。
 *
 * - Origin 白名单：只放行正式站点与本机开发端口，外加用户显式配置的来源；
 *   永远不回 `access-control-allow-origin: *`。
 * - Host 校验：必须是 `127.0.0.1:PORT` 或 `localhost:PORT`，挡 DNS rebinding。
 * - 可选配对令牌：设置后要求 `Authorization: Bearer <token>`。
 * - 输入上限：请求体 1MB，timeoutMs 夹在 5 秒到 600 秒。
 */

import { timingSafeEqual } from 'node:crypto';

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://dramatissync.com:8443',
  'https://dramatissync.com',
  'http://127.0.0.1:5273',
  'http://localhost:5273',
]);

export const MAX_BODY_BYTES = 1024 * 1024;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 180_000;
/** 正在跑的一个 + 排队的最多这么多个；再多就 429。 */
export const MAX_QUEUED_ASKS = 2;

/** 把 `a,b , c` 这类逗号分隔的来源列表解析成规范化的 origin 数组；非法项抛错。 */
export function parseOriginList(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => {
      let parsed;
      try {
        parsed = new URL(item);
      } catch {
        throw new Error(`额外来源不是合法地址：${item}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`额外来源只能是 http/https：${item}`);
      }
      return parsed.origin;
    });
}

/** 校验端口：1-65535 的整数，否则抛出带来源说明的错误。 */
export function parsePort(raw, fallback, label) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} 必须是 1-65535 的整数，收到的是「${String(raw)}」。`);
  }
  return value;
}

/** Host 头是否指向本机这个端口（大小写不敏感）。 */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`;
}

/** Origin 是否在白名单里。没有 Origin（curl、本机脚本）返回 true，由 Host 校验把关。 */
export function isAllowedOrigin(origin, allowedOrigins) {
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return allowedOrigins.includes(origin);
}

/** 配对令牌校验：没设令牌时总是通过；设了就要求 Bearer 完全一致（常量时间比较）。 */
export function isAuthorized(authorizationHeader, token) {
  if (token === undefined || token === '') return true;
  if (typeof authorizationHeader !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (match === null) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * 一次请求的准入判定。返回 `{ ok: true }` 或 `{ ok: false, status, error }`。
 * 预检（OPTIONS）不要求令牌：浏览器预检不会带 Authorization。
 */
export function checkAccess({ method, headers, port, allowedOrigins, token }) {
  if (!isAllowedHost(headers.host, port)) {
    return { ok: false, status: 403, error: 'Host 不是本机地址，拒绝（防 DNS rebinding）。' };
  }
  if (!isAllowedOrigin(headers.origin, allowedOrigins)) {
    return { ok: false, status: 403, error: '这个来源不在白名单里。' };
  }
  if (method !== 'OPTIONS' && !isAuthorized(headers.authorization, token)) {
    return { ok: false, status: 401, error: '缺少或错误的配对令牌（Authorization: Bearer …）。' };
  }
  return { ok: true };
}

/** 把用户给的 timeoutMs 夹进 [5s, 600s]；不是有限数字时用默认值。 */
export function clampTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

/** 读请求体，超过上限时抛出带 `status = 413` 的错误。 */
export async function readLimitedBody(request, limit = MAX_BODY_BYTES) {
  const declared = Number(request.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw tooLarge(limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tooLarge(limit) {
  const error = new Error(`请求体超过 ${String(Math.round(limit / 1024))}KB 上限。`);
  error.status = 413;
  return error;
}

/**
 * 串行队列：同一时刻只跑一个任务（否则并发会互相覆盖输入框）。
 * 排队的超过 `maxQueued` 时 `run` 抛出 `status = 429` 的错误。
 */
export function createSerialQueue(maxQueued = MAX_QUEUED_ASKS) {
  let tail = Promise.resolve();
  let active = 0;
  return {
    get pending() {
      return active;
    },
    run(task) {
      if (active >= maxQueued + 1) {
        const error = new Error('本地助手正忙（已有任务在排队），稍后再试。');
        error.status = 429;
        return Promise.reject(error);
      }
      active += 1;
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        active -= 1;
      });
    },
  };
}
