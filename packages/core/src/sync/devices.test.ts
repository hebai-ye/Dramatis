/**
 * 设备可见性、换密码、覆盖可见性（顺序 14 / 15 / 19）。
 *
 * 三项合在一个文件里，因为它们共用同一条协议改动：**记录上多了一个 `deviceId`**。
 * 顺序 14 靠它列出「最近写过的设备」，顺序 19 靠它说清「这条被哪台设备改过」，
 * 顺序 15（换密码）是这三项里唯一会**改变权限**的动作：换完之后，
 * 只知道旧密码的设备再也同步不了——这就是「断开一台设备」的真实语义。
 */

import { describe, expect, it } from 'vitest';
import { createSpaceCredentials, openSpace, rotatePassword } from '../crypto/keys.js';
import { createBlankCard } from '../model/card.js';
import { createPersona } from '../model/persona.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createWorldFromCard } from '../session/setup.js';
import { Repository } from '../storage/repository.js';
import { runSync } from './loop.js';
import { createMemorySyncTransport, type MemorySyncServer } from './memory-transport.js';
import { SyncServerError } from './server.js';
import type { SyncReport } from './types.js';

/** 测试里把 KDF 迭代数调小：这里验的是协议与权限，不是 KDF 的强度。 */
const FAST = { handleIterations: 100, keyIterations: 200 };

interface Peer {
  repository: Repository;
  credential: string;
  encKey: CryptoKey;
}

/** 一台设备的本地库：一个世界（房间 / 对话 / 场景 / 实例 / 卡 / 身份）。 */
async function freshDevice(credential: string, encKey: CryptoKey): Promise<Peer> {
  const repository = new Repository(createMemoryEntityStore());
  const persona = createPersona({ name: '旅人' });
  await repository.savePersona(persona);
  const card = createBlankCard({ name: '陈九' });
  const world = createWorldFromCard(card, persona);
  await repository.saveCard(card);
  await repository.saveSnapshot({
    room: world.room,
    conversations: [world.conversation],
    scenes: [world.scene],
    instances: [world.instance],
  });
  return { repository, credential, encKey };
}

function syncOf(peer: Peer, server: MemorySyncServer, spaceHandle: string): Promise<SyncReport> {
  return runSync({
    repository: peer.repository,
    transport: server.transport,
    spaceHandle,
    credential: peer.credential,
    encKey: peer.encKey,
  });
}

async function twoDevices() {
  const created = await createSpaceCredentials({ userId: '旅人', password: '老密码', ...FAST });
  const server = createMemorySyncTransport({
    spaceHandle: created.spaceHandle,
    credentialHash: created.credentialHash,
    /*
     * 必须给**真的**恢复码哈希：内存传输的默认值是把两份设成同一个，
     * 那样「换密码之后旧密码还能不能用」就测不出来了
     * （旧凭证会从恢复码那条路蒙混过关）。真机上这两个哈希本来就是不同的。
     */
    recoveryCredentialHash: created.recoveryCredentialHash,
  });
  const opened = await openSpace({
    spaceHandle: created.spaceHandle,
    secret: '老密码',
    purpose: 'password',
    wrapped: created.passwordWrap,
    keyIterations: FAST.keyIterations,
  });
  return {
    created,
    server,
    a: await freshDevice(created.credential, created.encKey),
    b: await freshDevice(opened.credential, opened.encKey),
  };
}

describe('设备可见性（顺序 14）', () => {
  it('记录带着设备号上线上，服务端按设备聚合出「最近写过的设备」', async () => {
    const { created, server, a, b } = await twoDevices();
    await syncOf(a, server, created.spaceHandle);
    await syncOf(b, server, created.spaceHandle);

    const { devices } = (await server.transport.devices?.({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
    })) ?? { devices: [] };

    expect(devices.length).toBe(2);
    // 两台设备的号都是各自本机生成的随机 uuid，不会撞
    expect(new Set(devices.map((device) => device.deviceId)).size).toBe(2);
    expect(devices.every((device) => device.records > 0)).toBe(true);
    // 列表按「最后写入时间」倒序
    expect((devices[0]?.lastWriteAt ?? '') >= (devices[1]?.lastWriteAt ?? '')).toBe(true);

    // 服务端看到的设备号就是本机那两个（不是它自己编的）
    const known = new Set([await a.repository.deviceId(), await b.repository.deviceId()]);
    expect(devices.every((device) => known.has(device.deviceId))).toBe(true);
  });

  it('服务端上仍然没有明文（除了坐标与随机设备号）', async () => {
    const { created, server, a } = await twoDevices();
    await syncOf(a, server, created.spaceHandle);
    const raw = JSON.stringify(server.raw());
    expect(raw).toContain('rooms'); // 坐标是明文的，这是设计
    expect(raw).not.toContain('旅人');
    expect(raw).not.toContain('陈九');
  });
});

describe('换同步密码（顺序 15）= 断开只知道旧密码的设备', () => {
  it('旧凭证 401、新密码可用、恢复码照样开、主密钥没换（旧数据还解得开）', async () => {
    const { created, server, a } = await twoDevices();
    await syncOf(a, server, created.spaceHandle);

    const rotated = await rotatePassword({
      spaceHandle: created.spaceHandle,
      encKey: created.encKey,
      newPassword: '新密码',
      keyIterations: FAST.keyIterations,
    });
    await server.transport.rotate?.({
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      credentialHash: rotated.credentialHash,
      passwordWrap: rotated.passwordWrap,
    });

    // 旧密码：过不了鉴权了（这就是「把只知道旧密码的设备断开」）
    await expect(
      server.transport.head({ spaceHandle: created.spaceHandle, credential: created.credential }),
    ).rejects.toBeInstanceOf(SyncServerError);

    // 新密码：解出来的是同一把主密钥 —— 用它连上去，能把 A 推上去的东西拉回来
    const reopened = await openSpace({
      spaceHandle: created.spaceHandle,
      secret: '新密码',
      purpose: 'password',
      wrapped: rotated.passwordWrap,
      keyIterations: FAST.keyIterations,
    });
    const b = await freshDevice(reopened.credential, reopened.encKey);
    const report = await syncOf(b, server, created.spaceHandle);
    expect(report.pulled).toBeGreaterThan(0);
    expect((await b.repository.listRooms()).length).toBeGreaterThan(0);

    // 恢复码那份封装刻意没动：老设备的恢复码照样能开
    const byRecovery = await openSpace({
      spaceHandle: created.spaceHandle,
      secret: created.recoveryCode,
      purpose: 'recovery',
      wrapped: created.recoveryWrap,
      keyIterations: FAST.keyIterations,
    });
    expect(byRecovery.credential).not.toBe('');
  });
});

describe('覆盖可见性（顺序 19）', () => {
  it('另一台设备推了一条更旧的 → 报告里说得出「被哪台挡回去了」', async () => {
    const { created, server, a, b } = await twoDevices();
    await syncOf(a, server, created.spaceHandle);
    await syncOf(b, server, created.spaceHandle);

    /*
     * 真实场景：A 改了一条记录并推上去（时间戳 10）；B 离线一阵子，
     * 期间也改过同一条（时间戳 5），回来后把旧的推上去。A 再同步时，
     * 拉到的这条比本机旧 ⇒ 本机留着，而「这条是 B 写的」要能说出来。
     */
    const roomId = (await a.repository.listRooms())[0]?.id;
    expect(roomId).toBeDefined();
    if (roomId === undefined) return;

    const roomA = await a.repository.getRoom(roomId);
    if (roomA === null) return;
    /*
     * 时间戳直接写同步层（`putSyncRecord`），不走 `saveRoom`：
     * 仓储层会给实体盖上**当前时间**，那样两边的先后就由测试跑的先后决定，
     * 而不是我指定的时间——这一条测的是「旧的不该盖新的」，时间必须由我说了算。
     */
    await a.repository.putSyncRecord({
      collection: 'rooms',
      id: roomId,
      updatedAt: '2099-01-01T00:00:00.000Z',
      deletedAt: null,
      value: { ...roomA, title: 'A 改的' },
    });
    await syncOf(a, server, created.spaceHandle);

    const roomB = await b.repository.getRoom(roomId);
    if (roomB === null) return;
    await b.repository.putSyncRecord({
      collection: 'rooms',
      id: roomId,
      updatedAt: '2000-01-01T00:00:00.000Z',
      deletedAt: null,
      value: { ...roomB, title: 'B 改的（更旧）' },
    });
    /*
     * 让 B 把这条旧版本推上去：推送点拨回 2000 年之前，游标留着（不能清零——
     * 清零会走「先拉后推」，B 会先收下 A 那条更新的，旧版本根本不会被推上去，
     * 那正是审计 A4 要的行为）。
     */
    const stateB = await b.repository.readSyncState();
    await b.repository.writeSyncState({ ...stateB, pushedAt: '1999-12-31T00:00:00.000Z' });
    await syncOf(b, server, created.spaceHandle);

    const report = await syncOf(a, server, created.spaceHandle);
    const bDeviceId = await b.repository.deviceId();
    expect(report.overriddenCount).toBeGreaterThan(0);
    expect(report.overridden.some((item) => item.deviceId === bDeviceId)).toBe(true);
    // 本机那条留着（没被旧版本盖回去）
    expect((await a.repository.getRoom(roomId))?.title).toBe('A 改的');
  });
});
