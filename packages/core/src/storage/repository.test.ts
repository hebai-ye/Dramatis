import { describe, expect, it, vi } from 'vitest';
import type { Card } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
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
    deletedAt: null,
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
    updatedAt: now,
    endedAt: null,
    deletedAt: null,
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
    deletedAt: null,
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
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  return {
    room,
    scene,
    instance,
    card,
    bookId: bookIdValue,
    book: {
      id: bookIdValue,
      name: '测试世界书',
      entries: [],
      extensions: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
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

    /*
     * 这个列表跟着 SCHEMA_VERSION 长：写成「2 到当前版本」的推导，
     * 免得每加一条迁移都要回来改一次数字（改数字的时候最容易顺手漏掉别的断言）。
     */
    expect(report.applied.map((migration) => migration.version)).toEqual(
      Array.from({ length: SCHEMA_VERSION - 1 }, (_, index) => index + 2),
    );

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

  it('v9 给旧状态历史补 id、before/after 与来源记忆字段', async () => {
    const store = createMemoryEntityStore();
    const { instance } = fixtures();
    const legacy = {
      ...instance,
      affect: {
        ...instance.affect,
        valence: 0.2,
        arousal: 0.1,
        history: [
          { at: instance.updatedAt, turnId: 'turn-old', deltaValence: 0.2, deltaArousal: 0.1, reason: '旧记录' },
        ],
      },
      relationships: [
        {
          ...instance.relationships[0],
          trust: 0.3,
          history: [{ at: instance.updatedAt, turnId: 'turn-old', field: 'trust', delta: 0.3, reason: '旧记录' }],
        },
      ],
    };
    await store.put(COLLECTIONS.instances, legacy as never);

    const repo = new Repository(store);
    await repo.migrate();
    const [migrated] = await repo.listInstances(instance.roomId);

    expect(migrated?.affect.history[0]?.id).toContain('legacy:');
    expect(migrated?.affect.history[0]?.beforeValence).toBeCloseTo(0, 6);
    expect(migrated?.affect.history[0]?.afterValence).toBeCloseTo(0.2, 6);
    expect(migrated?.affect.history[0]?.sourceMemoryIds).toEqual([]);
    expect(migrated?.relationships[0]?.history[0]?.before).toBeCloseTo(0, 6);
    expect(migrated?.relationships[0]?.history[0]?.after).toBeCloseTo(0.3, 6);
    expect(migrated?.relationships[0]?.history[0]?.reversionOf).toBeNull();
  });

  it('v10 把旧世界身份复制到每条对话', async () => {
    const store = createMemoryEntityStore();
    const { room } = fixtures();
    const conversation = createConversation({ roomId: room.id, title: '旧对话' });
    await store.put(COLLECTIONS.meta, {
      id: META_KEYS.schemaVersion,
      value: 9,
      updatedAt: nowIso(),
    });
    await store.put(COLLECTIONS.rooms, {
      ...room,
      personaId: 'persona-old',
      playerName: '沈砚',
      playerPersona: '旧信的主人',
    });
    await store.put(COLLECTIONS.conversations, {
      ...conversation,
      personaId: undefined,
      playerName: undefined,
      playerPersona: undefined,
    } as never);

    const repo = new Repository(store);
    const report = await repo.migrate();
    const [migrated] = await repo.listConversations(room.id);

    expect(report.applied.map((migration) => migration.version)).toEqual([10]);
    expect(migrated?.personaId).toBe('persona-old');
    expect(migrated?.playerName).toBe('沈砚');
    expect(migrated?.playerPersona).toBe('旧信的主人');
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
        updatedAt: nowIso(),
        lastRecalledAt: null,
        recallCount: 0,
        deletedAt: null,
      },
    ]);
    await queue.enqueue({ kind: 'memory.extract', payload: {}, idempotencyKey: 'k', roomId: room.id });

    await repo.deleteRoom(room.id);

    expect(await repo.listMemories(room.id)).toHaveLength(0);
    expect(await queue.list()).toHaveLength(0);
  });
});

describe('Repository / 消息', () => {
  it('追加消息时分配递增的 seq，并盖上 updatedAt（P2-6）', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();

    // 故意带一个过期时间：写入路径必须自己盖章，不能信调用方
    const first = await repo.appendMessages(room.id, [
      { ...message(room, scene, 'A'), updatedAt: '2000-01-01T00:00:00.000Z' },
    ]);
    const second = await repo.appendMessages(room.id, [message(room, scene, 'B')]);

    expect(first[0]?.localSeq).toBe(1);
    expect(second[0]?.localSeq).toBe(2);
    expect(Date.parse(first[0]?.updatedAt ?? '')).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
    expect(Date.parse(second[0]?.updatedAt ?? '')).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
  });

  it('同一毫秒落盘的消息仍有稳定顺序', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();

    const sameInstant = nowIso();
    const batch = ['一', '二', '三'].map((content) => ({
      ...message(room, scene, content),
      id: messageId(newId()),
      createdAt: sameInstant,
      localSeq: 0,
      deviceId: '',
    }));

    await repo.appendMessages(room.id, batch);
    const listed = await repo.listMessages(room.id);

    expect(listed.map((item) => item.content)).toEqual(['一', '二', '三']);
    expect(listed.map((item) => item.localSeq)).toEqual([1, 2, 3]);
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
    expect(updated?.localSeq).toBe(saved.localSeq);
    expect(Date.parse(updated?.updatedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(saved.updatedAt));
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

describe('Repository / updatedAt（P2-6 数据层前置）', () => {
  const OLD = '2000-01-01T00:00:00.000Z';
  const isFresh = (value: string | undefined): boolean =>
    Date.parse(value ?? '') > Date.parse('2020-01-01T00:00:00.000Z');

  it('saveScene 覆盖调用方给的时间：写入路径自己盖章', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { scene } = fixtures();

    await repo.saveScene({ ...scene, updatedAt: OLD });

    expect(isFresh((await repo.getScene(scene.id))?.updatedAt)).toBe(true);
  });

  it('同一毫秒里写两次，updatedAt 仍然严格递增（LWW 与记录密文的 AAD 都靠它）', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { scene } = fixtures();

    await repo.saveScene(scene);
    const first = (await repo.getScene(scene.id))?.updatedAt ?? '';
    await repo.saveScene(scene);
    const second = (await repo.getScene(scene.id))?.updatedAt ?? '';

    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));

    // 时间被外部调慢（或库里存着一个未来时间）时也不许倒退：倒退会让 LWW 判错，
    // 也会让同一 id 的两版密文撞上同一个 AAD
    await repo.saveScene({ ...scene, updatedAt: '1999-01-01T00:00:00.000Z' });
    const third = (await repo.getScene(scene.id))?.updatedAt ?? '';
    expect(Date.parse(third)).toBeGreaterThan(Date.parse(second));
  });

  it('全库单调：不同记录之间也不会撞时间（推送水位线靠它）', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene, instance, card, book } = fixtures();

    // 一口气写五条不同的记录：本机逻辑时钟保证五条各不相同、且依次递增
    await repo.saveRoom(room);
    await repo.saveScene(scene);
    await repo.saveInstance(instance);
    await repo.saveCard(card);
    await repo.saveWorldBook(book);

    const stamps = [
      (await repo.getRoom(room.id))?.updatedAt ?? '',
      (await repo.getScene(scene.id))?.updatedAt ?? '',
      (await repo.listInstances(room.id))[0]?.updatedAt ?? '',
      (await repo.getCard(card.id))?.updatedAt ?? '',
      (await repo.getWorldBook(book.id))?.updatedAt ?? '',
    ];

    for (let index = 1; index < stamps.length; index += 1) {
      expect(Date.parse(stamps[index] ?? '')).toBeGreaterThan(Date.parse(stamps[index - 1] ?? ''));
    }
  });

  it('推送水位线之前的时间不会发给新记录（否则那条永远推不出去）', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();
    // 假装刚同步过，水位线被一台「时钟偏快」的设备抬到了未来
    const future = new Date(Date.now() + 60_000).toISOString();
    await repo.writeSyncState({ spaceHandle: 'space-1', pulledHead: 3, pushedAt: future });

    const [saved] = await repo.appendMessages(room.id, [message(room, scene, '同步之后写的')]);
    expect(Date.parse(saved?.updatedAt ?? '')).toBeGreaterThan(Date.parse(future));

    // 增量推送按水位线筛，这条必须在里面
    const outbound = await repo.listSyncRecords({ since: future });
    expect(outbound.map((record) => record.id)).toEqual([saved?.id]);
  });

  it('saveMemories / updateMemory 也会更新 updatedAt', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene, instance } = fixtures();
    const event = {
      id: eventId(newId()),
      roomId: room.id,
      conversationId: null,
      sceneId: scene.id,
      timeline: { worldTime: '第一日', sequence: 1 },
      location: '',
      participants: [instance.id],
      summary: '一件发生过的事',
      observerId: null,
      perception: '',
      importance: 0.5,
      pinned: false,
      importanceLocked: false,
      affects: [],
      sourceTurnIds: ['turn-1'],
      createdAt: nowIso(),
      updatedAt: OLD,
      lastRecalledAt: null,
      recallCount: 0,
      deletedAt: null,
    };

    await repo.saveMemories([event]);
    const [saved] = await repo.listMemories(room.id);
    expect(isFresh(saved?.updatedAt)).toBe(true);

    const updated = await repo.updateMemory(event.id, { pinned: true, updatedAt: OLD });
    expect(isFresh(updated?.updatedAt)).toBe(true);
    expect(updated?.pinned).toBe(true);
  });

  it('saveChapterSummary 盖章', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();

    await repo.saveChapterSummary({
      id: newId(),
      roomId: room.id,
      conversationId: null,
      title: '第 1 章',
      sceneIds: [scene.id],
      summary: '前情',
      keyFacts: [],
      createdAt: OLD,
      updatedAt: OLD,
      deletedAt: null,
    });

    const [chapter] = await repo.listChapterSummaries(room.id);
    expect(isFresh(chapter?.updatedAt)).toBe(true);
  });

  it('迁移把老数据的 updatedAt 回填成 createdAt，而不是「现在」', async () => {
    const store = createMemoryEntityStore();
    const createdAt = '2026-01-02T03:04:05.000Z';
    await store.put(COLLECTIONS.scenes, {
      id: 'scene-legacy',
      roomId: 'room-legacy',
      conversationId: null,
      title: '老场景',
      location: '',
      worldTime: '',
      castPolicy: 'locked',
      cast: [],
      summary: '',
      createdAt,
      endedAt: null,
      deletedAt: null,
    });

    const repo = new Repository(store);
    await repo.migrate();

    const migrated = await store.get<Record<string, unknown>>(COLLECTIONS.scenes, 'scene-legacy');
    expect(migrated?.updatedAt).toBe(createdAt);
  });
});

describe('Repository / 软删除（P2-6）', () => {
  it('删消息是盖章：查询看不到，记录还在（同步要拿它当墓碑推出去）', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const { room, scene } = fixtures();
    const [saved] = await repo.appendMessages(room.id, [message(room, scene, '要删掉的')]);
    if (!saved) throw new Error('未写入');

    await repo.deleteMessage(saved.id);

    expect(await repo.listMessages(room.id)).toHaveLength(0);
    const raw = await store.get<{ content: string; deletedAt: string | null; updatedAt: string }>(
      COLLECTIONS.messages,
      saved.id,
    );
    // 原文还在：这就是「用户删了，但同步还得告诉另一台设备这条被删了」的前提
    expect(raw?.content).toBe('要删掉的');
    expect(raw?.deletedAt).not.toBeNull();
    // 墓碑的时间不能倒退，否则 LWW 会判成「没改过」
    expect(Date.parse(raw?.updatedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(saved.updatedAt));

    const withDeleted = await repo.listMessages(room.id, { includeDeleted: true });
    expect(withDeleted.map((item) => item.id)).toEqual([saved.id]);
  });

  it('过滤发生在分页之前：删掉最近一条，历史不该凭空少一截', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();
    const saved = await repo.appendMessages(
      room.id,
      ['一', '二', '三', '四'].map((content) => message(room, scene, content)),
    );
    const last = saved[3];
    if (!last) throw new Error('未写入');

    await repo.deleteMessage(last.id);

    expect((await repo.listMessages(room.id, { limit: 3 })).map((item) => item.content)).toEqual(['一', '二', '三']);
  });

  it('删角色卡与世界书同样留墓碑，只是不再出现在列表里', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const { card, book } = fixtures();

    await repo.saveCard(card);
    await repo.saveWorldBook(book);
    await repo.deleteCard(card.id);
    await repo.deleteWorldBook(book.id);

    expect(await repo.listCards()).toHaveLength(0);
    expect(await repo.listWorldBooks()).toHaveLength(0);
    expect(await repo.getCard(card.id)).toBeNull();
    // 素材是跨世界共用的：删掉一张卡不能把引用它的世界也带走
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.cards, card.id))?.deletedAt).not.toBeNull();
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.worldBooks, book.id))?.deletedAt).not.toBeNull();
  });

  it('删世界：子记录一起盖章，队列与账单硬删（它们不参与同步）', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const queue = createBackgroundRunner(store);
    const { room, scene, instance, card, book } = fixtures();

    await repo.saveSnapshot({ room, scenes: [scene], instances: [instance], cards: [card], worldBooks: [book] });
    await repo.appendMessages(room.id, [message(room, scene, '一个回合')]);
    await queue.enqueue({ kind: 'memory.extract', payload: {}, idempotencyKey: 'k', roomId: room.id });

    await repo.deleteRoom(room.id);

    expect(await repo.getRoom(room.id)).toBeNull();
    expect(await repo.listScenes(room.id)).toHaveLength(0);
    expect(await repo.listInstances(room.id)).toHaveLength(0);
    expect(await repo.listMessages(room.id)).toHaveLength(0);
    expect(await queue.list()).toHaveLength(0);
    // 墓碑仍然在库里——世界没了，但它「没了」这件事要能被同步解释
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.rooms, room.id))?.deletedAt).not.toBeNull();
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.scenes, scene.id))?.deletedAt).not.toBeNull();
  });

  it('删除是幂等的：重复删除不会把墓碑时间一路推到当下', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const { room, scene } = fixtures();
    const [saved] = await repo.appendMessages(room.id, [message(room, scene, '删两次')]);
    if (!saved) throw new Error('未写入');

    await repo.deleteMessage(saved.id);
    const first = await store.get<{ deletedAt: string | null }>(COLLECTIONS.messages, saved.id);
    await repo.deleteMessage(saved.id);
    const second = await store.get<{ deletedAt: string | null }>(COLLECTIONS.messages, saved.id);

    expect(second?.deletedAt).toBe(first?.deletedAt);
  });

  it('给同一条对话滚回来的记忆也走软删除', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene, instance } = fixtures();
    const turnId = newId();
    await repo.saveMemories([
      {
        id: eventId(newId()),
        roomId: room.id,
        conversationId: null,
        sceneId: scene.id,
        timeline: { worldTime: '第一日', sequence: 1 },
        location: '',
        participants: [instance.id],
        summary: '会被重抽撤销的事',
        observerId: null,
        perception: '',
        importance: 0.5,
        pinned: false,
        importanceLocked: false,
        affects: [],
        sourceTurnIds: [turnId],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
        lastRecalledAt: null,
        recallCount: 0,
      },
    ]);

    expect(await repo.deleteMemoriesByTurn(room.id, turnId)).toBe(1);
    // 第二次调用没有可撤的了：墓碑不该被反复计数
    expect(await repo.deleteMemoriesByTurn(room.id, turnId)).toBe(0);
    expect(await repo.listMemories(room.id)).toHaveLength(0);
  });

  it('迁移 v5 给老记录补 deletedAt = null', async () => {
    const store = createMemoryEntityStore();
    await store.put(COLLECTIONS.rooms, {
      id: 'room-legacy',
      title: '旧世界',
      personaId: null,
      playerName: '玩家',
      playerPersona: '',
      cardIds: [],
      instanceIds: [],
      worldBookIds: [],
      activeConversationId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const repo = new Repository(store);
    await repo.migrate();

    const migrated = await store.get<{ deletedAt: string | null }>(COLLECTIONS.rooms, 'room-legacy');
    expect(migrated?.deletedAt).toBeNull();
    expect(await repo.getRoom(roomId('room-legacy'))).not.toBeNull();
  });
});

describe('Repository / 本机设备与 localSeq（P2-6）', () => {
  it('deviceId 存在 meta 里，同一个库怎么读都是同一个', async () => {
    const store = createMemoryEntityStore();
    const first = new Repository(store);
    const created = await first.deviceId();

    expect(created).not.toBe('');
    expect(await first.deviceId()).toBe(created);
    // 换一个 Repository 实例读同一个库：设备号必须一样，否则同一条消息
    // 会被算成两台设备的（同步时排序会散架）
    const second = new Repository(store);
    expect(await second.deviceId()).toBe(created);
    expect(await second.getMeta<string>(META_KEYS.deviceId)).toBe(created);
  });

  it('追加消息时盖上设备号与 localSeq', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();
    const deviceId = await repo.deviceId();

    const [saved] = await repo.appendMessages(room.id, [message(room, scene, '一')]);

    expect(saved?.deviceId).toBe(deviceId);
    expect(saved?.localSeq).toBe(1);
    // 改消息不该把设备号与号段改掉
    const updated = await repo.updateMessage(saved?.id ?? messageId('missing'), { content: '改过' });
    expect(updated?.deviceId).toBe(deviceId);
    expect(updated?.localSeq).toBe(1);
  });

  it('库里只有老计数器键时，新号接着它排（不会从 1 重来）', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const { room, scene } = fixtures();
    await repo.setMeta(`seq:${room.id}`, 7);

    const [saved] = await repo.appendMessages(room.id, [message(room, scene, '接着排')]);

    expect(saved?.localSeq).toBe(8);
  });

  it('老消息只有 seq：读出来归一成 localSeq，排序不变', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const { room, scene } = fixtures();
    const at = '2026-01-01T00:00:00.000Z';
    for (const [content, seq] of [
      ['一', 1],
      ['二', 2],
      ['三', 3],
    ] as const) {
      await store.put(COLLECTIONS.messages, {
        id: newId(),
        roomId: room.id,
        conversationId: null,
        sceneId: scene.id,
        turnId: 'turn-legacy',
        seq,
        role: 'player',
        speakerInstanceId: null,
        speakerName: '旅人',
        audience: [],
        content,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      });
    }

    const listed = await repo.listMessages(room.id);

    expect(listed.map((item) => item.content)).toEqual(['一', '二', '三']);
    expect(listed.map((item) => item.localSeq)).toEqual([1, 2, 3]);
    // 老记录没有设备号：读的时候按本机补上，不让调用方拿到 undefined
    expect(listed[0]?.deviceId).toBe(await repo.deviceId());
  });

  it('迁移 v6：seq 改名 localSeq、补设备号、搬计数器', async () => {
    const store = createMemoryEntityStore();
    const roomIdValue = roomId(newId());
    const at = '2026-01-02T00:00:00.000Z';
    await store.put(COLLECTIONS.rooms, {
      id: roomIdValue,
      title: '旧世界',
      personaId: null,
      playerName: '旅人',
      playerPersona: '',
      cardIds: [],
      instanceIds: [],
      worldBookIds: [],
      activeConversationId: null,
      createdAt: at,
      updatedAt: at,
    });
    await store.put(COLLECTIONS.messages, {
      id: 'message-legacy',
      roomId: roomIdValue,
      conversationId: null,
      sceneId: null,
      turnId: 'turn-legacy',
      seq: 3,
      role: 'player',
      speakerInstanceId: null,
      speakerName: '旅人',
      audience: [],
      content: '旧消息',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    });
    await store.put(COLLECTIONS.meta, { id: `seq:${roomIdValue}`, value: 3, updatedAt: at });

    const repo = new Repository(store);
    const report = await repo.migrate();
    expect(report.to).toBe(SCHEMA_VERSION);

    const raw = await store.get<Record<string, unknown>>(COLLECTIONS.messages, 'message-legacy');
    expect(raw?.localSeq).toBe(3);
    expect(raw?.seq).toBeUndefined();
    expect(typeof raw?.deviceId === 'string' && raw.deviceId !== '').toBe(true);

    expect(await repo.getMeta(`seq:${roomIdValue}`)).toBeNull();
    expect(await repo.getMeta(`localSeq:${roomIdValue}`)).toBe(3);

    // 迁移之后接着写：拿到 4，而不是从 1 重来（重来就会和老消息撞号）
    const [next] = await repo.appendMessages(roomIdValue, [
      createPlayerMessage({
        roomId: roomIdValue,
        sceneId: null,
        turnId: 'turn-new',
        speakerName: '旅人',
        content: '新消息',
      }),
    ]);
    expect(next?.localSeq).toBe(4);
    expect(next?.deviceId).toBe((raw?.deviceId as string) ?? '');
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
