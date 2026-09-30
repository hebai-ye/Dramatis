import { pbkdf2Sync } from 'node:crypto';

// biome-ignore lint/suspicious/noControlCharactersInRegex: 运营ID拒绝控制字符
const CONTROLS = /[\u0000-\u001f\u007f]/;

export function normalizeAccountId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128 || CONTROLS.test(value)) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized === '' ? null : normalized;
}

/** 身份协议v1，与core/crypto/keys.ts一致；集成测试用客户端派生结果校验。
 * 只从已知ID定位句柄，不证明所有权，不涉及密码或解密钥匙。 */
export function accountSpaceHandle(normalizedId: string): string {
  return pbkdf2Sync(normalizedId, 'dramatis:space-handle:v1', 100_000, 32, 'sha256').toString('base64url');
}
