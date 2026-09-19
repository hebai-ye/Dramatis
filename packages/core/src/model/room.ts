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
  /**
   * 场景设定（人写的简介）。
   *
   * 来自角色卡的 scenario，用户可以在场景面板里改。**不是**自动摘要——
   * 自动的滚动场记在下面的 `recap` 里，两者用途不同所以分开存：
   * 这是「这一场是什么」，recap 是「这一场到目前为止发生了什么」。
   */
  summary: string;
  /**
   * 滚动场记（P1-5 的场景层）：这一场到目前为止发生了什么。
   *
   * 由后台按阈值生成，原文仍然留在库里；它只是让「已经过去的部分」
   * 有个便宜的载体，避免长线对话把上下文撑爆。
   */
  recap?: string;
  /**
   * 场记覆盖到哪一条消息（房间内递增的 `seq`）。
   *
   * 滚动摘要的游标：只把**这之后**的消息压进去，所以重跑、补写都不会把
   * 同一段话统计两遍。缺失或为 0 表示这一场还没摘过。
   */
  recapUpToSeq?: number;
  /** 上次生成摘要的时间；界面据此显示「什么时候整理的」。 */
  recapUpdatedAt?: string;
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
