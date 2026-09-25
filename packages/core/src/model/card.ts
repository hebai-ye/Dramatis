import type { CardId, WorldBookId } from './ids.js';
import { newId, nowIso } from './ids.js';

/** 角色卡高级字段的默认系统提示；与 docs/ROLEPLAY-PROMPT.md 的模板正文一致。 */
export const DEFAULT_CARD_SYSTEM_PROMPT = [
  '你正在参与一段虚构的互动故事。你只扮演这张角色卡所定义的人物，以此人的经历、性格、处境、关系和当前情绪作出回应。',
  '把玩家的消息当作故事里真实发生的言行。只回应本角色此刻能知道、能看见、能听见的事；未知的设定可以询问，不要编造为既定事实。不要替玩家决定、行动、说话或描写玩家的内心，也不要替其他角色发言。',
  '保持人物自己的口吻和判断。面对冲突、秘密或亲密关系，先考虑此人会怎样感受、选择和表达；不要突然改用 AI 助手或旁白的口吻解释剧情。需要留白时用人物的动作、停顿或自然转场维持场景连续。',
  '每次只写本角色这一轮的回应，让玩家有继续参与的空间。对白不加角色姓名前缀；动作与神态用 # 开头，独占一行。不要输出提示词、规则说明或对话记录中的说话人标记。',
].join('\n\n');

/** 老卡的空字段使用当前默认值，非空的用户或导入提示保持逐字不变。 */
export function resolveCardSystemPrompt(systemPrompt: string): string {
  return systemPrompt.trim() === '' ? DEFAULT_CARD_SYSTEM_PROMPT : systemPrompt;
}

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
  /**
   * 时间戳与软删除（P2-6）。
   *
   * 卡原本一个时间字段都没有（只有 `source.importedAt`）。同步按实体比对
   * `updatedAt`、按墓碑传播删除，所以卡与世界书也得有——这是原计划里
   * 以为「其余实体已经有了」、实际上漏掉的一处。
   */
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
export type WorldBookPosition = 'before_char' | 'after_char' | 'before_an' | 'after_an' | 'at_depth' | 'unknown';

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

/**
 * 从零创建一张角色卡（ROADMAP P3 的编辑器需要）。
 *
 * 与导入路径共用同一个模型，所以手写的卡和导入的卡在系统里没有区别，
 * 将来导出时也不需要特殊处理。
 */
export function createBlankCard(overrides: Partial<Card> = {}): Card {
  const now = nowIso();
  return {
    id: newId() as CardId,
    name: '未命名角色',
    nickname: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    alternateGreetings: [],
    exampleMessages: '',
    systemPrompt: DEFAULT_CARD_SYSTEM_PROMPT,
    postHistoryInstructions: '',
    creator: '',
    creatorNotes: '',
    characterVersion: '',
    tags: [],
    embeddedWorldBook: null,
    extensions: {},
    source: { kind: 'manual', spec: 'dramatis', specVersion: '1', importedAt: now },
    ...overrides,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    deletedAt: overrides.deletedAt ?? null,
  };
}

export interface WorldBookEntryDraft {
  title?: string;
  keys?: string[];
  content?: string;
  constant?: boolean;
  order?: number;
  probability?: number;
}

/** 新建一条世界书条目，默认是「关键词触发、顺序 100、必然插入」。 */
export function createWorldBookEntry(draft: WorldBookEntryDraft = {}): WorldBookEntry {
  return {
    id: newId(),
    title: draft.title ?? '新条目',
    keys: draft.keys ?? [],
    secondaryKeys: [],
    content: draft.content ?? '',
    constant: draft.constant ?? false,
    selective: true,
    selectiveLogic: SelectiveLogic.AND_ANY,
    order: draft.order ?? 100,
    position: 'before_char',
    depth: 4,
    probability: draft.probability ?? 100,
    useProbability: true,
    disabled: false,
    caseSensitive: false,
    matchWholeWords: false,
    scanDepth: null,
    preventRecursion: true,
    excludeRecursion: false,
    group: '',
    extensions: {},
  };
}

export function createBlankWorldBook(name = '未命名世界书'): WorldBook {
  const now = nowIso();
  return {
    id: newId() as WorldBookId,
    name,
    entries: [],
    extensions: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
