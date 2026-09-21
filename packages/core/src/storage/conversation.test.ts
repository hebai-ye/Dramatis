import { describe, expect, it } from 'vitest';
import { buildMemoryEvents } from '../memory/ingest.js';
import type { Card } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
import { cardId, eventId, instanceId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Room } from '../model/room.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createInstanceFor, createSceneFor, planNewConversation } from '../session/setup.js';
import { createPlayerMessage } from '../session/turn.js';
import { COLLECTIONS, Repository } from './repository.js';

function makeCard(name: string): Card {
  return {
    id: cardId(newId()),
    name,
    nickname: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
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
    source: { kind: 'manual', spec: 'dramatis', specVersion: '1', importedAt: nowIso() },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
}

/** 一个世界、一张卡、一个实例，还有一条已经聊过的对话。 */
async function worldFixture() {
  const repository = new Repository(createMemoryEntityStore());
  const now = nowIso();
  const roomIdValue = roomId(newId());
  const card = makeCard('Alice');
  const alice = createInstanceFor(card, roomIdValue);

  const room: Room = {
    id: roomIdValue,
    title: '雨夜酒馆',
    personaId: null,
    playerName: '旅人',
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [alice.id],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const conversation = createConversation({
    roomId: roomIdValue,
    title: '第一条线',
    instances: [alice],
  });
  const scene = createSceneFor(roomIdValue, conversation.id, [alice.id], { title: '开场' });
  const withScene = { ...conversation, activeSceneId: scene.id };
  const nextRoom = { ...room, activeConversationId: conversation.id };

  await repository.saveSnapshot({
    room: nextRoom,
    conversations: [withScene],
    scenes: [scene],
    instances: [alice],
    cards: [card],
  });

  return { repository, room: nextRoom, conversation: withScene, scene, alice, card, now };
}

describe('世界 → 多对话', () => {
  it('对话级身份快照独立于世界默认身份', () => {
    const conversation = createConversation({
      roomId: roomId('room-identity'),
      title: '沈砚线',
      persona: { personaId: 'persona-shen', name: '沈砚', description: '旧信的主人' },
    });

    expect(conversation.personaId).toBe('persona-shen');
    expect(conversation.playerName).toBe('沈砚');
    expect(conversation.playerPersona).toBe('旧信的主人');
  });

  it('新对话继承世界的默认身份，之后可以独立切换', () => {
    const plan = planNewConversation({
      room: {
        id: roomId('room-persona-default'),
        title: '默认身份世界',
        personaId: 'persona-player',
        playerName: '旅人',
        playerPersona: '四处漂泊',
        cardIds: [],
        instanceIds: [],
        worldBookIds: [],
        activeConversationId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
      },
      existingInstances: [],
      title: '新线',
    });

    expect(plan.conversation.personaId).toBe('persona-player');
    expect(plan.conversation.playerName).toBe('旅人');
    expect(plan.conversation.playerPersona).toBe('四处漂泊');
  });

  it('新对话不会给同一位角色派生第二份实例', async () => {
    const { repository, room, alice, card } = await worldFixture();

    const plan = planNewConversation({
      room,
      existingInstances: [alice],
      title: '第二条线',
      cards: [card],
    });

    expect(plan.createdInstances).toHaveLength(0);
    expect(plan.scene.cast).toEqual([alice.id]);
    expect(plan.conversation.id).not.toBe(room.activeConversationId);

    await repository.saveSnapshot({
      room: plan.room,
      conversations: [plan.conversation],
      scenes: [plan.scene],
    });

    expect(await repository.listConversations(room.id)).toHaveLength(2);
    expect(await repository.listInstances(room.id)).toHaveLength(1);
  });

  it('新投入的卡会派生实例，并挂到世界里', async () => {
    const { repository, room, alice, card } = await worldFixture();
    const bobCard = makeCard('Bob');

    const plan = planNewConversation({
      room,
      existingInstances: [alice],
      title: '带上 Bob',
      cards: [card, bobCard],
    });

    expect(plan.createdInstances).toHaveLength(1);
    expect(plan.room.instanceIds).toHaveLength(2);
    expect(plan.room.cardIds).toContain(bobCard.id);
    expect(plan.scene.cast).toHaveLength(2);

    await repository.saveSnapshot({
      room: plan.room,
      conversations: [plan.conversation],
      scenes: [plan.scene],
      instances: plan.createdInstances,
    });
    expect(await repository.listInstances(room.id)).toHaveLength(2);
  });

  it('消息与记忆按对话归位，列表只取当前对话', async () => {
    const { repository, room, conversation, scene, alice, now } = await worldFixture();
    const second = createConversation({ roomId: room.id, title: '第二条线' });
    const secondScene = createSceneFor(room.id, second.id, [alice.id]);
    await repository.saveSnapshot({
      conversations: [{ ...second, activeSceneId: secondScene.id }],
      scenes: [secondScene],
    });

    await repository.appendMessages(room.id, [
      createPlayerMessage({
        roomId: room.id,
        conversationId: conversation.id,
        sceneId: scene.id,
        turnId: newId(),
        speakerName: '旅人',
        content: '第一条线说的话',
      }),
      createPlayerMessage({
        roomId: room.id,
        conversationId: second.id,
        sceneId: secondScene.id,
        turnId: newId(),
        speakerName: '旅人',
        content: '第二条线说的话',
      }),
    ]);

    const scoped = await repository.listMessages(room.id, { conversationId: conversation.id });
    expect(scoped.map((message) => message.content)).toEqual(['第一条线说的话']);
    expect(await repository.listMessages(room.id)).toHaveLength(2);

    const { events } = buildMemoryEvents({
      roomId: room.id,
      conversationId: second.id,
      sceneId: secondScene.id,
      worldTime: '',
      sequence: 1,
      participants: [alice],
      extraction: { summary: '第二条件里发生的事', importance: 0.5, location: '', observations: [] },
      turnId: 'turn-second',
      createdAt: now,
    });
    await repository.saveMemories(events);

    expect(await repository.listMemories(room.id, { conversationId: second.id })).toHaveLength(events.length);
    expect(await repository.listMemories(room.id, { conversationId: conversation.id })).toHaveLength(0);
  });
});

describe('归档对话', () => {
  it('把情绪、关系与记忆回滚到这条线开始之前，但保留对话本身', async () => {
    const { repository, room, conversation, scene, alice, now } = await worldFixture();

    // 这条线开始之后，Alice 的情绪与关系都变了
    const drifted: CharacterInstance = {
      ...alice,
      affect: {
        valence: 0.8,
        arousal: 0.7,
        updatedAt: now,
        history: [
          {
            id: 'change-1',
            at: now,
            turnId: 'turn-1',
            beforeValence: 0,
            afterValence: 0.8,
            beforeArousal: 0,
            afterArousal: 0.7,
            deltaValence: 0.8,
            deltaArousal: 0.7,
            reason: '被夸了',
            sourceMemoryIds: [],
            reversionOf: null,
          },
        ],
      },
      relationships: [
        {
          target: 'player',
          trust: 0.6,
          affinity: 0.5,
          fear: 0,
          respect: 0.2,
          tension: 0.1,
          updatedAt: now,
          history: [
            {
              id: 'relationship-change-1',
              at: now,
              turnId: 'turn-1',
              field: 'trust',
              before: 0,
              after: 0.6,
              delta: 0.6,
              reason: '被夸了',
              sourceMemoryIds: [],
              reversionOf: null,
            },
          ],
        },
      ],
    };
    await repository.saveInstance(drifted);

    // 而且留下了一条记忆
    const { events } = buildMemoryEvents({
      roomId: room.id,
      conversationId: conversation.id,
      sceneId: scene.id,
      worldTime: '',
      sequence: 1,
      participants: [drifted],
      extraction: { summary: '这条线里发生过的事', importance: 0.7, location: '', observations: [] },
      turnId: 'turn-1',
      createdAt: now,
    });
    await repository.saveMemories(events);

    const report = await repository.archiveConversation(conversation.id);

    expect(report?.removedMemories).toBe(events.length);
    expect(report?.restoredInstances).toBe(1);
    expect(await repository.listMemories(room.id)).toHaveLength(0);

    const restored = (await repository.listInstances(room.id))[0];
    expect(restored?.affect.valence).toBe(0);
    expect(restored?.affect.history).toHaveLength(0);
    expect(restored?.relationships[0]?.trust).toBe(0);

    // 对话本身保留，但从主列表里消失
    expect(await repository.getConversation(conversation.id)).not.toBeNull();
    expect(await repository.listConversations(room.id)).toHaveLength(0);
    expect(await repository.listConversations(room.id, { includeArchived: true })).toHaveLength(1);

    // 消息与场景不动：归档回滚的是状态，不是记录
    expect(await repository.listScenes(room.id)).toHaveLength(1);
  });

  it('重复归档不会把状态再擦一遍', async () => {
    const { repository, conversation, room } = await worldFixture();

    const first = await repository.archiveConversation(conversation.id);
    expect(first?.removedMemories).toBe(0);

    const second = await repository.archiveConversation(conversation.id);
    expect(second?.restoredInstances).toBe(0);
    expect(second?.removedMemories).toBe(0);
    expect(second?.nextConversationId).toBeNull();
    expect(await repository.listConversations(room.id, { includeArchived: true })).toHaveLength(1);
  });

  it('归档当前对话后，世界切到另一条还没归档的线', async () => {
    const { repository, room, conversation, alice } = await worldFixture();
    const second = planNewConversation({
      room,
      existingInstances: [alice],
      title: '第二条线',
      cast: [alice],
    });
    await repository.saveSnapshot({
      room: second.room,
      conversations: [second.conversation],
      scenes: [second.scene],
    });

    const report = await repository.archiveConversation(second.conversation.id);
    expect(report?.nextConversationId).toBe(conversation.id);
    expect((await repository.getRoom(room.id))?.activeConversationId).toBe(conversation.id);
  });

  it('删除对话会带走它的场景、消息与记忆，但留下角色', async () => {
    const { repository, room, conversation, scene, alice } = await worldFixture();
    await repository.appendMessages(room.id, [
      createPlayerMessage({
        roomId: room.id,
        conversationId: conversation.id,
        sceneId: scene.id,
        turnId: newId(),
        speakerName: '旅人',
        content: '要被删掉的话',
      }),
    ]);

    await repository.deleteConversation(conversation.id);

    expect(await repository.getConversation(conversation.id)).toBeNull();
    expect(await repository.listMessages(room.id)).toHaveLength(0);
    expect(await repository.listScenes(room.id)).toHaveLength(0);
    expect(await repository.listInstances(room.id)).toHaveLength(1);
    expect((await repository.getRoom(room.id))?.activeConversationId).toBeNull();
    expect(alice.id).toBeDefined();
  });

  it('v3 迁移给旧数据补出主线对话，并把场景、消息、记忆认领过去', async () => {
    const store = createMemoryEntityStore();
    const now = nowIso();
    const roomIdValue = roomId(newId());
    const sceneIdValue = sceneId(newId());
    const instanceIdValue = instanceId(newId());

    await store.put(COLLECTIONS.rooms, {
      id: roomIdValue,
      title: '旧世界',
      playerName: '旅人',
      playerPersona: '',
      activeSceneId: sceneIdValue,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await store.put(COLLECTIONS.scenes, {
      id: sceneIdValue,
      roomId: roomIdValue,
      title: '开场',
      cast: [instanceIdValue],
      createdAt: now,
    });
    await store.put(COLLECTIONS.messages, {
      id: newId(),
      roomId: roomIdValue,
      sceneId: sceneIdValue,
      content: '旧消息',
      seq: 1,
      createdAt: now,
    });
    await store.put(COLLECTIONS.memories, {
      id: eventId(newId()),
      roomId: roomIdValue,
      sceneId: sceneIdValue,
      summary: '旧记忆',
      createdAt: now,
    });

    const repository = new Repository(store);
    await repository.migrate();

    const conversations = await repository.listConversations(roomIdValue);
    expect(conversations).toHaveLength(1);
    const conversation = conversations[0];
    if (!conversation) throw new Error('迁移没有补出对话');

    expect(conversation.activeSceneId).toBe(sceneIdValue);
    expect((await repository.getRoom(roomIdValue))?.activeConversationId).toBe(conversation.id);
    expect((await repository.listScenes(roomIdValue))[0]?.conversationId).toBe(conversation.id);
    expect((await repository.listMessages(roomIdValue))[0]?.conversationId).toBe(conversation.id);
    expect((await repository.listMemories(roomIdValue))[0]?.conversationId).toBe(conversation.id);
  });
});
