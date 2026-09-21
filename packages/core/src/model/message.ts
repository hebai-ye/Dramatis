import type { ConversationId, EventId, InstanceId, MessageId, RoomId, SceneId } from './ids.js';

/**
 * 一次模型调用的真实用量（服务商在流末尾返回）。
 *
 * 两个字段都可能缺失：有的服务商不返回 usage，有的只给总数。缺的时候按 0 记，
 * 而不是编一个估算值混进去——估算值不能用来算钱（P3-7）。
 */
export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * 消息的说话人类型。
 *
 * `admin` 是副对话里的「世界管理员」——它不扮演任何角色，产出的是
 * 角色卡与世界书这类素材，所以既不是 character 也不是 narration。
 */
export type MessageRole = 'player' | 'character' | 'system' | 'narration' | 'admin';

/**
 * 管理员产出的素材草稿（LAYOUT「管理员产出的角色卡、世界卡由用户决定去留」）。
 *
 * 草稿挂在消息上：副对话刷新后仍要能看见「当时起草了什么」，而用户还没
 * 决定的东西不能直接进素材库——否则素材库会堆满没人要的废稿。
 */
export interface AdminArtifact {
  id: string;
  kind: 'character-card' | 'world-book' | 'scene';
  title: string;
  summary: string;
  status: 'pending' | 'adopted' | 'discarded' | 'applied';
  /** 待采纳的实体内容（序列化后的角色卡 / 世界书）。 */
  payload: unknown;
  /** 采纳后落库得到的 id；场景类草稿在执行时就写入，直接记目标场景。 */
  targetId: string | null;
  createdAt: string;
}

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
   * 本机分配的房间内序号（P2-6，原字段名 `seq`）。
   *
   * 不依赖 createdAt 排序：同一毫秒内落盘的多条消息必须仍有稳定顺序，
   * 这也是跨设备合并的基础。**两台设备各排各的号**，所以排序要看
   * `(deviceId, localSeq)`：单看号码，两台设备的第一条消息都是 1。
   * 未落盘的消息此值为 0。
   */
  localSeq: number;
  /**
   * 这条消息是在哪台设备上产生的（P2-6）。
   *
   * 未落盘时是空串，由仓储层的 `appendMessages` 填上本机设备号——
   * 与 `localSeq` 一样，只有写库的人才知道该填什么。
   */
  deviceId: string;
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
  /**
   * 这一轮角色声明的意图（P1-6 的零额外调用版）。
   *
   * 模型在回复开头写一行「意图：…」，解析后单独存这里、正文里不留——
   * 留在正文里就会进历史，被下一轮学成正文的一部分。
   */
  intent?: string;
  /**
   * 意图是从哪来的。
   *
   * `planned`：生成前的导演调用给出的打算（P1-6，最可信的一种）。
   * `declared`：模型照格式写了「意图：…」那一行（取决于它是否听话）。
   * `reasoning`：它没有声明，但有推理流，取第一句当盘算——这是模型真实在想的事，
   * 只是不是我们要求的格式。三者在界面上用不同措辞区分，不混为一谈。
   */
  intentSource?: 'planned' | 'declared' | 'reasoning';
  /** 副对话里管理员这次产出的草稿；主对话的消息不带这个字段。 */
  artifacts?: AdminArtifact[];
  /**
   * 生成这条消息的实际用量。
   *
   * 存到消息上而不是只放在内存里：刷新之后仍然能看到「这一轮花了多少」，
   * 这是 P3-7 按回合统计的最小形态，也是 P1-9 设熔断阈值的依据。
   */
  usage?: MessageUsage;
  createdAt: string;
  /** 最后一次写入的时间（P2-6）：编辑、改归属、采纳草稿都会把它推到当下。 */
  updatedAt: string;
  /** 软删除墓碑（P2-6）：重抽、删除单条消息都是盖章，原文还在库里。 */
  deletedAt: string | null;
}

/**
 * 取消息的房间内序号，兼容 P2-6 之前只有 `seq` 的老数据。
 *
 * 老库里的记录要等迁移 v6 改名，但读路径（摘要游标、封存排序）不能
 * 因此拿到 undefined ——统一走这里，比到处写 `?? 0` 安全。
 */
export function localSeqOf(message: { localSeq?: number; seq?: number }): number {
  return message.localSeq ?? message.seq ?? 0;
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
  /** 最后一次写入的时间（P2-6）：用户改重要度、置顶、被召回都会更新它。 */
  updatedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
  /** 软删除墓碑（P2-6）：撤销与删除都是盖章，同步时要把它推给别的设备。 */
  deletedAt: string | null;
  /**
   * 这条记忆被哪条「印象」取代了（顺序 27a 的记忆合并）。
   *
   * **原文永远不删**：合并只是给它盖一个章，说明「这段经过已经并进那条印象里了」。
   * 面板仍然搜得到它、同步仍然带得走它，而任何一条印象都能顺着 `supersedes`
   * 找回它的来源——这是这条链路可回滚的唯一依据。
   */
  supersededBy?: EventId | null;
  /** 反过来：这条印象是由哪些原文合并来的（印象自己持有）。 */
  supersedes?: EventId[];
  /** 合并发生的时间；有它就说明「这条已经进过印象，别再参与合并了」。 */
  consolidatedAt?: string | null;
}
