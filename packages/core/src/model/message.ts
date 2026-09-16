import type { ConversationId, EventId, InstanceId, MessageId, RoomId, SceneId } from './ids.js';

/**
 * 消息的说话人类型。
 *
 * `admin` 是副对话里的「世界管理员」——它不扮演任何角色，产出的是
 * 角色卡与世界书这类素材，所以既不是 character 也不是 narration。
 */
export type MessageRole = 'player' | 'character' | 'system' | 'narration' | 'admin';

export interface Message {
  id: MessageId;
  roomId: RoomId;
  /**
   * 这条消息属于哪条对话。
   *
   * 主对话与副对话是两条独立记录，各有各的历史；界面只渲染当前对话的消息，
   * 记忆抽取也只处理主对话（管理员的产出不是剧情，不该变成角色的记忆）。
   */
  conversationId: ConversationId | null;
  sceneId: SceneId | null;
  /** 一次玩家输入到角色回应视为同一回合。 */
  turnId: string;
  /**
   * 房间内单调递增的序号，由仓储层在落盘时分配。
   *
   * 不依赖 createdAt 排序：同一毫秒内落盘的多条消息必须仍有稳定顺序，
   * 这也是 P2-6 跨设备合并的基础。未落盘的消息此值为 0。
   */
  seq: number;
  role: MessageRole;
  speakerInstanceId: InstanceId | null;
  speakerName: string;
  /**
   * 这条消息发生时在场的角色实例。
   *
   * 空数组表示「所有人都能看到」，用于旁白与系统消息。有了它，
   * 每个角色看到的上下文才是各自视角的（P0-5）；记忆抽取也才知道
   * 该给谁写记忆（P1-2）——离开场景期间发生的事，角色本就不该记得。
   */
  audience: InstanceId[];
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
  /**
   * 这条记忆由哪条对话产生。
   *
   * 归档一条对话时按它整批删除——「把记忆回滚到该对话开始之前」，
   * 靠时间戳判断既不可靠也不可逆。
   */
  conversationId: ConversationId | null;
  /** 抽取时所在的场景；没有活跃场景时为空。 */
  sceneId: SceneId | null;
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
  /** 用户手动置顶。置顶的记忆不参与衰减，召回时始终优先。 */
  pinned: boolean;
  /** 用户手动改过重要度，衰减与重锚都不覆盖它。 */
  importanceLocked: boolean;
  affects: InstanceId[];
  /** 溯源，可展开回原文。 */
  sourceTurnIds: string[];
  createdAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
}
