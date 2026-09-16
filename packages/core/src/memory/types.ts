import type { MemoryEvent } from '../model/message.js';

/** 抽取结果里的一条视角条目，`speaker` 是角色名，落库时才解析成实例 ID。 */
export interface RawObservation {
  speaker: string;
  perception: string;
}

/**
 * 一次抽取的产物（ROADMAP P1-1）。
 *
 * 一次调用同时得到客观经过与每个角色的主观印象，而不是每个角色各调一次。
 * 这是把额外调用压在每回合一次以内的关键。
 */
export interface ExtractedMemory {
  summary: string;
  importance: number;
  /** 对话里出现地点变化时才有值。 */
  location: string;
  observations: RawObservation[];
}

export interface RecallQuery {
  /** 正在回忆的人。 */
  observerId: string;
  /** 用于关键词匹配的文本，通常是玩家输入加上最近几轮对话。 */
  text: string;
  /** 当前在场者，用来做关联加权。 */
  participantIds: readonly string[];
  /** 当前地点。 */
  location: string;
  /** 计算时效衰减的基准时间。 */
  now: string;
}

export type RecallReasonCode =
  | 'keyword'
  | 'importance'
  | 'recency'
  | 'participant'
  | 'location'
  | 'pinned'
  | 'rehearsal';

export interface RecallReason {
  code: RecallReasonCode;
  label: string;
  delta: number;
}

export interface RecalledMemory {
  event: MemoryEvent;
  score: number;
  reasons: RecallReason[];
}

export class MemoryExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryExtractionError';
  }
}
