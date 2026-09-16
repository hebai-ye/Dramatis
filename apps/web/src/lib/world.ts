import {
  type Card,
  type CharacterInstance,
  type InstanceId,
  instanceId,
  neutralTraits,
  newId,
  nowIso,
  type Persona,
  PLAYER,
  type Room,
  type RoomId,
  roomId,
  type Scene,
  sceneId,
} from '@dramatis/core';

export interface World {
  room: Room;
  scene: Scene;
  instance: CharacterInstance;
}

/** 依据角色卡创建一个角色实例（P0-3）。 */
export function createInstanceFor(card: Card, roomIdValue: RoomId, displayName?: string): CharacterInstance {
  const now = nowIso();
  const name = displayName?.trim();

  return {
    id: instanceId(newId()),
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

/** 创建一个新场景（P0-6）。 */
export function createSceneFor(
  roomIdValue: RoomId,
  cast: InstanceId[],
  options?: { title?: string; summary?: string },
): Scene {
  return {
    id: sceneId(newId()),
    roomId: roomIdValue,
    title: options?.title ?? '新场景',
    location: '',
    worldTime: '',
    castPolicy: 'locked',
    cast,
    // M2 起由压缩流水线接管；现在用来装载角色卡里的场景设定
    summary: options?.summary ?? '',
    createdAt: nowIso(),
    endedAt: null,
  };
}

/**
 * 从一张角色卡开一条新的世界线：一名角色、一个场景、一名玩家。
 *
 * 场景默认 `locked`：单人开场时锁场是正确默认值，用户随时能在场景面板改。
 */
export function createWorldFromCard(card: Card, persona: Persona): World {
  const roomIdValue = roomId(newId());
  const instance = createInstanceFor(card, roomIdValue);
  const scene = createSceneFor(roomIdValue, [instance.id], {
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
    activeSceneId: scene.id,
    createdAt: now,
    updatedAt: now,
  };

  return { room, scene, instance };
}
