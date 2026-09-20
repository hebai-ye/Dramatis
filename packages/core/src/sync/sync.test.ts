import { describe, expect, it } from 'vitest';
import { createSpaceCredentials, openSpace } from '../crypto/keys.js';
import { createBlankCard } from '../model/card.js';
import { eventId, newId, nowIso, type RoomId, type SceneId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { createPersona } from '../model/persona.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createWorldFromCard } from '../session/setup.js';
import { createPlayerMessage, createTurnId } from '../session/turn.js';
import { Repository } from '../storage/repository.js';
import { runSync } from './loop.js';
import { createMemorySyncTransport, type MemorySyncServer } from './memory-transport.js';
import { decideMerge } from './merge.js';
import { SyncServerError } from './server.js';
import type { SyncTransport } from './types.js';

/** 测试里把 KDF 迭代数调小：这里验的是协议与合并，不是 KDF 的强度。 */
const FAST = { handleIterations: 100, keyIterations: 200 };

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Device {
  repository: Repository;
  credential: string;
  encKey: CryptoKey;
}

interface PeerToPeer {
  spaceHandle: string;
  server: MemorySyncServer;
  a: Device;
  b: Device;
}

/** 两台设备 + 一台内存服务端：A 建空间，B 用密码加入（解出同一把主密钥）。 */
async function twoDevices(): Promise<PeerToPeer> {
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

  return {
    spaceHandle: created.spaceHandle,
    server,
    a: {
      repository: new Repository(createMemoryEntityStore()),
      credential: created.credential,
      encKey: created.encKey,
    },
    b: { repository: new Repository(createMemoryEntityStore()), credential: joined.credential, encKey: joined.encKey },
  };
}

function sync(peer: PeerToPeer, device: Device, transport: SyncTransport = peer.server.transport) {
  return runSync({
    repository: device.repository,
    transport,
    spaceHandle: peer.spaceHandle,
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
  await repository.saveConversation(world.conversation);
  return world;
}

async function say(repository: Repository, roomId: RoomId, sceneId: SceneId, content: string): Promise<string> {
  const [saved] = await repository.appendMessages(roomId, [
    createPlayerMessage({ roomId, sceneId, turnId: createTurnId(), speakerName: '旅人', content }),
  ]);
  if (!saved) throw new Error('未写入');
  return saved.id;
}

async function remember(repository: Repository, roomId: RoomId, summary: string, importance = 0.5): Promise<string> {
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
    importance,
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

describe('decideMerge（LWW 的全部岔路）', () => {
  const base = { updatedAt: '2026-09-19T10:00:00.000Z', deletedAt: null };

  it('本地没有这条 → 收下', () => {
    expect(decideMerge(null, base)).toBe('take-remote');
  });

  it('远端更新 → 收下；远端更旧 → 保留本地', () => {
    expect(decideMerge(base, { ...base, updatedAt: '2026-09-19T10:00:00.001Z' })).toBe('take-remote');
    expect(decideMerge(base, { ...base, updatedAt: '2026-09-19T09:59:59.999Z' })).toBe('keep-local');
  });

  it('时间戳相同：墓碑赢，其余保留本地', () => {
    const tombstone = { ...base, deletedAt: '2026-09-19T10:00:00.000Z' };
    expect(decideMerge(base, tombstone)).toBe('take-remote');
    expect(decideMerge(tombstone, base)).toBe('keep-local');
    expect(decideMerge(tombstone, { ...tombstone, deletedAt: '2026-09-19T10:00:00.000Z' })).toBe('keep-local');
  });
});

describe('同步循环', () => {
  it('空设备第一次同步就拿到同一条世界线（房间/对话/场景/角色/消息）', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    await say(peer.a.repository, world.room.id, world.scene.id, '三十箱货是谁的？');

    const pushedReport = await sync(peer, peer.a);
    expect(pushedReport.pushed).toBeGreaterThanOrEqual(5);
    // 自己推上去的记录会被原样拉回来（服务端不区分是哪台设备写的），
    // 合并看到时间戳相同 → 一条都不改。这是设计里认可的「回声」：
    // 幂等比「省一次往返」重要，何况只有首次同步会撞上。
    expect(pushedReport.applied).toBe(0);

    const pulledReport = await sync(peer, peer.b);
    expect(pulledReport.applied).toBe(pushedReport.pushed);

    const loaded = await peer.b.repository.loadRoom(world.room.id);
    expect(loaded?.room.title).toBe('老世界');
    expect(loaded?.scenes).toHaveLength(1);
    expect(loaded?.instances).toHaveLength(1);
    expect(loaded?.messages.map((message) => message.content)).toEqual(['三十箱货是谁的？']);
    // 消息带着**原设备**的设备号：排序要靠它 + localSeq
    expect(loaded?.messages[0]?.deviceId).toBe(await peer.a.repository.deviceId());
  });

  it('两端离线各聊两轮，联网合并后都看到四条、顺序一致', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    await sync(peer, peer.a);
    await sync(peer, peer.b);

    // 两边各自离线聊两轮
    await say(peer.a.repository, world.room.id, world.scene.id, 'A 的第一句');
    await delay(2);
    await say(peer.a.repository, world.room.id, world.scene.id, 'A 的第二句');
    await delay(2);
    await say(peer.b.repository, world.room.id, world.scene.id, 'B 的第一句');
    await delay(2);
    await say(peer.b.repository, world.room.id, world.scene.id, 'B 的第二句');

    // 拉取型协议要两边各推一次、对方才能拉到：A 先推、B 推完后再让 A 拉一次
    await sync(peer, peer.a);
    await sync(peer, peer.b);
    await sync(peer, peer.a);

    const onA = (await peer.a.repository.listMessages(world.room.id)).map((message) => message.content);
    const onB = (await peer.b.repository.listMessages(world.room.id)).map((message) => message.content);

    expect(onA).toEqual(onB);
    expect(onA).toHaveLength(4);
    // 两台设备的 localSeq 都从 1 开始，所以顺序不能只看序号——这里看的是时间序
    expect(onA).toEqual(['A 的第一句', 'A 的第二句', 'B 的第一句', 'B 的第二句']);
  });

  it('一台删掉的消息，另一台同步后也看不到（库里留的是墓碑）', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    const doomed = await say(peer.a.repository, world.room.id, world.scene.id, '这条要被删掉');
    await sync(peer, peer.a);
    await sync(peer, peer.b);

    await peer.a.repository.deleteMessage(doomed as never);
    await sync(peer, peer.a);
    await sync(peer, peer.b);

    const onB = await peer.b.repository.listMessages(world.room.id);
    expect(onB.some((message) => message.id === doomed)).toBe(false);
    // 墓碑在本地留着：它还要继续推给别的设备（这里证明「删掉」不是「没同步到」）
    const tombstone = await peer.b.repository.getSyncRecord('messages', doomed);
    expect(tombstone?.deletedAt).not.toBeNull();
  });

  it('同一条记忆两边都改过：updatedAt 晚的赢', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    const memoryId = await remember(peer.a.repository, world.room.id, '三十箱货在船上', 0.4);
    await sync(peer, peer.a);
    await sync(peer, peer.b);

    // B 后改（等 3ms 保证时间戳真的更晚）
    await delay(3);
    await peer.b.repository.updateMemory(memoryId as never, { importance: 0.9 });
    await sync(peer, peer.b);
    await sync(peer, peer.a);

    const onA = (await peer.a.repository.listMemories(world.room.id)).find((item) => item.id === memoryId);
    const onB = (await peer.b.repository.listMemories(world.room.id)).find((item) => item.id === memoryId);
    expect(onA?.importance).toBe(0.9);
    expect(onB?.importance).toBe(0.9);
    // 记忆是「全留」：合并不会因为冲突删掉任何一条
    expect(await peer.a.repository.listMemories(world.room.id)).toHaveLength(1);
  });

  it('重复同步是幂等的：第二次不推也不改', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    await say(peer.a.repository, world.room.id, world.scene.id, '一句话');
    await sync(peer, peer.a);
    await sync(peer, peer.b);

    const againA = await sync(peer, peer.a);
    const againB = await sync(peer, peer.b);

    // 拉回来的东西不会再被推回去（推送点跟着拉取一起推进）
    expect(againA.pushed).toBe(0);
    expect(againA.pulled).toBe(0);
    expect(againA.applied).toBe(0);
    expect(againB.pushed).toBe(0);
    expect(againB.applied).toBe(0);
  });

  it('换空间时本地游标作废，从头拉一遍', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    await say(peer.a.repository, world.room.id, world.scene.id, '一句话');
    await sync(peer, peer.a);
    await sync(peer, peer.b);

    // 一台新的设备，库里还留着别的空间留下的状态（游标很靠后、推送点很晚）：
    // 如果照单全收，它会把所有记录都当成「已经拉过了」，用户看到一片空白
    const fresh = new Repository(createMemoryEntityStore());
    await fresh.writeSyncState({
      spaceHandle: 'another-space',
      pulledHead: 999,
      pushedAt: '2099-01-01T00:00:00.000Z',
    });

    const report = await runSync({
      repository: fresh,
      transport: peer.server.transport,
      spaceHandle: peer.spaceHandle,
      credential: peer.b.credential,
      encKey: peer.b.encKey,
    });

    expect(report.pulled).toBe(report.applied);
    expect(report.pulled).toBeGreaterThan(0);
    expect((await fresh.readSyncState()).spaceHandle).toBe(peer.spaceHandle);
    expect((await fresh.loadRoom(world.room.id))?.messages.map((message) => message.content)).toEqual(['一句话']);
  });

  it('凭证不对时服务端直接拒绝', async () => {
    const peer = await twoDevices();
    await seedWorld(peer.a.repository, '老世界');

    await expect(
      peer.server.transport.head({ spaceHandle: peer.spaceHandle, credential: '伪造的凭证' }),
    ).rejects.toBeInstanceOf(SyncServerError);
    await expect(
      runSync({
        repository: peer.b.repository,
        transport: peer.server.transport,
        spaceHandle: peer.spaceHandle,
        credential: '伪造的凭证',
        encKey: peer.b.encKey,
      }),
    ).rejects.toThrowError(/凭证/);
  });

  it('服务端手里只有密文（明文一个字都不上去）', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    await say(peer.a.repository, world.room.id, world.scene.id, '「三十箱货是谁的？」');
    await sync(peer, peer.a);

    const raw = JSON.stringify(peer.server.raw());
    expect(raw).not.toContain('三十箱');
    expect(raw).not.toContain('老世界');
    // 坐标（id / 集合名）是明文的，这是设计：服务端靠它们路由与排队
    expect(raw).toContain('messages');
  });

  it('服务端动了记录的内容或坐标 → 解密失败，整轮报错而不是静默跳过', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    const messageId = await say(peer.a.repository, world.room.id, world.scene.id, '别动我');
    await sync(peer, peer.a);

    peer.server.tamper('messages', messageId, { updatedAt: '2099-01-01T00:00:00.000Z' });

    await expect(sync(peer, peer.b)).rejects.toThrowError(/解不开/);
    // 游标没被推进：修好之后原样重来
    expect((await peer.b.repository.readSyncState()).pulledHead).toBe(0);
  });
});

describe('同步读口 / 写口', () => {
  it('listSyncRecords 只给白名单里的集合，且含墓碑、支持 since', async () => {
    const peer = await twoDevices();
    const world = await seedWorld(peer.a.repository, '老世界');
    const messageId = await say(peer.a.repository, world.room.id, world.scene.id, '一句话');
    await peer.a.repository.deleteMessage(messageId as never);
    // 不参与同步的集合：账单与 meta
    await peer.a.repository.setMeta('session.lastRoomId', world.room.id);
    await peer.a.repository.setMeta('sync.state', { spaceHandle: null, pulledHead: 0, pushedAt: null });

    const all = await peer.a.repository.listSyncRecords();
    expect(all.every((record) => record.collection !== ('meta' as never))).toBe(true);
    expect(all.some((record) => record.collection === 'messages' && record.deletedAt !== null)).toBe(true);
    expect(all.some((record) => record.collection === 'rooms')).toBe(true);
    expect(all.some((record) => record.collection === 'personas')).toBe(true);

    const latest = all.at(-1)?.updatedAt ?? '';
    expect(await peer.a.repository.listSyncRecords({ since: latest })).toHaveLength(0);
  });
});
