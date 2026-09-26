/**
 * 2026-09-26 审计里仓储层的几条修复（A5 / B4 / B11 / B14 / C1 / C2）。
 */
import { describe, expect, it } from 'vitest';
import { createConversation } from '../model/conversation.js';
import { conversationId, eventId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import type { Room } from '../model/room.js';
import type { EntityStore } from '../platform/entity-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createPlayerMessage } from '../session/turn.js';
import { COLLECTIONS, META_KEYS, MIGRATIONS, Repository } from './repository.js';

function makeRoom(): Room {
  const now = nowIso();
  return {
    id: roomId(newId()),
    title: '雨夜酒馆',
    personaId: null,
    playerName: '旅人',
    playerPersona: '',
    cardIds: [],
    instanceIds: [],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function memory(room: Room, overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  const now = nowIso();
  return {
    id: eventId(newId()),
    roomId: room.id,
    conversationId: null,
    sceneId: null,
    timeline: { worldTime: '第一日', sequence: 1 },
    location: '',
    participants: [],
    summary: '一件小事',
    observerId: null,
    perception: '',
    importance: 0.3,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    supersededBy: null,
    supersedes: [],
    consolidatedAt: null,
    lastRecalledAt: null,
    recallCount: 0,
    ...overrides,
  };
}

function playerMessage(room: Room, content: string, conversation: string | null = null) {
  return {
    ...createPlayerMessage({
      roomId: room.id,
      sceneId: sceneId(newId()),
      turnId: newId(),
      speakerName: '旅人',
      content,
    }),
    conversationId: conversation === null ? null : conversationId(conversation),
  };
}

describe('审计 A5：归档走逻辑时钟', () => {
  it('水位线超前时，归档记录的 updatedAt 仍大于水位线，能被增量推送带走', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const room = makeRoom();
    const conversation = createConversation({ roomId: room.id, title: '线', instances: [] });
    await repo.saveSnapshot({
      room: { ...room, activeConversationId: conversation.id },
      conversations: [conversation],
    });

    const future = new Date(Date.now() + 120_000).toISOString();
    await repo.writeSyncState({ spaceHandle: 's', pulledHead: 1, pushedAt: future });

    await repo.archiveConversation(conversation.id);
    const outbound = await repo.listSyncRecords({ since: future });
    const archived = outbound.find((record) => record.id === conversation.id);
    expect(archived).toBeDefined();
    expect((archived?.value as { archivedAt?: string | null } | undefined)?.archivedAt).not.toBeNull();
    expect((archived?.updatedAt ?? '') > future).toBe(true);
  });
});

describe('审计 B4：删除印象撤销合并', () => {
  async function consolidated() {
    const repo = new Repository(createMemoryEntityStore());
    const room = makeRoom();
    await repo.saveRoom(room);
    const impressionId = eventId(newId());
    const at = nowIso();
    const sources = ['t1', 't2', 't3'].map((turn) =>
      memory(room, { sourceTurnIds: [turn], supersededBy: impressionId, consolidatedAt: at }),
    );
    const impression = memory(room, {
      id: impressionId,
      sourceTurnIds: ['t1', 't2', 't3'],
      supersedes: sources.map((item) => item.id),
      consolidatedAt: at,
    });
    await repo.saveMemories([...sources, impression]);
    return { repo, room, sources, impression };
  }

  it('重抽其中一个回合：印象被删，其余原文恢复成未合并', async () => {
    const { repo, room, sources, impression } = await consolidated();
    await repo.deleteMemoriesByTurn(room.id, 't2');

    const alive = await repo.listMemories(room.id);
    const ids = alive.map((item) => item.id);
    expect(ids).not.toContain(impression.id);
    expect(ids).not.toContain(sources[1]?.id);
    for (const source of [sources[0], sources[2]]) {
      const found = alive.find((item) => item.id === source?.id);
      expect(found?.supersededBy).toBeNull();
      expect(found?.consolidatedAt).toBeNull();
    }
  });

  it('用户直接删印象：全部原文恢复', async () => {
    const { repo, room, impression } = await consolidated();
    await repo.deleteMemory(impression.id);
    const alive = await repo.listMemories(room.id);
    expect(alive).toHaveLength(3);
    expect(alive.every((item) => item.supersededBy === null && item.consolidatedAt === null)).toBe(true);
  });

  it('原文已经被另一条印象接手的，不去动它', async () => {
    const { repo, room, sources, impression } = await consolidated();
    const other = eventId(newId());
    const first = sources[0];
    if (first === undefined) throw new Error('fixture');
    await repo.updateMemory(first.id, { supersededBy: other });
    await repo.deleteMemory(impression.id);
    const alive = await repo.listMemories(room.id);
    expect(alive.find((item) => item.id === first.id)?.supersededBy).toBe(other);
  });
});

describe('审计 B14：localSeq 原子发号 / 时钟跨标签页', () => {
  it('两个仓储实例（两个标签页）同时追加，号码不重复', async () => {
    const store = createMemoryEntityStore();
    const tabA = new Repository(store);
    const tabB = new Repository(store);
    const room = makeRoom();
    await tabA.saveRoom(room);

    const results = await Promise.all([
      tabA.appendMessages(room.id, [playerMessage(room, 'a1'), playerMessage(room, 'a2')]),
      tabB.appendMessages(room.id, [playerMessage(room, 'b1')]),
      tabA.appendMessages(room.id, [playerMessage(room, 'a3')]),
    ]);
    const seqs = results.flat().map((item) => item.localSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs)).toBe(4);
  });

  it('计数器丢了按库里最大号续上', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const room = makeRoom();
    await repo.saveRoom(room);
    await repo.appendMessages(room.id, [playerMessage(room, '1'), playerMessage(room, '2')]);
    await store.remove(COLLECTIONS.meta, `localSeq:${room.id}`);
    const [next] = await repo.appendMessages(room.id, [playerMessage(room, '3')]);
    expect(next?.localSeq).toBe(3);
  });

  it('别的标签页推进了水位线，本标签页的缓存不会盖出不大于它的时间戳', async () => {
    const store = createMemoryEntityStore();
    const tabA = new Repository(store);
    const tabB = new Repository(store);
    const room = makeRoom();
    // A 先写一次，把水位线（空）与时钟缓存住
    await tabA.saveRoom(room);

    const future = new Date(Date.now() + 300_000).toISOString();
    await tabB.writeSyncState({ spaceHandle: 's', pulledHead: 1, pushedAt: future });

    await tabA.saveRoom({ ...room, title: '改名' });
    const saved = await store.get<{ updatedAt: string }>(COLLECTIONS.rooms, room.id);
    expect((saved?.updatedAt ?? '') > future).toBe(true);
  });

  it('后端没有原子 update 时照样工作', async () => {
    const { update: _dropped, ...rest } = createMemoryEntityStore();
    const store: EntityStore = { ...rest, kind: 'legacy' };
    const repo = new Repository(store);
    const room = makeRoom();
    await repo.saveRoom(room);
    const stamped = await repo.appendMessages(room.id, [playerMessage(room, 'x'), playerMessage(room, 'y')]);
    expect(stamped.map((item) => item.localSeq)).toEqual([1, 2]);
  });
});

describe('审计 C1：v3 迁移幂等', () => {
  it('重跑不会再造一条空主线', async () => {
    const store = createMemoryEntityStore();
    const legacyRoom = { id: 'r1', title: '老世界', activeSceneId: null, createdAt: nowIso(), updatedAt: nowIso() };
    await store.put(COLLECTIONS.rooms, legacyRoom);
    await store.put(COLLECTIONS.messages, { id: 'm1', roomId: 'r1', content: '老消息' });
    const v3 = MIGRATIONS.find((migration) => migration.version === 3);
    if (v3 === undefined) throw new Error('缺 v3');

    await v3.run(store);
    await v3.run(store);

    const conversations = await store.list<{ id: string }>(COLLECTIONS.conversations);
    expect(conversations).toHaveLength(1);
    const room = await store.get<{ activeConversationId: string }>(COLLECTIONS.rooms, 'r1');
    const message = await store.get<{ conversationId: string }>(COLLECTIONS.messages, 'm1');
    expect(room?.activeConversationId).toBe(conversations[0]?.id);
    expect(message?.conversationId).toBe(conversations[0]?.id);
  });

  it('断在「主线已建、归属没改完」之间：重跑接着用那条主线', async () => {
    const store = createMemoryEntityStore();
    const legacyRoom = { id: 'r1', title: '老世界', activeSceneId: null, createdAt: nowIso(), updatedAt: nowIso() };
    await store.put(COLLECTIONS.rooms, legacyRoom);
    await store.put(COLLECTIONS.messages, { id: 'm1', roomId: 'r1', content: '老消息' });
    const v3 = MIGRATIONS.find((migration) => migration.version === 3);
    if (v3 === undefined) throw new Error('缺 v3');

    // 第一次跑：把消息改挂到主线的那一步弄坏，等价于这时断电（conversation 已建、归属没写完、
    // room.activeConversationId 还是空的——老判据正好漏掉的就是这个窗口）
    const originalPut = store.put.bind(store);
    let armed = true;
    store.put = async (collection: string, record: { id: string }): Promise<void> => {
      if (armed && collection === COLLECTIONS.messages) {
        armed = false;
        throw new Error('断电');
      }
      await originalPut(collection, record);
    };
    await expect(v3.run(store)).rejects.toThrow('断电');
    store.put = originalPut;

    await v3.run(store);

    const conversations = await store.list<{ id: string }>(COLLECTIONS.conversations);
    expect(conversations).toHaveLength(1);
    const room = await store.get<{ activeConversationId: string }>(COLLECTIONS.rooms, 'r1');
    const message = await store.get<{ conversationId: string }>(COLLECTIONS.messages, 'm1');
    expect(room?.activeConversationId).toBe(conversations[0]?.id);
    expect(message?.conversationId).toBe(conversations[0]?.id);
  });
});

describe('审计 C2：读单条老消息时补本机设备号', () => {
  it('新实例缓存为空时 updateMessage 不会写入空设备号', async () => {
    const store = createMemoryEntityStore();
    const first = new Repository(store);
    const room = makeRoom();
    await first.saveRoom(room);
    const [saved] = await first.appendMessages(room.id, [playerMessage(room, '老')]);
    if (saved === undefined) throw new Error('fixture');
    // 模拟 P2-6 之前写下的老消息：没有设备号
    const raw = await store.get<Record<string, unknown>>(COLLECTIONS.messages, saved.id);
    const { deviceId: _device, ...legacy } = raw ?? {};
    await store.put(COLLECTIONS.messages, { ...legacy, id: saved.id });

    const fresh = new Repository(store);
    const updated = await fresh.updateMessage(saved.id, { content: '新' });
    const device = await store.get<{ value: string }>(COLLECTIONS.meta, META_KEYS.deviceId);
    expect(updated?.deviceId).toBe(device?.value);
    expect(updated?.deviceId).not.toBe('');
  });
});

describe('审计 B11：loadRoom 可以只读当前对话', () => {
  it('传 conversationId 时只返回这条对话的消息、记忆与章节，其余集合不变', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const room = makeRoom();
    await repo.saveRoom(room);
    await repo.appendMessages(room.id, [playerMessage(room, '甲', 'c1'), playerMessage(room, '乙', 'c2')]);
    await repo.saveMemories([
      memory(room, { conversationId: conversationId('c1') }),
      memory(room, { conversationId: conversationId('c2') }),
    ]);

    const full = await repo.loadRoom(room.id);
    const scoped = await repo.loadRoom(room.id, { conversationId: conversationId('c1') });
    expect(full?.messages).toHaveLength(2);
    expect(scoped?.messages.map((item) => item.content)).toEqual(['甲']);
    expect(scoped?.memories).toHaveLength(1);
    expect(scoped?.conversations).toEqual(full?.conversations);
  });
});
