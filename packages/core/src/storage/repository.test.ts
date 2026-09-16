import { describe, expect, it, vi } from 'vitest';
import type { Card } from '../model/card.js';
import { cardId, eventId, instanceId, messageId, newId, nowIso, roomId, sceneId, worldBookId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Room, Scene } from '../model/room.js';
import { createBackgroundRunner } from '../platform/background-runner.js';
import { createMemoryKeyStore } from '../platform/key-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createPlayerMessage } from '../session/turn.js';
import { COLLECTIONS, META_KEYS, type Migration, Repository, SCHEMA_VERSION } from './repository.js';

function fixtures() {
  const now = nowIso();
  const roomIdValue = roomId(newId());
  const sceneIdValue = sceneId(newId());
  const instanceIdValue = instanceId(newId());
  const cardIdValue = cardId(newId());
  const bookIdValue = worldBookId(newId());

  const room: Room = {
    id: roomIdValue,
    title: '雨夜酒馆',
    personaId: null,
    playerName: '旅人',
    playerPersona: '',
    cardIds: [cardIdValue],
    instanceIds: [instanceIdValue],
    worldBookIds: [bookIdValue],
    activeConversationId: null,
    createdAt: now,
    updatedAt: now,
  };

  const scene: Scene = {
    id: sceneIdValue,
    roomId: roomIdValue,
    conversationId: null,
    title: '开场',
    location: '旧城东侧',
    worldTime: '第三日 · 黄昏',
    castPolicy: 'locked',
    cast: [instanceIdValue],
    summary: '',
    createdAt: now,
    endedAt: null,
  };

  const instance: CharacterInstance = {
    id: instanceIdValue,
    roomId: roomIdValue,
    cardId: cardIdValue,
    displayName: 'Alice',
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
  };

  const card: Card = {
    id: cardIdValue,
    name: 'Alice',
    nickname: '',
    description: '酒馆老板',
    personality: '爽朗',
    scenario: '',
    firstMessage: '欢迎光临。',
    alternateGreetings: [],
    exampleMessages: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creator: '',
    creatorNotes: '',
    characterVersion: '',
    tags: [],
    embeddedWorldBook: null,
    extensions: {},
    source: { kind: 'json', spec: 'chara_card_v2', specVersion: '2.0', importedAt: now },
  };

  return {
    room,
    scene,
    instance,
    card,
    bookId: bookIdValue,
    book: { id: bookIdValue, name: '测试世界书', entries: [], extensions: {} },
  };
}

function message(room: Room, scene: Scene, content: string, turnId = newId()) {
  return createPlayerMessage({
    roomId: room.id,
    sceneId: scene.id,
    turnId,
    speakerName: room.playerName,
    content,
  });
}

describe('Repository / schema', () => {
  it('全新数据库迁移后写入 schema 版本', async () => {
    const repo = new Repository(createMemoryEntityStore(), []);

    expect(await repo.schemaVersion()).toBe(0);
    const report = await repo.migrate();

    expect(report).toEqual({ from: 0, to: SCHEMA_VERSION, applied: [] });
    expect(await repo.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  it('内建迁移把房间内联的玩家身份抽出为 persona 实体', async () => {
    const store = createMemoryEntityStore();
    await store.put(COLLECTIONS.rooms, {
      id: 'room-legacy',
      title: '旧房间',
      playerName: '旅人',
      playerPersona: '四处漂泊的旅人',
    });

    const repo = new Repository(store);
    const report = await repo.migrate();

    expect(report.applied.map((migration) => migration.version)).toEqual([2, 3]);

    const personas = await repo.listPersonas();
    expect(personas).toHaveLength(1);
    expect(personas[0]?.name).toBe('旅人');
    expect(personas[0]?.description).toBe('四处漂泊的旅人');

    const room = await repo.getRoom(roomId('room-legacy'));
    expect(room?.personaId).toBe(personas[0]?.id);
    // v3 顺手把旧房间拆成「世界 + 一条主线对话」
    expect(room?.activeConversationId).not.toBeNull();
    const conversations = await repo.listConversations(roomId('room-legacy'));
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe(room?.activeConversationId);
  });

  it('已是最新版本时重复迁移不做任何事', async () => {
    const repo = new Repository(createMemoryEntityStore());
    await repo.migrate();

    const again = await repo.migrate();
    expect(again).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] });
  });

  it('落后版本时执行对应迁移', async () => {
    const store = createMemoryEntityStore();
    const order: number[] = [];
    const migrations: Migration[] = [
      {
        version: 1,
        describe: 'first',
        run: async () => {
          order.push(1);
        },
      },
    ];

    const repo = new Repository(store, migrations);
    const report = await repo.migrate();

    expect(order).toEqual([1]);
    expect(report.applied.map((migration) => migration.version)).toEqual([1]);
    expect(await repo.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  it('迁移只执行一次', async () => {
    const store = createMemoryEntityStore();
    let runs = 0;
    const migrations: Migration[] = [
      {
        version: 1,
        describe: 'once',
        run: async () => {
          runs += 1;
        },
      },
    ];

    const repo = new Repository(store, migrations);
    await repo.migrate();
    await repo.migrate();

    expect(runs).toBe(1);
  });

  it('暴露后端实现标识', () => {
    expect(new Repository(createMemoryEntityStore()).backendKind).toBe('memory');
  });
});

describe('Repository / 房间', () => {
  it('房间可存取并出现在列表里', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene, instance, card, book } = fixtures();

    await repo.saveSnapshot({ room, scenes: [scene], instances: [instance], cards: [card], worldBooks: [book] });
    await repo.appendMessages(room.id, [message(room, scene, '你好')]);

    const loaded = await repo.getRoom(room.id);
    expect(loaded?.title).toBe('雨夜酒馆');

    const summaries = await repo.listRooms();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.messageCount).toBe(1);
    expect(summaries[0]?.instanceCount).toBe(1);
  });

  it('loadRoom 聚合出完整快照', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene, instance, card, book } = fixtures();

    await repo.saveSnapshot({ room, scenes: [scene], instances: [instance], cards: [card], worldBooks: [book] });
    await repo.appendMessages(room.id, [message(room, scene, '第一句')]);

    const snapshot = await repo.loadRoom(room.id);
    expect(snapshot?.cards).toHaveLength(1);
    expect(snapshot?.worldBooks).toHaveLength(1);
    expect(snapshot?.scenes).toHaveLength(1);
    expect(snapshot?.messages).toHaveLength(1);
  });

  it('删除房间会级联清理场景、实例与消息，但保留角色卡', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene, instance, card, book } = fixtures();

    await repo.saveSnapshot({ room, scenes: [scene], instances: [instance], cards: [card], worldBooks: [book] });
    await repo.appendMessages(room.id, [message(room, scene, '要被清理')]);

    await repo.deleteRoom(room.id);

    expect(await repo.getRoom(room.id)).toBeNull();
    expect(await repo.listScenes(room.id)).toHaveLength(0);
    expect(await repo.listInstances(room.id)).toHaveLength(0);
    expect(await repo.listMessages(room.id)).toHaveLength(0);
    // 角色卡是跨房间共用的资产，不能被连带删除
    expect(await repo.getCard(card.id)).not.toBeNull();
  });

  it('不存在的房间返回 null', async () => {
    const repo = new Repository(createMemoryEntityStore());
    expect(await repo.loadRoom(roomId('missing'))).toBeNull();
  });

  it('删除房间会连记忆与后台任务一起清理', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const queue = createBackgroundRunner(store);
    const { room, scene, instance, card, book } = fixtures();

    await repo.saveSnapshot({ room, scenes: [scene], instances: [instance], cards: [card], worldBooks: [book] });
    await repo.saveMemories([
      {
        id: eventId(newId()),
        roomId: room.id,
        conversationId: null,
        sceneId: scene.id,
        timeline: { worldTime: '第一日', sequence: 1 },
        location: '',
        participants: [instance.id],
        summary: '一件会被一起删掉的事',
        observerId: instance.id,
        perception: '',
        importance: 0.5,
        pinned: false,
        importanceLocked: false,
        affects: [],
        sourceTurnIds: ['turn-1'],
        createdAt: nowIso(),
        lastRecalledAt: null,
        recallCount: 0,
      },
    ]);
    await queue.enqueue({ kind: 'memory.extract', payload: {}, idempotencyKey: 'k', roomId: room.id });

    await repo.deleteRoom(room.id);

    expect(await repo.listMemories(room.id)).toHaveLength(0);
    expect(await queue.list()).toHaveLength(0);
  });
});

describe('Repository / 消息', () => {
  it('追加消息时分配递增的 seq', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();

    const first = await repo.appendMessages(room.id, [message(room, scene, 'A')]);
    const second = await repo.appendMessages(room.id, [message(room, scene, 'B')]);

    expect(first[0]?.seq).toBe(1);
    expect(second[0]?.seq).toBe(2);
  });

  it('同一毫秒落盘的消息仍有稳定顺序', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();

    const sameInstant = nowIso();
    const batch = ['一', '二', '三'].map((content) => ({
      ...message(room, scene, content),
      id: messageId(newId()),
      createdAt: sameInstant,
      seq: 0,
    }));

    await repo.appendMessages(room.id, batch);
    const listed = await repo.listMessages(room.id);

    expect(listed.map((item) => item.content)).toEqual(['一', '二', '三']);
    expect(listed.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('limit 返回最近的 N 条且保持正序', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();

    await repo.appendMessages(
      room.id,
      ['一', '二', '三', '四'].map((content) => message(room, scene, content)),
    );

    const recent = await repo.listMessages(room.id, { limit: 2 });
    expect(recent.map((item) => item.content)).toEqual(['三', '四']);
  });

  it('更新消息不会破坏 id / roomId / seq', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();
    const [saved] = await repo.appendMessages(room.id, [message(room, scene, '原文')]);
    if (!saved) throw new Error('未写入');

    const updated = await repo.updateMessage(saved.id, { content: '改过的' });

    expect(updated?.content).toBe('改过的');
    expect(updated?.id).toBe(saved.id);
    expect(updated?.roomId).toBe(saved.roomId);
    expect(updated?.seq).toBe(saved.seq);
  });

  it('按回合删除消息，用于重抽', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();
    const targetTurn = newId();

    await repo.appendMessages(room.id, [
      message(room, scene, '保留'),
      message(room, scene, '要撤销', targetTurn),
      message(room, scene, '也要撤销', targetTurn),
    ]);

    const removed = await repo.removeMessagesByTurn(room.id, targetTurn);

    expect(removed).toBe(2);
    expect((await repo.listMessages(room.id)).map((item) => item.content)).toEqual(['保留']);
  });

  it('更新不存在的消息返回 null', async () => {
    const repo = new Repository(createMemoryEntityStore());
    expect(await repo.updateMessage(messageId(newId()), { content: 'x' })).toBeNull();
  });
});

describe('Repository / 模型服务配置', () => {
  it('保存、列出与删除配置', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const now = nowIso();

    await repo.saveProviderProfile({
      id: 'p1',
      name: '主力',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      keyRef: 'provider:p1',
      temperature: 0.9,
      maxTokens: 16384,
      reserveForReply: 1024,
      role: 'main',
      createdAt: now,
      updatedAt: now,
    });

    expect(await repo.listProviderProfiles()).toHaveLength(1);

    await repo.deleteProviderProfile('p1');
    expect(await repo.listProviderProfiles()).toHaveLength(0);
  });

  it('密钥不落在实体里，只保存引用', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const keyStore = createMemoryKeyStore();

    await repo.saveProviderProfile({
      id: 'p1',
      name: '主力',
      baseUrl: 'https://example.com',
      model: 'm',
      keyRef: 'provider:p1',
      temperature: 1,
      maxTokens: 8000,
      reserveForReply: 1000,
      role: 'main',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await keyStore.set('provider:p1', 'sk-secret');

    const raw = await store.list<Record<string, unknown>>(COLLECTIONS.providerProfiles);
    expect(JSON.stringify(raw)).not.toContain('sk-secret');
    expect(await keyStore.get('provider:p1')).toBe('sk-secret');
  });
});

describe('Repository / meta', () => {
  it('meta 可读写任意值', async () => {
    const repo = new Repository(createMemoryEntityStore());

    await repo.setMeta('demo', { nested: [1, 2, 3] });
    expect(await repo.getMeta<{ nested: number[] }>('demo')).toEqual({ nested: [1, 2, 3] });
    expect(await repo.getMeta('nope')).toBeNull();
  });

  it('记录最近打开的房号，供会话恢复使用', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const spy = vi.fn();

    await repo.setMeta(META_KEYS.lastRoomId, 'room-1');
    spy(await repo.getMeta<string>(META_KEYS.lastRoomId));

    expect(spy).toHaveBeenCalledWith('room-1');
  });
});
