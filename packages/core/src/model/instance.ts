import type { CardId, InstanceId, RelationshipTarget, RoomId } from './ids.js';

/**
 * 角色的存在模式（设计文档 §2.3）。
 *
 * `offscreen` 是叙事质量的关键：角色不参与对话，但记忆仍在积累。
 */
export type Presence = 'onstage' | 'muted' | 'offscreen' | 'absent';

/** 慢变量：从角色卡解析而来，基本恒定（设计文档 §5.1）。 */
export const TRAIT_AXES = [
  'extroversion',
  'aggression',
  'empathy',
  'playfulness',
  'caution',
] as const;

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
  at: string;
  turnId: string;
  deltaValence: number;
  deltaArousal: number;
  reason: string;
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
  at: string;
  turnId: string;
  field: 'trust' | 'affinity' | 'fear' | 'respect' | 'tension';
  delta: number;
  reason: string;
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
}
