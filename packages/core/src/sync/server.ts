/**
 * 同步服务端的平台无关部分（P2-6 第四步，对应 SYNC.md §4）。
 *
 * 一层薄薄的逻辑：**空间登记 + 凭证校验 + 记录存取 + 游标**。它不知道什么是
 * D1、KV、JSON 文件还是内存，只认下面这个 `SyncServerStore` 接口。于是同一份
 * 逻辑能跑在三个地方：
 *
 * - `createMemorySyncTransport`（单测、探针页）——内存实现；
 * - 开发用后端（`apps/web/tools/sync-dev-backend.ts`，挂在 vite 上）——JSON 文件；
 * - Cloudflare Worker 参考实现——D1。
 *
 * 服务端能看见的东西被接口限制死了：坐标、密文、时间戳、两份凭证哈希、两份
 * 主密钥封装。它**没有**明文，也没有密码——`keyWraps` 对它是透明的字节。
 */

import { CryptoError } from '../crypto/errors.js';
import { verifyCredential } from '../crypto/keys.js';
import { type EncryptedRecord, recordSize } from '../crypto/records.js';
import type {
  SyncAcceptedRecord,
  SyncCredentials,
  SyncHeadInput,
  SyncHeadResult,
  SyncPulledRecord,
  SyncPullInput,
  SyncPullResult,
  SyncPushInput,
  SyncPushResult,
  SyncWireRecord,
} from './types.js';

/** 服务端存的一个空间：只有哈希与封装，没有密码、没有明文。 */
export interface SyncSpaceRecord {
  spaceHandle: string;
  /** `SHA-256(密码派生的凭证)`。 */
  credentialHash: string;
  /** `SHA-256(恢复码派生的凭证)`——两者等价，都能过鉴权。 */
  recoveryCredentialHash: string;
  /**
   * 主密钥的两份封装（密码一份、恢复码一份）。
   *
   * 对服务端是**不透明的**：它照着存、照还，解不开（KEK 由用户密码派生）。
   * 之所以不在这里写死结构，是为了让这一层不依赖具体加密形状。
   */
  keyWraps: Record<string, unknown>;
  createdAt: string;
}

/** 服务端存的一条记录（`SyncWireRecord` 加一个自己分配的号）。 */
export interface SyncRecordRow {
  collection: string;
  id: string;
  serverRev: number;
  updatedAt: string;
  deletedAt: string | null;
  sealed: EncryptedRecord;
}

/**
 * 服务端的存储接口。
 *
 * 五个方法，任何后端都能实现：内存用 Map、开发后端用 JSON 文件、Cloudflare
 * 用 D1 的一张表（主键 `(spaceHandle, collection, id)`，`serverRev` 用自增或
 * 单独一行计数器）。
 */
export interface SyncServerStore {
  getSpace(spaceHandle: string): Promise<SyncSpaceRecord | null>;
  /** 登记新空间；已存在返回 false（调用方据此回 409，而不是覆盖别人的空间）。 */
  createSpace(record: SyncSpaceRecord): Promise<boolean>;
  head(spaceHandle: string): Promise<number>;
  /** 写入（同一坐标覆盖）并返回各自分配到的号，号必须单调递增。 */
  append(spaceHandle: string, records: readonly SyncWireRecord[]): Promise<SyncAcceptedRecord[]>;
  list(spaceHandle: string, options: { since: number; limit: number }): Promise<SyncPulledRecord[]>;
  /**
   * 可选：给配额用的用量统计（顺序 16）。没实现的存储（老后端 / 参考实现）
   * 就跳过配额检查——**不能因为加了个护栏就让旧服务端起不来**。
   */
  spaceUsage?(spaceHandle: string): Promise<{ records: number; bytes: number }>;
}

/** 服务端错误：带上 HTTP 状态码，HTTP 层直接照搬（内核层也能读 code）。 */
export class SyncServerError extends Error {
  override readonly name = 'SyncServerError';
  constructor(
    readonly status: number,
    readonly code: 'space-not-found' | 'space-exists' | 'unauthorized' | 'bad-request' | 'space-full' | 'rate-limited',
    message: string,
  ) {
    super(message);
  }
}

/** 一次拉取的默认与最大条数：移动网络下别一次拉爆。 */
export const DEFAULT_PULL_LIMIT = 200;
export const MAX_PULL_LIMIT = 500;

/**
 * 服务端护栏（顺序 16）。
 *
 * 这些数字不是「技术上能存多少」，而是**邀请朋友之前必须先有的那条线**：
 * 没有它，一个写错的客户端（或一个故意的人）可以用一次请求把服务端的
 * 磁盘与内存吃干净。三档都很宽松——正常用户一辈子碰不到，
 * 但它们保证「出事时是有界的」。
 */
export interface SyncServerLimits {
  /** 一个空间最多存多少条记录（含墓碑）。 */
  maxRecordsPerSpace: number;
  /** 一个空间最多占多少字节（`recordSize` 的口径：IV + 密文）。 */
  maxBytesPerSpace: number;
  /** 一个空间每分钟最多几次写入请求。 */
  pushesPerMinute: number;
  /** 一次请求最多带多少条记录（正常客户端按 200 分块，见 loop.ts）。 */
  maxRecordsPerPush: number;
}

export const DEFAULT_SYNC_LIMITS: SyncServerLimits = {
  maxRecordsPerSpace: 50_000,
  maxBytesPerSpace: 256 * 1024 * 1024,
  pushesPerMinute: 120,
  maxRecordsPerPush: 500,
};

export interface CreateSyncSpaceInput {
  spaceHandle: string;
  credentialHash: string;
  recoveryCredentialHash: string;
  keyWraps?: Record<string, unknown>;
  /** 创建时间，缺省由调用方给（服务端不依赖本机时钟做业务判断）。 */
  at: string;
}

export interface SyncServer {
  /** 登记一个新空间。已存在时返回 'exists'，**不覆盖**（否则谁先占谁定）。 */
  createSpace(input: CreateSyncSpaceInput): Promise<'created' | 'exists'>;
  /** 取空间元数据（句柄就是钥匙；里面只有哈希与密文，拿到也解不开）。 */
  getSpaceMeta(spaceHandle: string): Promise<SyncSpaceRecord | null>;
  head(input: SyncHeadInput): Promise<SyncHeadResult>;
  push(input: SyncPushInput): Promise<SyncPushResult>;
  pull(input: SyncPullInput): Promise<SyncPullResult>;
}

/** 鉴权：凭证哈希对得上密码那份或恢复码那份都算过（两者等价，SYNC §3.3）。 */
async function authorize(store: SyncServerStore, credentials: SyncCredentials): Promise<void> {
  const space = await store.getSpace(credentials.spaceHandle);
  if (space === null) {
    throw new SyncServerError(404, 'space-not-found', '这个空间不存在（或者用户 id 打错了）。');
  }

  const ok =
    (await verifyCredential(credentials.credential, space.credentialHash)) ||
    (await verifyCredential(credentials.credential, space.recoveryCredentialHash));
  if (!ok) {
    throw new SyncServerError(401, 'unauthorized', '凭证不对：检查一下同步密码（或恢复码）。');
  }
}

export interface CreateSyncServerOptions {
  limits?: Partial<SyncServerLimits>;
  /** 注入时钟：限流窗口要用时间，测试里不该等真实的一分钟。 */
  now?: () => number;
}

/** 把这份逻辑装到某个存储上。三个宿主（内存 / 开发后端 / Worker）都走它。 */
export function createSyncServer(store: SyncServerStore, options: CreateSyncServerOptions = {}): SyncServer {
  const limits: SyncServerLimits = { ...DEFAULT_SYNC_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());

  /*
   * 限流状态放在**进程内存**里（每个空间一个最近写入请求的时间窗）。
   * 为什么不做成存到库里：护栏要防的是「一次请求打爆」，不是精确计费；
   * 进程重启后计数归零完全可以接受，而多写一张表会让三个宿主都要动。
   * 单进程部署（用户自己的服务器就是）下它就够了。
   */
  const pushWindow = new Map<string, number[]>();

  function checkPushRate(spaceHandle: string): void {
    const at = now();
    const windowStart = at - 60_000;
    const recent = (pushWindow.get(spaceHandle) ?? []).filter((stamp) => stamp > windowStart);
    if (recent.length >= limits.pushesPerMinute) {
      throw new SyncServerError(
        429,
        'rate-limited',
        `这个空间一分钟内写入请求太多了（上限 ${String(limits.pushesPerMinute)} 次）。等一下再同步。`,
      );
    }
    recent.push(at);
    pushWindow.set(spaceHandle, recent);
  }

  return {
    async createSpace(input: CreateSyncSpaceInput) {
      if (input.spaceHandle === '') {
        throw new SyncServerError(400, 'bad-request', '空间句柄不能为空。');
      }
      if (input.credentialHash === '' || input.recoveryCredentialHash === '') {
        throw new SyncServerError(400, 'bad-request', '凭证哈希不能为空。');
      }

      const created = await store.createSpace({
        spaceHandle: input.spaceHandle,
        credentialHash: input.credentialHash,
        recoveryCredentialHash: input.recoveryCredentialHash,
        keyWraps: input.keyWraps ?? {},
        createdAt: input.at,
      });
      return created ? 'created' : 'exists';
    },

    async getSpaceMeta(spaceHandle: string) {
      return store.getSpace(spaceHandle);
    },

    async head(input: SyncHeadInput) {
      await authorize(store, input);
      return { head: await store.head(input.spaceHandle) };
    },

    async push(input: SyncPushInput) {
      await authorize(store, input);
      if (input.records.length === 0) {
        return { head: await store.head(input.spaceHandle), accepted: [] };
      }

      // ---- 护栏（顺序 16）：先看一次请求带多少，再看这个空间还剩多少 ----
      checkPushRate(input.spaceHandle);
      if (input.records.length > limits.maxRecordsPerPush) {
        throw new SyncServerError(
          413,
          'space-full',
          `一次最多写 ${String(limits.maxRecordsPerPush)} 条，收到 ${String(input.records.length)} 条。`,
        );
      }

      const usage = await store.spaceUsage?.(input.spaceHandle);
      if (usage !== undefined) {
        if (usage.records >= limits.maxRecordsPerSpace) {
          throw new SyncServerError(
            413,
            'space-full',
            `这个空间已经存满（${String(limits.maxRecordsPerSpace)} 条）。先删掉一些，或者按「设置 → 数据」导出一份封存再清理。`,
          );
        }
        if (usage.bytes >= limits.maxBytesPerSpace) {
          throw new SyncServerError(
            413,
            'space-full',
            `这个空间已经写满（约 ${String(Math.round(limits.maxBytesPerSpace / 1024 / 1024))} MB）。先导出一份封存再清理。`,
          );
        }
      }

      const accepted = await store.append(input.spaceHandle, input.records);
      return { head: await store.head(input.spaceHandle), accepted };
    },

    async pull(input: SyncPullInput) {
      await authorize(store, input);
      if (!Number.isFinite(input.since) || input.since < 0) {
        throw new SyncServerError(400, 'bad-request', 'since 必须是一个非负数。');
      }

      const requested = input.limit ?? DEFAULT_PULL_LIMIT;
      const limit = Math.max(1, Math.min(MAX_PULL_LIMIT, Math.floor(requested)));
      const records = await store.list(input.spaceHandle, { since: input.since, limit });

      /*
       * 分页的游标语义（踩过）：`head` 必须是**这一批的最后一条**，不是全局头号。
       *
       * 返回全局头号时，客户端拉到一页就把游标推到末尾，剩下的记录永远不会再来——
       * 一台新设备同步一个超过一页（200 条）的空间时，会「成功同步」出一份残缺的数据。
       * 全局头号另用 `serverHead` 告诉客户端「还差多少」，它只用于显示。
       */
      const serverHead = await store.head(input.spaceHandle);
      const last = records[records.length - 1];
      const head = last === undefined ? input.since : last.serverRev;
      return { head, serverHead, hasMore: head < serverHead, records };
    },
  };
}

/**
 * 内存存储（单测、探针页、以及任何「先跑起来看看」的场合）。
 *
 * 它保证的是**语义**：号单调递增、按号发记录、坐标唯一、空间之间完全隔离。
 */
export interface MemorySyncStore extends SyncServerStore {
  /** 诊断与测试专用：直接看和改底层那些行（线上实现不该有这种东西）。 */
  debugRows(spaceHandle: string): Map<string, SyncRecordRow>;
}

export function createMemorySyncStore(): MemorySyncStore {
  const spaces = new Map<string, SyncSpaceRecord>();
  const rows = new Map<string, Map<string, SyncRecordRow>>();
  const heads = new Map<string, number>();

  const rowKey = (collection: string, id: string): string => `${collection}/${id}`;

  return {
    async getSpace(spaceHandle) {
      return spaces.get(spaceHandle) ?? null;
    },

    async createSpace(record) {
      if (spaces.has(record.spaceHandle)) return false;
      spaces.set(record.spaceHandle, record);
      rows.set(record.spaceHandle, new Map());
      heads.set(record.spaceHandle, 0);
      return true;
    },

    async head(spaceHandle) {
      return heads.get(spaceHandle) ?? 0;
    },

    async append(spaceHandle, records) {
      const table = rows.get(spaceHandle);
      if (table === undefined) throw new CryptoError('空间不存在。');

      const accepted: SyncAcceptedRecord[] = [];
      let head = heads.get(spaceHandle) ?? 0;
      for (const record of records) {
        head += 1;
        table.set(rowKey(record.collection, record.id), {
          collection: record.collection,
          id: record.id,
          serverRev: head,
          updatedAt: record.updatedAt,
          deletedAt: record.deletedAt,
          sealed: record.sealed,
        });
        accepted.push({ collection: record.collection, id: record.id, serverRev: head });
      }
      heads.set(spaceHandle, head);
      return accepted;
    },

    async list(spaceHandle, options) {
      const table = rows.get(spaceHandle);
      if (table === undefined) return [];
      return [...table.values()]
        .filter((row) => row.serverRev > options.since)
        .sort((left, right) => left.serverRev - right.serverRev)
        .slice(0, options.limit)
        .map((row) => ({
          collection: row.collection as SyncPulledRecord['collection'],
          id: row.id,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
          sealed: row.sealed,
          serverRev: row.serverRev,
        }));
    },

    async spaceUsage(spaceHandle) {
      const table = rows.get(spaceHandle);
      if (table === undefined) return { records: 0, bytes: 0 };
      let bytes = 0;
      for (const row of table.values()) bytes += recordSize(row.sealed);
      return { records: table.size, bytes };
    },

    debugRows(spaceHandle) {
      return rows.get(spaceHandle) ?? new Map();
    },
  };
}
