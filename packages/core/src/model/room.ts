import type { CardId, ConversationId, InstanceId, RoomId, SceneId, WorldBookId } from './ids.js';

/**
 * 场景的入场策略（设计文档 §2.3）。
 *
 * `locked` 即用户要求的「此时场景无法进入新角色」。
 */
export type CastPolicy = 'open' | 'locked' | 'invite_only' | 'triggered';

export interface Scene {
  id: SceneId;
  roomId: RoomId;
  /**
   * 场景属于哪条对话。
   *
   * 一个世界可以开多条对话（LAYOUT「世界 → 多个对话」），每条对话有自己的
   * 场景线：换了对话就该换场景，否则两条线的「此刻在哪里」会互相污染。
   */
  conversationId: ConversationId | null;
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

/**
 * 世界（仓储层里仍叫 room）。
 *
 * LAYOUT 把层级定为「世界 = 项目，一个世界下可以开多个对话」，所以
 * 世界本身不再直接挂着一条对话线，而是持有若干条 `Conversation`。
 * 角色、角色卡、世界书、玩家身份是**世界级**的，跨对话共用；
 * 场景、消息、对话模式是**对话级**的。
 */
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
  /** 当前打开的对话；为空表示这个世界还没有任何对话。 */
  activeConversationId: ConversationId | null;
  createdAt: string;
  updatedAt: string;
}
