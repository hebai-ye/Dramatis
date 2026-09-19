import {
  type ConversationId,
  conversationId,
  type InstanceId,
  newId,
  nowIso,
  type RoomId,
  type SceneId,
} from './ids.js';
import type { Affect, CharacterInstance, Relationship } from './instance.js';

/**
 * 对话类型（LAYOUT「主区标题栏 · 右上控件」）。
 *
 * - `main`：角色扮演。角色以第一人称说话，动作用 `#` 另起一段
 * - `side`：世界管理。AI 是「世界管理员」，不扮演任何角色，真实调用工具
 *
 * 两者是**两条独立记录**，各有各的历史：主对话里发生的事不会因为
 * 管理员聊过几句就改变，管理员也不出现在角色扮演的上下文里。
 */
export type ConversationKind = 'main' | 'side';

/**
 * 会话级对话模式（LAYOUT「输入区 · 加号」）。
 *
 * 与场景级的入场策略是两件事：入场策略决定「谁有资格出现在这里」，
 * 对话模式决定「此刻的发言节奏」。
 */
export interface ConversationModes {
  /** 是否所有角色都必须等主角发言之后才能发言。 */
  playerFirst: boolean;
  /** 静默模式：主角长时间说话期间，其他角色只能做动作，不能开口。 */
  silent: boolean;
  /**
   * 意图先行（P1-6）：生成前先花一次便宜调用问「这一轮谁开口、他想做什么」。
   *
   * 缺省视为**开**——老数据里没有这个字段，但它正是增强体验的那一项；
   * 想省调用的用户可以在这里关掉（额外调用从 2 次降到 1 次）。
   */
  intentFirst?: boolean;
}

export function defaultConversationModes(): ConversationModes {
  return { playerFirst: false, silent: false, intentFirst: true };
}

/** 意图先行默认开：只有显式关掉才算关。 */
export function isIntentFirst(modes: ConversationModes | undefined): boolean {
  return modes?.intentFirst !== false;
}

/**
 * 对话开始那一刻的角色状态。
 *
 * 归档（LAYOUT「归档对话」）要的是「把情绪、关系、记忆回滚到这条线开始之前」，
 * 所以开始之前的状态必须留一份。只留情绪与关系：它们是会漂移的快变量，
 * 记忆则按对话 id 整批删除。
 */
export interface ConversationStateSnapshot {
  instanceId: InstanceId;
  affect: Affect;
  relationships: Relationship[];
}

export interface Conversation {
  id: ConversationId;
  roomId: RoomId;
  kind: ConversationKind;
  title: string;
  /** 每条对话有自己的场景线；世界（房间）上的卡与角色是共用的。 */
  activeSceneId: SceneId | null;
  modes: ConversationModes;
  /**
   * 非空表示这条对话已归档。
   *
   * 归档的含义是「这条时间线没有发生过」：情绪、关系、记忆都回滚到开始之前，
   * 但对话本身被保留，不在主列表里，改从设置中打开（只读回顾）。
   */
  archivedAt: string | null;
  /** 对话开始时的状态，归档时用它还原。 */
  stateSnapshot: ConversationStateSnapshot[];
  createdAt: string;
  updatedAt: string;
}

export function createConversation(input: {
  roomId: RoomId;
  title: string;
  kind?: ConversationKind;
  activeSceneId?: SceneId | null;
  instances?: readonly CharacterInstance[];
  id?: ConversationId;
}): Conversation {
  const now = nowIso();
  const title = input.title.trim();

  return {
    id: input.id ?? conversationId(newId()),
    roomId: input.roomId,
    kind: input.kind ?? 'main',
    title: title === '' ? '新对话' : title,
    activeSceneId: input.activeSceneId ?? null,
    modes: defaultConversationModes(),
    archivedAt: null,
    stateSnapshot: captureConversationState(input.instances ?? []),
    createdAt: now,
    updatedAt: now,
  };
}

export function isConversationArchived(conversation: Conversation): boolean {
  return conversation.archivedAt !== null;
}

/** 记下此刻的状态，供日后归档还原。深拷贝，避免与实例共享引用。 */
export function captureConversationState(instances: readonly CharacterInstance[]): ConversationStateSnapshot[] {
  return instances.map((instance) => ({
    instanceId: instance.id,
    affect: structuredClone(instance.affect),
    relationships: structuredClone(instance.relationships),
  }));
}

/**
 * 按快照还原角色的情绪与关系。
 *
 * 快照里没有的实例（对话开始后才加入世界的角色）不动：他们本来就不在
 * 「这条线开始之前」的状态里，硬套别人的旧状态只会更糟。
 */
export function restoreInstancesFromSnapshot(
  instances: readonly CharacterInstance[],
  snapshot: readonly ConversationStateSnapshot[],
  at: string,
): CharacterInstance[] {
  const byId = new Map(snapshot.map((item) => [item.instanceId, item]));

  return instances.map((instance) => {
    const saved = byId.get(instance.id);
    if (!saved) return instance;

    return {
      ...instance,
      affect: structuredClone(saved.affect),
      relationships: structuredClone(saved.relationships),
      updatedAt: at,
    };
  });
}
