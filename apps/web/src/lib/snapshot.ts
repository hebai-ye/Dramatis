/**
 * 服务端快照（顺序 17）：把服务端上那份**原文**存成一个文件，也能再灌回去。
 *
 * 它是什么：一条条记录的密文 + 坐标（`collection/id/updatedAt/deletedAt/sealed`），
 * 原样取自服务端。**它本身解不开**——要读懂里面的内容仍然需要同步密码或恢复码。
 *
 * 它解决的是什么问题：本机数据与服务端数据是**同一份数据的两个副本**，
 * 两边都有各自的失效方式（本地库被浏览器清掉、服务端被清库/换机器）。
 *
 * - 本地没了、服务端还在 → 同步一下就能拉回来（本来就有，`resync` 那个按钮）。
 * - 服务端没了、本地还在 → 重新开通空间、把本地的推上去（顺序 11 那条提示）。
 * - **两边都没了** → 只有这个文件能证明「当时服务端上有什么」，而且如果还有密码，
 *   它还能被重新灌回一个空的服务端（`restoreSnapshot`）。这就是它存在的理由。
 *
 * 为什么不做「每天自动存」，只做提醒：浏览器不让页面在没有用户操作时写文件，
 * 所以自动存只能是下载目录里堆垃圾。改成「超过一天没存就给一条提示 + 一个按钮」，
 * 让用户自己决定——这条产品判断写在 LAYOUT 里。
 */

import type { SyncPulledRecord } from '@dramatis/core';

export const SNAPSHOT_KIND = 'dramatis-server-snapshot';
export const SNAPSHOT_VERSION = 1;
/** 超过这个时间没存，界面上提醒一句。 */
export const SNAPSHOT_REMIND_MS = 24 * 60 * 60 * 1000;

export interface ServerSnapshot {
  kind: typeof SNAPSHOT_KIND;
  version: number;
  spaceHandle: string;
  takenAt: string;
  /** 存这份快照的那台设备（排查「谁存的」用）。 */
  deviceId: string;
  /** 服务端当时的头号，恢复完可以对照。 */
  head: number;
  records: SyncPulledRecord[];
  note: string;
}

export function buildSnapshot(input: {
  spaceHandle: string;
  deviceId: string;
  head: number;
  records: SyncPulledRecord[];
}): ServerSnapshot {
  return {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    spaceHandle: input.spaceHandle,
    takenAt: new Date().toISOString(),
    deviceId: input.deviceId,
    head: input.head,
    records: input.records,
    note: '这是服务端那份的原文（只有密文与坐标）。要读里面的内容仍然需要同步密码或恢复码；这份文件可以在服务端被清空后重新灌回去。',
  };
}

/** 认一份文件是不是我们的快照；不是就给出人话，别让用户猜。 */
export function parseSnapshot(raw: string): ServerSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('这个文件不是合法 JSON。');
  }
  const record = parsed as Partial<ServerSnapshot> | null;
  if (record === null || record.kind !== SNAPSHOT_KIND) {
    throw new Error('这不是「服务端快照」文件（kind 不对）。封存文件请用「数据」那一档导入。');
  }
  if (!Array.isArray(record.records)) throw new Error('快照文件里没有 records 数组。');
  if (typeof record.spaceHandle !== 'string' || record.spaceHandle === '') {
    throw new Error('快照文件里没有空间句柄。');
  }
  return {
    kind: SNAPSHOT_KIND,
    version: typeof record.version === 'number' ? record.version : SNAPSHOT_VERSION,
    spaceHandle: record.spaceHandle,
    takenAt: typeof record.takenAt === 'string' ? record.takenAt : '',
    deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
    head: typeof record.head === 'number' ? record.head : 0,
    records: record.records,
    note: typeof record.note === 'string' ? record.note : '',
  };
}

/** 文件名：带日期和空间前 8 位，一眼看得出是哪一份。 */
export function snapshotFileName(snapshot: ServerSnapshot): string {
  const stamp = snapshot.takenAt.slice(0, 10).replace(/-/g, '');
  return `dramatis-server-${snapshot.spaceHandle.slice(0, 8)}-${stamp}.json`;
}
