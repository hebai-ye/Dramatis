/** Shared deployment policy. Pure data/functions: also used by core, no Node/runtime imports. */
export const DEFAULT_STORAGE_MAX_BYTES = 96 * 1024 ** 2;
export const MAX_STORAGE_QUOTA_BYTES = 1024 ** 4;

export function assertDefaultStorageQuota(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_STORAGE_QUOTA_BYTES) {
    throw new Error('默认存储配额必须是正整数字节且不超过1TiB。');
  }
  return bytes;
}

/** The historical *_MB settings use MiB, not decimal MB. Invalid values fail closed. */
export function parseDefaultStorageMiB(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_STORAGE_MAX_BYTES;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new Error('默认存储配额必须是十进制MiB数值。');
  return assertDefaultStorageQuota(Number(raw) * 1024 ** 2);
}
