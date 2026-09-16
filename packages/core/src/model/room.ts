import type { CardId, InstanceId, RoomId, SceneId, WorldBookId } from './ids.js';

/**
 * 场景的入场策略（设计文档 §2.3）。
 *
 * `locked` 即用户要求的「此时场景无法进入新角色」。
 */
export type CastPolicy = 'open' | 'locked' | 'invite_only' | 'triggered';

export interface Scene {
  id: SceneId;
  roomId: RoomId;
  title: string;
  location: string;
  /** 世界内时间，自由文本，例如「第三日 · 黄昏」。 */
  worldTime: string;
  castPolicy: CastPolicy;
  /** 在场名单，含 muted 者；不含 offscreen 与 absent。 */
  cast: InstanceId[];
  /** 场景摘要，M2 由压缩流水线维护。 */
  summary: string;
  createdAt: string;
  endedAt: string | null;
}

/** 世界 / 房间 —— 一条持续的世界线（设计文档 §2.2）。 */
export interface Room {
  id: RoomId;
  title: string;
  /** 玩家身份的标识；为空时退回下面的冗余字段。 */
  personaId: string | null;
  /**
   * 玩家 persona 的冗余副本。
   *
   * 从 persona 同步而来，让 prompt 装配不必再查一次库。冗余的代价是
   * 要记得更新，所以只在「切换 persona」与「编辑 persona」两个入口写它。
   */
  playerName: string;
  playerPersona: string;
  cardIds: CardId[];
  instanceIds: InstanceId[];
  worldBookIds: WorldBookId[];
  activeSceneId: SceneId | null;
  createdAt: string;
  updatedAt: string;
}
