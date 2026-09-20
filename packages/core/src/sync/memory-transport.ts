/**
 * 内存版同步服务端（P2-6 第三步）。
 *
 * 它只是把 `createSyncServer` 装到内存存储上（第四步抽出来的那层共享逻辑），
 * 所以「校验凭证、分配 `serverRev`、按游标发记录」这些行为与开发后端、
 * Cloudflare Worker **是同一份代码**——不会各自漂移。
 *
 * 它看不见明文：手里只有 `SyncWireRecord`（密文 + 坐标）。
 */

import { credentialHashOf } from './credential.js';
import { createMemorySyncStore, createSyncServer } from './server.js';
import type { SyncTransport, SyncWireRecord } from './types.js';

export interface MemorySyncTransportOptions {
  spaceHandle: string;
  /** 服务端只存这个（`hashCredential` 的输出），不存凭证本身。 */
  credentialHash: string;
  /** 同一条记录的两种凭证等价：不传就用同一份哈希。 */
  recoveryCredentialHash?: string;
}

export interface MemorySyncServer {
  transport: SyncTransport;
  /** 诊断用：现在存了多少条、头号是多少。 */
  stats: () => { head: number; records: number };
  /** 诊断用：看看服务端手里有没有明文（应该只有密文）。 */
  raw: () => SyncWireRecord[];
  /** 模拟服务端把某条记录改掉（用于验证 AAD 的防护）。 */
  tamper: (collection: string, id: string, patch: Partial<SyncWireRecord>) => void;
}

/** 造一台内存服务器。 */
export function createMemorySyncTransport(options: MemorySyncTransportOptions): MemorySyncServer {
  const store = createMemorySyncStore();
  const space = {
    spaceHandle: options.spaceHandle,
    credentialHash: options.credentialHash,
    recoveryCredentialHash: options.recoveryCredentialHash ?? options.credentialHash,
    keyWraps: {},
    createdAt: '1970-01-01T00:00:00.000Z',
  };
  // 直接登记：调用方已经算好了哈希，这里不需要（也不该）知道密码
  void store.createSpace(space);

  const server = createSyncServer(store);

  return {
    transport: {
      head: (input) => server.head(input),
      push: (input) => server.push(input),
      pull: (input) => server.pull(input),
    },
    stats: () => {
      const rows = [...store.debugRows(options.spaceHandle).values()];
      return {
        head: rows.reduce((max, row) => Math.max(max, row.serverRev), 0),
        records: rows.length,
      };
    },
    raw: () =>
      [...store.debugRows(options.spaceHandle).values()].map((row) => ({
        collection: row.collection as SyncWireRecord['collection'],
        id: row.id,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
        sealed: row.sealed,
      })),
    tamper: (collection, id, patch) => {
      const rows = store.debugRows(options.spaceHandle);
      const existing = rows.get(`${collection}/${id}`);
      if (existing === undefined) return;
      rows.set(`${collection}/${id}`, { ...existing, ...patch });
    },
  };
}

export { credentialHashOf };
