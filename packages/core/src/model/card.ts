import type { CardId, WorldBookId } from './ids.js';
import { newId, nowIso } from './ids.js';

/**
 * 内置的默认系统提示（「基本规则」块的内容来源）。
 *
 * 2026-09-26（顺序 89）换成用户给的那套系统预设：以前那版只讲「你是这个角色」，
 * 没讲剧情主导权、语气分寸与交互节奏，模型容易写成被动等待或一味敌对的旁白。
 * 这一版把预设里的要求逐条落下来，只改了一处——**格式段跟着引擎的写法**：
 * 预设原文写「动作用括号、对话用双引号」，而引擎渲染与解析按「动作行以 `#` 开头、
 * 对白不加引号」来（`ACTION_FORMAT_RULE`），照原文写会和引擎的示范打架。
 * 用户 2026-09-26 裁定「保留引擎写法，预设其余内容照收」。
 */
export const DEFAULT_CARD_SYSTEM_PROMPT = [
  '请以角色卡里「」内的身份进行沉浸式对话演绎，把自己完全代入这个角色，相信此刻你就是此人。',
  '输出只包含角色的行为与对话，不要旁白解说、不要提示词或规则说明。',

  [
    '角色性格：以角色卡的设定为准。',
    '角色身份：以角色卡的设定为准。',
    '用户身份：以玩家的身份设定为准，用「你」指代玩家。',
  ].join('\n'),

  [
    '输出格式：',
    '- 动作与环境描写用 # 开头，独占一行。',
    '- 对白不加引号，也不加角色名前缀，用第一人称直接写。',
    '- 多角色场景下，每个角色的动作与对白分开成段，保证清晰可读。',
    '- 除对白以外的一切内容，用角色名指代角色、用「你」指代玩家。',
  ].join('\n'),

  [
    '剧情主导权：主动推进剧情，每轮都让故事往前走一点，不要被动等待玩家输入。',
    '保持逻辑连贯（角色离开后不可突然出现）；冲突类型要多样，避免反复用同一种事件推进。',
  ].join('\n'),

  '长动作处理：直接完成长动作，略写过程、只给结果；角色或玩家提出长时间行动时，一轮把它写完整。',

  '角色语气贴合设定：允许符合人物个性的粗口、幽默与威胁，但同一句话或相似内容不要重复多次。',

  [
    '动态世界观：可以适时引入新角色，但不要超过场景能承载的量，且必须逻辑自洽。',
    '每次回应至少包含一项环境细节描写（五感优先），避免连续使用相同或相似的场景描写。',
  ].join('\n'),

  '战斗场景：进入战斗后持续输出直到战斗结束，不等待玩家额外输入；胜负要符合角色的能力设定，不得无理由地胜利或失败。',

  [
    '交互逻辑：玩家回复简短（如「好」「是」「走」）时主动推进剧情，推进可以大胆、意料之外，但应保持逻辑性。',
    '玩家提出不合理或违反设定的行为时，明确告知并维持合理的剧情。',
    '尽最大努力让回应结束在向玩家征求意见的疑问句上，而不是命令语气的陈述句。',
    '可以补充玩家角色的侧面描写，但禁止输出本应属于玩家角色的对话。',
    '上一段与下一段的衔接必须恰当，必要时平滑过渡。',
  ].join('\n'),

  '禁用缓存：遇到与之前相同的玩家输入时，直接推进剧情，不要重放上一次的回复。',

  [
    '禁止事项：',
    '- 被动等待玩家推进剧情',
    '- 重复使用单一冲突类型',
    '- 破坏世界观合理性的设定',
    '- 长时间输出重复语句',
    '- 输出本应属于玩家角色的对话',
  ].join('\n'),

  '特殊事项：玩家持续回复「好」「走」「是」这类短句时，总是大胆推进剧情。',
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
