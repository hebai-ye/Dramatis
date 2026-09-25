import type { WorldBookMatch } from '../compat/sillytavern/worldbook.js';
import {
  type AttachmentSourceLookup,
  expandAttachment,
  readAttachment,
  renderAttachment,
  renderAttachmentExpansion,
} from '../memory/attachment.js';
import type { ChapterSummary } from '../memory/summary.js';
import {
  type Card,
  DEFAULT_CARD_SYSTEM_PROMPT,
  resolveCardSystemPrompt,
  type WorldBookPosition,
} from '../model/card.js';
import {
  type ConversationModes,
  type HistoryPolicy,
  historyPolicyOf,
  replyLengthOf,
  unlimitedModeOf,
} from '../model/conversation.js';
import { type InstanceId, PLAYER } from '../model/ids.js';
import type { Affect, CharacterInstance, TraitAxis } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Room, Scene } from '../model/room.js';
import { INTENT_FORMAT_RULE } from '../render/intent.js';
import { ACTION_FORMAT_EXAMPLES, ACTION_FORMAT_RULE, normalizeCardExample } from '../render/segments.js';
import { heuristicTokenCounter, type TokenCounter } from '../token/estimate.js';
import { applyBudget } from './budget.js';
import { expandHistoryOnMention, partitionHistory, selectHistoryFor } from './history.js';
import { NO_REPEAT_RULE, REPLY_LENGTH_RULES } from './reply-style.js';
import type { BudgetReport, ChatMessage, PromptBlock, PromptPlacement } from './types.js';
import { unlimitedPromptOf } from './unlimited.js';

/**
 * 召回记忆的展示形态。
 *
 * M0 只需要渲染；真正的抽取与排序在 M2 实现。
 */
export interface PromptMemory {
  id: string;
  summary: string;
  /** 该视角下的观感、误解与情绪反应。 */
  perception?: string;
  /** 召回分数；同一轮内只用于相对比较（预算紧张时分数低的先丢）。 */
  score: number;
  worldTime?: string;
  observerName?: string;
  /**
   * 这条是怎么被想起来的（顺序 57）：常规召回、玩家提到才想起的旧事、
   * 问过去时从印象翻出的来源原文。缺省视为常规。
   */
  origin?: 'recall' | 'mention' | 'source';
}

export interface AssembleInput {
  card: Card;
  instance: CharacterInstance;
  room: Room;
  scene: Scene | null;
  history: Message[];
  playerInput: string;
  worldBookMatches?: WorldBookMatch[];
  memories?: PromptMemory[];
  /**
   * 已经滚成章节的前情（P1-5），按时间正序。
   *
   * 只带最近几章：更早的压成一句「还有 N 章」。原文没有被删除，
   * 需要细节时靠记忆召回与「展开回想」去找，而不是把整段历史塞回 prompt。
   */
  chapters?: readonly ChapterSummary[];
  /** 场景内的角色，用于让模型知道还有谁在场（P0-6）。 */
  cast?: readonly CharacterInstance[];
  /**
   * 这条对话的全部场景（含已结束的），顺序 58 要用：
   * ① 判断哪些原文已被各自场景的场记覆盖；② 把「已结束但还没进章节」的场记带上。
   * 缺省只看 `scene` 一个。
   */
  scenes?: readonly Scene[];
  /** 历史策略（顺序 58）；缺省从 `modes` 读，再缺省 `recap-aware / 40`。 */
  historyPolicy?: HistoryPolicy;
  /**
   * 判断「提到」用的文本：**只能是玩家这一句**，不含历史（与顺序 57 同一口径）。
   * 缺省用 `playerInput`；同一回合第二名角色发言时 `playerInput` 为空，调用方要单独传。
   */
  mention?: { text: string; askingPast?: boolean };
  /** 附件索引里那些 id 对应的原文；没有时只注入索引，不展开正文。 */
  attachmentSources?: AttachmentSourceLookup;
  /** 会话级对话模式：静默、是否必须等主角先开口（LAYOUT「输入区 · 加号」）。 */
  modes?: ConversationModes;
  /**
   * 无限制模式的提示词正文（用户数据，2026-09-25）。
   *
   * **由调用方从用户自己的存储里读出来传进来**，不是本仓库的常量：网页是公开托管的
   * 静态站点，写进代码就等于编译进公开可下载的 JS（`prompt/unlimited.ts` 的注释里记了
   * 这件事的来龙去脉）。缺省 / 空串 → 模式开着也不加块。
   */
  unlimitedPrompt?: string;
  /**
   * 这一轮的意图（P1-6）：由生成前的导演调用给出。
   *
   * 有了它，角色是**照着自己的打算**落笔的，而不是重新猜一遍「这轮该干嘛」；
   * `hold_back`（想说没说）也靠它写成动作。它是提示，不是台词——明确要求不要写出来。
   */
  intent?: string;
  /** 意图的模式；`hold_back` 时只写动作。 */
  intentMode?: 'reply' | 'cut_in' | 'hold_back' | 'initiate';
  /** 当前对话选择的玩家身份；缺省时退回 Room 上的旧字段。 */
  player?: { name: string; description: string };
  budget: {
    /** 模型的上下文窗口。 */
    maxTokens: number;
    /** 为回复预留的空间。 */
    reserveForReply: number;
  };
  options?: AssembleOptions;
}

export interface AssembleOptions {
  /** 最多带入多少条历史消息，默认 40。 */
  historyLimit?: number;
  counter?: TokenCounter;
  /** 覆盖默认系统提示。 */
  systemPrompt?: string;
}

export interface AssembledPrompt {
  blocks: PromptBlock[];
  messages: ChatMessage[];
  report: BudgetReport;
  tokenEstimate: number;
  /**
   * 本次装配的历史账（P0-5 / 顺序 58）：`total` 这条对话有多少条，`visible` 这个角色看得见多少条，
   * `collapsed` 其中被场记覆盖而收起了多少条，`recalled` 又因玩家提到而取回了几条。
   */
  historyStats: { total: number; visible: number; collapsed: number; recalled: number };
  /** 带进来的记忆各是怎么想起来的（顺序 57），供检查器展示。 */
  memoryStats: { recall: number; mention: number; source: number };
}

/** 越大越不可丢弃。 */
const PRIORITY = {
  system: 1000,
  player: 1000,
  instruction: 900,
  persona: 700,
  scene: 600,
  worldbook: 500,
  relationship: 400,
  history: 300,
} as const;

/** 预算被榨干时仍要留下的最小空间，保证 prompt 不会退化成空。 */
const MIN_PROMPT_TOKENS = 256;

/**
 * 动作写法的现场示范。
 *
 * 真实模型（DeepSeek）在 12 回合里只有约 2 条照 `#` 约定写；把规则写进系统提示、
 * 在每轮指令里再提醒一次都不管用。原因是它**模仿对话记录**远胜于服从规则——
 * 而记录里最近几条恰好都是「动作没带 `#`」的。所以这里直接给一段形状正确的短示范，
 * 放在模型生成前读到的最后一段里，并注明「只是示范，不是本轮内容」。
 */
const FORMAT_DEMO = [
  '格式示范（只是示范，不是本轮内容）：对白带「」，没带引号的一律当动作。',
  '玩家：你们两个怎么看？',
  '# 他把袖口的水拧了一把。',
  '「先看看货再说。」',
  '他抬眼看了看门口。',
].join('\n');

const TRAIT_LABELS: Record<TraitAxis, readonly [string, string]> = {
  extroversion: ['外向主动', '内向寡言'],
  aggression: ['强势好斗', '温和退让'],
  empathy: ['共情敏锐', '疏离冷淡'],
  playfulness: ['爱开玩笑', '正经严肃'],
  caution: ['谨慎多疑', '大胆冒进'],
};

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}……`;
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value.trim() !== '') return value;
  }
  return '';
}

function formatScore(value: number): string {
  const clamped = Math.max(-1, Math.min(1, value));
  const sign = clamped >= 0 ? '+' : '-';
  return `${sign}${Math.abs(clamped).toFixed(2)}`;
}

/** 把特质轴翻译成人话，只保留偏离中性的部分，避免噪声。 */
function describeTraits(traits: CharacterInstance['traits']): string {
  const parts: string[] = [];
  for (const axis of Object.keys(TRAIT_LABELS) as TraitAxis[]) {
    const value = traits[axis];
    if (value >= 0.25) {
      parts.push(TRAIT_LABELS[axis][0]);
    } else if (value <= -0.25) {
      parts.push(TRAIT_LABELS[axis][1]);
    }
  }
  return parts.join('、');
}

/** 快变量接近中性时不写入 prompt，省下的 token 留给记忆。 */
function describeAffect(affect: Affect): string | null {
  const notable = Math.abs(affect.valence) >= 0.15 || affect.arousal >= 0.4;
  if (!notable) return null;

  const mood =
    affect.valence >= 0.5
      ? '心情很好'
      : affect.valence >= 0.15
        ? '心情不错'
        : affect.valence <= -0.5
          ? '情绪低落'
          : affect.valence <= -0.15
            ? '有些不快'
            : '情绪平稳';

  const energy = affect.arousal >= 0.7 ? '情绪激动' : affect.arousal >= 0.4 ? '略有起伏' : '比较平静';
  return `${mood}，${energy}`;
}

function defaultSystemPrompt(card: Card, playerName: string): string {
  return [
    `你正在参与的是一场多角色扮演对话。玩家扮演的是「${playerName}」。`,
    `你只扮演「${card.name}」这一个角色，始终以其身份说话与行动。`,
    '不要替玩家做决定，不要描写玩家的心理活动，不要以旁白解释角色动机。',
    '用第一人称和动作描写写作，像小说里的对话那样自然。',
    ACTION_FORMAT_RULE,
  ].join('\n');
}

/**
 * 会话级模式的指令（LAYOUT 的「对话模式」）。
 *
 * 模式只是开关，模型不知道就等于没开——所以它必须落到 prompt 里，
 * 和入场策略一样，是「界面上的设置真的生效」的那一步。
 */
function describeModes(modes: ConversationModes | undefined): string[] {
  if (!modes) return [];
  const lines: string[] = [];
  if (modes.playerFirst) {
    lines.push('本轮模式：只有玩家先开口，你才可以接话。玩家没说话就保持沉默，用动作推进即可。');
  }
  if (modes.silent) {
    lines.push('本轮模式（静默）：不要说话，只写动作与神态（每条用 `#` 起段），也不要替别人发言。');
  }
  return lines;
}

function buildPersonaBlock(card: Card, instance: CharacterInstance): PromptBlock {
  const parts = [`你现在扮演的是「${instance.displayName}」。`];
  if (card.description.trim() !== '') parts.push(card.description.trim());
  if (card.personality.trim() !== '') parts.push(`性格：${card.personality.trim()}`);

  const traits = describeTraits(instance.traits);
  if (traits !== '') parts.push(`性格倾向：${traits}`);

  // 卡里的示例要先归一化成我们自己的写法：它是模型最愿意模仿的示范，
  // 而老卡片的写法（动作挤在对白后、回复开头挂名字）正好与约定相反
  const examples = truncate(
    normalizeCardExample(card.exampleMessages, [card.name, card.nickname, instance.displayName]),
    1200,
  );
  if (examples !== '') parts.push(`对话风格示例：\n${examples}`);

  const compressed = [
    `你现在扮演的是「${instance.displayName}」。`,
    truncate(firstNonEmpty(card.description, card.personality), 160),
  ]
    .filter((part) => part.trim() !== '')
    .join('\n');

  return {
    id: `persona:${instance.id}`,
    kind: 'persona',
    label: `角色：${instance.displayName}`,
    content: parts.join('\n\n'),
    priority: PRIORITY.persona,
    droppable: true,
    compressed,
  };
}

function buildRelationshipBlock(instance: CharacterInstance): PromptBlock | null {
  const lines: string[] = [];

  const mood = describeAffect(instance.affect);
  if (mood !== null) lines.push(`当前情绪：${mood}`);

  const towardPlayer = instance.relationships.find((relationship) => relationship.target === PLAYER);
  if (towardPlayer) {
    lines.push(
      `对玩家的态度：信任 ${formatScore(towardPlayer.trust)}、好感 ${formatScore(towardPlayer.affinity)}` +
        `、畏惧 ${formatScore(towardPlayer.fear)}、敬重 ${formatScore(towardPlayer.respect)}` +
        `、紧张感 ${formatScore(towardPlayer.tension)}`,
    );
  }

  if (lines.length === 0) return null;

  return {
    id: `relationship:${instance.id}`,
    kind: 'relationship',
    label: '关系与情绪状态',
    content: lines.join('\n'),
    priority: PRIORITY.relationship,
    droppable: true,
    compressed: lines.join('；'),
  };
}

/**
 * 场景块。
 *
 * 入场策略会被翻译成给模型的明确指令——这是「锁场」从 UI 落到
 * 实际行为的关键，光有开关而模型不知道，等于没有。
 */
function describePresence(presence: CharacterInstance['presence']): string {
  switch (presence) {
    case 'onstage':
      return '在场';
    case 'muted':
      return '在场但一直没说话';
    case 'offscreen':
      return '不在这场，人在别处';
    default:
      return '已离场';
  }
}

function buildSceneBlock(
  scene: Scene | null,
  cast: readonly CharacterInstance[],
  speakerId: InstanceId,
): PromptBlock | null {
  if (!scene) return null;

  const lines = [`地点：${scene.location.trim() === '' ? '未指定' : scene.location.trim()}`];
  if (scene.worldTime.trim() !== '') lines.push(`时间：${scene.worldTime.trim()}`);

  switch (scene.castPolicy) {
    case 'locked':
      lines.push('导演指令：本场景名单已锁定。不得引入任何新角色，也不要提及未在场角色进入场景。');
      break;
    case 'invite_only':
      lines.push('导演指令：只有玩家明确召唤的角色才能进入场景，不要自行引入其他角色。');
      break;
    case 'triggered':
      lines.push('导演指令：只有设定被触发的角色才能进入场景。');
      break;
    default:
      // open 策略不追加额外约束，角色可以自行入场
      break;
  }

  if (scene.summary.trim() !== '') lines.push(`场景摘要：${scene.summary.trim()}`);
  // 滚动场记（P1-5 的场景层）：已经过去的部分不再占原文的位置
  if (scene.recap !== undefined && scene.recap.trim() !== '') {
    lines.push(`本场已经发生：${scene.recap.trim()}`);
  }

  if (cast.length > 0) {
    const roster = cast
      .map(
        (member) =>
          `${member.displayName}（${member.id === speakerId ? '正在与你对话' : describePresence(member.presence)}）`,
      )
      .join('、');
    lines.push(`在场角色：${roster}`);
  }

  return {
    id: `scene:${scene.id}`,
    kind: 'scene',
    label: '当前场景',
    content: lines.join('\n'),
    priority: PRIORITY.scene,
    droppable: false,
  };
}

/** SillyTavern 的 `position` 落到装配的哪一层（DESIGN §9）。 */
const PLACEMENT_BY_POSITION: Record<WorldBookPosition, PromptPlacement> = {
  before_char: 'before_char',
  after_char: 'after_char',
  before_an: 'before_scene',
  after_an: 'after_scene',
  at_depth: 'at_depth',
  unknown: 'default',
};

/**
 * 世界书命中 → 一块一命中（顺序 60）。
 *
 * 为什么要一条一块：预算守卫是**按块**降级的，以前所有命中并成一块，要么全进要么全丢；
 * 现在每条各带自己的优先级（按 `order` 排开），挤不下时先丢 `order` 最低的那几条。
 *
 * 标签统一叫「世界设定」，标题写在正文里（`【标题】`）——这样默认位置的几条会被
 * `renderSystemBlocks` 合并回一个 `### 世界设定` 小节，和顺序 60 之前**逐字一样**。
 */
function buildWorldBookBlocks(matches: readonly WorldBookMatch[]): PromptBlock[] {
  if (matches.length === 0) return [];

  // order 越小越先被丢：映射成一段夹在 relationship(400) 与 scene(600) 之间的优先级
  const byOrderAscending = [...matches].sort((a, b) => {
    if (a.entry.order !== b.entry.order) return a.entry.order - b.entry.order;
    return a.entry.title.localeCompare(b.entry.title);
  });
  const rankOf = new Map(byOrderAscending.map((match, index) => [match.entry.id, index]));

  return matches.map((match) => {
    const rank = rankOf.get(match.entry.id) ?? 0;
    const title = match.entry.title.trim() === '' ? '未命名条目' : match.entry.title.trim();
    const placement = PLACEMENT_BY_POSITION[match.entry.position] ?? 'default';
    return {
      id: `worldbook:${match.entry.id}`,
      kind: 'worldbook',
      label: '世界设定',
      content: `【${title}】\n${match.entry.content.trim()}`,
      priority: Math.min(PRIORITY.scene - 1, PRIORITY.relationship + 1 + rank),
      droppable: true,
      placement,
      ...(placement === 'at_depth' ? { depth: Math.max(0, Math.floor(match.entry.depth)) } : {}),
    };
  });
}

/**
 * 记忆块。
 *
 * M0 每条记忆独立成块，这样预算守卫可以按分数逐条丢弃；
 * 渲染时会合并到同一个「相关记忆」小节下。
 */
function buildMemoryBlocks(memories: PromptMemory[]): PromptBlock[] {
  return memories.map((memory) => {
    const parts: string[] = [];
    if (memory.worldTime !== undefined && memory.worldTime.trim() !== '') parts.push(`（${memory.worldTime.trim()}）`);
    parts.push(memory.summary.trim());
    if (memory.perception !== undefined && memory.perception.trim() !== '') {
      parts.push(`他当时的感觉：${memory.perception.trim()}`);
    }
    // 被提起才想起的旧事、印象背后的原文：标一下，模型知道这是「翻出来的细节」而不是当下的事
    const origin = memory.origin ?? 'recall';
    if (origin === 'mention') parts.push('（旧事，因为被提起才想起）');
    if (origin === 'source') parts.push('（这是那段印象里的一件具体的事）');

    return {
      id: `memory:${memory.id}`,
      kind: 'memory',
      label: origin === 'recall' ? '相关记忆' : origin === 'mention' ? '提到才想起的旧事' : '印象背后的原文',
      content: parts.join(' '),
      priority: PRIORITY.history + Math.round(memory.score * 200),
      droppable: true,
      score: memory.score,
    };
  });
}

/**
 * 记忆附件块（顺序 27c）。
 *
 * 常驻的**永远只有索引**；只有玩家这句话命中索引关键词，或明显在问过去，
 * 才把命中的最多三条正文展开。这样日常闲聊不为「文件夹里的正文」付 token。
 */
function buildAttachmentBlocks(input: AssembleInput): PromptBlock[] {
  const attachment = readAttachment(input.card);
  if (attachment === null) return [];

  const blocks: PromptBlock[] = [
    {
      id: 'memory-attachment-index',
      kind: 'attachment',
      label: '跨对话记忆索引',
      content: renderAttachment(attachment),
      priority: PRIORITY.history + 5,
      droppable: true,
      score: 0.8,
    },
  ];

  const expansion = expandAttachment(attachment, input.playerInput, input.attachmentSources ?? {});
  if (expansion.reason === null || (expansion.memories.length === 0 && expansion.chapters.length === 0)) return blocks;

  blocks.push({
    id: 'memory-attachment-expanded',
    kind: 'attachment',
    label: '想起的具体的事',
    content: renderAttachmentExpansion(expansion),
    priority: PRIORITY.history + 180,
    droppable: true,
    score: 1.2,
  });
  return blocks;
}
/** 一次最多带几章；更早的只报条数，不占预算。 */
const CHAPTER_BLOCK_LIMIT = 3;

/**
 * 前几场的场记（顺序 58 顺带补的漏洞）。
 *
 * 章节要攒够 3 场才滚，所以**已结束、但还没进章节**的那几场，它们的场记在原文滚出
 * 窗口之后没有任何载体——历史收起之后这段戏就凭空消失了。这里把它们带上，
 * 优先级同章节块；已经进了章节的不再重复。
 */
function buildPastScenesBlock(
  scenes: readonly Scene[],
  currentSceneId: string | null,
  chapters: readonly ChapterSummary[],
): PromptBlock | null {
  const covered = new Set(chapters.flatMap((chapter) => chapter.sceneIds));
  const past = scenes
    .filter(
      (scene) =>
        scene.id !== currentSceneId &&
        scene.endedAt !== null &&
        scene.deletedAt === null &&
        !covered.has(scene.id) &&
        (scene.recap ?? '').trim() !== '',
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (past.length === 0) return null;

  const body = past
    .map((scene) => {
      const where = scene.location.trim() === '' ? '' : `（${scene.location.trim()}）`;
      return `${scene.title.trim() === '' ? '前一场' : scene.title.trim()}${where}：${(scene.recap ?? '').trim()}`;
    })
    .join('\n');

  return {
    id: 'scene-recaps',
    kind: 'chapter',
    label: '前几场',
    content: body,
    priority: PRIORITY.history + 10,
    droppable: true,
  };
}

/**
 * 玩家提到关键词时，从收起的远处原文里取回的几条（顺序 58）。
 *
 * 自成一节而不是插回对话记录：它们是「翻出来的旧话」，按原位置插回去会让记录
 * 看起来缺了一大段；集中列出并标明是旧对话，模型知道该怎么用。
 */
function buildHistoryRecallBlock(messages: readonly Message[]): PromptBlock | null {
  if (messages.length === 0) return null;
  const lines = messages.map((message) => {
    const name = message.role === 'player' ? `${message.speakerName}（玩家）` : message.speakerName;
    return `- ${name}：${message.content.replace(/\s*\n\s*/g, ' ')}`;
  });
  return {
    id: 'history-recall',
    kind: 'history-recall',
    label: '提到的旧对话原文',
    content: ['【这几句是更早的对话原文，因为被提起才翻出来】', ...lines].join('\n'),
    priority: PRIORITY.history + 180,
    droppable: true,
    score: 1.2,
  };
}

/**
 * 章节块（P1-5 的第三层）。
 *
 * 前面的戏早就不在窗口里了，靠零散的记忆条目召回是**抽查**；这一块给的是
 * 「前面发生过什么」的连续线索。只带最近三章：更早的压成一句「还有 N 章」，
 * 因为越久远的越可能只是氛围，而不是当下要用的线索。
 */
function buildChapterBlock(chapters: readonly ChapterSummary[]): PromptBlock | null {
  if (chapters.length === 0) return null;

  const recent = chapters.slice(-CHAPTER_BLOCK_LIMIT);
  const body = recent
    .map((chapter) => {
      const facts = chapter.keyFacts.length === 0 ? '' : `（要点：${chapter.keyFacts.join('；')}）`;
      return `${chapter.title}：${chapter.summary.trim()}${facts}`;
    })
    .join('\n');

  const older = chapters.length - recent.length;
  const prefix = older <= 0 ? '' : `更早还有 ${String(older)} 章（略）。\n`;

  return {
    id: 'chapter',
    kind: 'chapter',
    label: '前情提要',
    content: prefix + body,
    priority: PRIORITY.history + 10,
    droppable: true,
  };
}

/**
 * 历史消息块。
 *
 * `prefixSpeaker` 在多角色场景下必开：对话消息的 assistant 角色分不出是谁说的，
 * 不标名字模型就会把几个角色混成一个声音。
 *
 * 标记用 `【名字】` 而不是「名字：」。真实模型验证里的教训：写成「名字：」时，
 * 模型会把历史当范本照抄，甚至用**别人的名字**开头（秦娘那条回复以「陈九：」开头），
 * 于是同一句话同时属于两个人。方括号标记看起来就不像台词，被误抄的概率低得多；
 * 万一还是被抄了，渲染层也认得它、能剥掉。
 */
function buildHistoryBlocks(history: Message[], limit: number, prefixSpeaker: boolean): PromptBlock[] {
  const recent = history.slice(-limit);
  return recent.map((message, index) => ({
    id: `history:${message.id}`,
    kind: 'history',
    label: message.speakerName,
    content:
      prefixSpeaker && message.role !== 'player' ? `【${message.speakerName}】${message.content}` : message.content,
    priority: PRIORITY.history,
    droppable: true,
    sequence: index,
    message: {
      role: message.role === 'player' ? 'user' : 'assistant',
      speakerName: message.speakerName,
    },
  }));
}

/** 把系统侧的所有块渲染成一条 system 消息，记忆合并到同一小节。 */
function renderSystemBlocks(blocks: PromptBlock[]): string {
  const sections: string[] = [];
  let memoryGroup: string[] = [];
  /*
   * 世界书一条一块（顺序 60），但**相邻且同标签**的几条要合并回一个小节：
   * 默认位置的老世界书因此仍然只出现一次 `### 世界设定`，与顺序 60 之前逐字一样。
   */
  let worldBookGroup: string[] = [];

  const flushMemory = (): void => {
    if (memoryGroup.length === 0) return;
    sections.push(`### 相关记忆\n${memoryGroup.map((item) => `- ${item}`).join('\n')}`);
    memoryGroup = [];
  };

  const flushWorldBook = (): void => {
    if (worldBookGroup.length === 0) return;
    sections.push(`### 世界设定\n${worldBookGroup.join('\n\n')}`);
    worldBookGroup = [];
  };

  for (const block of blocks) {
    if (block.kind === 'memory') {
      flushWorldBook();
      memoryGroup.push(block.content.replace(/\s*\n\s*/g, ' '));
      continue;
    }
    if (block.kind === 'worldbook' && block.label === '世界设定') {
      flushMemory();
      worldBookGroup.push(block.content);
      continue;
    }
    flushMemory();
    flushWorldBook();
    sections.push(block.label.trim() === '' ? block.content : `### ${block.label}\n${block.content}`);
  }

  flushMemory();
  flushWorldBook();
  return sections.join('\n\n');
}

export function toChatMessages(blocks: PromptBlock[]): ChatMessage[] {
  /*
   * `at_depth` 的块不进那条大 system 提示，而是插到历史里（顺序 60）。
   * 位置按 SillyTavern 的语义：插到**倒数第 depth 条之前**——depth 越大越靠前。
   */
  const atDepthBlocks = blocks.filter((block) => block.placement === 'at_depth');
  const systemBlocks = blocks.filter(
    (block) => block.kind !== 'history' && block.kind !== 'player' && block.placement !== 'at_depth',
  );
  const historyBlocks = blocks.filter((block) => block.kind === 'history' && block.message !== undefined);
  const playerBlock = blocks.find((block) => block.kind === 'player');

  const messages: ChatMessage[] = [];

  const system = renderSystemBlocks(systemBlocks).trim();
  if (system !== '') messages.push({ role: 'system', content: system });

  const insertionsAtIndex = new Map<number, PromptBlock[]>();
  for (const block of atDepthBlocks) {
    const depth = Math.max(0, Math.floor(block.depth ?? 0));
    const index = Math.max(0, historyBlocks.length - depth);
    const list = insertionsAtIndex.get(index);
    if (list === undefined) insertionsAtIndex.set(index, [block]);
    else list.push(block);
  }

  for (let index = 0; index <= historyBlocks.length; index += 1) {
    const inserted = insertionsAtIndex.get(index);
    if (inserted !== undefined && inserted.length > 0) {
      const content = renderSystemBlocks(inserted).trim();
      if (content !== '') messages.push({ role: 'system', content });
    }
    const block = historyBlocks[index];
    if (block === undefined) continue;
    const ref = block.message;
    if (ref === undefined) continue;
    messages.push({ role: ref.role, content: block.content });
  }

  if (playerBlock) messages.push({ role: 'user', content: playerBlock.content });

  return messages;
}

/** 无限制模式那一块的 id：提示词检查器、界面与测试都按它找。 */
export const UNLIMITED_BLOCK_ID = 'unlimited';

/**
 * 无限制模式那一条 system 块（用户 2026-09-25 点名）。
 *
 * 传 `null`（模式关着，或正文为空）就返回 `null` —— 调用方据此**什么都不加**。
 * 正文由调用方从用户自己的存储里读出来（`AssembleInput.unlimitedPrompt`），
 * 仓库里没有这段文字：网页产物是公开可下载的。
 *
 * 为什么 `droppable: false`：这是用户**自己打开的**开关，预算一紧就悄悄不加，
 * 等于告诉他「开了」却没开。要挤就挤别人（它和角色卡系统提示同一档）。
 * 代价是正文写太长会挤掉记忆与场记——所以长度由用户自己负责，界面上会显示字数。
 */
export function buildUnlimitedModeBlock(prompt: string | null): PromptBlock | null {
  if (prompt === null) return null;
  return {
    id: UNLIMITED_BLOCK_ID,
    kind: 'system',
    label: '无限制模式',
    content: prompt,
    priority: PRIORITY.system,
    droppable: false,
  };
}

/**
 * 按设计文档 §6 的顺序装配 prompt，并交给预算守卫降级。
 */
export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const options = input.options ?? {};
  const counter = options.counter ?? heuristicTokenCounter;
  const rawPlayerName = input.player?.name ?? input.room.playerName;
  const playerName = rawPlayerName.trim() === '' ? '玩家' : rawPlayerName.trim();
  // 身份是本轮不可丢的约束，限住长度以免一张极长身份卡挤爆提示词预算。
  const playerDescription = truncate(input.player?.description ?? input.room.playerPersona, 320);

  const systemContent = options.systemPrompt ?? resolveCardSystemPrompt(input.card.systemPrompt);
  const compressDefaultSystem =
    options.systemPrompt === undefined &&
    (input.card.systemPrompt.trim() === '' || input.card.systemPrompt === DEFAULT_CARD_SYSTEM_PROMPT);

  const blocks: PromptBlock[] = [
    {
      id: 'system',
      kind: 'system',
      label: '基本规则',
      content: systemContent,
      ...(compressDefaultSystem ? { compressed: defaultSystemPrompt(input.card, playerName) } : {}),
      priority: PRIORITY.system,
      droppable: false,
    },
  ];

  /*
   * 旧版「高级系统提示 · 当前对话」（顺序 67e 的输入框，2026-09-25 被无限制模式取代）。
   *
   * 界面已经不再提供编辑入口，但**照旧装配**：用户当初写下的要求不该因为一次 UI 重构
   * 就悄悄失效。（菜单里会显示它还在生效，并给一个「清空」按钮。）
   */
  const advancedSystemPrompt = input.modes?.advancedSystemPrompt?.trim();
  if (advancedSystemPrompt) {
    blocks.push({
      id: 'conversation-system',
      kind: 'system',
      label: '本对话高级系统提示（旧）',
      content: advancedSystemPrompt,
      priority: PRIORITY.system,
      droppable: false,
    });
  }

  /*
   * 无限制模式（用户 2026-09-25 点名）：正文来自**用户数据**（`input.unlimitedPrompt`），
   * 不是仓库里的常量——理由写在 `prompt/unlimited.ts` 顶上。模式开着且正文非空才放进去。
   */
  const unlimitedBlock = buildUnlimitedModeBlock(
    unlimitedModeOf(input.modes) ? unlimitedPromptOf(input.unlimitedPrompt) : null,
  );
  if (unlimitedBlock !== null) blocks.push(unlimitedBlock);

  /*
   * 世界书按位置落（顺序 60）：每条命中一块，`placement` 决定它插到哪一层。
   *
   * - `default`（含认不出的位置码）与 `before_char` 都落在「基本规则之后、人设之前」——
   *   这正是顺序 60 之前唯一的位置，所以老世界书的提示词**逐字不变**；
   * - `at_depth` 不进 system 提示，由 `toChatMessages` 插进历史。
   */
  const worldBookBlocks = buildWorldBookBlocks(input.worldBookMatches ?? []);
  const placedAt = (placement: PromptPlacement): PromptBlock[] =>
    worldBookBlocks.filter((block) => (block.placement ?? 'default') === placement);

  blocks.push(...placedAt('default'), ...placedAt('before_char'));
  blocks.push(buildPersonaBlock(input.card, input.instance));
  blocks.push(...placedAt('after_char'));

  const relationshipBlock = buildRelationshipBlock(input.instance);
  if (relationshipBlock) blocks.push(relationshipBlock);

  blocks.push(...buildAttachmentBlocks(input));
  blocks.push(...buildMemoryBlocks(input.memories ?? []));

  const chapterBlock = buildChapterBlock(input.chapters ?? []);
  if (chapterBlock) blocks.push(chapterBlock);

  const scenes = input.scenes ?? (input.scene === null ? [] : [input.scene]);
  const pastScenesBlock = buildPastScenesBlock(scenes, input.scene?.id ?? null, input.chapters ?? []);
  if (pastScenesBlock) blocks.push(pastScenesBlock);

  const cast = input.cast ?? [];
  const sceneBlock = buildSceneBlock(input.scene, cast, input.instance.id);
  blocks.push(...placedAt('before_scene'));
  if (sceneBlock) blocks.push(sceneBlock);
  blocks.push(...placedAt('after_scene'));

  // 插进历史的那几条（`at_depth`）：位置在 toChatMessages 里按 depth 算
  blocks.push(...placedAt('at_depth'));

  // 多人同场时才需要标名字，单人场景标了只是浪费 token
  const onstageCount = cast.filter((member) => member.presence === 'onstage').length;
  const prefixSpeaker = onstageCount > 1;

  // 按视角裁剪：角色看不到自己不在场时发生的事（P0-5）
  const visibleHistory = selectHistoryFor(input.history, input.instance.id);
  /*
   * 历史怎么带（2026-09-21 放开上限，2026-09-23 顺序 58 改成按场记覆盖收起）。
   *
   * 原来是 `?? 40` 写死只带最近 40 条——窗口调多大都没用；放开成 3000 条之后
   * 提示词随对话线性长（60 轮 5.9 千字、每轮几万 token）。用户要求**质量优先于省 token**，
   * 所以不按固定条数砍，而是：
   *
   * - 未被场记覆盖的原文全带；已被覆盖但在近窗内的也全带；
   * - 已被覆盖且在近窗外的收起，由场记 / 前几场 / 章节 / 记忆代表；
   * - 玩家这一句提到了收起段里的什么，就取回最多三条原文（下面的「提到的旧对话原文」块）；
   * - 真正超窗口时仍由 `applyBudget` 从最旧的历史开始丢（budget.ts 第 1 级）。
   *
   * `historyLimit` 保留给测试与想手动收窄的人。
   */
  const policy = input.historyPolicy ?? historyPolicyOf(input.modes);
  const partition = partitionHistory(visibleHistory, { messages: input.history, scenes, policy });
  const mentionText = input.mention?.text ?? input.playerInput;
  const recalledHistory = expandHistoryOnMention(partition.collapsed, mentionText);
  const historyRecallBlock = buildHistoryRecallBlock(recalledHistory);
  if (historyRecallBlock) blocks.push(historyRecallBlock);
  blocks.push(...buildHistoryBlocks(partition.kept, options.historyLimit ?? 3000, prefixSpeaker));

  // 让发言者知道场上还有谁，否则多角色场景里模型会替别人说话
  const otherSpeakers = cast
    .filter((member) => member.id !== input.instance.id && member.presence === 'onstage')
    .map((member) => member.displayName);
  const othersClause = otherSpeakers.length === 0 ? '' : `场景中还有 ${otherSpeakers.join('、')}，不要替他们发言。`;

  blocks.push({
    id: 'instruction',
    kind: 'instruction',
    label: '本轮指令',
    content:
      `现在轮到你发言。请以「${input.instance.displayName}」的身份回应，保持角色不跳出。` +
      (playerDescription === '' ? '' : `玩家「${playerName}」的身份设定：${playerDescription}\n`) +
      othersClause +
      '不要代替玩家行动，也不要描写玩家的内心想法。' +
      '未知设定先问，不编造既定事实。只写本角色这一轮的简短回应；不续演别人，那是他的回合。' +
      // 历史记录里的 assistant 消息带着「名字：」前缀（多人同场时才加），
      // 真实模型会照着这个格式往下写，甚至写成别人的名字——所以这里必须说清
      // 前缀只是给它看的标记，它自己回复时不要带。
      '直接写你的对白与动作，不要在回复开头写任何角色名（不要出现「某某：」这样的前缀）。' +
      '历史记录里的【名字】只是给你看的说话人标记，你的回复里不要出现这种标记。' +
      describeModes(input.modes)
        .map((line) => `\n${line}`)
        .join('') +
      // 放在最后：这一句是模型生成前读到的最后一段。写在前面的规则它经常漏——
      // DeepSeek 网页版端到端测试里，动作 `#` 的遵守率只有约 2/9。
      '\n格式（必须遵守）：动作与神态用 `#` 独占一行开头；对白不加任何名字前缀。' +
      // 导演调用已经判断过「这一轮他该做什么」，把结论给它，别让它再猜一遍
      (input.intent === undefined || input.intent.trim() === ''
        ? ''
        : `\n你这一轮打算：${input.intent.trim()}。照着这个打算写，但不要把这一行写进回复。` +
          (input.intentMode === 'hold_back' ? '（想说没说：只写动作与神态，不要开口。）' : '')) +
      // 意图先行（P1-6 的零额外调用版）：先声明这一轮想做什么，再落笔
      `\n${INTENT_FORMAT_RULE}`,
    priority: PRIORITY.instruction,
    droppable: false,
  });

  // 示范单独成块并且**可丢弃**：它是提升格式遵守率的优化项，不是必需品。
  // 预算紧张时应当先让位给记忆与关系，而不是把整条 prompt 顶出预算。
  /*
   * 顺序 67e：回答长度与反重复。
   *
   * 178 轮真实模型长跑里，回复从 171 字涨到 325 字、自称名字从 0.9 次涨到 5.6 次，
   * 于是「她把杯子放下」写成了「（角色名）把杯子放下」。用户裁定：动作可以连着做
   * 几个不同的，但不许同一个动作重复；长度要收紧，同时给用户三档自己选。
   *
   * 它**可丢弃**：这是质量规矩，不是正确性必需——预算被榨干时先让位给记忆与人设。
   * 但优先级只比「本轮指令」低一点，正常预算下一定在，历史被丢光之前轮不到它。
   */
  blocks.push({
    id: 'reply-style',
    kind: 'format',
    label: '回答长度与反重复',
    content: [NO_REPEAT_RULE, REPLY_LENGTH_RULES[replyLengthOf(input.modes)]].join('\n'),
    priority: PRIORITY.instruction - 50,
    droppable: true,
    compressed: REPLY_LENGTH_RULES[replyLengthOf(input.modes)],
  });

  blocks.push({
    id: 'format',
    kind: 'format',
    label: '格式示范',
    content: [ACTION_FORMAT_EXAMPLES, FORMAT_DEMO].join('\n\n'),
    priority: PRIORITY.history + 50,
    droppable: true,
    compressed: '对白用「」包起来，没被引号包住的句子会被当成动作。',
  });

  // 同一回合里第二名角色发言时 playerInput 为空——玩家的话已经在历史里了，
  // 再插一次会把同一句台词说两遍。
  if (input.playerInput.trim() !== '') {
    blocks.push({
      id: 'player',
      kind: 'player',
      label: playerName,
      content: input.playerInput,
      priority: PRIORITY.player,
      droppable: false,
    });
  }

  const available = Math.max(MIN_PROMPT_TOKENS, input.budget.maxTokens - input.budget.reserveForReply);
  const { blocks: kept, report } = applyBudget(blocks, { maxTokens: available, counter });

  const memoryStats = { recall: 0, mention: 0, source: 0 };
  const keptIds = new Set(kept.map((block) => block.id));
  for (const memory of input.memories ?? []) {
    if (!keptIds.has(`memory:${memory.id}`)) continue;
    memoryStats[memory.origin ?? 'recall'] += 1;
  }

  return {
    blocks: kept,
    messages: toChatMessages(kept),
    report,
    tokenEstimate: report.usedTokens,
    historyStats: {
      total: input.history.length,
      visible: visibleHistory.length,
      collapsed: partition.collapsed.length,
      recalled: recalledHistory.length,
    },
    memoryStats,
  };
}
