/**
 * 凭证的小工具（P2-6 第四步）。
 *
 * 单独一个文件是为了避免循环引用：`keys.ts`（算法）与 `server.ts`（服务端逻辑）
 * 都需要「把凭证折成哈希」，而它们之间不该互相 import。
 */

import { hashCredential } from '../crypto/keys.js';

/** 服务端存的那一份：`SHA-256(凭证)`。 */
export async function credentialHashOf(credential: string): Promise<string> {
  return hashCredential(credential);
}
