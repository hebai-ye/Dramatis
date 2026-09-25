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

import { randomBytes, toBase64Url } from '../crypto/encoding.js';
import { CryptoError } from '../crypto/errors.js';
import { verifyCredential } from '../crypto/keys.js';
import { type EncryptedRecord, recordSize } from '../crypto/records.js';
import type {
  SyncAcceptedRecord,
  SyncCredentials,
  SyncDeviceSummary,
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
  /**
   * 空间纪元（审计 A4）：建空间时随机生成，之后不变。
   *
   * 服务端库丢了重建、换了一台服务端时它必然不同，客户端据此把游标作废重来。
   * 可选：老库里的空间没有它（SQLite 版在启动迁移时补上），老存储实现也可以不给。
   */
  epoch?: string;
}

/** 生成一个新的空间纪元：128 bit 随机，base64url。 */
export function newSpaceEpoch(): string {
  return toBase64Url(randomBytes(16));
}

/** 服务端存的一条记录（`SyncWireRecord` 加一个自己分配的号）。 */
export interface SyncRecordRow {
  collection: string;
  id: string;
  serverRev: number;
  updatedAt: string;
  deletedAt: string | null;
  sealed: EncryptedRecord;
  /** 写这条记录的那台设备（顺序 14）；老记录可能是 null。 */
  deviceId: string | null;
}

/**
 * 一台设备在这个空间里的足迹（顺序 14）。
 *
 * 形状定义在 `types.ts`（传输层也要用它），这里只是转出去，免得两处各写一份。
 */
export type { SyncDeviceSummary } from './types.js';

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
  /**
   * 可选：按设备聚合（顺序 14）。没实现就返回空列表——
   * 「看得见设备」是增强，不该让旧后端连同步都做不了。
   */
  deviceUsage?(spaceHandle: string): Promise<SyncDeviceSummary[]>;
  /**
   * 可选：这台服务端上一共登记了多少个空间（顺序 61 的总量护栏）。
   * 没实现就跳过总量检查——老后端照样能跑。
   */
  spaceCount?(): Promise<number>;
  /** 换同步密码：只替换密码那一份凭证与封装，恢复码那份不动。 */
  rotatePassword?(spaceHandle: string, patch: { credentialHash: string; passwordWrap: unknown }): Promise<boolean>;
}

/** 服务端错误：带上 HTTP 状态码，HTTP 层直接照搬（内核层也能读 code）。 */
export class SyncServerError extends Error {
  override readonly name = 'SyncServerError';
  constructor(
    readonly status: number,
    readonly code:
      | 'space-not-found'
      | 'space-exists'
      | 'unauthorized'
      | 'bad-request'
      | 'space-full'
      | 'rate-limited'
      | 'server-full',
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
  /**
   * **同一个来源**每分钟最多登记几个新空间（顺序 61）。
   *
   * 为什么单独管 `POST /spaces`：它是唯一**不需要凭证**的写接口。没有这条线，
   * 任何人可以在你的服务器上刷出无限多个空空间，把磁盘与内存吃干净——
   * 写入配额只保护「已经存在的空间」，挡不住新建。
   */
  spacesPerMinute: number;
  /** 这台服务端上最多有多少个空间（顺序 61）。限流挡「一分钟刷一千个」，总量挡「一年慢慢刷满」。 */
  maxSpaces: number;
}

export const DEFAULT_SYNC_LIMITS: SyncServerLimits = {
  maxRecordsPerSpace: 50_000,
  maxBytesPerSpace: 256 * 1024 * 1024,
  pushesPerMinute: 120,
  maxRecordsPerPush: 500,
  // 一个人从头建一遍自己的空间只需要几个，20 已经宽松得离谱
  spacesPerMinute: 20,
  maxSpaces: 10_000,
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
  createSpace(input: CreateSyncSpaceInput, context?: { clientKey?: string }): Promise<'created' | 'exists'>;
  /** 取空间元数据（句柄就是钥匙；里面只有哈希与密文，拿到也解不开）。 */
  getSpaceMeta(spaceHandle: string): Promise<SyncSpaceRecord | null>;
  head(input: SyncHeadInput): Promise<SyncHeadResult>;
  push(input: SyncPushInput): Promise<SyncPushResult>;
  pull(input: SyncPullInput): Promise<SyncPullResult>;
  /** 这个空间最近有哪些设备在写（顺序 14）。 */
  devices(input: SyncHeadInput): Promise<{ devices: SyncDeviceSummary[] }>;
  /** 换同步密码（顺序 15）：旧密码从此过不了鉴权，等于把只知道旧密码的设备断开。 */
  rotatePassword(input: SyncHeadInput & { credentialHash: string; passwordWrap: unknown }): Promise<void>;
}

/** 鉴权：凭证哈希对得上密码那份或恢复码那份都算过（两者等价，SYNC §3.3）。 */
async function authorize(store: SyncServerStore, credentials: SyncCredentials): Promise<SyncSpaceRecord> {
  const space = await store.getSpace(credentials.spaceHandle);
  if (space === null) {
    throw new SyncServerError(404, 'space-not-found', '这个空间不存在（或者账户 ID 打错了）。');
  }

  const ok =
    (await verifyCredential(credentials.credential, space.credentialHash)) ||
    (await verifyCredential(credentials.credential, space.recoveryCredentialHash));
  if (!ok) {
    throw new SyncServerError(401, 'unauthorized', '凭证不对：检查一下同步密码（或恢复码）。');
  }
  return space;
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
  /* 建空间也同样限流，但按**来源**而不是按空间（顺序 61）：这时空间还不存在。 */
  const createWindow = new Map<string, number[]>();

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

  /**
   * `POST /spaces` 的两道闸（顺序 61）：同一来源每分钟的登记次数、以及总量上限。
   *
   * `clientKey` 由 HTTP 宿主给（socket 地址，或在可信反向代理后面取 `x-forwarded-for` 的
   * 第一跳）。宿主没给就退化成「所有请求共用一个 key」——那条线依然在，
   * 只是粒度粗一些，总比完全没有好。
   */
  /** 第一道闸：同一个来源一分钟内不许建太多个。 */
  function checkCreateRate(clientKey: string): void {
    const at = now();
    const windowStart = at - 60_000;
    const recent = (createWindow.get(clientKey) ?? []).filter((stamp) => stamp > windowStart);
    if (recent.length >= limits.spacesPerMinute) {
      throw new SyncServerError(
        429,
        'rate-limited',
        `一分钟内建了太多空间（上限 ${String(limits.spacesPerMinute)} 个）。等一下再试。`,
      );
    }
    recent.push(at);
    createWindow.set(clientKey, recent);
  }

  /** 第二道闸：这台服务端上的空间总数。**只对新建生效**——已存在的空间该回 409。 */
  async function checkSpaceCapacity(): Promise<void> {
    const count = await store.spaceCount?.();
    if (count !== undefined && count >= limits.maxSpaces) {
      throw new SyncServerError(
        503,
        'server-full',
        `这台服务端上的空间数量已经到上限（${String(limits.maxSpaces)} 个）。这是给自建服务器的护栏，请联系服务器的主人。`,
      );
    }
  }

  return {
    async createSpace(input: CreateSyncSpaceInput, context) {
      if (input.spaceHandle === '') {
        throw new SyncServerError(400, 'bad-request', '空间句柄不能为空。');
      }
      if (input.credentialHash === '' || input.recoveryCredentialHash === '') {
        throw new SyncServerError(400, 'bad-request', '凭证哈希不能为空。');
      }

      /*
       * 护栏（顺序 61）：先看「这个来源建得太频繁吗」，再看「这台服务器还装得下吗」。
       *
       * 顺序很关键：**已存在的空间必须先走 409**。容量那条闸只对真正的新建生效，
       * 否则服务端装满之后，一个只是来重连的客户端会拿到 503、以为自己的空间没了。
       */
      checkCreateRate(context?.clientKey ?? 'unknown');
      const existing = await store.getSpace(input.spaceHandle);
      if (existing === null) await checkSpaceCapacity();

      const created = await store.createSpace({
        spaceHandle: input.spaceHandle,
        credentialHash: input.credentialHash,
        recoveryCredentialHash: input.recoveryCredentialHash,
        keyWraps: input.keyWraps ?? {},
        createdAt: input.at,
        epoch: newSpaceEpoch(),
      });
      return created ? 'created' : 'exists';
    },

    async getSpaceMeta(spaceHandle: string) {
      return store.getSpace(spaceHandle);
    },

    async head(input: SyncHeadInput) {
      const space = await authorize(store, input);
      const head = await store.head(input.spaceHandle);
      return space.epoch === undefined || space.epoch === '' ? { head } : { head, epoch: space.epoch };
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
        /*
         * 判据是「**这一批写完之后**会不会超」，不是「现在满没满」——
         * 这一条是演练里改过来的：原来只拦「已经满了」的情况，于是一批 10 条
         * 可以把 20 条的上限直接顶到 27 条（顺序 17 的配额演练实测）。
         *
         * 代价是**保守**：覆盖同一条也算一条新的，所以在快满时连更新都会被挡。
         * 这是有意的——护栏的目标是「不许再往里写」，不是精确记账；
         * 真要贴着上限用，就把上限调大（`--max-records`）。
         */
        if (usage.records + input.records.length > limits.maxRecordsPerSpace) {
          throw new SyncServerError(
            413,
            'space-full',
            /*
             * 指引必须**准确**：服务端上的记录只增不减——本地删掉的实体会变成墓碑
             * （`deletedAt` 非空），而墓碑同样占一行。所以「删掉一些」在这里没用，
             * 写上去只会让用户白折腾一轮（顺序 17 的演练里就是这么发现的）。
             */
            `这个空间已经存满（上限 ${String(limits.maxRecordsPerSpace)} 条）。这是给自建服务器的护栏，正常用很难碰到；碰到了最实际的办法是换一个账户 ID 重新开一个空间（本机这份数据会推过去），并把本机数据先导出一份封存留底（设置 → 数据）。`,
          );
        }
        /*
         * 字节这一条也要按「**写完之后**」判（顺序 61）。
         *
         * 原来写的是 `usage.bytes >= max`——那是「现在满没满」。于是一批 20MB 的记录
         * 可以把 256MB 的上限直接顶到 276MB：条数那条早已改成写后判定，
         * 字节这条漏了，两条口径不一致。
         */
        const batchBytes = input.records.reduce((sum, record) => sum + recordSize(record.sealed), 0);
        if (usage.bytes + batchBytes > limits.maxBytesPerSpace) {
          throw new SyncServerError(
            413,
            'space-full',
            `这个空间已经写满（上限约 ${String(Math.round(limits.maxBytesPerSpace / 1024 / 1024))} MB，这一批还要 ${String(Math.round(batchBytes / 1024 / 1024))} MB）。先按「设置 → 数据」导出一份封存留底，再考虑换个用户 id 开一个新空间。`,
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

    async devices(input: SyncHeadInput) {
      await authorize(store, input);
      return { devices: (await store.deviceUsage?.(input.spaceHandle)) ?? [] };
    },

    async rotatePassword(input: SyncHeadInput & { credentialHash: string; passwordWrap: unknown }) {
      await authorize(store, input);
      if (input.credentialHash === '') {
        throw new SyncServerError(400, 'bad-request', '新凭证哈希不能为空。');
      }
      const done = await store.rotatePassword?.(input.spaceHandle, {
        credentialHash: input.credentialHash,
        passwordWrap: input.passwordWrap,
      });
      /*
       * 存储没实现这一条时**明确告诉用户做不到**，不能回一句成功——
       * 「以为换了密码、其实旧密码还能用」是这一项里最危险的谎。
       */
      if (done === undefined || done === false) {
        throw new SyncServerError(501, 'bad-request', '这台服务端的版本还不支持换密码，请先更新服务端。');
      }
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
      spaces.set(record.spaceHandle, { ...record, epoch: record.epoch ?? newSpaceEpoch() });
      rows.set(record.spaceHandle, new Map());
      heads.set(record.spaceHandle, 0);
      return true;
    },

    async spaceCount() {
      return spaces.size;
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
          deviceId: record.deviceId ?? null,
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
          ...(row.deviceId === null ? {} : { deviceId: row.deviceId }),
        }));
    },

    async spaceUsage(spaceHandle) {
      const table = rows.get(spaceHandle);
      if (table === undefined) return { records: 0, bytes: 0 };
      let bytes = 0;
      for (const row of table.values()) bytes += recordSize(row.sealed);
      return { records: table.size, bytes };
    },

    async deviceUsage(spaceHandle) {
      const table = rows.get(spaceHandle);
      if (table === undefined) return [];
      const byDevice = new Map<string, SyncDeviceSummary>();
      for (const row of table.values()) {
        if (row.deviceId === null) continue;
        const existing = byDevice.get(row.deviceId);
        if (existing === undefined) {
          byDevice.set(row.deviceId, { deviceId: row.deviceId, lastWriteAt: row.updatedAt, records: 1 });
          continue;
        }
        existing.records += 1;
        if (row.updatedAt > existing.lastWriteAt) existing.lastWriteAt = row.updatedAt;
      }
      return [...byDevice.values()].sort((left, right) => right.lastWriteAt.localeCompare(left.lastWriteAt));
    },

    async rotatePassword(spaceHandle, patch) {
      const space = spaces.get(spaceHandle);
      if (space === undefined) return false;
      spaces.set(spaceHandle, {
        ...space,
        credentialHash: patch.credentialHash,
        keyWraps: { ...space.keyWraps, password: patch.passwordWrap },
      });
      return true;
    },

    debugRows(spaceHandle) {
      return rows.get(spaceHandle) ?? new Map();
    },
  };
}
