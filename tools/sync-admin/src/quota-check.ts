import { assertDefaultStorageQuota } from './quota-policy.js';

export interface SyncQuotaHealth {
  ok: boolean;
  uptimeMs?: number;
  storageQuota?: { version: 1; defaultMaxBytes: number };
}

export class QuotaConfigurationError extends Error {
  readonly status = 503;
  constructor(
    readonly code: 'quota-unverified' | 'quota-mismatch',
    message: string,
  ) {
    super(message);
  }
}

export function verifyQuotaHealth(health: SyncQuotaHealth, expected: number): void {
  assertDefaultStorageQuota(expected);
  const actual = health.storageQuota;
  if (
    !health.ok ||
    actual?.version !== 1 ||
    !Number.isSafeInteger(actual.defaultMaxBytes) ||
    actual.defaultMaxBytes <= 0
  ) {
    throw new QuotaConfigurationError(
      'quota-unverified',
      '无法核验同步服务的有效默认配额，管理请求已关闭；请检查同步服务版本与健康端口。',
    );
  }
  if (actual.defaultMaxBytes !== expected) {
    throw new QuotaConfigurationError(
      'quota-mismatch',
      `默认配额不一致：同步服务${actual.defaultMaxBytes}字节，管理台${expected}字节；请对齐配置并重启管理台。`,
    );
  }
}

/** Local health only; no account, credential, pathname or database content is transported. */
export async function readSyncQuotaHealth(port: number, fetchImpl: typeof fetch = fetch): Promise<SyncQuotaHealth> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
      cache: 'no-store',
    });
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object') return { ok: false };
    const data = body as Record<string, unknown>;
    const quota = data.storageQuota as Record<string, unknown> | undefined;
    return {
      ok: response.ok && data.ok === true,
      ...(typeof data.uptimeMs === 'number' && Number.isFinite(data.uptimeMs) && data.uptimeMs >= 0
        ? { uptimeMs: data.uptimeMs }
        : {}),
      ...(quota?.version === 1 && typeof quota.defaultMaxBytes === 'number'
        ? { storageQuota: { version: 1, defaultMaxBytes: quota.defaultMaxBytes } }
        : {}),
    };
  } catch {
    return { ok: false };
  }
}
