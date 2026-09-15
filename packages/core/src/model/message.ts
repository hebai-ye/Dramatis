import type { EventId, InstanceId, MessageId, RoomId, SceneId } from './ids.js';

export type MessageRole = 'player' | 'character' | 'system' | 'narration';

export interface Message {
  id: MessageId;
  roomId: RoomId;
  sceneId: SceneId | null;
  /** 一次玩家输入到角色回应视为同一回合。 */
  turnId: string;
  role: MessageRole;
  speakerInstanceId: InstanceId | null;
  speakerName: string;
  content: string;
  createdAt: string;
}

/**
 * 情节记忆条目（设计文档 §4.3）。
 *
 * M0 仅定义结构，抽取与召回在 M2 实现。
 */
export interface MemoryEvent {
  id: EventId;
  roomId: RoomId;
  sceneId: SceneId;
  timeline: {
    worldTime: string;
    sequence: number;
  };
  location: string;
  participants: InstanceId[];
  /** 客观经过。 */
  summary: string;
  /** 该条目属于谁的视角；null 表示客观条目。 */
  observerId: InstanceId | null;
  /** 该视角下的观感、误解与情绪反应。 */
  perception: string;
  /** 0 ~ 1，影响召回优先级与衰减速度。 */
  importance: number;
  affects: InstanceId[];
  /** 溯源，可展开回原文。 */
  sourceTurnIds: string[];
  createdAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
}
