/**
 * 同步协议的类型与传输层接口（P2-6 第三步，对应 SYNC.md §4）。
 *
 * 分三层，一层都别混：
 *
 * ```
 * LocalSyncRecord      本地库里的样子（含墓碑）
 *   └─ 加密 → SyncWireRecord   线上传的样子（密文 + 服务端看得见的坐标）
 *        └─ SyncTransport      三个接口：head / push / pull
 * ```
 *
 * `SyncTransport` 是可注入的：单测与探针页用内存实现（`createMemorySyncTransport`），
 * 线上用 Cloudflare Worker 或任何照着这三个接口写的后端。内核只认这个接口，
 * 所以换后端不需要动合并逻辑，也不需要动数据层。
 */

import type { EncryptedRecord } from '../crypto/records.js';

/**
 * 参与同步的集合（SYNC §4.1 的白名单）。
 *
 * 刻意写成常量数组而不是散在各处的字符串：漏一个集合不会报错，只会安静地不同步，
 * 而这种 bug 要等到用户换设备才会发现。
 */
export const SYNC_COLLECTIONS = [
  'rooms',
  'conversations',
  'scenes',
  'instances',
  'cards',
  'worldBooks',
  'messages',
  'memories',
  'chapterSummaries',
  'personas',
] as const;

export type SyncCollection = (typeof SYNC_COLLECTIONS)[number];

/** 本地库里的一条可同步记录（墓碑也算一条）。 */
export interface LocalSyncRecord {
  collection: SyncCollection;
  id: string;
  /** 实体的 `updatedAt`，由仓储层保证严格递增。 */
  updatedAt: string;
  /** 非 null 表示这条是被删的（墓碑）。 */
  deletedAt: string | null;
  /** 实体本身（明文，加密前）。 */
  value: unknown;
  /** 拉回来的记录才有：写它的设备。本地记录不填（本机写的当然就是本机）。 */
  deviceId?: string;
}

/** 上传/下载时线上那条记录：坐标是明文，内容是密文。 */
export interface SyncWireRecord {
  collection: SyncCollection;
  id: string;
  /** 明文，LWW 要用；「这毫秒被改过」泄露的信息可以忽略（SYNC §3.3）。 */
  updatedAt: string;
  deletedAt: string | null;
  sealed: EncryptedRecord;
  /**
   * 写这条记录的那台设备（顺序 14/19）。
   *
   * 为什么它是**可选**的、而且明文：老客户端（顺序 13 之前那几版）不带这个字段，
   * 服务端得照收；而「哪台设备在写」本来就是服务端必须知道的信息（同步面板要显示
   * 「最近写过的设备」、断开时要能指着具体一台）。它不是隐私——设备号是本机生成的
   * 随机 uuid，不含任何用户信息。
   */
  deviceId?: string;
}

/** 拉回来的记录多一个服务端游标号。 */
export interface SyncPulledRecord extends SyncWireRecord {
  serverRev: number;
}

export interface SyncCredentials {
  spaceHandle: string;
  credential: string;
}

export interface SyncHeadInput extends SyncCredentials {}

export interface SyncHeadResult {
  /** 服务端现在到第几号了（客户端拿它当拉取游标的上界）。 */
  head: number;
}

export interface SyncPushInput extends SyncCredentials {
  /** 客户端以为的服务端游标；服务端可以据此诊断「你落后了」，但不必拒绝。 */
  baseHead: number;
  records: readonly SyncWireRecord[];
}

export interface SyncAcceptedRecord {
  collection: SyncCollection;
  id: string;
  /** 服务端分配的新号。 */
  serverRev: number;
}

export interface SyncPushResult {
  head: number;
  accepted: readonly SyncAcceptedRecord[];
}

export interface SyncPullInput extends SyncCredentials {
  /** 只要 `serverRev > since` 的记录（`since = 0` 就是全量）。 */
  since: number;
  limit?: number;
}

export interface SyncPullResult {
  /**
   * 这一批**真正给到**的最后一条的号；一条都没有时等于 `since`。
   *
   * 客户端拿它当新游标。**不能返回服务端的全局头号**：一次拉取是分页的
   * （服务端默认一页 200 条），返回全局头号会让客户端以为「我已经拉完了」，
   * 剩下的记录再也不会传过来——换设备时表现为「只同步了一部分就静默结束」。
   */
  head: number;
  /**
   * 服务端此刻的全局头号（仅供参考：界面显示「还差多少」）。
   *
   * 老服务端（部署在用户服务器上的那一版）不发这个字段，客户端要能兜住。
   */
  serverHead?: number;
  /** 还有没有下一批。老服务端不发，客户端按「游标是否追平全局头号」自己判断。 */
  hasMore?: boolean;
  records: readonly SyncPulledRecord[];
}

/**
 * 同步传输层：三个接口，一个后端一个实现。
 *
 * 它不认识实体，只搬「坐标 + 密文」。这一层薄是刻意的：换后端、写参考实现、
 * 在单测里假装一台服务器，都只涉及这三个函数。
 */
export interface SyncTransport {
  head(input: SyncHeadInput): Promise<SyncHeadResult>;
  push(input: SyncPushInput): Promise<SyncPushResult>;
  pull(input: SyncPullInput): Promise<SyncPullResult>;
  /**
   * 这个空间最近有哪些设备在写（顺序 14）。
   *
   * 可选：老的传输实现（以及任何只实现三个必需接口的第三方后端）没有它，
   * 界面照常同步，只是不显示设备列表。
   */
  devices?(input: SyncHeadInput): Promise<{ devices: SyncDeviceSummary[] }>;
  /** 换同步密码（顺序 15）。同样是可选的：没实现就是「这台服务端还不支持」。 */
  rotate?(input: SyncHeadInput & { credentialHash: string; passwordWrap: unknown }): Promise<void>;
}

/** 一台设备在某个空间里的足迹（顺序 14）。 */
export interface SyncDeviceSummary {
  deviceId: string;
  lastWriteAt: string;
  records: number;
}

/**
 * 本地同步状态（存 meta，不进实体——本地不该有服务端概念）。
 *
 * - `pulledHead`：上次拉到的服务端号；
 * - `pushedAt`：上次推出去的记录里最晚的 `updatedAt`，用来只推新改动。
 */
export interface SyncState {
  /** 这份状态属于哪个空间；换空间就作废重来。 */
  spaceHandle: string | null;
  pulledHead: number;
  pushedAt: string | null;
}

export const EMPTY_SYNC_STATE: SyncState = { spaceHandle: null, pulledHead: 0, pushedAt: null };

/** 解不开、被隔离掉的一条（顺序 13）。 */
export interface SyncQuarantinedRecord {
  collection: string;
  id: string;
  /** 给人看的一句话：为什么解不开。 */
  reason: string;
}

/** 一次同步做了什么（界面与诊断都读它）。 */
export interface SyncReport {
  spaceHandle: string;
  pushed: number;
  pulled: number;
  /** 拉回来之后真的写进库的条数。 */
  applied: number;
  /** 本地的更新更晚（或时间戳相同且本地不是墓碑），原样保留的条数。 */
  skipped: number;
  /**
   * 解不开、已经隔离跳过的记录（顺序 13）。
   *
   * 明细**最多 20 条**（`QUARANTINE_DETAIL_LIMIT`）：这是给人看的诊断，
   * 不是日志，没必要把几千条都塞进内存与界面。总数看 `quarantinedCount`。
   */
  quarantined: readonly SyncQuarantinedRecord[];
  /** 一共跳过多少条（可能大于明细条数）。 */
  quarantinedCount: number;
  /**
   * 本机较新、把远端那条挡回去了的记录（顺序 19 的「覆盖可见性」）。
   *
   * 只记**来自别的设备**的那些：自己两台设备之间撞车才是用户要看的，
   * 本机自己改两遍不算覆盖。明细同 quarantine 一样最多 20 条。
   */
  overridden: readonly SyncOverriddenRecord[];
  /** 一共挡回去多少条（来自其它设备的）。 */
  overriddenCount: number;
  head: number;
}

/** 一条「远端比本机旧、所以本机这条留着」的记录（顺序 19）。 */
export interface SyncOverriddenRecord {
  collection: string;
  id: string;
  /** 那条被挡回去的记录是哪台设备写的；老记录可能没有。 */
  deviceId: string;
}
