/**
 * 编码与随机数（P2-6 第二步，加密工具的最底层）。
 *
 * 为什么自己写这几个函数而不是引依赖：`core` 保持零运行时依赖是既定约束
 * （见 STATUS「不可回退的设计决定」第 6 条），而这里需要的只是
 * base64url、UTF-8 与随机字节——WebCrypto 与 `btoa` / `atob` 在浏览器和
 * Node 20+ 都有，不引依赖反而更稳。
 */

import { CryptoError } from './errors.js';

/** 把字节编成 base64url（不带 `=` 填充）。密文、IV、凭证都走这个格式。 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → 字节。填充缺失、`-` / `_` 两种变体都认。 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  let binary: string;
  try {
    binary = atob(normalized + '='.repeat(padding));
  } catch {
    throw new CryptoError('这段数据不是合法的 base64url，可能已经被截断或改过。');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(length) || length <= 0) {
    throw new CryptoError(`随机字节数必须是正整数，收到 ${String(length)}。`);
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * 定长比较，用于校验凭证。
 *
 * 说明：JS 里做不到真正的常数时间（JIT、字符串内部表示都会影响），
 * 这里只保证**比较次数不随内容提前退出**——攻击者不能靠计时逐字节猜凭证。
 * 真正的防线是凭证本身够长（256 bit 随机，见 `deriveCredential`）。
 */
export function timingSafeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * WebCrypto 句柄。
 *
 * `crypto.subtle` 只在**安全上下文**里存在：`https://`、`localhost` /
 * `127.0.0.1` 有，用 `http://192.168.x.x` 打开开发服务器就没有。缺了它
 * 整个同步功能都做不了，所以这里给出明确的报错，而不是让调用方拿到
 * 一个 `undefined is not an object`。
 */
export function subtle(): SubtleCrypto {
  const available = globalThis.crypto?.subtle;
  if (available === undefined) {
    throw new CryptoError(
      '这个环境没有 WebCrypto（浏览器只允许在安全上下文里用：https，或者 localhost / 127.0.0.1）。',
    );
  }
  return available;
}
