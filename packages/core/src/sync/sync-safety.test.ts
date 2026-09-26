/**
 * 同步正确性的时序回归（审计 A3 / A4 / A6）。
 *
 * 这三条的共同点：出错时**界面仍然说两端一致**，只有换设备才发现少了东西。
 * 所以每一条都按「失败场景」原样复现，而不是只测函数的返回值。
 */

import { describe, expect, it } from 'vitest';
import { createSpaceCredentials, openSpace } from '../crypto/keys.js';
import { createBlankCard } from '../model/card.js';
import { eventId, newId, nowIso, type RoomId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { createPersona } from '../model/persona.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createWorldFromCard } from '../session/setup.js';
import { Repository } from '../storage/repository.js';
import { resetSyncState, runSync } from './loop.js';
import { createMemorySyncTransport, type MemorySyncServer } from './memory-transport.js';
import type { SyncTransport } from './types.js';

const FAST = { handleIterations: 100, keyIterations: 200 };

interface Device {
  repository: Repository;
  credential: string;
  encKey: CryptoKey;
}

async function setup() {
  const created = await createSpaceCredentials({ userId: '旅人', password: '同步密码', ...FAST });
  const server = createMemorySyncTransport({
    spaceHandle: created.spaceHandle,
    credentialHash: created.credentialHash,
  });
  const joined = await openSpace({
    spaceHandle: created.spaceHandle,
    secret: '同步密码',
    purpose: 'password',
    wrapped: created.passwordWrap,
    keyIterations: FAST.keyIterations,
  });
  const a: Device = {
    repository: new Repository(createMemoryEntityStore()),
    credential: created.credential,
    encKey: created.encKey,
  };
  const b: Device = {
    repository: new Repository(createMemoryEntityStore()),
    credential: joined.credential,
    encKey: joined.encKey,
  };
  return { created, server, a, b };
}

function syncWith(device: Device, spaceHandle: string, transport: SyncTransport) {
  return runSync({
    repository: device.repository,
    transport,
    spaceHandle,
    credential: device.credential,
    encKey: device.encKey,
  });
}

async function seedWorld(repository: Repository, title: string) {
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
  await repository.saveRoom({ ...world.room, title });
  return world;
}

async function remember(repository: Repository, roomId: RoomId, summary: string): Promise<string> {
  const event: MemoryEvent = {
    id: eventId(newId()),
    roomId,
    conversationId: null,
    sceneId: null,
    timeline: { worldTime: '第一日', sequence: 1 },
    location: '',
    participants: [],
    summary,
    observerId: null,
    perception: '',
    importance: 0.5,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: ['turn-1'],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
    lastRecalledAt: null,
    recallCount: 0,
  };
  await repository.saveMemories([event]);
  return event.id;
}

describe('推送点只由本机推上去的记录推进（审计 A3）', () => {
  it('推拉之间插进来的本地写入 + 对端时钟超前：这条下一轮照样推得出去', async () => {
    const { created, server, a, b } = await setup();
    const world = await seedWorld(a.repository, '老世界');
    await syncWith(a, created.spaceHandle, server.transport);
    await syncWith(b, created.spaceHandle, server.transport);

    // B 的时钟快了几十年：它写的记录时间戳远在 A 的本机时间之后
    const room = await b.repository.getRoom(world.room.id);
    if (room === null) throw new Error('B 没拿到房间');
    await b.repository.putSyncRecord({
      collection: 'rooms',
      id: room.id,
      updatedAt: '2090-01-01T00:00:00.000Z',
      deletedAt: null,
      value: { ...room, title: 'B 用超前的钟改的' },
    });
    const stateB = await b.repository.readSyncState();
    await b.repository.writeSyncState({ ...stateB, pushedAt: '2000-01-01T00:00:00.000Z' });
    await syncWith(b, created.spaceHandle, server.transport);

    // A 同步：推完之后、拉之前，本机又写了一条记忆（时间戳是 A 的本机时间，远早于 2090）
    let memoryId = '';
    const interleaving: SyncTransport = {
      head: (input) => server.transport.head(input),
      push: (input) => server.transport.push(input),
      pull: async (input) => {
        if (memoryId === '') memoryId = await remember(a.repository, world.room.id, '同步途中记下的');
        return server.transport.pull(input);
      },
    };
    const first = await syncWith(a, created.spaceHandle, interleaving);
    expect(first.applied).toBeGreaterThan(0);
    expect((await a.repository.getRoom(world.room.id))?.title).toBe('B 用超前的钟改的');

    // 推送点没有越过那条记忆
    const memory = (await a.repository.listSyncRecords()).find((record) => record.id === memoryId);
    const stateA = await a.repository.readSyncState();
    expect(memory).toBeDefined();
    expect(stateA.pushedAt === null || (memory?.updatedAt ?? '') > stateA.pushedAt).toBe(true);

    // 下一轮它被推上去，B 收得到
    const second = await syncWith(a, created.spaceHandle, server.transport);
    expect(second.pushed).toBeGreaterThanOrEqual(1);
    await syncWith(b, created.spaceHandle, server.transport);
    const memoriesB = await b.repository.listMemories(world.room.id);
    expect(memoriesB.map((item) => item.summary)).toContain('同步途中记下的');
  });

  it('拉回来的记录不会被推回去：两边来回同步几轮，推送数归零', async () => {
    const { created, server, a, b } = await setup();
    const world = await seedWorld(a.repository, '老世界');
    await syncWith(a, created.spaceHandle, server.transport);
    await syncWith(b, created.spaceHandle, server.transport);
    await remember(b.repository, world.room.id, 'B 记的');
    await syncWith(b, created.spaceHandle, server.transport);

    const a1 = await syncWith(a, created.spaceHandle, server.transport);
    expect(a1.applied).toBe(1);
    const a2 = await syncWith(a, created.spaceHandle, server.transport);
    const b2 = await syncWith(b, created.spaceHandle, server.transport);
    expect(a2.pushed).toBe(0);
    expect(b2.pushed).toBe(0);
    // 自己推的回声不算「被别的设备覆盖」
    expect(b2.overriddenCount).toBe(0);
  });
});

describe('服务端重建 / 回滚之后游标自愈（审计 A4）', () => {
  it('服务端库丢了重建（号从 0 数起）：本机按新设备重来，把数据推回去', async () => {
    const { created, server, a } = await setup();
    const world = await seedWorld(a.repository, '老世界');
    await remember(a.repository, world.room.id, '记忆一');
    await syncWith(a, created.spaceHandle, server.transport);
    const before = server.stats().records;

    // 同一个句柄、同一份凭证，但库是空的
    const rebuilt: MemorySyncServer = createMemorySyncTransport({
      spaceHandle: created.spaceHandle,
      credentialHash: created.credentialHash,
    });
    const report = await syncWith(a, created.spaceHandle, rebuilt.transport);
    expect(report.reset).toBe('head-behind');
    expect(report.pushed).toBe(before);
    expect(rebuilt.stats().records).toBe(before);
  });

  it('重建之后号又涨过了旧值：靠纪元（epoch）认出来，而且不拿本机旧版本顶掉服务端上更新的', async () => {
    const { created, server, a, b } = await setup();
    const world = await seedWorld(a.repository, '老世界');
    await syncWith(a, created.spaceHandle, server.transport);
    await syncWith(b, created.spaceHandle, server.transport);
    const stateB = await b.repository.readSyncState();
    expect(stateB.epoch).toBeDefined();

    // 服务端重建；A 先连上来，推了一大堆（号远超 B 记得的旧值），其中房间标题是新的
    const rebuilt = createMemorySyncTransport({
      spaceHandle: created.spaceHandle,
      credentialHash: created.credentialHash,
    });
    for (let index = 0; index < stateB.pulledHead + 5; index += 1) {
      await remember(a.repository, world.room.id, `重建后 ${String(index)}`);
    }
    const roomA = await a.repository.getRoom(world.room.id);
    if (roomA === null) throw new Error('没有房间');
    await a.repository.saveRoom({ ...roomA, title: 'A 在重建后改的' });
    await syncWith(a, created.spaceHandle, rebuilt.transport);
    expect(rebuilt.stats().head).toBeGreaterThan(stateB.pulledHead);

    const report = await syncWith(b, created.spaceHandle, rebuilt.transport);
    expect(report.reset).toBe('epoch-changed');
    // B 先拉后推：拿到了 A 的新标题，自己手里的旧版本一条都没推上去
    expect(report.pushed).toBe(0);
    expect((await b.repository.getRoom(world.room.id))?.title).toBe('A 在重建后改的');
    expect((await b.repository.listMemories(world.room.id)).length).toBe(stateB.pulledHead + 5);

    await syncWith(a, created.spaceHandle, rebuilt.transport);
    expect((await a.repository.getRoom(world.room.id))?.title).toBe('A 在重建后改的');
  });

  it('老服务端不发纪元：照常同步，本地也不记纪元', async () => {
    const { created, server, a } = await setup();
    await seedWorld(a.repository, '老世界');
    const legacy: SyncTransport = {
      head: async (input) => ({ head: (await server.transport.head(input)).head }),
      push: (input) => server.transport.push(input),
      pull: (input) => server.transport.pull(input),
    };
    const report = await syncWith(a, created.spaceHandle, legacy);
    expect(report.reset).toBeNull();
    expect((await a.repository.readSyncState()).epoch).toBeUndefined();
    const again = await syncWith(a, created.spaceHandle, legacy);
    expect(again.pushed).toBe(0);
    expect(again.reset).toBeNull();
  });

  it('resetSyncState 之后的下一轮：先拉再推，本地与服务端相同的记录一条都不重推', async () => {
    const { created, server, a, b } = await setup();
    const world = await seedWorld(a.repository, '老世界');
    await syncWith(a, created.spaceHandle, server.transport);
    await syncWith(b, created.spaceHandle, server.transport);
    await remember(b.repository, world.room.id, 'B 只在本机的');

    await resetSyncState(b.repository, created.spaceHandle);
    expect(await b.repository.readSyncState()).toMatchObject({ pulledHead: 0, pushedAt: null });

    const report = await syncWith(b, created.spaceHandle, server.transport);
    expect(report.pulled).toBeGreaterThan(0);
    // 只推了本机独有的那一条
    expect(report.pushed).toBe(1);
    const again = await syncWith(b, created.spaceHandle, server.transport);
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
  });
});

describe('墓碑只信密文里的那一份（审计 A6）', () => {
  it('服务端只改线上的 deletedAt 想删掉一条：被隔离，本地不删', async () => {
    const { created, server, a, b } = await setup();
    const world = await seedWorld(a.repository, '老世界');
    const memoryId = await remember(a.repository, world.room.id, '别删我');
    await syncWith(a, created.spaceHandle, server.transport);
    await syncWith(b, created.spaceHandle, server.transport);

    const row = server.raw().find((record) => record.id === memoryId);
    if (row === undefined) throw new Error('服务端没有这条');
    server.tamper('memories', memoryId, { deletedAt: row.updatedAt });
    // 让 B 从头再拉一次那条被改过的
    const stateB = await b.repository.readSyncState();
    await b.repository.writeSyncState({ ...stateB, pulledHead: 1 });

    const report = await syncWith(b, created.spaceHandle, server.transport);
    expect(report.quarantined.some((item) => item.id === memoryId)).toBe(true);
    expect((await b.repository.listMemories(world.room.id)).map((item) => item.summary)).toContain('别删我');
  });

  it('服务端把墓碑的 deletedAt 抹掉想复活一条：被隔离，本地仍是删掉的', async () => {
    const { created, server, a, b } = await setup();
    const world = await seedWorld(a.repository, '老世界');
    const memoryId = await remember(a.repository, world.room.id, '删掉的');
    await syncWith(a, created.spaceHandle, server.transport);
    await syncWith(b, created.spaceHandle, server.transport);
    await a.repository.deleteMemory(memoryId as never);
    await syncWith(a, created.spaceHandle, server.transport);
    // 墓碑的密文里确实带着 deletedAt，于是正常同步删得掉
    await syncWith(b, created.spaceHandle, server.transport);
    expect(await b.repository.listMemories(world.room.id)).toHaveLength(0);

    // 服务端把墓碑改成「活的」：新设备拉到它不能把删掉的东西复活
    server.tamper('memories', memoryId, { deletedAt: null });
    const fresh = new Repository(createMemoryEntityStore());
    const report = await syncWith({ ...b, repository: fresh }, created.spaceHandle, server.transport);
    expect(report.quarantined.some((item) => item.id === memoryId)).toBe(true);
    expect(await fresh.listMemories(world.room.id)).toHaveLength(0);
    expect(await fresh.getSyncRecord('memories', memoryId)).toBeNull();
  });
});
