import type { CardId, WorldBookId } from './ids.js';

/**
 * 角色卡 —— 模板层（设计文档 §2.1）。
 *
 * 一张卡可以派生出任意多个角色实例；实例的记忆与关系不随卡变动。
 */
export interface Card {
  id: CardId;
  name: string;
  /** 角色对玩家的自称或昵称，留空则用 name。 */
  nickname: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  alternateGreetings: string[];
  exampleMessages: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creator: string;
  creatorNotes: string;
  characterVersion: string;
  tags: string[];
  /** 卡内嵌的世界书（SillyTavern 的 character_book）。M0 仅原样保留。 */
  embeddedWorldBook: unknown | null;
  /** 未识别的扩展字段原样保留，避免导入时静默丢数据（设计文档 §9.2）。 */
  extensions: Record<string, unknown>;
  source: CardSource;
}

export interface CardSource {
  kind: 'png' | 'json' | 'manual';
  fileName?: string;
  /** 原始 spec 标识，例如 chara_card_v2。 */
  spec: string;
  specVersion: string;
  importedAt: string;
}

/** 世界书（设计文档 §9.1）。M0 只做导入与关键词匹配。 */
export interface WorldBook {
  id: WorldBookId;
  name: string;
  entries: WorldBookEntry[];
  /** 未识别字段原样保留。 */
  extensions: Record<string, unknown>;
}

/** 选择逻辑，数值对齐 SillyTavern 的 selectiveLogic。 */
export const SelectiveLogic = {
  /** 主键命中，且次级键中任意一个命中。 */
  AND_ANY: 0,
  /** 主键命中，且并非全部次级键都命中。 */
  NOT_ALL: 1,
  /** 主键命中，且没有任何次级键命中。 */
  NOT_ANY: 2,
  /** 主键命中，且全部次级键都命中。 */
  AND_ALL: 3,
} as const;

export type SelectiveLogicValue = (typeof SelectiveLogic)[keyof typeof SelectiveLogic];

/** 插入位置，对齐 SillyTavern 的 position 数值。 */
export type WorldBookPosition =
  | 'before_char'
  | 'after_char'
  | 'before_an'
  | 'after_an'
  | 'at_depth'
  | 'unknown';

export interface WorldBookEntry {
  id: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  /** 常驻条目，不需要关键词命中。 */
  constant: boolean;
  selective: boolean;
  selectiveLogic: SelectiveLogicValue;
  /** 排序权重，越大越靠前。 */
  order: number;
  position: WorldBookPosition;
  depth: number;
  /** 0 ~ 100，命中后按此概率插入。 */
  probability: number;
  useProbability: boolean;
  disabled: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  /** null 表示继承全局设置。 */
  scanDepth: number | null;
  preventRecursion: boolean;
  excludeRecursion: boolean;
  group: string;
  extensions: Record<string, unknown>;
}
