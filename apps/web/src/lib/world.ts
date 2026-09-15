import {
  PLAYER,
  instanceId,
  neutralTraits,
  newId,
  nowIso,
  roomId,
  sceneId,
  type Card,
  type CharacterInstance,
  type Room,
  type Scene,
} from '@dramatis/core';

export interface World {
  room: Room;
  scene: Scene;
  instance: CharacterInstance;
}

/**
 * 从一张角色卡建立最小可用的世界：一名角色、一个场景、一名玩家。
 *
 * M0 固定为单人对话，因此场景默认 `locked`——即使模型想拉人进来也不会发生。
 * 多角色阵容与入场策略的完整控制是 M1 的内容。
 */
export function createWorldFromCard(card: Card, playerName: string): World {
  const roomIdValue = roomId(newId());
  const instanceIdValue = instanceId(newId());
  const sceneIdValue = sceneId(newId());
  const now = nowIso();

  const displayName = card.nickname.trim() !== '' ? card.nickname.trim() : card.name;

  const instance: CharacterInstance = {
    id: instanceIdValue,
    roomId: roomIdValue,
    cardId: card.id,
    displayName,
    presence: 'onstage',
    traits: neutralTraits(),
    affect: {
      valence: 0,
      arousal: 0,
      updatedAt: now,
      history: [],
    },
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

  const scene: Scene = {
    id: sceneIdValue,
    roomId: roomIdValue,
    title: '开场',
    location: '',
    worldTime: '',
    castPolicy: 'locked',
    cast: [instanceIdValue],
    // M2 起由压缩流水线接管；M0 用来装载角色卡里的场景设定
    summary: card.scenario.trim(),
    createdAt: now,
    endedAt: null,
  };

  const room: Room = {
    id: roomIdValue,
    title: card.name,
    playerName: playerName.trim() === '' ? '玩家' : playerName.trim(),
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [instanceIdValue],
    worldBookIds: [],
    activeSceneId: sceneIdValue,
    createdAt: now,
    updatedAt: now,
  };

  return { room, scene, instance };
}
