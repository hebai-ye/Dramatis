/**
 * 同步循环（P2-6 第三步，对应 SYNC.md §4.3）。
 *
 * ```
 * 0. 读本地同步状态（拉取游标 pulledHead + 推送点 pushedAt + 服务端纪元 epoch），
 *    问一次服务端 head：服务端被清空 / 重建 / 回滚过就把本地状态作废重来（审计 A4）
 * 1. 把 updatedAt > pushedAt 的记录加密推上去
 * 2. 拉 serverRev > pulledHead 的记录 → 解密 → 按 §4.2 合并 → 推进游标
 * 3. 推送点只越过「本轮确实推上去的」与「本轮拉回来、本地与之完全相同的」记录（审计 A3）
 * ```
 *
 * 从没从这个空间拉过（`pulledHead === 0`：新设备、换空间、状态被重置）时顺序是
 * **先拉、再推、再拉**：本机那份可能是旧的（快照恢复、服务端重建），先推会把服务端上
 * 更新的版本盖掉——服务端不做 LWW，只认最后一次写入。先拉回来合并，再只推
 * 「本机确实更新」的那些，就不会拿旧的顶新的。
 *
 * 性质，都能在单测里验：
 *
 * - **幂等**：同一批记录推两次、合并两次，结果一样（合并只认时间戳与墓碑）。
 * - **推进有序**：平时先推后拉。否则本地刚改的东西会先被远端的旧版本覆盖一次，
 *   虽然下一轮还能改回来，但那一下闪动是没必要的。
 * - **失败不推进游标**：推失败就下次重推；整轮抛错时游标原地不动。
 * - **不漏推**（审计 A3）：同步进行期间本机新写的记录，哪怕时间戳比同轮拉回来的
 *   记录更早（对端时钟超前），也不会被推送点越过。
 * - **坏记录隔离**（顺序 13）：单个记录解不开**不再卡死整轮**——跳过它、记下来、
 *   游标照常往前推（否则那一条会让这台设备的同步永远停在它前面）。跳过不是
 *   静默：条数与明细都进 `SyncReport`，界面会如实说出来。
 *
 * 为什么把「停下报错」改成「隔离」：这条规则是**改过的**，改动理由值得写下来。
 * 原来的想法是「宁可让人看见，也不要少一条数据还装作同步成功」；真实场景是
 * 服务端上有一条损坏/被改过的记录时，用户的表现不是「看见错误」，而是
 * **同步从此再也不动**（游标卡在它前面），而且自己没有任何办法恢复。
 * 现在改成：跳过那一条、把其余照常同步、并把「跳过了 N 条」摆在同步面板上。
 */

import { CryptoError } from '../crypto/errors.js';
import { decryptRecord, encryptRecord } from '../crypto/records.js';
import type { Repository } from '../storage/repository.js';
import { mergeRemoteRecords } from './merge.js';
import type {
  LocalSyncRecord,
  SyncOverriddenRecord,
  SyncQuarantinedRecord,
  SyncReport,
  SyncResetReason,
  SyncState,
  SyncTransport,
  SyncWireRecord,
} from './types.js';

export interface RunSyncInput {
  repository: Repository;
  transport: SyncTransport;
  spaceHandle: string;
  /** 每请求带一次的凭证（`Authorization: Bearer`）。 */
  credential: string;
  /** 主密钥（`openSpace` 的输出），用来加解密记录。 */
  encKey: CryptoKey;
  /** 一页最多拉多少条（服务端还会再夹一层上限）；不给就用服务端的默认页大小。 */
  limit?: number;
}

/**
 * 一次同步最多拉几页。
 *
 * 分页是必需的（服务端一页默认 200 条，上限 500），但循环必须有上界：
 * 服务端要是坏到「永远说还有」，客户端不该跟着转不出来。200 页 × 500 条
 * 远超任何一次正常的补齐。
 */
const MAX_PULL_ROUNDS = 200;

/**
 * 一次推多少条（顺序 13）。
 *
 * 原来是把「所有没推过的记录」塞进一个请求：一个用了半年、几千条消息的库
 * 第一次连同步，会发出一个几 MB 的请求——服务端还没限流，手机流量先受不了。
 * 200 条一包，和拉取那边的默认页大小对齐，两边都按同样的粒度走。
 */
const PUSH_BATCH_SIZE = 200;

/** 报告里最多列几条隔离明细（给人看的诊断，不是日志）。 */
export const QUARANTINE_DETAIL_LIMIT = 20;

function later(left: string | null, right: string): string {
  if (left === null) return right;
  return right > left ? right : left;
}

/** 一条记录的「版本坐标」：集合 + id + updatedAt。两边这三样相同就是同一个版本。 */
function versionKey(record: { collection: string; id: string; updatedAt: string }): string {
  return JSON.stringify([record.collection, record.id, record.updatedAt]);
}

/** 解密出来的实体里写的墓碑时间（审计 A6：只信这一份，线上明文那份只用来比对）。 */
function sealedDeletedAt(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const deletedAt = (value as { deletedAt?: unknown }).deletedAt;
  return typeof deletedAt === 'string' ? deletedAt : null;
}

/**
 * 要封进密文的那份实体：保证里面的 `deletedAt` 与这条记录的墓碑状态一致（审计 A6）。
 *
 * 仓储层的墓碑本来就是「带 `deletedAt` 的整条实体」，这里只是兜底：万一某条记录的
 * 墓碑时间只在外层、没进实体，收的一方会因为「线上与密文不一致」把它隔离掉。
 */
function sealable(record: LocalSyncRecord): unknown {
  const value = record.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  if (sealedDeletedAt(value) === record.deletedAt) return value;
  return { ...(value as Record<string, unknown>), deletedAt: record.deletedAt };
}

/**
 * 把本机同步状态清回「从没同步过这个空间」（审计 A4 的确定性修复）。
 *
 * 网页层在两处**必须**调它：
 *
 * - `connect` 新建空间之后（服务端上是一个全新的空间，本机的游标与推送点都属于过去）；
 * - `restoreSnapshot` 把快照灌回服务端之后（服务端内容被整体换过）。
 *
 * 清完之后下一次 `runSync` 会走「先拉、再推、再拉」：先把服务端上的一切合并进来，
 * 再只推本机确实更新的记录。代价只是一次全量拉取。
 */
export async function resetSyncState(
  repository: Pick<Repository, 'writeSyncState'>,
  spaceHandle: string | null,
): Promise<void> {
  await repository.writeSyncState({ spaceHandle, pulledHead: 0, pushedAt: null });
}

/** 跑一次同步。抛错表示「这一轮没成」——本地库与游标都保持原样，下次重来。 */
export async function runSync(input: RunSyncInput): Promise<SyncReport> {
  const repository = input.repository;
  const credentials = { spaceHandle: input.spaceHandle, credential: input.credential };
  const fresh: SyncState = { spaceHandle: input.spaceHandle, pulledHead: 0, pushedAt: null };
  const stored = await repository.readSyncState();

  let reset: SyncResetReason | null = null;
  // 换空间就作废重来：上一个空间的游标会把这里的记录当成「已经拉过」
  let state: SyncState = stored;
  if (stored.spaceHandle !== input.spaceHandle) {
    state = fresh;
    if (stored.spaceHandle !== null) reset = 'space-changed';
  }

  /*
   * ---- 0. 服务端还是不是原来那个（审计 A4）----
   *
   * 服务端库丢了、从备份回滚了、被人清过之后，句柄不变，但号从头数起。本机游标还停在
   * 老位置：老号以内的新记录永远拉不到，推送点也让本机一条都不推。两道检测：
   *
   * - `head < pulledHead`：服务端比本机记得的还短——一定被回滚/重建过（老服务端也适用）；
   * - `epoch` 变了：新服务端每个空间有一个建空间时生成的随机纪元，重建之后必然不同，
   *   能覆盖「重建后号又涨过了旧值」这种单看 head 看不出来的情况。
   *
   * 任一命中就按新设备处理（先拉后推），代价只是一次全量同步。
   */
  const remote = await input.transport.head(credentials);
  const remoteHead = typeof remote.head === 'number' && Number.isFinite(remote.head) ? remote.head : null;
  const remoteEpoch = typeof remote.epoch === 'string' && remote.epoch !== '' ? remote.epoch : undefined;
  if (reset === null && remoteHead !== null && remoteHead < state.pulledHead) {
    reset = 'head-behind';
    state = fresh;
  } else if (reset === null && remoteEpoch !== undefined && state.epoch !== undefined && remoteEpoch !== state.epoch) {
    reset = 'epoch-changed';
    state = fresh;
  }

  const deviceId = await repository.deviceId();
  /** 本轮真正推上去的版本（推送点只能越过它们与 `pulledVersions`）。 */
  const pushedVersions = new Set<string>();
  /** 本轮拉回来、解开了的版本。本地与之完全相同的记录不需要（也不该）推回去。 */
  const pulledVersions = new Set<string>();

  let pushed = 0;
  let head = state.pulledHead;

  // ---- 推 ----
  const pushPhase = async (): Promise<void> => {
    const outbound = (await repository.listSyncRecords({ since: state.pushedAt })).filter(
      // 与刚拉回来的一模一样：服务端上已经有了，推回去只会让别的设备看到一条「回声」
      (record) => !pulledVersions.has(versionKey(record)),
    );
    // 分块推（顺序 13）：一块失败了整轮就失败，推送点不推进，下次从同一块重来
    for (let offset = 0; offset < outbound.length; offset += PUSH_BATCH_SIZE) {
      const batch = outbound.slice(offset, offset + PUSH_BATCH_SIZE);
      const wire: SyncWireRecord[] = [];
      for (const record of batch) {
        const value = sealable(record);
        wire.push({
          collection: record.collection,
          id: record.id,
          updatedAt: record.updatedAt,
          // 线上这份只是给服务端看的副本，与密文里的逐字一致；收的一方只信密文（审计 A6）
          deletedAt: sealedDeletedAt(value),
          sealed: await encryptRecord(
            input.encKey,
            {
              spaceHandle: input.spaceHandle,
              collection: record.collection,
              id: record.id,
              updatedAt: record.updatedAt,
            },
            value,
          ),
          // 这台设备的号：跟着每条记录上线上，服务端与别的设备才知道「是谁写的」（顺序 14/19）
          deviceId,
        });
      }

      const result = await input.transport.push({ ...credentials, records: wire });

      pushed += wire.length;
      head = Math.max(head, result.head);
      for (const record of batch) pushedVersions.add(versionKey(record));
    }
  };

  // ---- 拉（分页拉，直到追平服务端）----
  //
  // 服务端一页只给 200 条（见 sync/server.ts 的 DEFAULT_PULL_LIMIT），所以这里必须
  // **一直拉到追平**。曾经的写法只拉一页，并且把全局头号当成新游标——一台新设备
  // 同步一个超过一页的空间时，会「同步成功」出一份残缺的数据（换设备复现过）。
  let cursor = state.pulledHead;
  let serverHead = cursor;
  let pulledCount = 0;
  let applied = 0;
  let skipped = 0;
  let truncated = false;
  const quarantined: SyncQuarantinedRecord[] = [];
  let quarantinedCount = 0;
  const overridden: SyncOverriddenRecord[] = [];
  let overriddenCount = 0;

  const quarantine = (collection: string, id: string, reason: string): void => {
    quarantinedCount += 1;
    if (quarantined.length < QUARANTINE_DETAIL_LIMIT) quarantined.push({ collection, id, reason });
  };

  const pullPhase = async (): Promise<void> => {
    for (let round = 0; ; round += 1) {
      const page = await input.transport.pull({
        ...credentials,
        since: cursor,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });

      // 返回的这一批**真正**给到了哪里：有记录看最后一条的号，没记录就是没得拉
      const last = page.records[page.records.length - 1];
      const pageEnd = last === undefined ? page.head : last.serverRev;
      // 老服务端不发 serverHead / hasMore，按「游标有没有追平全局头号」自己判断
      serverHead = Math.max(serverHead, page.serverHead ?? page.head);
      const hasMore = page.hasMore ?? pageEnd < (page.serverHead ?? page.head);

      const decoded: LocalSyncRecord[] = [];
      for (const record of page.records) {
        let value: unknown;
        try {
          value = await decryptRecord<unknown>(
            input.encKey,
            {
              spaceHandle: input.spaceHandle,
              collection: record.collection,
              id: record.id,
              updatedAt: record.updatedAt,
            },
            record.sealed,
          );
        } catch (error) {
          /*
           * 坏记录隔离（顺序 13）：**这一条**解不开，跳过它继续。
           *
           * 以前的写法是整轮抛错。听起来更安全，实际后果是：服务端上只要有一条
           * 坏记录，这台设备的同步就永远停在它前面——用户的观感是「同步坏了」，
           * 而且自己没有任何办法恢复。现在跳过它、把这件事记进报告，
           * 界面上明说「跳过了 N 条」，其余数据照常同步。
           */
          quarantine(record.collection, record.id, error instanceof CryptoError ? error.message : String(error));
          continue;
        }

        /*
         * 墓碑只信密文里的那一份（审计 A6）。
         *
         * `deletedAt` 不在 AAD 里：恶意服务端可以保持密文与 `updatedAt` 不变、只改线上
         * 明文的 `deletedAt`，而合并在时间戳相同时「墓碑赢」——于是能凭空删掉一条，
         * 或者反过来复活一条。每个客户端推上去的墓碑密文里都带着同一个 `deletedAt`
         * （仓储层的墓碑就是带 `deletedAt` 的整条实体），所以两者不一致只可能是被动过。
         */
        const deletedAt = sealedDeletedAt(value);
        if (deletedAt !== (record.deletedAt ?? null)) {
          quarantine(
            record.collection,
            record.id,
            '这条记录线上标的「已删除」与密文里的不一致，可能在服务端被动过，已跳过。',
          );
          continue;
        }

        decoded.push({
          collection: record.collection,
          id: record.id,
          updatedAt: record.updatedAt,
          deletedAt,
          value,
          ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
        });
      }

      // 逐页合并，而不是先攒齐再合并：空间大的时候内存不必扛下整份数据
      const merged = await mergeRemoteRecords(decoded, {
        get: (record) => repository.getSyncRecord(record.collection, record.id),
        put: (record) => repository.putSyncRecord(record),
      });
      applied += merged.applied;
      skipped += merged.skipped;
      /*
       * 覆盖可见性（顺序 19）：只统计**来自别的设备**的那些。
       * 本机自己的旧版本被自己挡回去不算覆盖，「两台设备撞车」才是用户想看的。
       */
      for (const record of decoded) {
        pulledVersions.add(versionKey(record));
        if (record.deviceId === undefined || record.deviceId === deviceId) continue;
        if (merged.overriddenIds.has(`${record.collection}/${record.id}`)) {
          overriddenCount += 1;
          if (overridden.length < QUARANTINE_DETAIL_LIMIT) {
            overridden.push({ collection: record.collection, id: record.id, deviceId: record.deviceId });
          }
        }
      }
      pulledCount += decoded.length;

      cursor = pageEnd;
      /*
       * 停下来的条件是**服务端这一页没给东西**，不是「解开了几条」：
       * 一页全是坏记录时（比如整个空间是别的密码写的），以前会在半路
       * 悄悄停下，剩下的记录一条都拉不回来。
       */
      if (!hasMore || page.records.length === 0) break;
      if (round + 1 >= MAX_PULL_ROUNDS) {
        truncated = true;
        break;
      }
    }
  };

  if (state.pulledHead === 0 || state.pushedAt === null) {
    // 新设备 / 换空间 / 被重置：先把服务端上的一切合并进来，再只推本机确实更新的，
    // 最后把自己刚推的收回来对齐游标（否则下一轮会把这一批当成新东西再拉一遍）
    await pullPhase();
    // 一轮没拉完（到了页数上限）就先不推：没拉到的那部分里可能有比本机更新的版本
    if (!truncated) {
      await pushPhase();
      if (pushed > 0) await pullPhase();
    }
  } else {
    await pushPhase();
    await pullPhase();
  }

  /*
   * ---- 推送点（审计 A3）----
   *
   * 以前的写法是「推上去的 + 拉回来的记录里最晚的那个时间」。失败场景：推完之后、
   * 拉之前，本机写了一条 T1；同轮拉回另一台设备的 T2 > T1。推送点被推到 T2，
   * 下一轮 `since: T2` 就把 T1 跳过了——这条永远推不上去，界面还说两端一致。
   *
   * 现在重新读一遍「推送点之后的本地记录」，按时间从早到晚，只越过**本轮推上去的版本**
   * 与**本地和拉回来那份完全相同的版本**；碰到第一条两者都不是的（同步期间新写的、
   * 或者本地比拉回来那份更新的）就停在它前面，下一轮它还在。
   */
  const pending = await repository.listSyncRecords({ since: state.pushedAt });
  pending.sort((left, right) => (left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0));
  let pushedAt = state.pushedAt;
  for (let index = 0; index < pending.length; ) {
    const at = pending[index]?.updatedAt ?? '';
    let end = index;
    let accounted = true;
    // 同一时刻的一组要么一起越过，要么都不越过：推送点是按 `updatedAt <= since` 过滤的
    while (end < pending.length && pending[end]?.updatedAt === at) {
      const record = pending[end];
      if (record !== undefined) {
        const key = versionKey(record);
        if (!pushedVersions.has(key) && !pulledVersions.has(key)) accounted = false;
      }
      end += 1;
    }
    if (!accounted) break;
    pushedAt = later(pushedAt, at);
    index = end;
  }

  const reportedHead = Math.max(serverHead, cursor);
  // 拉到的位置（cursor）才是下次的起点；服务端头号只用于显示「还差多少」。
  // 到上限被迫停下时不装作成功——游标只推进到真正拿到的位置，下一次接着拉。
  head = Math.max(head, truncated ? cursor : reportedHead);

  // 游标只在整轮走完之后推进（推送点同理）：中途抛错就下次重来，不会有半截状态
  await repository.writeSyncState({
    spaceHandle: input.spaceHandle,
    pulledHead: cursor,
    pushedAt,
    ...(remoteEpoch === undefined ? {} : { epoch: remoteEpoch }),
  });

  return {
    spaceHandle: input.spaceHandle,
    pushed,
    pulled: pulledCount,
    applied,
    skipped,
    quarantined,
    quarantinedCount,
    overridden,
    overriddenCount,
    head,
    reset,
  };
}
