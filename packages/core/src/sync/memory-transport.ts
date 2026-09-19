/**
 * 内存版同步服务端（P2-6 第三步）。
 *
 * 它不是「测试替身」那么轻——它**照协议实现了一个真的服务端**：校验凭证、
 * 分配单调递增的 `serverRev`、按游标发记录、只存密文与坐标。所以：
 *
 * - 单测用它跑完整的「两台设备离线各聊一段再合并」；
 * - 探针页用它把整条链跑在真浏览器里；
 * - 将来写 Cloudflare Worker 时，它是那份实现的对照物（同一份接口契约）。
 *
 * 它**看不见明文**：手里只有 `SyncWireRecord`（密文 + 坐标），
 * 这也正是写这个 fake 的意义——服务端能做的事被接口限制住了。
 */

import { timingSafeEqual } from '../crypto/encoding.js';
import { CryptoError } from '../crypto/errors.js';
import { hashCredential, verifyCredential } from '../crypto/keys.js';
import type {
  SyncHeadInput,
  SyncHeadResult,
  SyncPulledRecord,
  SyncPullInput,
  SyncPullResult,
  SyncPushInput,
  SyncPushResult,
  SyncTransport,
  SyncWireRecord,
} from './types.js';

interface StoredWireRecord {
  record: SyncWireRecord;
  serverRev: number;
}

export interface MemorySyncTransportOptions {
  spaceHandle: string;
  /** 服务端只存这个（`hashCredential` 的输出），不存凭证本身。 */
  credentialHash: string;
  /** 同一个 id 的新版本会覆盖旧的——服务端按坐标去重，历史版本不留。 */
  now?: () => number;
}

export interface MemorySyncServer {
  transport: SyncTransport;
  /** 诊断用：现在存了多少条、头号是多少。 */
  stats: () => { head: number; records: number };
  /** 诊断用：看看服务端手里有没有明文（应该只有密文）。 */
  raw: () => StoredWireRecord[];
  /** 模拟服务端把某条记录挪到别的位置（用于验证 AAD 的防护）。 */
  tamper: (collection: string, id: string, patch: Partial<SyncWireRecord>) => void;
}

/** 造一台内存服务器。凭证校验、游标分配、分页都照着 SYNC §4 的约定。 */
export function createMemorySyncTransport(options: MemorySyncTransportOptions): MemorySyncServer {
  const records = new Map<string, StoredWireRecord>();
  let head = 0;

  const keyOf = (record: { collection: string; id: string }): string => `${record.collection}/${record.id}`;

  const authorize = async (input: { spaceHandle: string; credential: string }): Promise<void> => {
    if (input.spaceHandle !== options.spaceHandle) {
      throw new CryptoError('这个空间不存在（或者句柄不对）。');
    }
    if (!(await verifyCredential(input.credential, options.credentialHash))) {
      throw new CryptoError('凭证不对：请检查同步密码（或恢复码）。');
    }
  };

  const transport: SyncTransport = {
    async head(input: SyncHeadInput): Promise<SyncHeadResult> {
      await authorize(input);
      return { head };
    },

    async push(input: SyncPushInput): Promise<SyncPushResult> {
      await authorize(input);
      const accepted: { collection: SyncWireRecord['collection']; id: string; serverRev: number }[] = [];

      for (const record of input.records) {
        head += 1;
        records.set(keyOf(record), { record, serverRev: head });
        accepted.push({ collection: record.collection, id: record.id, serverRev: head });
      }

      return { head, accepted };
    },

    async pull(input: SyncPullInput): Promise<SyncPullResult> {
      await authorize(input);
      const since = input.since;
      const limit = input.limit ?? Number.POSITIVE_INFINITY;

      const pending: SyncPulledRecord[] = [...records.values()]
        .filter((item) => item.serverRev > since)
        .sort((left, right) => left.serverRev - right.serverRev)
        .slice(0, limit)
        .map((item) => ({ ...item.record, serverRev: item.serverRev }));

      return { head, records: pending };
    },
  };

  return {
    transport,
    stats: () => ({ head, records: records.size }),
    raw: () => [...records.values()],
    tamper: (collection, id, patch) => {
      const existing = records.get(`${collection}/${id}`);
      if (existing === undefined) return;
      records.set(`${collection}/${id}`, { ...existing, record: { ...existing.record, ...patch } });
    },
  };
}

/** 给单测与探针用：算一份服务端该存的凭证哈希。 */
export async function credentialHashOf(credential: string): Promise<string> {
  return hashCredential(credential);
}

/** 常数时间比较两个哈希（服务端也可以直接用它，而不是每次重算）。 */
export function sameHash(left: string, right: string): boolean {
  return timingSafeEqual(left, right);
}
