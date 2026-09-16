import type { Card } from '../model/card.js';
import { type Conversation, type ConversationKind, createConversation } from '../model/conversation.js';
import {
  instanceId as asInstanceId,
  roomId as asRoomId,
  sceneId as asSceneId,
  type CardId,
  type InstanceId,
  newId,
  nowIso,
  PLAYER,
} from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Persona } from '../model/persona.js';
import type { Room, Scene } from '../model/room.js';

/** 依据角色卡创建一个角色实例（P0-3）。 */
export function createInstanceFor(card: Card, roomIdValue: Room['id'], displayName?: string): CharacterInstance {
  const now = nowIso();
  const name = displayName?.trim();

  return {
    id: asInstanceId(newId()),
    roomId: roomIdValue,
    cardId: card.id,
    displayName: name !== undefined && name !== '' ? name : card.nickname.trim() || card.name,
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [
      {
        target: PLAYER,
        trust: 0,
        affinity: 0,
        fear: 0,
        respect: 0,
        tension: 0,
        updatedAt: now,
        history: [],
      },
    ],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建一个新场景（P0-6）。场景一定属于某条对话。 */
export function createSceneFor(
  roomIdValue: Room['id'],
  conversationIdValue: Scene['conversationId'],
  cast: InstanceId[],
  options?: { title?: string; summary?: string; location?: string; worldTime?: string },
): Scene {
  return {
    id: asSceneId(newId()),
    roomId: roomIdValue,
    conversationId: conversationIdValue,
    title: options?.title ?? '新场景',
    location: options?.location ?? '',
    worldTime: options?.worldTime ?? '',
    castPolicy: 'locked',
    cast,
    // M2 起由压缩流水线接管；现在用来装载角色卡里的场景设定
    summary: options?.summary ?? '',
    createdAt: nowIso(),
    endedAt: null,
  };
}

export interface World {
  room: Room;
  conversation: Conversation;
  scene: Scene;
  instance: CharacterInstance;
}

/**
 * 从一张角色卡开一条新的世界线：一名角色、一个场景、一名玩家。
 *
 * 场景默认 `locked`：单人开场时锁场是正确默认值，用户随时能在场景面板改。
 */
export function createWorldFromCard(card: Card, persona: Persona): World {
  const roomIdValue = asRoomId(newId());
  const instance = createInstanceFor(card, roomIdValue);
  const conversation = createConversation({
    roomId: roomIdValue,
    title: '主线',
    instances: [instance],
  });
  const scene = createSceneFor(roomIdValue, conversation.id, [instance.id], {
    title: '开场',
    summary: card.scenario.trim(),
  });
  const now = nowIso();

  const room: Room = {
    id: roomIdValue,
    title: card.name,
    personaId: persona.id,
    playerName: persona.name,
    playerPersona: persona.description,
    cardIds: [card.id],
    instanceIds: [instance.id],
    worldBookIds: [],
    activeConversationId: conversation.id,
    createdAt: now,
    updatedAt: now,
  };

  return { room, conversation: { ...conversation, activeSceneId: scene.id }, scene, instance };
}

export interface NewConversationPlan {
  room: Room;
  conversation: Conversation;
  scene: Scene;
  /** 这条对话新派生出来的角色实例（世界里已有实例的卡不会重复派生）。 */
  createdInstances: CharacterInstance[];
}

/**
 * 规划一条新对话（LAYOUT「左栏 · 新对话」）。
 *
 * 开启新对话时投入**世界卡与零或以上角色卡**：世界书挂在世界上，
 * 这里只决定「这一条线由谁开始」。世界里的角色实例是共用的，
 * 所以已经实例化过的卡不会重复派生——否则同一个角色会在世界里出现两份，
 * 记忆与关系也就跟着分叉了。
 */
export function planNewConversation(input: {
  room: Room;
  existingInstances: readonly CharacterInstance[];
  title: string;
  /** 本对话开始时投入的角色卡；为空表示先开一条空线。 */
  cards?: readonly Card[];
  cast?: readonly CharacterInstance[];
  kind?: ConversationKind;
  sceneTitle?: string;
  sceneSummary?: string;
  location?: string;
  worldTime?: string;
}): NewConversationPlan {
  const createdInstances: CharacterInstance[] = [];
  const existingByCard = new Map<CardId, CharacterInstance>();
  for (const instance of input.existingInstances) {
    if (!existingByCard.has(instance.cardId)) existingByCard.set(instance.cardId, instance);
  }

  for (const card of input.cards ?? []) {
    if (existingByCard.has(card.id)) continue;
    const created = createInstanceFor(card, input.room.id);
    createdInstances.push(created);
    existingByCard.set(card.id, created);
  }

  const picked: CharacterInstance[] = [];
  if (input.cast !== undefined) {
    picked.push(...input.cast);
  } else {
    for (const card of input.cards ?? []) {
      const instance = existingByCard.get(card.id);
      if (instance) picked.push(instance);
    }
  }

  const now = nowIso();
  const conversation = createConversation({
    roomId: input.room.id,
    title: input.title,
    kind: input.kind,
    // 快照记的是「这条线开始之前」的状态，所以不含这条线新派生的实例
    instances: input.existingInstances,
  });

  const scene = createSceneFor(
    input.room.id,
    conversation.id,
    picked.map((instance) => instance.id),
    {
      title: input.sceneTitle ?? '开场',
      summary: input.sceneSummary ?? '',
      location: input.location ?? '',
      worldTime: input.worldTime ?? '',
    },
  );

  const room: Room = {
    ...input.room,
    cardIds: [
      ...input.room.cardIds,
      ...(input.cards ?? []).map((card) => card.id).filter((id) => !input.room.cardIds.includes(id)),
    ],
    instanceIds: [...input.room.instanceIds, ...createdInstances.map((instance) => instance.id)],
    activeConversationId: conversation.id,
    updatedAt: now,
  };

  return {
    room,
    conversation: { ...conversation, activeSceneId: scene.id },
    scene,
    createdInstances,
  };
}
