import type { CardId, EventId, InstanceId, RelationshipTarget, RoomId } from './ids.js';

/**
 * 角色的存在模式（设计文档 §2.3）。
 *
 * `offscreen` 是叙事质量的关键：角色不参与对话，但记忆仍在积累。
 */
export type Presence = 'onstage' | 'muted' | 'offscreen' | 'absent';

/** 慢变量：从角色卡解析而来，基本恒定（设计文档 §5.1）。 */
export const TRAIT_AXES = ['extroversion', 'aggression', 'empathy', 'playfulness', 'caution'] as const;

export type TraitAxis = (typeof TRAIT_AXES)[number];

/** 每根轴取值 -1 ~ 1。 */
export type TraitScores = Record<TraitAxis, number>;

export function neutralTraits(): TraitScores {
  return {
    extroversion: 0,
    aggression: 0,
    empathy: 0,
    playfulness: 0,
    caution: 0,
  };
}

/** 快变量：情绪状态，每轮更新并衰减。 */
export interface Affect {
  /** 情绪正负，-1 ~ 1。 */
  valence: number;
  /** 激动程度，0 ~ 1。 */
  arousal: number;
  updatedAt: string;
  /** 变化必须留下理由，便于回溯与调试（设计文档 §5.1）。 */
  history: AffectChange[];
}

export interface AffectChange {
  /** 这条变化自己的 id；撤销是按它定位，不靠数组下标。 */
  id: string;
  at: string;
  turnId: string;
  /** 这次影响前后的实际值（夹紧、褪色之后仍能精确回放）。 */
  beforeValence: number;
  afterValence: number;
  beforeArousal: number;
  afterArousal: number;
  deltaValence: number;
  deltaArousal: number;
  reason: string;
  /** 触发这次变化的记忆条目（顺序 27d）。 */
  sourceMemoryIds: EventId[];
  /** 这是一条撤销记录时，指向被撤销的原影响 id；原影响本身不改。 */
  reversionOf: string | null;
}

/** 关系边：本角色 → 某个目标。数值 -1 ~ 1。 */
export interface Relationship {
  target: RelationshipTarget;
  trust: number;
  affinity: number;
  fear: number;
  respect: number;
  /** 尚未化解的紧张感，0 ~ 1。 */
  tension: number;
  updatedAt: string;
  history: RelationshipChange[];
}

export interface RelationshipChange {
  id: string;
  at: string;
  turnId: string;
  field: 'trust' | 'affinity' | 'fear' | 'respect' | 'tension';
  before: number;
  after: number;
  delta: number;
  reason: string;
  sourceMemoryIds: EventId[];
  reversionOf: string | null;
}

/** 角色实例 —— 某个世界线中的具体存在（设计文档 §2.1）。 */
export interface CharacterInstance {
  id: InstanceId;
  roomId: RoomId;
  cardId: CardId;
  displayName: string;
  presence: Presence;
  traits: TraitScores;
  affect: Affect;
  relationships: Relationship[];
  /** 性格被手动校正过，抗漂移时不覆盖。 */
  traitsLocked: boolean;
  createdAt: string;
  updatedAt: string;
  /** 软删除墓碑（P2-6）：把角色移出世界是盖章，历史消息里的引用仍然指得到。 */
  deletedAt: string | null;
}
